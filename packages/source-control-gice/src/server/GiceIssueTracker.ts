/** Gice's issue tracker over its REST API. Every cursor names a page. */
import { IssueTrackerKind, type IssueCapabilities } from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueScopeTarget,
  type IssueTrackerApi,
} from "@t3tools/source-control-core/server/IssueTracker";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { definition } from "../shared/definition.ts";
import * as GiceApi from "./GiceApi.ts";
import {
  GiceIssue,
  GiceIssueFeed,
  ISSUE_STATES,
  TIMELINE_EVENT_TYPES,
  toIssueComment,
  toIssueEvents,
  toIssueSummary,
  toIssueViewerPermissions,
  toLinkedPullRequests,
} from "./giceIssueJson.ts";
import {
  GiceComment,
  GiceLabel,
  GiceTemplate,
  GiceUser,
  reactionContent,
  toActor,
  toLabel,
  toReactions,
} from "./gicePullRequestJson.ts";

const KIND = IssueTrackerKind.make(definition.kind);

const CAPABILITIES: IssueCapabilities = {
  create: true,
  edit: true,
  comment: true,
  labels: true,
  assignees: true,
  reactions: true,
  templates: true,
  linkedPullRequests: true,
  events: true,
  search: true,
};

const PAGE_SIZE = 50;
/** Gice's largest page. */
const MAX_PAGE_SIZE = 100;
const NUMBER = /^[1-9]\d*$/u;

type Target = { readonly host: string; readonly scope?: string };

function parsePage(cursor: string | undefined): number | null {
  if (cursor === undefined) return 1;
  return /^[1-9]\d{0,6}$/u.test(cursor) ? Number(cursor) : null;
}

/** `<page>:<per_page>`, so a later call asking for another limit keeps the pages it started. */
function parseListCursor(cursor: string, operation: string) {
  const match = /^([1-9]\d{0,6}):([1-9]\d{0,2})$/u.exec(cursor);
  return match === null || Number(match[2]) > MAX_PAGE_SIZE
    ? Effect.fail(refused(operation, "The cursor was not one Gice handed out."))
    : Effect.succeed({ page: Number(match[1]), perPage: Number(match[2]) });
}

const INVOLVEMENT_PARAM = {
  authored: "author",
  assigned: "assignee",
  mentioned: "mentioned",
} as const;

function reasonFor(reason: GiceApi.GiceApiError["reason"]): IssueTrackerError["reason"] {
  return reason === "forbidden" ? "failed" : reason;
}

const refused = (operation: string, detail: string, cause?: unknown) =>
  new IssueTrackerError({
    tracker: KIND,
    operation,
    reason: "failed",
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

const notFound = (operation: string, detail = "Gice has no such issue.") =>
  new IssueTrackerError({ tracker: KIND, operation, reason: "not-found", detail });

export const make = Effect.gen(function* () {
  const api = yield* GiceApi.GiceApi;

  const { send, read, readList } = GiceApi.targetRequests(api, {
    repositoryOf: (target: Target) => target.scope,
    mapError: (operation) => (error) =>
      new IssueTrackerError({
        tracker: KIND,
        operation,
        reason: reasonFor(error.reason),
        detail: error.detail,
        ...(error.retryAt === undefined ? {} : { retryAt: error.retryAt }),
        cause: error,
      }),
  });

  const issuePath = (
    operation: string,
    target: IssueScopeTarget & { readonly key: string },
  ): Effect.Effect<string, IssueTrackerError> =>
    NUMBER.test(target.key)
      ? Effect.succeed(`/issues/${target.key}`)
      : Effect.fail(notFound(operation));

  const getViewer = (operation: string, target: Target) =>
    read(operation, { host: target.host }, { path: "/user" }, GiceUser).pipe(
      Effect.map((user) => user.username),
    );

  /** The issues routes answer for a pull request's number too; that is not an issue here. */
  const readIssue = (operation: string, target: Target, path: string) =>
    read(operation, target, { path }, GiceIssue).pipe(
      Effect.filterOrFail(
        (issue) => !issue.is_pull,
        (issue) => notFound(operation, `#${issue.number} is a pull request on Gice, not an issue.`),
      ),
    );

  const commentsPage = (operation: string, target: Target, path: string, page: number) =>
    read(
      operation,
      target,
      { path: `${path}/comments?per_page=${PAGE_SIZE}&page=${page}` },
      Schema.Array(GiceComment),
    ).pipe(
      // A page past the last is a cursor the conversation has outlived.
      Effect.map((comments) => ({
        comments: comments.map(toIssueComment),
        nextCursor: page > 1 && comments.length > 0 ? String(page - 1) : null,
      })),
    );

  const tracker: IssueTrackerApi = {
    kind: KIND,
    capabilities: CAPABILITIES,

    getViewer: (input) => getViewer("getViewer", input),

    listIssues: Effect.fn("GiceIssueTracker.listIssues")(function* (input) {
      const operation = "listIssues";
      const { page, perPage } =
        input.cursor === undefined
          ? { page: 1, perPage: Math.min(Math.max(1, input.limit), MAX_PAGE_SIZE) }
          : yield* parseListCursor(input.cursor, operation);
      const params = new URLSearchParams({
        state: input.state,
        sort: input.sort,
        per_page: String(perPage),
        page: String(page),
      });
      const labels = input.labels ?? [];
      if (labels.length > 0) params.set("labels", labels.join(","));
      const text = input.query?.trim() ?? "";
      if (text !== "") params.set("q", text);
      if (input.involvement !== "all")
        params.set(INVOLVEMENT_PARAM[input.involvement], input.viewer);
      if (input.assignee !== undefined) params.set("assignee", input.assignee);
      // `assignee` names one person, so "assigned to me" is kept here beside a named assignee.
      const alsoAssignedTo =
        input.involvement === "assigned" && input.assignee !== undefined
          ? input.viewer.toLowerCase()
          : null;
      const listed = yield* readList(operation, input, { path: `/issues?${params}` }, GiceIssue);
      return {
        items: listed.items
          .filter(
            (issue) =>
              alsoAssignedTo === null ||
              issue.assignees.some((user) => user.username.toLowerCase() === alsoAssignedTo),
          )
          .map(toIssueSummary),
        nextCursor: GiceApi.listContinues(
          listed,
          (page - 1) * perPage + listed.items.length,
          perPage,
        )
          ? `${page + 1}:${perPage}`
          : null,
      };
    }),

    getIssue: Effect.fn("GiceIssueTracker.getIssue")(function* (input) {
      const operation = "getIssue";
      const path = yield* issuePath(operation, input);
      const [issue, viewer, feed] = yield* Effect.all(
        [
          readIssue(operation, input, path),
          getViewer(operation, input),
          read(
            operation,
            input,
            {
              path: `/events?issue=${input.key}&types=${TIMELINE_EVENT_TYPES}&limit=${MAX_PAGE_SIZE}`,
            },
            GiceIssueFeed,
          ),
        ],
        { concurrency: 3 },
      );
      // The newest comments come first; older pages are read back towards the first.
      const conversation =
        issue.comments_count === 0
          ? { comments: [], nextCursor: null }
          : yield* commentsPage(
              operation,
              input,
              path,
              Math.ceil(issue.comments_count / PAGE_SIZE),
            );
      return {
        ...toIssueSummary(issue),
        body: issue.body,
        viewer,
        viewerPermissions: toIssueViewerPermissions(issue),
        states: ISSUE_STATES,
        reactions: toReactions(issue),
        comments: conversation.comments,
        commentsCursor: conversation.nextCursor,
        events: toIssueEvents(feed.events),
        linkedPullRequests: toLinkedPullRequests(issue, input.scope),
      };
    }),

    getComments: Effect.fn("GiceIssueTracker.getComments")(function* (input) {
      const operation = "getComments";
      const page = parsePage(input.cursor);
      if (page === null)
        return yield* refused(operation, "The cursor was not one Gice handed out.");
      return yield* commentsPage(operation, input, yield* issuePath(operation, input), page);
    }),

    create: Effect.fn("GiceIssueTracker.create")(function* (input) {
      const operation = "create";
      const issue = yield* read(
        operation,
        input,
        {
          method: "POST",
          path: "/issues",
          body: {
            title: input.title,
            body: input.body,
            labels: input.labels,
            assignees: input.assignees,
          },
        },
        GiceIssue,
      );
      return { key: String(issue.number), displayKey: `#${issue.number}`, url: issue.html_url };
    }),

    comment: Effect.fn("GiceIssueTracker.comment")(function* (input) {
      const operation = "comment";
      yield* send(operation, input, {
        method: "POST",
        path: `${yield* issuePath(operation, input)}/comments`,
        body: { body: input.body },
      });
    }),

    update: Effect.fn("GiceIssueTracker.update")(function* (input) {
      const operation = "update";
      const path = yield* issuePath(operation, input);
      if (input.title !== undefined || input.body !== undefined) {
        yield* send(operation, input, {
          method: "PATCH",
          path,
          body: {
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.body === undefined ? {} : { body: input.body }),
          },
        });
      }
      if (input.labels !== undefined) {
        yield* send(operation, input, {
          method: "PUT",
          path: `${path}/labels`,
          body: { labels: input.labels },
        });
      }
      if (input.assignees !== undefined) {
        // Gice adds and removes assignees by name, so the whole set is written as the difference.
        const current = (yield* readIssue(operation, input, path)).assignees.map(
          (user) => user.username,
        );
        const wanted = new Set(input.assignees.map((login) => login.toLowerCase()));
        const held = new Set(current.map((login) => login.toLowerCase()));
        const added = input.assignees.filter((login) => !held.has(login.toLowerCase()));
        const removed = current.filter((login) => !wanted.has(login.toLowerCase()));
        if (added.length > 0) {
          yield* send(operation, input, {
            method: "POST",
            path: `${path}/assignees`,
            body: { assignees: added },
          });
        }
        if (removed.length > 0) {
          yield* send(operation, input, {
            method: "DELETE",
            path: `${path}/assignees`,
            body: { assignees: removed },
          });
        }
      }
    }),

    setState: Effect.fn("GiceIssueTracker.setState")(function* (input) {
      const operation = "setState";
      const wanted = ISSUE_STATES.find((state) => state.name === input.state);
      if (wanted === undefined)
        return yield* refused(operation, `A Gice issue has no "${input.state}" state.`);
      yield* send(operation, input, {
        method: "PATCH",
        path: yield* issuePath(operation, input),
        body: { state: wanted.category },
      });
    }),

    setReaction: Effect.fn("GiceIssueTracker.setReaction")(function* (input) {
      const operation = "setReaction";
      if (input.subjectId !== undefined && !NUMBER.test(input.subjectId))
        return yield* refused(operation, "Gice has no such comment.");
      const path = `${
        input.subjectId === undefined
          ? yield* issuePath(operation, input)
          : `/comments/${input.subjectId}`
      }/reactions`;
      const content = reactionContent(input.content);
      if (input.reacted) {
        yield* send(operation, input, { method: "POST", path, body: { content } });
        return;
      }
      yield* send(operation, input, {
        method: "DELETE",
        path: `${path}?content=${encodeURIComponent(content)}`,
      }).pipe(Effect.catchIf(GiceApi.isAlreadyOff, () => Effect.succeed("")));
    }),

    // Gice reads the default branch's templates, and has no issue forms or `config.yml`.
    listTemplates: Effect.fn("GiceIssueTracker.listTemplates")(function* (input) {
      const templates = yield* read(
        "listTemplates",
        input,
        { path: "/templates?kind=issue" },
        Schema.Array(GiceTemplate),
      );
      return {
        templates: templates.map(({ path, name, about, title, body, labels, assignees }) => ({
          key: path,
          name,
          about,
          title,
          body,
          labels,
          assignees,
        })),
        blankIssuesEnabled: true,
      };
    }),

    listCandidates: Effect.fn("GiceIssueTracker.listCandidates")(function* (input) {
      const operation = "listCandidates";
      const page = `per_page=${MAX_PAGE_SIZE}`;
      const [labels, users] = yield* Effect.all(
        [
          readList(operation, input, { path: `/labels?${page}` }, GiceLabel),
          readList(operation, input, { path: `/assignee-candidates?${page}` }, GiceUser),
        ],
        { concurrency: 2 },
      );
      return {
        labels: labels.items.map((label) => ({
          ...toLabel(label),
          description: label.description || null,
        })),
        assignees: users.items.map((user) => ({ ...toActor(user), id: user.username })),
        truncated: [labels, users].some((list) =>
          GiceApi.listContinues(list, list.items.length, MAX_PAGE_SIZE),
        ),
      };
    }),
  };
  return tracker;
});
