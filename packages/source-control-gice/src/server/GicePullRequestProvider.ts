import {
  resolvePullRequestAuthorFilter,
  SourceControlProviderKind,
  type PullRequestCapabilities,
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
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { definition } from "../shared/definition.ts";
import * as GiceApi from "./GiceApi.ts";
import * as Json from "./gicePullRequestJson.ts";

const KIND = SourceControlProviderKind.make("gice");

// What a current Gice server can do. One that predates a feature says so in `GET /meta`, and
// `capabilitiesOnHost` answers for that server instead.
const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [...definition.changeRequestActions],
  mergeMethods: ["merge", "squash", "rebase"],
  deleteBranch: true,
  updateMethods: ["merge", "rebase"],
  search: true,
  reactions: true,
  mentions: false,
  referenceSigils: [],
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
  viewedFiles: "environment",
  withheldFileDiff: true,
};

const FEATURE_OF_ACTION = {
  ready: "pull_drafts",
  draft: "pull_drafts",
  "delete-branch": "pull_merge_options",
  "update-branch": "pull_update_branch",
  "enable-auto-merge": "pull_auto_merge",
  "disable-auto-merge": "pull_auto_merge",
} as const satisfies Partial<
  Record<PullRequestCapabilities["actions"][number], GiceApi.GiceFeature>
>;

function capabilitiesOf(features: GiceApi.GiceFeatures): PullRequestCapabilities {
  const reviews = features.has("pull_reviews");
  const inlineComment = reviews && features.has("pull_review_comments");
  const threads = features.has("pull_review_threads");
  const reviewers = features.has("pull_reviewer_requests");
  return {
    ...CAPABILITIES,
    actions: CAPABILITIES.actions.filter((action) => {
      const feature = (FEATURE_OF_ACTION as Partial<Record<string, GiceApi.GiceFeature>>)[action];
      return feature === undefined || features.has(feature);
    }),
    deleteBranch: features.has("pull_merge_options"),
    updateMethods: features.has("pull_update_branch") ? ["merge", "rebase"] : [],
    reactions: features.has("reactions"),
    labels: features.has("labels"),
    review: {
      inlineComment,
      rangeComment: inlineComment,
      reply: threads && features.has("pull_review_comments"),
      resolve: threads,
      verdicts: reviews ? CAPABILITIES.review.verdicts : [],
    },
    reviewers: { request: reviewers, listCandidates: reviewers, searchCandidates: reviewers },
    withheldFileDiff: features.has("pull_file_paging"),
  };
}

const UNAVAILABLE_REQUIREMENT = {
  missing:
    "Gice needs an access token on the server. Add one in Settings → Source control & issues, or sign in with the gice CLI.",
  unauthenticated:
    "Gice rejected the configured token. Check it in Settings → Source control & issues.",
};

/** Gice's largest page. */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;
/** Gice refuses a longer `q`. */
const MAX_QUERY_BYTES = 256;
/** Gice's most lines for `tail=`. */
const MAX_TAIL_LINES = 10_000;
/** How long Gice holds an events request open, inside the time a request is given to answer. */
const EVENTS_WAIT_SECONDS = 25;
const SHA = /^[0-9a-f]{40,64}$/u;
const REPOSITORY = /^[^/\s]+\/[^/\s]+$/u;

type HostRef = Pick<ProviderRepositoryRef, "host">;
type PullRef = ProviderRepositoryRef & { readonly number: number };
type Request = Omit<GiceApi.GiceApiRequest, "operation" | "host">;

const failure = (operation: string, detail: string, cause?: unknown) =>
  new PullRequestProviderError({
    provider: KIND,
    operation,
    reason: "failed",
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const unsupported = (operation: string, detail: string) => Effect.fail(failure(operation, detail));

const isCheckFailure = (error: PullRequestProviderError) =>
  error.reason === "not-found" || error.reason === "forbidden" || error.reason === "failed";

const decodeBase64 = (content: string) => Buffer.from(content, "base64").toString("utf8");

const noSuchComment = (operation: string) => failure(operation, "Gice has no such comment.");

const COMMENT_ID = /^[1-9]\d*$/u;
const NO_REVIEWERS = "Gice has no pull request reviewers.";
const NO_THREADS = "Gice has no review threads.";
const NO_LABELS = "Gice has no labels.";

export const make = Effect.gen(function* () {
  const api = yield* GiceApi.GiceApi;

  const send = (operation: string, input: HostRef, request: Request) =>
    api.request({ ...request, host: input.host, operation }).pipe(
      Effect.mapError(
        (error) =>
          new PullRequestProviderError({
            provider: KIND,
            operation,
            reason: error.status === 403 ? "forbidden" : error.reason,
            detail: error.detail,
            cause: error,
          }),
      ),
    );

  const read = <S extends Schema.Codec<unknown, unknown, never, never>>(
    operation: string,
    input: HostRef,
    request: Request,
    schema: S,
  ) =>
    send(operation, input, request).pipe(
      Effect.flatMap((raw) =>
        Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
          Effect.mapError((cause) =>
            failure(operation, "Gice returned an unreadable response.", cause),
          ),
        ),
      ),
    );

  /** Gice answers a listing with a bare array, so a short page is the only sign of the end. */
  const readPages = Effect.fn("GicePullRequestProvider.readPages")(function* <
    S extends Schema.Codec<unknown, unknown, never, never>,
  >(operation: string, input: HostRef, path: string, item: S) {
    const items: Array<S["Type"]> = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = yield* read(
        operation,
        input,
        { path: `${path}${path.includes("?") ? "&" : "?"}per_page=${PAGE_SIZE}&page=${page}` },
        Schema.Array(item),
      );
      items.push(...batch);
      if (batch.length < PAGE_SIZE) return { items, truncated: false };
    }
    return { items, truncated: true };
  });

  const repositoryPath = (
    operation: string,
    input: ProviderRepositoryRef,
  ): Effect.Effect<string, PullRequestProviderError> =>
    REPOSITORY.test(input.repository)
      ? Effect.succeed(`/repos/${input.repository.split("/").map(encodeURIComponent).join("/")}`)
      : Effect.fail(failure(operation, "Gice repositories are named owner/name."));

  const pullPath = (operation: string, input: PullRef) =>
    repositoryPath(operation, input).pipe(Effect.map((base) => `${base}/pulls/${input.number}`));

  const readPull = (operation: string, input: PullRef) =>
    pullPath(operation, input).pipe(
      Effect.flatMap((path) => read(operation, input, { path }, Json.GicePull)),
    );

  /**
   * A pull request does not carry its head commit, but Gice keeps `refs/pull/<n>/head` on it,
   * so the status of that ref gives the head and its checks together. A pull request whose
   * commits are gone has no such ref.
   */
  const readStatus = Effect.fn("GicePullRequestProvider.readStatus")(function* (
    operation: string,
    input: PullRef,
  ) {
    const base = yield* repositoryPath(operation, input);
    const query = new URLSearchParams({ ref: `refs/pull/${input.number}/head` });
    return yield* read(
      operation,
      input,
      { path: `${base}/status?${query}` },
      Json.GiceCommitStatus,
    ).pipe(
      Effect.catchIf(
        (error) => error.reason === "not-found",
        () => Effect.succeed(null),
      ),
    );
  });

  const readFiles = Effect.fn("GicePullRequestProvider.readFiles")(function* (
    operation: string,
    input: PullRef & { readonly commit?: string | undefined; readonly path?: string | undefined },
  ) {
    const path =
      input.commit === undefined
        ? `${yield* pullPath(operation, input)}/files${
            input.path === undefined ? "" : `?${new URLSearchParams({ path: input.path })}`
          }`
        : `${yield* repositoryPath(operation, input)}/commits/${encodeURIComponent(input.commit)}`;
    return yield* read(operation, input, { path }, Json.GiceFiles);
  });

  const readAccess = Effect.fn("GicePullRequestProvider.readAccess")(function* (
    operation: string,
    input: ProviderRepositoryRef,
  ) {
    const base = yield* repositoryPath(operation, input);
    const [user, repository] = yield* Effect.all(
      [
        read(operation, input, { path: "/user" }, Json.GiceUser),
        read(operation, input, { path: base }, Json.GiceRepository),
      ],
      { concurrency: 2 },
    );
    return { viewer: user.username, permission: repository.permission };
  });

  const readBlob = Effect.fn("GicePullRequestProvider.readBlob")(function* (
    input: ProviderRepositoryRef,
    ref: string,
    path: string,
  ) {
    const operation = "getDiffFileContents";
    const base = yield* repositoryPath(operation, input);
    const query = new URLSearchParams({ ref, path });
    const blob = yield* read(operation, input, { path: `${base}/blob?${query}` }, Json.GiceBlob);
    if (blob.is_binary || blob.content === undefined)
      return yield* failure(operation, "Gice cannot provide this file as text.");
    return decodeBase64(blob.content);
  });

  const summarize = (
    pull: Json.GicePull,
    input: ProviderRepositoryRef,
    status: Json.GiceCommitStatus | null,
  ) => {
    // Line totals an older server leaves out stay absent rather than read as zero.
    const {
      additions: _additions,
      deletions: _deletions,
      ...summary
    } = Json.toChangeRequest(pull, input);
    const checksState = status === null ? null : Json.toChecks(status, input).state;
    return {
      ...summary,
      ...(status === null ? {} : { headSha: status.sha }),
      ...Json.toSummaryFields(pull),
      ...(checksState === null ? {} : { checksState }),
    };
  };

  const readViewerPermissions = Effect.fn("GicePullRequestProvider.readViewerPermissions")(
    function* (operation: string, input: PullRef, pull: Json.GicePull) {
      const features = yield* api.features(input.host);
      if (features.has("pull_viewer_permissions") && pull.viewer_permissions != null)
        return Json.toReportedViewerPermissions(pull, pull.viewer_permissions, features);
      return Json.toViewerPermissions(pull, yield* readAccess(operation, input));
    },
  );

  /** Fails the way Gice always has for what the server on this host cannot do. */
  const requireFeature = (
    operation: string,
    input: HostRef,
    feature: GiceApi.GiceFeature,
    detail: string,
  ) =>
    api
      .features(input.host)
      .pipe(
        Effect.flatMap((features) =>
          features.has(feature) ? Effect.void : Effect.fail(failure(operation, detail)),
        ),
      );

  /**
   * Gice writes the commit message unless it is given one, so removing agent credits starts from
   * its default. An older server does not say what that is, and it is rebuilt here: the title
   * for a merge commit, the commits' subjects for a squash.
   */
  const messageWithoutCredits = Effect.fn("GicePullRequestProvider.messageWithoutCredits")(
    function* (
      operation: string,
      input: PullRef,
      method: "merge" | "squash",
      features: GiceApi.GiceFeatures,
    ) {
      const path = yield* pullPath(operation, input);
      const [pull, body] = yield* Effect.all(
        [
          read(operation, input, { path }, Json.GicePull),
          features.has("pull_merge_message")
            ? read(
                operation,
                input,
                { path: `${path}/merge-message?method=${method}` },
                Json.GiceMergeMessage,
              ).pipe(Effect.map((answer) => answer.message))
            : method === "merge"
              ? Effect.succeed(null)
              : read(
                  operation,
                  input,
                  { path: `${path}/commits?per_page=${PAGE_SIZE}` },
                  Schema.Array(Json.GiceCommit),
                ).pipe(
                  Effect.map((commits) =>
                    commits
                      .toReversed()
                      .map((commit) => `* ${Json.toCommit(commit).messageHeadline}`)
                      .join("\n"),
                  ),
                ),
        ],
        { concurrency: 2 },
      );
      const message = body ?? pull.title;
      const cleaned = removeAgentCredits(message);
      return cleaned === message || !pull.head_sha
        ? null
        : { commit_message: cleaned, expected_head_sha: pull.head_sha };
    },
  );

  const provider: PullRequestProviderApi = {
    kind: KIND,
    capabilities: CAPABILITIES,
    capabilitiesOnHost: (host) => api.features(host).pipe(Effect.map(capabilitiesOf)),
    unavailableRequirement: UNAVAILABLE_REQUIREMENT,
    mergeMessageRewrite: removeAgentCredits,
    getViewer: (input) =>
      input.host === undefined
        ? unsupported("getViewer", "Gice needs the server's host to say who is signed in.")
        : read("getViewer", { host: input.host }, { path: "/user" }, Json.GiceUser).pipe(
            Effect.map((user) => user.username),
          ),
    listChangeRequests: Effect.fn("GicePullRequestProvider.listChangeRequests")(function* (input) {
      const features = yield* api.features(input.host);
      const reviewing = input.involvement === "reviewing";
      // An older server asks nobody to review.
      if (reviewing && !features.has("pull_reviewer_requests"))
        return { items: [], truncated: false, continues: false };
      const operation = "listChangeRequests";
      const base = yield* repositoryPath(operation, input);
      const limit = Math.max(1, input.limit);
      const viewer = input.viewer.trim().toLowerCase();
      const text = input.query?.trim() ?? "";
      const filtered = features.has("pull_filters");
      const searched = filtered && Buffer.byteLength(text) <= MAX_QUERY_BYTES;
      // The caller narrows whatever is not asked for here.
      const narrowing = new URLSearchParams();
      if (filtered) {
        const author =
          input.filters?.author === undefined
            ? input.involvement === "authored"
              ? input.viewer.trim()
              : ""
            : resolvePullRequestAuthorFilter(input.filters.author, input.viewer);
        if (author !== "") narrowing.set("author", author);
        if (input.filters?.draft !== undefined)
          narrowing.set("draft", String(input.filters.draft === "only"));
        if (searched) {
          // Only a search this side of the server needs the descriptions to match against.
          narrowing.set("fields", "summary");
          if (text !== "") narrowing.set("q", text);
        }
      }
      // Gice wants every label named; a group offering a choice is left to the caller.
      const labels = (input.filters?.labels ?? []).flatMap((group) =>
        group.length === 1 ? group : [],
      );
      if (labels.length > 0 && features.has("pull_labels_filter"))
        narrowing.set("labels", labels.join(","));
      // An older server lists every pull request, and the ones asking the viewer are picked here.
      const asked = reviewing && features.has("pull_review_requested_filter");
      if (asked) narrowing.set("review_requested", input.viewer.trim());
      const local = (reviewing && !asked) || (text !== "" && !searched);
      const kept = (pull: Json.GicePull) =>
        (!reviewing ||
          asked ||
          (pull.requested_reviewers ?? []).some(
            (user) => user.username.toLowerCase() === viewer,
          )) &&
        (searched || Json.matchesQuery(pull, text));
      // Gice lists newest number first and pages by offset, so a continuation reads from the top
      // and keeps the numbers below the last one delivered. An offset would skip a row for
      // every row above it that left the listing in between.
      const resume = Number(input.cursor?.resumeAfter);
      const continuing = Number.isSafeInteger(resume) && resume > 0;
      const pageSize = continuing || local ? PAGE_SIZE : Math.min(PAGE_SIZE, limit + 1);
      const items: Array<Json.GicePull> = [];
      let more = true;
      for (let page = 1; more && items.length <= limit && page <= MAX_PAGES; page++) {
        const query = new URLSearchParams({
          state: input.state,
          per_page: String(pageSize),
          page: String(page),
        });
        for (const [name, value] of narrowing) query.set(name, value);
        const batch = yield* read(
          operation,
          input,
          { path: `${base}/pulls?${query}` },
          Schema.Array(Json.GicePull),
        );
        items.push(...batch.filter((pull) => (!continuing || pull.number < resume) && kept(pull)));
        more = batch.length === pageSize;
      }
      const delivered = items.slice(0, limit);
      const last = delivered.at(-1);
      return {
        items: delivered.map((pull) => Json.toChangeRequest(pull, input)),
        truncated: more || items.length > limit,
        continues: true,
        ...(last === undefined ? {} : { resumeAfter: String(last.number) }),
      };
    }),
    getChangeRequestPreview: (input) =>
      readPull("getChangeRequestPreview", input).pipe(
        Effect.map((pull) => Json.toChangeRequest(pull, input)),
      ),
    getChangeRequestSummary: Effect.fn("GicePullRequestProvider.getChangeRequestSummary")(
      function* (input) {
        const operation = "getChangeRequestSummary";
        const [pull, status] = yield* Effect.all(
          [readPull(operation, input), readStatus(operation, input)],
          { concurrency: 2 },
        );
        return summarize(pull, input, status);
      },
    ),
    getChangeRequestChecks: Effect.fn("GicePullRequestProvider.getChangeRequestChecks")(
      function* (input) {
        const operation = "getChangeRequestChecks";
        const [pull, status] = yield* Effect.all(
          [readPull(operation, input), readStatus(operation, input)],
          { concurrency: 2 },
        );
        return {
          state: pull.state,
          checks: status === null ? [] : Json.toChecks(status, input).checks,
        };
      },
    ),
    getChangeRequest: Effect.fn("GicePullRequestProvider.getChangeRequest")(function* (input) {
      const operation = "getChangeRequest";
      const features = yield* api.features(input.host);
      const [pull, status, files] = yield* Effect.all(
        [
          readPull(operation, input),
          readStatus(operation, input),
          // An older server gives line totals only with the files; the pull request stands
          // without them.
          features.has("pull_stats")
            ? Effect.succeed(null)
            : readFiles(operation, input).pipe(Effect.orElseSucceed(() => null)),
        ],
        { concurrency: 3 },
      );
      const checks = status === null ? null : Json.toChecks(status, input);
      return {
        ...Json.toChangeRequest(pull, input),
        ...Json.toDetailFields(pull),
        headSha: pull.head_sha || (status?.sha ?? null),
        additions:
          pull.additions ?? files?.files.reduce((total, file) => total + file.additions, 0) ?? 0,
        deletions:
          pull.deletions ?? files?.files.reduce((total, file) => total + file.deletions, 0) ?? 0,
        changedFiles: pull.changed_files ?? files?.files.length ?? 0,
        reviewers: Json.requestedReviewers(pull),
        checks: checks?.checks ?? [],
        ...(checks == null || checks.state === null ? {} : { checksState: checks.state }),
        // Gice offers every method on every repository and refuses a rebase it cannot replay.
        mergeCapabilities: { merge: true, squash: true, rebase: true },
        viewerPermissions: yield* readViewerPermissions(operation, input, pull),
      };
    }),
    getChangeRequestActivity: Effect.fn("GicePullRequestProvider.getChangeRequestActivity")(
      function* (input) {
        const operation = "getChangeRequestActivity";
        const base = yield* repositoryPath(operation, input);
        const features = yield* api.features(input.host);
        const pulls = `${base}/pulls/${input.number}`;
        const none = Effect.succeed({ items: [], truncated: false });
        const [comments, commits, reviews, threads, pull] = yield* Effect.all(
          [
            readPages(
              operation,
              input,
              `${base}/issues/${input.number}/comments`,
              Json.GiceComment,
            ),
            readPages(operation, input, `${pulls}/commits`, Json.GiceCommit),
            features.has("pull_reviews")
              ? readPages(operation, input, `${pulls}/reviews`, Json.GiceReview)
              : none,
            features.has("pull_review_threads")
              ? readPages(operation, input, `${pulls}/threads`, Json.GiceReviewThread)
              : none,
            // The description's reactions and the people asked to review are on the pull request.
            features.has("reactions") || features.has("pull_reviewer_requests")
              ? readPull(operation, input)
              : Effect.succeed(null),
          ],
          { concurrency: 5 },
        );
        const remarks = [...comments.items.map(Json.toComment), ...Json.toReviews(reviews.items)];
        const reviewers = new Map(
          [
            ...(pull === null ? [] : Json.requestedReviewers(pull)),
            ...remarks.flatMap((remark) =>
              remark.kind === "review" && remark.author !== null ? [remark.author] : [],
            ),
          ].map((actor) => [actor.login, actor]),
        );
        return {
          ...(pull === null ? {} : { reviewers: [...reviewers.values()] }),
          comments: remarks.toSorted((left, right) =>
            left.createdAt.localeCompare(right.createdAt),
          ),
          commentCount: remarks.length,
          commentsTruncated: comments.truncated || reviews.truncated,
          reviewThreads: Json.toReviewThreads(threads.items),
          reviewThreadsTruncated: threads.truncated,
          // Gice lists a pull request's commits newest first.
          commits: commits.items.map(Json.toCommit).toReversed(),
          ...(pull === null ? {} : { reactions: Json.toReactions(pull) }),
        };
      },
    ),
    getViewerPermissions: Effect.fn("GicePullRequestProvider.getViewerPermissions")(
      function* (input) {
        const operation = "getViewerPermissions";
        return yield* readViewerPermissions(operation, input, yield* readPull(operation, input));
      },
    ),
    getChangeRequestWatchFingerprint: Effect.fn(
      "GicePullRequestProvider.getChangeRequestWatchFingerprint",
    )(function* (input) {
      const operation = "getChangeRequestWatchFingerprint";
      if (!(yield* api.features(input.host)).has("events")) return null;
      const base = yield* repositoryPath(operation, input);
      return Json.toWatchFingerprint(
        yield* read(
          operation,
          input,
          { path: `${base}/events?pull=${input.number}&limit=${PAGE_SIZE}` },
          Json.GiceEvents,
        ),
      );
    }),
    changeRequestEvents: (input) => {
      const operation = "changeRequestEvents";
      // Without a cursor Gice answers at once with the newest event, which is where to wait from.
      const poll = (base: string, since: number | null) =>
        read(
          operation,
          input,
          {
            path: `${base}/events?pull=${input.number}&${
              since === null ? "limit=1" : `since=${since}&wait=${EVENTS_WAIT_SECONDS}`
            }`,
          },
          Json.GiceEvents,
        );
      return Stream.unwrap(
        Effect.gen(function* () {
          if (!(yield* api.features(input.host)).has("events")) return Stream.empty;
          const base = yield* repositoryPath(operation, input);
          return Stream.paginate(null as number | null, (since) =>
            poll(base, since).pipe(
              Effect.map(
                (feed) =>
                  [
                    since === null || feed.events.length > 0 ? [undefined] : [],
                    Option.some<number | null>(feed.cursor),
                  ] as const,
              ),
              // A feed that stops answering ends, and its readers go back to polling.
              Effect.orElseSucceed(() => [[], Option.none<number | null>()] as const),
            ),
          );
        }).pipe(Effect.orElseSucceed(() => Stream.empty)),
      );
    },
    getDiff: Effect.fn("GicePullRequestProvider.getDiff")(function* (input) {
      const paged = (yield* api.features(input.host)).has("pull_file_paging");
      // A commit's own diff has no per-file read.
      if (input.path !== undefined && (!paged || input.commit !== undefined))
        return yield* failure("getDiff", "Gice cannot read one file of this diff.");
      return Json.toDiff(
        yield* readFiles("getDiff", input),
        paged && input.commit === undefined && input.path === undefined,
      );
    }),
    getDiffFilePaths: (input) =>
      readFiles("getDiffFilePaths", input).pipe(
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
        const base = yield* repositoryPath(operation, input);
        let sides: { readonly old: string | undefined; readonly new: string };
        if (input.commit !== undefined) {
          const commit = yield* read(
            operation,
            input,
            { path: `${base}/commits/${encodeURIComponent(input.commit)}` },
            Json.GiceCommit,
          );
          sides = { old: commit.parents?.[0], new: commit.sha };
        } else {
          const pull = yield* readPull(operation, input);
          // Revisions list oldest first, and the newest one holds the head with its merge base.
          const query = new URLSearchParams({
            per_page: "1",
            page: String(pull.revisions_count ?? 1),
          });
          const [revision] = yield* read(
            operation,
            input,
            { path: `${base}/pulls/${input.number}/revisions?${query}` },
            Schema.Array(Json.GiceRevision),
          );
          if (revision === undefined)
            return yield* failure(operation, "Gice has no commits for this pull request.");
          sides = { old: revision.base_sha, new: revision.head_sha };
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
      readFiles("getFileStats", input).pipe(
        Effect.map((diff) => ({
          files: diff.files.map(({ path, additions, deletions }) => ({
            path,
            additions,
            deletions,
          })),
          truncated: false,
        })),
      ),
    getFileRevisions: (input) =>
      input.paths.length === 0
        ? Effect.succeed({ revisions: new Map(), complete: false })
        : readFiles("getFileRevisions", input).pipe(
            Effect.map((diff) => Json.toFileRevisions(diff, input.paths)),
          ),
    getCheckLogs: Effect.fn("GicePullRequestProvider.getCheckLogs")(function* (input) {
      const operation = "getCheckLogs";
      const base = yield* repositoryPath(operation, input);
      return yield* Effect.forEach(
        input.checks,
        (check): Effect.Effect<ProviderCheckLog, PullRequestProviderError> => {
          const run = Json.runNumberOf(check.url);
          if (run === null)
            return Effect.succeed({
              ...check,
              log: null,
              truncated: false,
              detail: "Gice holds no log for this check.",
            });
          return Effect.gen(function* () {
            const job = Json.jobIdOf(check.url);
            if (job !== null) {
              // One line more than asked for says whether the log goes back further.
              const tail = Math.min(Math.max(1, input.tailLines) + 1, MAX_TAIL_LINES);
              const log = yield* send(operation, input, {
                path: `${base}/runs/${run}/jobs/${job}/logs?tail=${tail}`,
              });
              return { ...check, ...tailLogLines(log, input.tailLines), detail: null };
            }
            const { jobs } = yield* read(
              operation,
              input,
              { path: `${base}/runs/${run}` },
              Json.GiceRunJobs,
            );
            // A check is a whole run; the jobs that failed are the ones worth reading.
            const failed = jobs.filter(
              (job) => job.conclusion === "failure" || job.conclusion === "cancelled",
            );
            const logs = yield* Effect.forEach(
              failed.length > 0 ? failed : jobs,
              (job) =>
                send(operation, input, { path: `${base}/runs/${run}/jobs/${job.id}/logs` }).pipe(
                  Effect.map((log) => `==> ${job.name} <==\n${log}`),
                ),
              { concurrency: 2 },
            );
            if (logs.length === 0)
              return { ...check, log: null, truncated: false, detail: "This run has no jobs." };
            return { ...check, ...tailLogLines(logs.join("\n"), input.tailLines), detail: null };
          }).pipe(
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
      const base = yield* repositoryPath("rerunChecks", input);
      const outcomes = new Map<number, string | null>();
      yield* Effect.forEach(
        new Set(input.checks.flatMap((check) => Json.runNumberOf(check.url) ?? [])),
        (run) =>
          send("rerunChecks", input, { method: "POST", path: `${base}/runs/${run}/rerun` }).pipe(
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
      const path = yield* pullPath(action, input);
      const features = yield* api.features(input.host);
      const cannot = failure(action, `Gice cannot ${action} a pull request.`);
      if (action === "revert" || action === "approve-workflows") return yield* cannot;
      if (action !== "merge" && action !== "close" && action !== "reopen") {
        if (!features.has(FEATURE_OF_ACTION[action])) return yield* cannot;
      }
      if (input.mergeMethod === "fast-forward")
        return yield* failure(action, "Gice has no fast-forward merge.");
      const method = input.mergeMethod ?? "merge";
      const options = features.has("pull_merge_options");
      // The message is Gice's to write for a rebase, which keeps each commit's own.
      const message =
        (action === "merge" || action === "enable-auto-merge") &&
        input.removeAgentCreditsOnMerge === true &&
        options &&
        method !== "rebase"
          ? yield* messageWithoutCredits(action, input, method, features)
          : null;
      const pinned =
        options && input.expectedHeadSha !== undefined && SHA.test(input.expectedHeadSha)
          ? { expected_head_sha: input.expectedHeadSha }
          : {};
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
              ...(features.has("pull_auto_merge_expected_head") ? pinned : {}),
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
        case "delete-branch":
          // Gice answers a deleted branch with no body to read.
          return yield* send(action, input, { method: "DELETE", path: `${path}/head-branch` }).pipe(
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
      return summarize(pull, input, null);
    }),
    updateChangeRequest: Effect.fn("GicePullRequestProvider.updateChangeRequest")(
      function* (input) {
        const path = yield* pullPath("updateChangeRequest", input);
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
      const base = yield* repositoryPath("comment", input);
      yield* send("comment", input, {
        method: "POST",
        path: `${base}/issues/${input.number}/comments`,
        body: { body: input.body },
      });
    }),
    updateComment: Effect.fn("GicePullRequestProvider.updateComment")(function* (input) {
      const operation = "updateComment";
      const inline =
        input.kind === "review-comment" ? Json.reviewCommentIdOf(input.commentId) : null;
      if (inline === null && (input.kind !== "issue-comment" || !COMMENT_ID.test(input.commentId)))
        return yield* noSuchComment(operation);
      if (inline !== null && !(yield* api.features(input.host)).has("pull_review_comments"))
        return yield* noSuchComment(operation);
      const base = yield* repositoryPath(operation, input);
      yield* send(operation, input, {
        method: "PATCH",
        path:
          inline === null
            ? `${base}/comments/${input.commentId}`
            : `${base}/pulls/comments/${inline}`,
        body: { body: input.body },
      });
    }),
    submitReview: Effect.fn("GicePullRequestProvider.submitReview")(function* (input) {
      const operation = "submitReview";
      yield* requireFeature(
        operation,
        input,
        "pull_reviews",
        "Gice has no pull request reviews. Leave a comment instead.",
      );
      if (input.comments.length > 0)
        yield* requireFeature(
          operation,
          input,
          "pull_review_comments",
          "Gice cannot comment on a line of a pull request.",
        );
      // Without `commit_id` Gice records the review against the head it has now.
      yield* send(operation, input, {
        method: "POST",
        path: `${yield* pullPath(operation, input)}/reviews`,
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
        yield* requireFeature(operation, input, "pull_reviewer_requests", NO_REVIEWERS);
        const path = yield* pullPath(operation, input);
        const query = new URLSearchParams({ per_page: String(PAGE_SIZE) });
        if (input.query?.trim()) query.set("q", input.query.trim());
        // Gice leaves the author out of the candidates itself.
        const [pull, users] = yield* Effect.all(
          [
            read(operation, input, { path }, Json.GicePull),
            read(
              operation,
              input,
              { path: `${path}/reviewer-candidates?${query}` },
              Schema.Array(Json.GiceUser),
            ),
          ],
          { concurrency: 2 },
        );
        const requested = new Set(
          (pull.requested_reviewers ?? []).map((user) => user.username.toLowerCase()),
        );
        return {
          candidates: users.map((user) => Json.toReviewerCandidate(user, requested)),
          truncated: users.length >= PAGE_SIZE,
        };
      },
    ),
    setReviewerRequest: Effect.fn("GicePullRequestProvider.setReviewerRequest")(function* (input) {
      const operation = "setReviewerRequest";
      yield* requireFeature(operation, input, "pull_reviewer_requests", NO_REVIEWERS);
      if (input.reviewers.some((reviewer) => reviewer.kind !== "user"))
        return yield* failure(operation, "Gice has no teams to ask for a review.");
      yield* send(operation, input, {
        method: input.requested ? "POST" : "DELETE",
        path: `${yield* pullPath(operation, input)}/requested_reviewers`,
        body: { reviewers: input.reviewers.map((reviewer) => reviewer.id) },
      });
    }),
    listLabelCandidates: Effect.fn("GicePullRequestProvider.listLabelCandidates")(
      function* (input) {
        const operation = "listLabelCandidates";
        yield* requireFeature(operation, input, "labels", NO_LABELS);
        const base = yield* repositoryPath(operation, input);
        const [labels, applied] = yield* Effect.all(
          [
            readPages(operation, input, `${base}/labels`, Json.GiceLabel),
            readPages(operation, input, `${base}/issues/${input.number}/labels`, Json.GiceLabel),
          ],
          { concurrency: 2 },
        );
        const held = new Set(applied.items.map((label) => label.name.toLowerCase()));
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
        if (!(yield* api.features(input.host)).has("labels"))
          return { items: [], truncated: false };
        const base = yield* repositoryPath(operation, input);
        const labels = yield* readPages(operation, input, `${base}/labels`, Json.GiceLabel);
        return { items: labels.items.map(Json.toLabel), truncated: labels.truncated };
      },
    ),
    searchRepositoryAuthors: Effect.fn("GicePullRequestProvider.searchRepositoryAuthors")(
      function* (input) {
        const operation = "searchRepositoryAuthors";
        const base = yield* repositoryPath(operation, input);
        const collaborators = yield* readPages(
          operation,
          input,
          `${base}/collaborators`,
          Json.GiceCollaborator,
        );
        // The owner is not a collaborator of their own repository.
        const owner = input.repository.split("/")[0]!;
        const query = input.query?.trim().toLowerCase() ?? "";
        return {
          items: [
            { login: owner, name: null, avatarUrl: null },
            ...collaborators.items.map((collaborator) => Json.toActor(collaborator.user)),
          ].filter(
            (actor) =>
              actor.login.toLowerCase().includes(query) ||
              actor.name?.toLowerCase().includes(query) === true,
          ),
          truncated: collaborators.truncated,
        };
      },
    ),
    setLabels: Effect.fn("GicePullRequestProvider.setLabels")(function* (input) {
      const operation = "setLabels";
      yield* requireFeature(operation, input, "labels", NO_LABELS);
      const path = `${yield* repositoryPath(operation, input)}/issues/${input.number}/labels`;
      if (input.applied)
        return yield* send(operation, input, {
          method: "POST",
          path,
          body: { labels: input.labels },
        }).pipe(Effect.asVoid);
      // Gice takes labels off one at a time, and answers 404 for one that is already off.
      yield* Effect.forEach(
        input.labels,
        (label) =>
          send(operation, input, {
            method: "DELETE",
            path: `${path}/${encodeURIComponent(label)}`,
          }).pipe(
            Effect.catchIf(
              (error) => error.reason === "not-found",
              () => Effect.void,
            ),
          ),
        { concurrency: 1, discard: true },
      );
    }),
    replyToThread: Effect.fn("GicePullRequestProvider.replyToThread")(function* (input) {
      const operation = "replyToThread";
      yield* requireFeature(operation, input, "pull_review_threads", NO_THREADS);
      const thread = Json.threadIdParts(input.threadId);
      if (thread === null) return yield* failure(operation, "Gice has no such review thread.");
      yield* send(operation, input, {
        method: "POST",
        path: `${yield* pullPath(operation, input)}/comments/${thread.comment}/replies`,
        body: { body: input.body },
      });
    }),
    setReaction: Effect.fn("GicePullRequestProvider.setReaction")(function* (input) {
      const operation = "setReaction";
      yield* requireFeature(operation, input, "reactions", "Gice has no reactions.");
      const base = yield* repositoryPath(operation, input);
      const inline = input.subjectId === undefined ? null : Json.reviewCommentIdOf(input.subjectId);
      if (inline !== null)
        yield* requireFeature(
          operation,
          input,
          "review_comment_reactions",
          "Gice has no reactions on line comments.",
        );
      if (input.subjectId !== undefined && inline === null && !COMMENT_ID.test(input.subjectId))
        return yield* failure(
          operation,
          Json.isReviewId(input.subjectId)
            ? "Gice has no reactions on reviews."
            : "Gice has no such comment.",
        );
      const path = `${
        input.subjectId === undefined
          ? `${base}/issues/${input.number}`
          : inline === null
            ? `${base}/comments/${input.subjectId}`
            : `${base}/pulls/comments/${inline}`
      }/reactions`;
      const content = Json.reactionContent(input.content);
      if (!input.reacted && (yield* api.features(input.host)).has("reaction_delete_by_content"))
        // Gice answers 404 for a reaction that is already gone.
        return yield* send(operation, input, {
          method: "DELETE",
          path: `${path}?content=${encodeURIComponent(content)}`,
        }).pipe(
          Effect.asVoid,
          Effect.catchIf(
            (error) => error.reason === "not-found",
            () => Effect.void,
          ),
        );
      // On an older server reacting again answers with the reaction already there, which is how
      // to find the id of the one to take back.
      const reaction = yield* read(
        operation,
        input,
        { method: "POST", path, body: { content } },
        Json.GiceReaction,
      );
      if (!input.reacted)
        yield* send(operation, input, { method: "DELETE", path: `${path}/${reaction.id}` });
    }),
    setThreadResolution: Effect.fn("GicePullRequestProvider.setThreadResolution")(
      function* (input) {
        const operation = "setThreadResolution";
        yield* requireFeature(operation, input, "pull_review_threads", NO_THREADS);
        const thread = Json.threadIdParts(input.threadId);
        if (thread === null) return yield* failure(operation, "Gice has no such review thread.");
        const base = yield* repositoryPath(operation, input);
        yield* send(operation, input, {
          method: input.resolved ? "PUT" : "DELETE",
          path: `${base}/pulls/threads/${thread.thread}/resolution`,
        });
      },
    ),
  };
  return provider;
});
