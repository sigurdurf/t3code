import {
  resolvePullRequestAuthorFilter,
  type PullRequestCapabilities,
  type PullRequestInvolvement,
  type PullRequestListFilters,
  type PullRequestMergeMethod,
  type PullRequestStackHead,
} from "@t3tools/contracts";
import { removeAgentCredits } from "@t3tools/source-control-core/server/mergeMessage";
import {
  PullRequestProviderError,
  tailLogLines,
  type ProviderCheckLog,
  type ProviderCheckRerun,
  type ProviderRepositoryRef,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { definition } from "../shared/definition.ts";
import * as GiceApi from "./GiceApi.ts";
import * as Json from "./gicePullRequestJson.ts";

const KIND = definition.kind;

const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [...definition.changeRequestActions],
  mergeMethods: ["merge", "squash", "rebase"],
  deleteBranch: true,
  updateMethods: ["merge", "rebase"],
  search: true,
  reactions: true,
  reviewReactions: false,
  mentions: true,
  referenceSigils: ["#"],
  labels: true,
  review: {
    inlineComment: true,
    rangeComment: true,
    reply: true,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
  },
  reviewers: { request: true, listCandidates: true, searchCandidates: true },
  edit: { changeRequest: true, comment: true },
  viewedFiles: "host",
  withheldFileDiff: true,
  stacks: true,
  stackActions: true,
};

const UNAVAILABLE_REQUIREMENT = {
  missing:
    "Gice needs an access token on the server. Add one in Settings → Source control & issues, or sign in with the gice CLI.",
  unauthenticated:
    "Gice has no working token for this server: the saved one was refused or cannot be read, or the server is turned off in Settings → Source control & issues.",
};

/** Gice's largest page. */
const PAGE_SIZE = 100;
const REFERENCE_PAGE_SIZE = 20;
const MAX_PAGES = 10;
/** Gice's most lines for `tail=`. */
const MAX_TAIL_LINES = 10_000;
/** Gice's most line comments in one review. */
const MAX_REVIEW_COMMENTS = 100;
/** How long a repository read once is believed readable, and how many are remembered. */
const READABLE_TTL_MILLIS = 60 * 60_000;
const READABLE_CAPACITY = 4_096;
/** How long Gice holds an events request open, inside the time a request is given to answer. */
const EVENTS_WAIT_SECONDS = 25;

type Target = Pick<ProviderRepositoryRef, "host"> & { readonly repository?: string };
type PullRef = ProviderRepositoryRef & { readonly number: number };
type Request = Omit<GiceApi.GiceApiRequest, "operation" | "host" | "repository">;

const failure = (operation: string, detail: string, cause?: unknown) =>
  new PullRequestProviderError({
    provider: KIND,
    operation,
    reason: "failed",
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const isCheckFailure = (error: PullRequestProviderError) =>
  error.reason === "not-found" || error.reason === "forbidden" || error.reason === "failed";

const decodeBase64 = (content: string) => Buffer.from(content, "base64").toString("utf8");

const noSuchComment = (operation: string) => failure(operation, "Gice has no such comment.");

const COMMENT_ID = /^[1-9]\d*$/u;

const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

const DROPPED_COMMITS =
  /^restacking (#\d+ would leave out \d+ commit\(s\) that an earlier head of #\d+ had)\b.*?; nothing was changed\. (.+?)\.?$/su;

/** Gice's words for a refusal, with what to do where they leave it out. */
function refusalDetail(error: Pick<GiceApi.GiceApiError, "code" | "field" | "detail">) {
  // Gice lists the commits and why before what to do, and clients cut long text, which loses the
  // commands. Any other wording is shown whole.
  const dropped =
    error.code === "restack_drops_commits" ? DROPPED_COMMITS.exec(error.detail) : null;
  if (dropped !== null) return `${dropped[1]}. ${sentence(dropped[2]!)}.`;
  if (error.code === "head_changed")
    return `${error.detail}: it has commits that were not shown here. Refresh, review them, and try again.`;
  if (error.field?.startsWith("expected_heads"))
    return `The stack changed since it was shown (${error.detail}). Refresh it and try again.`;
  return error.detail;
}

const numbered = (numbers: ReadonlyArray<number>) => numbers.map((n) => `#${n}`).join(", ");

/** A stack action that stopped part way: what Gice did, and which layer it stopped at and why. */
function stoppedDetail(
  verb: "merged" | "rebased",
  done: ReadonlyArray<number>,
  stopped: NonNullable<typeof Json.GiceStackResult.Type.stopped>,
) {
  const reason = refusalDetail({ code: stopped.code, detail: stopped.message });
  // Gice's message for a failed step names the layer and the step, and says it can be run again.
  if (stopped.code === "stack_step_failed")
    return done.length === 0 ? sentence(reason) : `Gice ${verb} ${numbered(done)}; ${reason}`;
  return done.length === 0
    ? `Gice stopped at #${stopped.number} before anything was ${verb}: ${reason}`
    : `Gice ${verb} ${numbered(done)}, then stopped at #${stopped.number}: ${reason}`;
}

/**
 * A listing of pull requests, the most recently updated first as the caller shows them, narrowed
 * by what Gice can narrow by; the caller narrows the rest.
 */
function listQuery(
  input: {
    readonly state: string;
    readonly involvement: PullRequestInvolvement;
    readonly viewer: string;
    readonly query?: string | undefined;
    readonly filters?: PullRequestListFilters | undefined;
  },
  pageSize: number,
  page: number,
) {
  const query = new URLSearchParams({
    state: input.state,
    sort: "updated",
    per_page: String(pageSize),
    page: String(page),
    fields: "summary",
  });
  const author =
    input.filters?.author === undefined
      ? input.involvement === "authored"
        ? input.viewer.trim()
        : ""
      : resolvePullRequestAuthorFilter(input.filters.author, input.viewer);
  if (author !== "") query.set("author", author);
  if (input.involvement === "reviewing") query.set("review_requested", input.viewer.trim());
  if (input.filters?.draft !== undefined)
    query.set("draft", String(input.filters.draft === "only"));
  const text = input.query?.trim() ?? "";
  if (text !== "") query.set("q", text);
  // Gice wants every label named; a group offering a choice is left to the caller. Gice label
  // names hold no comma, which separates them here.
  const labels = (input.filters?.labels ?? []).flatMap((group) =>
    group.length === 1 ? group : [],
  );
  if (labels.length > 0) query.set("labels", labels.join(","));
  return query;
}

export const make = Effect.gen(function* () {
  const api = yield* GiceApi.GiceApi;

  const { send, read, readList } = GiceApi.targetRequests(api, {
    repositoryOf: (target: Target) => target.repository,
    mapError: (operation) => (error) =>
      new PullRequestProviderError({
        provider: KIND,
        operation,
        reason: error.reason,
        detail: refusalDetail(error),
        ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
        cause: error,
      }),
  });

  // Gice leaves out of a list across repositories one the token cannot read, as it does one
  // with no rows. A repository read since is readable, so only its silence is an empty answer.
  const readableUntil = new Map<string, number>();
  const readableKey = (host: string, repository: string) =>
    `${host.toLowerCase()}\n${repository.trim().toLowerCase()}`;
  const markReadable = Effect.fn("GicePullRequestProvider.markReadable")(function* (
    host: string,
    repositories: Iterable<string>,
  ) {
    const until = (yield* Clock.currentTimeMillis) + READABLE_TTL_MILLIS;
    for (const repository of repositories) {
      const key = readableKey(host, repository);
      readableUntil.delete(key);
      readableUntil.set(key, until);
      if (readableUntil.size > READABLE_CAPACITY)
        readableUntil.delete(readableUntil.keys().next().value!);
    }
  });

  const readPages = Effect.fn("GicePullRequestProvider.readPages")(function* <
    S extends Schema.Codec<unknown, unknown, never, never>,
  >(operation: string, input: Target, path: string, item: S) {
    const items: Array<S["Type"]> = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = yield* readList(
        operation,
        input,
        { path: `${path}?per_page=${PAGE_SIZE}&page=${page}` },
        item,
      );
      items.push(...batch.items);
      if (!GiceApi.listContinues(batch, items.length, PAGE_SIZE))
        return { items, truncated: false };
    }
    return { items, truncated: true };
  });

  const pullPath = (input: PullRef) => `/pulls/${input.number}`;

  const readPull = (operation: string, input: PullRef) =>
    read(operation, input, { path: pullPath(input) }, Json.GicePull);

  /** The checks of `refs/pull/<n>/head`, which a pull request whose commits are gone lacks. */
  const readStatus = Effect.fn("GicePullRequestProvider.readStatus")(function* (
    operation: string,
    input: PullRef,
  ) {
    const query = new URLSearchParams({ ref: `refs/pull/${input.number}/head` });
    return yield* read(operation, input, { path: `/status?${query}` }, Json.GiceCommitStatus).pipe(
      Effect.catchIf(
        (error) => error.reason === "not-found",
        () => Effect.succeed(null),
      ),
    );
  });

  const readFiles = Effect.fn("GicePullRequestProvider.readFiles")(function* (
    operation: string,
    input: PullRef & { readonly commit?: string | undefined; readonly path?: string | undefined },
    withPatch = true,
  ) {
    const query = new URLSearchParams(input.path === undefined ? {} : { path: input.path });
    if (!withPatch) query.set("patch", "false");
    const path =
      input.commit === undefined
        ? `${pullPath(input)}/files${query.size === 0 ? "" : `?${query}`}`
        : `/commits/${encodeURIComponent(input.commit)}`;
    return yield* read(operation, input, { path }, Json.GiceFiles);
  });

  const readBlob = Effect.fn("GicePullRequestProvider.readBlob")(function* (
    input: ProviderRepositoryRef,
    ref: string,
    path: string,
  ) {
    const operation = "getDiffFileContents";
    const query = new URLSearchParams({ ref, path });
    const blob = yield* read(operation, input, { path: `/blob?${query}` }, Json.GiceBlob);
    if (blob.is_binary) return yield* failure(operation, "Gice cannot provide this file as text.");
    if (blob.content === undefined)
      return yield* failure(operation, "This file is too large for Gice to provide as text.");
    return decodeBase64(blob.content);
  });

  const summarize = (pull: Json.GicePull, input: ProviderRepositoryRef) => ({
    ...Json.toChangeRequest(pull, input),
    ...Json.toSummaryFields(pull),
  });

  /** Gice writes the merge message unless given one, so removing credits starts from its default. */
  const messageWithoutCredits = Effect.fn("GicePullRequestProvider.messageWithoutCredits")(
    function* (operation: string, input: PullRef, method: "merge" | "squash") {
      const path = pullPath(input);
      const [pull, { message }] = yield* Effect.all(
        [
          read(operation, input, { path }, Json.GicePull),
          read(
            operation,
            input,
            { path: `${path}/merge-message?method=${method}` },
            Json.GiceMergeMessage,
          ),
        ],
        { concurrency: 2 },
      );
      const cleaned = removeAgentCredits(message);
      return cleaned === message || !pull.head_sha
        ? null
        : { commit_message: cleaned, expected_head_sha: pull.head_sha };
    },
  );

  const readStack = (operation: string, input: PullRef) =>
    read(operation, input, { path: `${pullPath(input)}/stack` }, Json.GiceStack);

  /** The pull request with its stack, whose own permissions say whether it can be restacked. */
  const readPullInStack = Effect.fn("GicePullRequestProvider.readPullInStack")(function* (
    operation: string,
    input: PullRef,
  ) {
    const pull = yield* readPull(operation, input);
    return { pull, stack: pull.stack == null ? null : yield* readStack(operation, input) };
  });

  /**
   * Gice changes exactly the open layers `expected_heads` names, at those heads, and refuses
   * when they are not the ones the action would change, so the heads the person was shown
   * decide what changes; nothing here does.
   */
  const runStackAction = Effect.fn("GicePullRequestProvider.runStackAction")(function* (
    input: PullRef & {
      readonly action: "merge" | "update-branch";
      readonly expectedStackHeads: ReadonlyArray<PullRequestStackHead>;
      readonly mergeMethod?: PullRequestMergeMethod | undefined;
    },
  ) {
    const { action } = input;
    const expected_heads = input.expectedStackHeads.map((layer) => ({
      number: layer.number,
      sha: layer.headSha,
    }));
    let request: Request;
    if (action === "merge") {
      request = {
        method: "POST",
        path: `${pullPath(input)}/stack/merge`,
        body: { method: input.mergeMethod ?? "merge", expected_heads },
      };
    } else {
      // A restack takes a pull request and every open one built on it, so it starts from the
      // lowest open layer under the top it was asked for.
      const lowest = (yield* readStack(action, input)).layers.find(
        (layer) => layer.state === "open",
      );
      if (lowest === undefined) return yield* failure(action, "This stack has no open layer.");
      request = {
        method: "POST",
        path: `/pulls/${lowest.number}/stack/restack`,
        body: { expected_heads },
      };
    }
    const result = yield* read(action, input, request, Json.GiceStackResult);
    if (result.stopped !== null)
      return yield* failure(
        action,
        action === "merge"
          ? stoppedDetail("merged", result.merged ?? [], result.stopped)
          : stoppedDetail("rebased", result.restacked ?? [], result.stopped),
      );
  });

  const provider: PullRequestProviderApi = {
    kind: KIND,
    capabilities: CAPABILITIES,
    detailChecks: "when-found",
    unavailableRequirement: UNAVAILABLE_REQUIREMENT,
    mergeMessageRewrite: removeAgentCredits,
    getViewer: (input) =>
      input.host === undefined
        ? Effect.fail(failure("getViewer", "Gice needs the server's host to say who is signed in."))
        : read("getViewer", { host: input.host }, { path: "/user" }, Json.GiceUser).pipe(
            Effect.map((user) => user.username),
          ),
    listChangeRequests: Effect.fn("GicePullRequestProvider.listChangeRequests")(function* (input) {
      const pageSize = Math.min(Math.max(1, input.limit), PAGE_SIZE);
      const offset = input.cursor?.delivered ?? 0;
      const page = Math.floor(offset / pageSize) + 1;
      const query = listQuery(input, pageSize, page);
      if (input.filters?.checks !== undefined)
        query.set("checks", input.filters.checks === "passing" ? "success" : "failure");
      const listed = yield* readList(
        "listChangeRequests",
        input,
        { path: `/pulls?${query}` },
        Json.GicePullRow,
      );
      // Gice pages by offset. A row updated since the cursor's boundary moved above it, so it is
      // left to the next read from the top; one that left the listing above skips a row.
      const rows = listed.items.slice(offset - (page - 1) * pageSize);
      const before = input.cursor?.updatedBefore;
      const byNumber = new Map(listed.items.map((pull) => [pull.number, pull]));
      if (input.repository !== undefined) yield* markReadable(input.host, [input.repository]);
      return {
        items: rows
          .map((pull) => Json.toChangeRequest(pull, input, byNumber))
          .filter((item) => before === undefined || item.updatedAt <= before),
        truncated: GiceApi.listContinues(
          listed,
          (page - 1) * pageSize + listed.items.length,
          pageSize,
        ),
        continues: true,
        cursorAdvance: rows.length,
      };
    }),
    // Gice carries a read across repositories on from where its last page stopped; one carried on
    // from a read of each repository, and a checks filter it has no parameter for, read each.
    listChangeRequestsAcross: Effect.fn("GicePullRequestProvider.listChangeRequestsAcross")(
      function* (input) {
        const resumeAfter = input.cursor?.resumeAfter;
        if (
          (input.cursor !== undefined && resumeAfter === undefined) ||
          input.filters?.checks !== undefined
        )
          return { items: [], truncated: false, unresolved: input.repositories };
        const pageSize = Math.min(Math.max(1, input.limit), PAGE_SIZE);
        const query = listQuery(input, pageSize, 1);
        query.set("repos", input.repositories.join(","));
        if (resumeAfter !== undefined) {
          query.delete("page");
          query.set("cursor", resumeAfter);
        }
        const listed = yield* readList(
          "listChangeRequestsAcross",
          { host: input.host },
          { path: `/pulls?${query}` },
          Json.GiceAcrossPull,
        );
        const byRepository = new Map<string, Map<number, typeof Json.GiceAcrossPull.Type>>();
        for (const pull of listed.items) {
          const key = pull.repository.full_name.toLowerCase();
          const rows = byRepository.get(key) ?? new Map();
          byRepository.set(key, rows.set(pull.number, pull));
        }
        yield* markReadable(
          input.host,
          listed.items.map((pull) => pull.repository.full_name),
        );
        // Gice works stacks out for the first ten repositories of a page; the rows of the rest
        // are read with their repository's, which says which of them are in one.
        const unstacked = new Set(
          listed.items.flatMap((pull) =>
            pull.stack === undefined ? [pull.repository.full_name.toLowerCase()] : [],
          ),
        );
        const now = yield* Clock.currentTimeMillis;
        const unresolved = input.repositories.filter(
          (repository) =>
            unstacked.has(repository.toLowerCase()) ||
            (readableUntil.get(readableKey(input.host, repository)) ?? 0) <= now,
        );
        return {
          items: listed.items.flatMap((pull) => {
            const key = pull.repository.full_name.toLowerCase();
            return unstacked.has(key)
              ? []
              : [Json.toAcrossChangeRequest(pull, byRepository.get(key)!)];
          }),
          truncated: listed.next !== undefined,
          ...(listed.next === undefined ? {} : { resumeAfter: listed.next }),
          ...(unresolved.length === 0 ? {} : { unresolved }),
        };
      },
    ),
    getChangeRequestPreview: (input) =>
      readPull("getChangeRequestPreview", input).pipe(
        Effect.map((pull) => Json.toChangeRequest(pull, input)),
      ),
    getChangeRequestSummary: (input) =>
      readPull("getChangeRequestSummary", input).pipe(Effect.map((pull) => summarize(pull, input))),
    getChangeRequestChecks: Effect.fn("GicePullRequestProvider.getChangeRequestChecks")(
      function* (input) {
        const operation = "getChangeRequestChecks";
        const [pull, status] = yield* Effect.all(
          [readPull(operation, input), readStatus(operation, input)],
          { concurrency: 2 },
        );
        return { state: pull.state, checks: status === null ? [] : Json.toChecks(status) };
      },
    ),
    getChangeRequestStack: (input) =>
      readStack("getChangeRequestStack", input).pipe(Effect.map(Json.toStack)),
    getChangeRequest: Effect.fn("GicePullRequestProvider.getChangeRequest")(function* (input) {
      const operation = "getChangeRequest";
      const [{ pull, stack }, status] = yield* Effect.all(
        [
          readPullInStack(operation, input),
          // A failed checks read leaves the pull request readable, its checks read on their own.
          readStatus(operation, input).pipe(Effect.orElseSucceed(() => null)),
        ],
        { concurrency: 2 },
      );
      return {
        ...Json.toChangeRequest(pull, input),
        ...Json.toDetailFields(pull),
        headSha: pull.head_sha,
        changedFiles: pull.changed_files,
        reviewers: pull.requested_reviewers.map(Json.toActor),
        checks: status === null ? [] : Json.toChecks(status),
        mergeCapabilities: Json.toMergeCapabilities(pull),
        viewerPermissions: Json.toViewerPermissions(pull, stack),
      };
    }),
    getChangeRequestActivity: Effect.fn("GicePullRequestProvider.getChangeRequestActivity")(
      function* (input) {
        const operation = "getChangeRequestActivity";
        const pulls = `/pulls/${input.number}`;
        const [comments, commits, reviews, threads, pull] = yield* Effect.all(
          [
            readPages(operation, input, `/issues/${input.number}/comments`, Json.GiceComment),
            readPages(operation, input, `${pulls}/commits`, Json.GiceCommit),
            readPages(operation, input, `${pulls}/reviews`, Json.GiceReview),
            readPages(operation, input, `${pulls}/threads`, Json.GiceReviewThread),
            // The description's reactions and the people asked to review are on the pull request.
            readPull(operation, input),
          ],
          { concurrency: 5 },
        );
        const remarks = [...comments.items.map(Json.toComment), ...Json.toReviews(reviews.items)];
        const reviewers = new Map(
          [
            ...pull.requested_reviewers.map(Json.toActor),
            ...remarks.flatMap((remark) =>
              remark.kind === "review" && remark.author !== null ? [remark.author] : [],
            ),
          ].map((actor) => [actor.login, actor]),
        );
        return {
          reviewers: [...reviewers.values()],
          comments: remarks.toSorted((left, right) =>
            left.createdAt.localeCompare(right.createdAt),
          ),
          commentCount: remarks.length,
          commentsTruncated: comments.truncated || reviews.truncated,
          reviewThreads: Json.toReviewThreads(threads.items),
          reviewThreadsTruncated: threads.truncated,
          // Gice lists a pull request's commits newest first.
          commits: commits.items.map(Json.toCommit).toReversed(),
          reactions: Json.toReactions(pull),
        };
      },
    ),
    getViewerPermissions: (input) =>
      readPullInStack("getViewerPermissions", input).pipe(
        Effect.map(({ pull, stack }) => Json.toViewerPermissions(pull, stack)),
      ),
    getChangeRequestWatchFingerprint: Effect.fn(
      "GicePullRequestProvider.getChangeRequestWatchFingerprint",
    )(function* (input) {
      const operation = "getChangeRequestWatchFingerprint";
      const newest = (types: string) =>
        read(
          operation,
          input,
          { path: `/events?pull=${input.number}${types}&limit=1` },
          Json.GiceEvents,
        );
      // Every change to a pull request, its checks and its base appends an event, and Gice works
      // mergeability out from the two tips on each read, so the newest event covers the detail.
      const [all, remarks] = yield* Effect.all(
        [newest(""), newest(`&types=${Json.REMARK_EVENT_TYPES}`)],
        { concurrency: 2 },
      );
      return { status: String(all.cursor), remarks: String(remarks.cursor), coversDetail: true };
    }),
    changeRequestEvents: (input) => {
      const operation = "changeRequestEvents";
      // Without a cursor Gice answers at once with the newest event, which is where to wait from.
      const poll = (since: number | null) =>
        read(
          operation,
          input,
          {
            path: `/events?pull=${input.number}&${
              since === null ? "limit=1" : `since=${since}&wait=${EVENTS_WAIT_SECONDS}`
            }`,
          },
          Json.GiceEvents,
        );
      // Guard against a misbehaving proxy returning empty long-poll replies immediately.
      const MIN_EMPTY_POLL_MS = 1_000;
      return Stream.paginate(null as number | null, (since) =>
        Effect.gen(function* () {
          const startedAt = yield* Clock.currentTimeMillis;
          const feed = yield* poll(since);
          if (since !== null && feed.events.length === 0) {
            const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
            if (elapsed < MIN_EMPTY_POLL_MS) {
              yield* Effect.sleep(Duration.millis(MIN_EMPTY_POLL_MS - elapsed));
            }
          }
          return [
            since === null || feed.events.length > 0 ? [undefined] : [],
            Option.some<number | null>(feed.cursor),
          ] as const;
        }).pipe(
          // A feed that stops answering ends, and its readers go back to polling.
          Effect.orElseSucceed(() => [[], Option.none<number | null>()] as const),
        ),
      );
    },
    getDiff: Effect.fn("GicePullRequestProvider.getDiff")(function* (input) {
      // A commit's own diff has no per-file read.
      if (input.path !== undefined && input.commit !== undefined)
        return yield* failure("getDiff", "Gice cannot read one file of this diff.");
      return Json.toDiff(
        yield* readFiles("getDiff", input),
        input.commit === undefined && input.path === undefined,
      );
    }),
    getDiffFilePaths: (input) =>
      readFiles("getDiffFilePaths", input, false).pipe(
        Effect.map((diff) => ({
          files: diff.files.map((file) => ({
            oldPath: file.old_path || file.path,
            newPath: file.path,
          })),
          nextCursor: null,
        })),
      ),
    getDiffFileContents: Effect.fn("GicePullRequestProvider.getDiffFileContents")(
      function* (input) {
        const operation = "getDiffFileContents";
        let sides: { readonly old: string | undefined; readonly new: string };
        if (input.commit !== undefined) {
          const commit = yield* read(
            operation,
            input,
            { path: `/commits/${encodeURIComponent(input.commit)}` },
            Json.GiceCommit,
          );
          sides = { old: commit.parents?.[0], new: commit.sha };
        } else {
          const pull = yield* readPull(operation, input);
          if (pull.head_sha === null || pull.merge_base_sha === null)
            return yield* failure(operation, "Gice has no commits for this pull request.");
          sides = { old: pull.merge_base_sha, new: pull.head_sha };
        }
        // A fork's commits are fetched into the pull request's repository, so both sides read there.
        const [oldContents, newContents] = yield* Effect.all(
          [
            input.changeType === "new" || sides.old === undefined
              ? Effect.succeed("")
              : readBlob(input, sides.old, input.oldPath),
            input.changeType === "deleted"
              ? Effect.succeed("")
              : readBlob(input, sides.new, input.newPath),
          ],
          { concurrency: 2 },
        );
        return { oldContents, newContents };
      },
    ),
    getFileStats: (input) =>
      readFiles("getFileStats", input, false).pipe(
        Effect.map((diff) => ({
          files: diff.files.map(({ path, additions, deletions }) => ({
            path,
            additions,
            deletions,
          })),
          truncated: false,
        })),
      ),
    getFilesViewed: (input) =>
      read("getFilesViewed", input, { path: `${pullPath(input)}/viewed` }, Json.GiceViewed).pipe(
        Effect.map(Json.toFilesViewed),
      ),
    // A diff names a file's version abbreviated, and Gice marks a file at a full blob id (an
    // empty one for a deleted file), else at the file as it is now. A file shown at a version it
    // has since left is not marked: nobody saw what it holds now.
    setFilesViewed: Effect.fn("GicePullRequestProvider.setFilesViewed")(function* (input) {
      const operation = "setFilesViewed";
      const current = input.files.some((file) => file.viewed && file.revision !== undefined)
        ? new Map(
            (yield* readFiles(operation, input, false)).files.map((file) => [
              file.path,
              file.sha ?? "",
            ]),
          )
        : new Map<string, string>();
      const files = input.files.flatMap(({ path, viewed, revision }) => {
        if (!viewed || revision === undefined) return [{ path, viewed }];
        const shown = /^0+$/u.test(revision) ? "" : revision.toLowerCase();
        const sha = current.get(path);
        if (sha === undefined || (shown === "" ? sha !== "" : !sha.startsWith(shown))) return [];
        return [{ path, viewed, sha }];
      });
      if (files.length === 0) return;
      yield* send(operation, input, {
        method: "PUT",
        path: `${pullPath(input)}/viewed`,
        body: { files },
      });
    }),
    getCheckLogs: Effect.fn("GicePullRequestProvider.getCheckLogs")(function* (input) {
      const operation = "getCheckLogs";
      // One line more than asked for says whether the log goes back further.
      const tail = Math.min(Math.max(1, input.tailLines) + 1, MAX_TAIL_LINES);
      return yield* Effect.forEach(
        input.checks,
        (check): Effect.Effect<ProviderCheckLog, PullRequestProviderError> => {
          const run = Json.runNumberOf(check.url);
          const job = Json.jobIdOf(check.url);
          if (run === null || job === null)
            return Effect.succeed({
              ...check,
              log: null,
              truncated: false,
              detail: run === null ? "Gice holds no log for this check." : "This run has no jobs.",
            });
          return send(operation, input, {
            path: `/runs/${run}/jobs/${job}/logs?tail=${tail}`,
          }).pipe(
            Effect.map((log) => ({
              ...check,
              ...tailLogLines(log, input.tailLines),
              detail: null,
            })),
            // Sign-in and rate-limit failures fail the call; the rest are this check's.
            Effect.catchIf(isCheckFailure, (error) =>
              Effect.succeed({ ...check, log: null, truncated: false, detail: error.detail }),
            ),
          );
        },
        { concurrency: 2 },
      );
    }),
    rerunChecks: Effect.fn("GicePullRequestProvider.rerunChecks")(function* (input) {
      // A run re-runs the named jobs and what they need together; one without jobs re-runs whole.
      const jobsByRun = new Map<number, Set<number>>();
      for (const check of input.checks) {
        const run = Json.runNumberOf(check.url);
        if (run === null) continue;
        const jobs = jobsByRun.get(run) ?? new Set();
        const job = Json.jobIdOf(check.url);
        if (job !== null) jobs.add(job);
        jobsByRun.set(run, jobs);
      }
      const outcomes = new Map<number, string | null>();
      yield* Effect.forEach(
        jobsByRun,
        ([run, jobs]) =>
          send("rerunChecks", input, {
            method: "POST",
            path: `/runs/${run}/rerun`,
            ...(jobs.size === 0 ? {} : { body: { jobs: [...jobs] } }),
          }).pipe(
            Effect.as<string | null>(null),
            Effect.catchIf(isCheckFailure, (error) => Effect.succeed(error.detail)),
            Effect.map((detail) => outcomes.set(run, detail)),
          ),
        { concurrency: 2, discard: true },
      );
      return input.checks.map((check): ProviderCheckRerun => {
        const run = Json.runNumberOf(check.url);
        if (run === null)
          return { name: check.name, rerun: false, detail: "Gice cannot re-run this check." };
        const detail = outcomes.get(run) ?? null;
        return { name: check.name, rerun: detail === null, detail };
      });
    }),
    runAction: Effect.fn("GicePullRequestProvider.runAction")(function* (input) {
      const { action } = input;
      if (action === "approve-workflows")
        return yield* failure(action, `Gice cannot ${action} a pull request.`);
      if (input.mergeMethod === "fast-forward")
        return yield* failure(action, "Gice has no fast-forward merge.");
      if (input.stackNumber !== undefined) {
        if ((action !== "merge" && action !== "update-branch") || !input.expectedStackHeads)
          return yield* failure(action, "Gice merges or rebases a stack at the heads it showed.");
        return yield* runStackAction({
          ...input,
          action,
          expectedStackHeads: input.expectedStackHeads,
        });
      }
      const path = pullPath(input);
      const method = input.mergeMethod ?? "merge";
      // The message is Gice's to write for a rebase, which keeps each commit's own.
      const message =
        (action === "merge" || action === "enable-auto-merge") &&
        input.removeAgentCreditsOnMerge === true &&
        method !== "rebase"
          ? yield* messageWithoutCredits(action, input, method)
          : null;
      const pinned =
        input.expectedHeadSha === undefined ? {} : { expected_head_sha: input.expectedHeadSha };
      let request: Request;
      switch (action) {
        case "merge":
          request = {
            method: "POST",
            path: `${path}/merge`,
            body: { method, ...message, ...pinned },
          };
          break;
        case "enable-auto-merge":
          request = {
            method: "PUT",
            path: `${path}/auto-merge`,
            body: {
              method,
              ...(message === null ? {} : { commit_message: message.commit_message }),
              ...pinned,
            },
          };
          break;
        case "disable-auto-merge":
          request = { method: "DELETE", path: `${path}/auto-merge` };
          break;
        case "update-branch":
          request = {
            method: "POST",
            path: `${path}/update-branch`,
            body: { method: input.updateMethod ?? "merge", ...pinned },
          };
          break;
        case "delete-branch": {
          // Deleting a branch moves the open pull requests based on it, and T3 Code's
          // confirmation does not list them, so such a branch is left to Gice's own page.
          const pull = yield* readPull(action, input);
          const based = pull.head_branch_pulls ?? [];
          if (based.length > 0) {
            const [them, are, their] =
              based.length === 1 ? ["it", "is", "its"] : ["them", "are", "their"];
            return yield* failure(
              action,
              `${numbered(based)} ${are} based on ${pull.head}, and deleting it moves ${them} to another base. Delete it on Gice, which lists ${them} first, or change ${their} base.`,
            );
          }
          // Gice refuses if a pull request was based on the branch since it was read, and answers
          // a deleted branch with no body to read.
          return yield* send(action, input, {
            method: "DELETE",
            path: `${path}/head-branch`,
            body: { expected_head_branch_pulls: based },
          }).pipe(Effect.asVoid);
        }
        case "revert":
          // Gice answers with the new pull request that reverts this one, on a branch it made.
          return yield* send(action, input, { method: "POST", path: `${path}/revert` }).pipe(
            Effect.asVoid,
          );
        case "ready":
        case "draft":
          request = { method: "PATCH", path, body: { draft: action === "draft" } };
          break;
        case "close":
        case "reopen":
          request = {
            method: "PATCH",
            path,
            body: { state: action === "close" ? "closed" : "open" },
          };
          break;
      }
      const pull = yield* read(action, input, request, Json.GicePull);
      return summarize(pull, input);
    }),
    updateChangeRequest: Effect.fn("GicePullRequestProvider.updateChangeRequest")(
      function* (input) {
        const path = pullPath(input);
        yield* send("updateChangeRequest", input, {
          method: "PATCH",
          path,
          body: {
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.body === undefined ? {} : { body: input.body }),
          },
        });
      },
    ),
    // A pull request shares its number and its comments with Gice's issues.
    comment: Effect.fn("GicePullRequestProvider.comment")(function* (input) {
      yield* send("comment", input, {
        method: "POST",
        path: `/issues/${input.number}/comments`,
        body: { body: input.body },
      });
    }),
    updateComment: Effect.fn("GicePullRequestProvider.updateComment")(function* (input) {
      const operation = "updateComment";
      const inline =
        input.kind === "review-comment" ? Json.reviewCommentIdOf(input.commentId) : null;
      if (inline === null && (input.kind !== "issue-comment" || !COMMENT_ID.test(input.commentId)))
        return yield* noSuchComment(operation);
      yield* send(operation, input, {
        method: "PATCH",
        path: inline === null ? `/comments/${input.commentId}` : `/pulls/comments/${inline}`,
        body: { body: input.body },
      });
    }),
    submitReview: Effect.fn("GicePullRequestProvider.submitReview")(function* (input) {
      const operation = "submitReview";
      // Splitting would turn one verdict into several reviews, so the reader chooses instead.
      if (input.comments.length > MAX_REVIEW_COMMENTS)
        return yield* failure(
          operation,
          `Gice takes at most ${MAX_REVIEW_COMMENTS} line comments in one review, and this one has ${input.comments.length}. Remove some, or submit them in another review.`,
        );
      // Without `commit_id` Gice records the review against the head it has now.
      yield* send(operation, input, {
        method: "POST",
        path: `${pullPath(input)}/reviews`,
        body: {
          event:
            input.verdict === "approve"
              ? "APPROVE"
              : input.verdict === "request-changes"
                ? "REQUEST_CHANGES"
                : "COMMENT",
          body: input.body,
          comments: input.comments.map(Json.toReviewComment),
        },
      });
    }),
    listReviewerCandidates: Effect.fn("GicePullRequestProvider.listReviewerCandidates")(
      function* (input) {
        const operation = "listReviewerCandidates";
        const path = pullPath(input);
        const query = new URLSearchParams({ per_page: String(PAGE_SIZE) });
        if (input.query?.trim()) query.set("q", input.query.trim());
        // Gice leaves the author out of the candidates itself.
        const [pull, users] = yield* Effect.all(
          [
            read(operation, input, { path }, Json.GicePull),
            readList(
              operation,
              input,
              { path: `${path}/reviewer-candidates?${query}` },
              Json.GiceUser,
            ),
          ],
          { concurrency: 2 },
        );
        const requested = new Set(
          pull.requested_reviewers.map((user) => user.username.toLowerCase()),
        );
        return {
          candidates: users.items.map((user) => Json.toReviewerCandidate(user, requested)),
          truncated: GiceApi.listContinues(users, users.items.length, PAGE_SIZE),
        };
      },
    ),
    setReviewerRequest: Effect.fn("GicePullRequestProvider.setReviewerRequest")(function* (input) {
      const operation = "setReviewerRequest";
      if (input.reviewers.some((reviewer) => reviewer.kind !== "user"))
        return yield* failure(operation, "Gice has no teams to ask for a review.");
      yield* send(operation, input, {
        method: input.requested ? "POST" : "DELETE",
        path: `${pullPath(input)}/requested_reviewers`,
        body: { reviewers: input.reviewers.map((reviewer) => reviewer.id) },
      });
    }),
    listLabelCandidates: Effect.fn("GicePullRequestProvider.listLabelCandidates")(
      function* (input) {
        const operation = "listLabelCandidates";
        const [labels, pull] = yield* Effect.all(
          [readPages(operation, input, "/labels", Json.GiceLabel), readPull(operation, input)],
          { concurrency: 2 },
        );
        const held = new Set(pull.labels.map((label) => label.name.toLowerCase()));
        return {
          candidates: labels.items.map((label) => ({
            ...Json.toLabel(label),
            description: label.description || null,
            isApplied: held.has(label.name.toLowerCase()),
          })),
          truncated: labels.truncated,
        };
      },
    ),
    listRepositoryLabels: Effect.fn("GicePullRequestProvider.listRepositoryLabels")(
      function* (input) {
        const operation = "listRepositoryLabels";
        const labels = yield* readPages(operation, input, "/labels", Json.GiceLabel);
        return { items: labels.items.map(Json.toLabel), truncated: labels.truncated };
      },
    ),
    // The owner and collaborators, who are also the people a comment can mention.
    searchRepositoryAuthors: Effect.fn("GicePullRequestProvider.searchRepositoryAuthors")(
      function* (input) {
        const query = new URLSearchParams({ per_page: String(PAGE_SIZE) });
        if (input.query?.trim()) query.set("q", input.query.trim());
        const users = yield* readList(
          "searchRepositoryAuthors",
          input,
          { path: `/assignee-candidates?${query}` },
          Json.GiceUser,
        );
        return {
          items: users.items.map(Json.toActor),
          truncated: GiceApi.listContinues(users, users.items.length, PAGE_SIZE),
        };
      },
    ),
    // Gice numbers issues and pull requests in one sequence, both written `#n`. Its search puts
    // the exact number first, then numbers starting with the text and titles holding it.
    searchRepositoryReferences: Effect.fn("GicePullRequestProvider.searchRepositoryReferences")(
      function* (input) {
        if (input.sigil !== undefined && input.sigil !== "#")
          return { items: [], truncated: false };
        const query = new URLSearchParams({ per_page: String(REFERENCE_PAGE_SIZE) });
        if (input.query?.trim()) query.set("q", input.query.trim());
        const references = yield* readList(
          "searchRepositoryReferences",
          input,
          { path: `/references?${query}` },
          Json.GiceReference,
        );
        return {
          items: references.items.map(Json.toReferenceCandidate),
          truncated: GiceApi.listContinues(
            references,
            references.items.length,
            REFERENCE_PAGE_SIZE,
          ),
        };
      },
    ),
    setLabels: Effect.fn("GicePullRequestProvider.setLabels")(function* (input) {
      const operation = "setLabels";
      const path = `/issues/${input.number}/labels`;
      if (input.applied)
        return yield* send(operation, input, {
          method: "POST",
          path,
          body: { labels: input.labels },
        }).pipe(Effect.asVoid);
      // Gice takes labels off one at a time.
      yield* Effect.forEach(
        input.labels,
        (label) =>
          send(operation, input, {
            method: "DELETE",
            path: `${path}/${encodeURIComponent(label)}`,
          }).pipe(Effect.catchIf(GiceApi.isAlreadyOff, () => Effect.void)),
        { concurrency: 1, discard: true },
      );
    }),
    replyToThread: Effect.fn("GicePullRequestProvider.replyToThread")(function* (input) {
      const operation = "replyToThread";
      const thread = Json.threadIdParts(input.threadId);
      if (thread === null) return yield* failure(operation, "Gice has no such review thread.");
      yield* send(operation, input, {
        method: "POST",
        path: `${pullPath(input)}/comments/${thread.comment}/replies`,
        body: { body: input.body },
      });
    }),
    setReaction: Effect.fn("GicePullRequestProvider.setReaction")(function* (input) {
      const operation = "setReaction";
      const inline = input.subjectId === undefined ? null : Json.reviewCommentIdOf(input.subjectId);
      if (input.subjectId !== undefined && inline === null && !COMMENT_ID.test(input.subjectId))
        return yield* failure(
          operation,
          Json.isReviewId(input.subjectId)
            ? "Gice has no reactions on reviews."
            : "Gice has no such comment.",
        );
      const path = `${
        input.subjectId === undefined
          ? `/issues/${input.number}`
          : inline === null
            ? `/comments/${input.subjectId}`
            : `/pulls/comments/${inline}`
      }/reactions`;
      const content = Json.reactionContent(input.content);
      if (input.reacted)
        return yield* send(operation, input, { method: "POST", path, body: { content } }).pipe(
          Effect.asVoid,
        );
      yield* send(operation, input, {
        method: "DELETE",
        path: `${path}?content=${encodeURIComponent(content)}`,
      }).pipe(Effect.catchIf(GiceApi.isAlreadyOff, () => Effect.void));
    }),
    setThreadResolution: Effect.fn("GicePullRequestProvider.setThreadResolution")(
      function* (input) {
        const operation = "setThreadResolution";
        const thread = Json.threadIdParts(input.threadId);
        if (thread === null) return yield* failure(operation, "Gice has no such review thread.");
        yield* send(operation, input, {
          method: input.resolved ? "PUT" : "DELETE",
          path: `/pulls/threads/${thread.thread}/resolution`,
        });
      },
    ),
  };
  return provider;
});
