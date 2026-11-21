/**
 * A Gice server for tests: the real GiceApi and credentials over a fake HttpClient. The builders
 * below answer with every field the Go server's objects carry (`internal/api/objects.go`), so a
 * decoder that reads a field the server does not send fails here first.
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as GiceApi from "./GiceApi.ts";
import * as GiceAppSignIn from "./GiceAppSignIn.ts";
import * as GiceCredentials from "./GiceCredentials.ts";

export const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const HOST = "code.example";

export interface SentRequest {
  readonly method: string;
  readonly url: string;
  /** Below `/api/v1`, with the query string. */
  readonly path: string;
  readonly authorization: string | undefined;
  readonly redirect: RequestRedirect | undefined;
  readonly body: unknown;
}

/** A route's answer for a request that never reached the server. */
export const UNREACHABLE: unique symbol = Symbol("unreachable");
/** A route's answer for a server that takes the request and never answers. */
export const STALLED: unique symbol = Symbol("stalled");

type Route = unknown | Response | ((request: SentRequest) => unknown);

const notFound = () => problem(404, "not_found", "not found");

/**
 * Routes are `METHOD /path?query` below `/api/v1`. A route named without its query answers any
 * query, and a missing route answers 404. A route answers with JSON, text, a `Response`, or a
 * function of the request returning one of those.
 */
export function fakeGiceServer(
  routes: Record<string, Route>,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly files?: Readonly<Record<string, string>>;
    readonly git?: Partial<SourceControlHost.SourceControlHost["Service"]["git"]>;
    readonly process?: Partial<SourceControlHost.SourceControlHost["Service"]["process"]>;
  } = {},
) {
  const sent: Array<SentRequest> = [];
  const files = options.files ?? { "/tmp/body.md": "Body" };
  const client = HttpClient.make((request, _url, _signal, fiber) => {
    const url = new URL(request.url);
    const entry: SentRequest = {
      method: request.method,
      url: request.url,
      path: `${url.pathname.replace(/^\/api\/v1/u, "")}${url.search}`,
      authorization: request.headers.authorization,
      redirect: Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)?.redirect,
      body:
        request.body._tag !== "Uint8Array"
          ? undefined
          : request.body.contentType === "application/x-www-form-urlencoded"
            ? Object.fromEntries(new URLSearchParams(new TextDecoder().decode(request.body.body)))
            : decodeJson(new TextDecoder().decode(request.body.body)),
    };
    sent.push(entry);
    const route =
      routes[`${entry.method} ${entry.path}`] ??
      routes[`${entry.method} ${url.pathname.replace(/^\/api\/v1/u, "")}`];
    const answer = typeof route === "function" ? route(entry) : route;
    if (answer === STALLED) return Effect.never;
    if (answer === UNREACHABLE)
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: new Error("unreachable") }),
        }),
      );
    const response =
      answer === undefined
        ? notFound()
        : answer instanceof Response
          ? answer
          : new Response(typeof answer === "string" ? answer : encodeJson(answer));
    return Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });
  const layer = GiceApi.layer.pipe(
    Layer.provideMerge(GiceCredentials.layer),
    Layer.provideMerge(GiceAppSignIn.layer),
    Layer.provideMerge(SourceControlRateLimit.layer),
    Layer.provideMerge(
      TestSourceControlHost.layer({
        ...(options.git ? { git: options.git } : {}),
        ...(options.process ? { process: options.process } : {}),
      }),
    ),
    Layer.provideMerge(
      FileSystem.layerNoop({
        readFileString: (path) =>
          files[path] === undefined
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "NotFound",
                  module: "FileSystem",
                  method: "readFileString",
                  pathOrDescriptor: path,
                }),
              )
            : Effect.succeed(files[path]),
      }),
    ),
    Layer.provide(
      Layer.succeed(
        HostProcess.Environment,
        options.env ?? { GICE_HOST: `https://${HOST}`, GICE_TOKEN: "env-token" },
      ),
    ),
    Layer.provide(Layer.succeed(HostProcess.HomeDirectory, "/home/alice")),
    Layer.provide(Layer.succeed(HostProcess.Hostname, "devbox")),
    Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
  );
  const routeOf = (request: SentRequest) => `${request.method} ${request.path}`;
  return {
    layer,
    sent,
    paths: () => sent.map(routeOf),
    bodies: () => sent.map((request) => [routeOf(request), request.body] as const),
  };
}

/**
 * A page of a listing, with the whole listing's length as Gice sends it, and for a list across
 * repositories followed by more rows, where the next page starts.
 */
export const listing = (items: ReadonlyArray<unknown>, total: number, next?: string) =>
  new Response(encodeJson(items), {
    headers: {
      "x-total-count": String(total),
      ...(next === undefined ? {} : { "x-next-cursor": next }),
    },
  });

/** Gice's error body, `{"error":{"code","message"}}`. */
export function problem(
  status: number,
  code: string,
  message: string,
  headers?: Record<string, string>,
) {
  return new Response(encodeJson({ error: { code, message } }), {
    status,
    ...(headers === undefined ? {} : { headers }),
  });
}

/** A refused field, as `validation_failed` names it with a machine-readable reason. */
export const invalid = (
  message: string,
  fields: { readonly field: string; readonly reason: string; readonly limit?: number },
) =>
  new Response(encodeJson({ error: { code: "validation_failed", message, ...fields } }), {
    status: 422,
  });

const CREATED = "2026-11-19T08:52:32Z";

/** A User as another account sees it: no `email`. */
export const user = (username: string, fields: Record<string, unknown> = {}) => ({
  id: 1,
  username,
  display_name: "",
  created_at: "2026-11-11T21:45:20Z",
  is_admin: false,
  kind: "user",
  avatar_url: `https://${HOST}/api/v1/users/${username}/avatar`,
  ...fields,
});

export const reactions = (counts: Record<string, number> = {}) => {
  const all = {
    "+1": 0,
    "-1": 0,
    laugh: 0,
    confused: 0,
    heart: 0,
    hooray: 0,
    rocket: 0,
    eyes: 0,
    ...counts,
  };
  return { total_count: Object.values(all).reduce((sum, count) => sum + count, 0), ...all };
};

export const label = (id: number, name: string, fields: Record<string, unknown> = {}) => ({
  id,
  name,
  color: "a2eeef",
  description: "",
  ...fields,
});

export const repository = (fullName: string, fields: Record<string, unknown> = {}) => {
  const [owner = "", name = ""] = fullName.split("/");
  return {
    id: 4,
    owner,
    name,
    full_name: fullName,
    description: "",
    is_private: true,
    default_branch: "main",
    is_empty: false,
    created_at: CREATED,
    updated_at: CREATED,
    clone_url_http: `https://${HOST}/${fullName}.git`,
    clone_url_ssh: `ssh://git@${HOST}:2222/${fullName}.git`,
    permission: "admin",
    workflows_enabled: true,
    shared_runners: false,
    likes_count: 0,
    liked: false,
    fork: false,
    parent: null,
    forks_count: 0,
    ...fields,
  };
};

/** What someone with write access may do with an open pull request. */
const PULL_PERMISSIONS = {
  can_edit: true,
  can_close: true,
  can_reopen: false,
  can_merge: true,
  can_update_branch: true,
  can_delete_head_branch: false,
  can_comment: true,
  can_label: true,
  can_review: true,
  can_approve: false,
  can_request_reviewers: true,
  merge_methods: ["merge", "squash", "rebase"],
  can_revert: false,
};

export const HEAD_SHA = "21723f23022029e1ce4a03f0465998d7a48de838";
export const BASE_SHA = "a1f642c8cf28c0db4b98c80737eb2171b97088fe";

/** A Pull as `GET R/pulls/{n}` answers it for someone with write access. */
export const pull = (fullName: string, number: number, fields: Record<string, unknown> = {}) => {
  const [owner = "", name = ""] = fullName.split("/");
  return {
    number,
    title: "Change",
    body: "Body",
    state: "open",
    author: user("alice"),
    comments_count: 0,
    created_at: CREATED,
    updated_at: "2026-11-19T09:01:40Z",
    closed_at: null,
    edited_at: null,
    is_pull: true,
    version: 3,
    html_url: `https://${HOST}/${fullName}/pulls/${number}`,
    labels: [],
    assignees: [],
    reactions: reactions(),
    viewer_reactions: [],
    closing_issues: [],
    linked_pulls: [],
    head: "feature",
    base: "main",
    head_repo: { owner, name, full_name: fullName },
    cross_repo: false,
    head_label: "feature",
    merged: false,
    merged_at: null,
    merged_by: null,
    merge_commit_sha: null,
    revisions_count: 1,
    draft: false,
    head_sha: HEAD_SHA,
    base_sha: BASE_SHA,
    merge_base_sha: BASE_SHA,
    additions: 12,
    deletions: 4,
    changed_files: 3,
    head_branch_exists: true,
    auto_merge: null,
    viewer_permissions: PULL_PERMISSIONS,
    merge_blockers: [],
    head_branch_pulls: [],
    head_branch_integration: false,
    checks_state: null,
    stack: null,
    mergeable: true,
    ahead: 2,
    behind: 1,
    review_decision: null,
    requested_reviewers: [],
    ...fields,
  };
};

/**
 * A Pull as a listing answers it with `fields=summary`: no body, mergeability, distance, merge
 * blockers or the pull requests based on its head branch.
 */
export const pullSummary = (
  fullName: string,
  number: number,
  fields: Record<string, unknown> = {},
) => {
  const omitted = new Set([
    "body",
    "mergeable",
    "ahead",
    "behind",
    "merge_blockers",
    "head_branch_pulls",
    "head_branch_integration",
  ]);
  const summary = Object.entries(pull(fullName, number)).filter(([key]) => !omitted.has(key));
  return { ...Object.fromEntries(summary), ...fields };
};

/**
 * A Pull as a list across repositories answers it with `fields=summary`: served without git, it
 * names its repository and leaves out what needs the branches.
 */
export const acrossPull = (
  fullName: string,
  number: number,
  fields: Record<string, unknown> = {},
) => {
  const [owner = "", name = ""] = fullName.split("/");
  const { head_branch_exists: _, ...row } = pullSummary(fullName, number);
  const {
    can_update_branch: _update,
    can_delete_head_branch: _delete,
    ...permissions
  } = PULL_PERMISSIONS;
  return {
    ...row,
    viewer_permissions: permissions,
    repository: { owner, name, full_name: fullName, is_private: true },
    ...fields,
  };
};

/** An Issue as `GET R/issues/{n}` answers it. */
export const issue = (fullName: string, number: number, fields: Record<string, unknown> = {}) => ({
  number,
  title: "Crash on start",
  body: "It crashes.",
  state: "open",
  author: user("carol"),
  comments_count: 0,
  created_at: "2026-11-19T20:44:49Z",
  updated_at: "2026-11-19T20:45:02Z",
  closed_at: null,
  edited_at: null,
  is_pull: false,
  version: 2,
  html_url: `https://${HOST}/${fullName}/issues/${number}`,
  labels: [],
  assignees: [],
  reactions: reactions(),
  viewer_reactions: [],
  closing_issues: [],
  linked_pulls: [],
  viewer_permissions: {
    can_edit: true,
    can_close: true,
    can_reopen: false,
    can_comment: true,
    can_label: false,
    can_assign: false,
  },
  ...fields,
});

/** A comment on an issue or a pull request. */
export const comment = (url: string, id: number, fields: Record<string, unknown> = {}) => ({
  id,
  body: `Comment ${id}`,
  author: user("alice"),
  created_at: "2026-11-19T09:00:00Z",
  updated_at: "2026-11-19T09:00:00Z",
  edited_at: null,
  html_url: `${url}#comment-${id}`,
  author_association: "owner",
  viewer_can_edit: false,
  viewer_can_delete: false,
  reactions: reactions(),
  viewer_reactions: [],
  ...fields,
});

/** An event of `GET R/events`, oldest first in a feed. */
export const event = (id: number, type: string, fields: Record<string, unknown> = {}) => ({
  id,
  type,
  number: 7,
  actor: user("alice"),
  created_at: "2026-11-19T20:45:02Z",
  payload: {},
  ...fields,
});

export const feed = (events: ReadonlyArray<{ readonly id: number }>, cursor?: number) => ({
  events,
  cursor: cursor ?? events.at(-1)?.id ?? 0,
  has_more: false,
});

const pullUrl = (fullName: string, number: number) => `https://${HOST}/${fullName}/pulls/${number}`;

/** A Commit as a pull request's commit list carries it. */
export const commit = (sha: string, fields: Record<string, unknown> = {}) => ({
  sha,
  parents: [BASE_SHA],
  message: "Change",
  author: { name: "Alice", email: "alice@example.com", date: "2026-11-19T08:50:20Z" },
  committer: { name: "Alice", email: "alice@example.com", date: "2026-11-19T08:50:20Z" },
  ...fields,
});

/** A Review of pull request 7 of team/app. */
export const review = (id: number, fields: Record<string, unknown> = {}) => ({
  id,
  pull_number: 7,
  user: user("bob"),
  body: "",
  state: "COMMENTED",
  commit_id: HEAD_SHA,
  comments_count: 0,
  submitted_at: "2026-11-19T10:00:00Z",
  created_at: "2026-11-19T10:00:00Z",
  updated_at: "2026-11-19T10:00:00Z",
  dismissed_state: null,
  dismissed_by: null,
  dismissed_at: null,
  dismissal_message: null,
  html_url: `${pullUrl("team/app", 7)}#review-${id}`,
  viewer_can_dismiss: false,
  ...fields,
});

const lineAnchor = {
  path: "src/a.ts",
  subject_type: "line",
  side: "RIGHT",
  line: 12,
  start_line: null,
  start_side: null,
  original_line: 10,
  original_start_line: null,
  commit_id: HEAD_SHA,
  original_commit_id: HEAD_SHA,
  outdated: false,
  diff_hunk: "@@ -1 +1,2 @@",
};

/** An inline comment on pull request 7 of team/app, in review 1 and thread 5. */
export const reviewComment = (id: number, fields: Record<string, unknown> = {}) => ({
  id,
  pull_number: 7,
  pull_request_review_id: 1,
  thread_id: 5,
  in_reply_to_id: null,
  body: `Comment ${id}`,
  ...lineAnchor,
  user: user("alice"),
  created_at: "2026-11-19T09:00:00Z",
  updated_at: "2026-11-19T09:00:00Z",
  edited_at: null,
  html_url: `${pullUrl("team/app", 7)}#discussion-${id}`,
  viewer_can_edit: true,
  viewer_can_delete: true,
  reactions: reactions(),
  viewer_reactions: [],
  ...fields,
});

/** A review thread on pull request 7 of team/app. */
export const thread = (id: number, fields: Record<string, unknown> = {}) => ({
  id,
  pull_number: 7,
  ...lineAnchor,
  resolved: false,
  resolved_by: null,
  resolved_at: null,
  user: user("alice"),
  created_at: "2026-11-19T09:00:00Z",
  updated_at: "2026-11-19T09:00:00Z",
  html_url: `${pullUrl("team/app", 7)}#discussion-${id}`,
  viewer_can_resolve: true,
  comments: [reviewComment(8)],
  ...fields,
});

/** A job of a run as `GET R/status` lists it. */
export const job = (run: number, id: number, fields: Record<string, unknown> = {}) => ({
  id,
  key: `job-${id}`,
  name: `Job ${id}`,
  status: "completed",
  conclusion: "success",
  started_at: "2026-11-19T09:00:00Z",
  completed_at: "2026-11-19T09:01:00Z",
  html_url: `https://${HOST}/team/app/runs/${run}?job=${id}`,
  carried_from: null,
  ...fields,
});

/** A run of team/app as `GET R/status` lists it. */
export const run = (number: number, fields: Record<string, unknown> = {}) => ({
  id: number,
  number,
  workflow: { path: ".gice/workflows/ci.yml", name: "CI" },
  event: "pull_request",
  ref: "refs/pull/7/head",
  ref_name: "7/head",
  sha: HEAD_SHA,
  pull_number: 7,
  title: "Change",
  actor: user("alice"),
  status: "completed",
  conclusion: "success",
  error: null,
  secrets: false,
  created_at: "2026-11-19T09:00:00Z",
  started_at: "2026-11-19T09:00:00Z",
  finished_at: "2026-11-19T09:01:00Z",
  html_url: `https://${HOST}/team/app/runs/${number}`,
  jobs: [],
  ...fields,
});

/** A Template as `GET R/templates` answers it, its front matter read out of the body. */
export const template = (
  kind: "pull" | "issue",
  path: string,
  fields: Record<string, unknown> = {},
) => ({
  kind,
  path,
  name: path.split("/").pop()?.replace(/\.md$/u, "") ?? path,
  about: "",
  title: "",
  labels: [],
  assignees: [],
  body: "## Summary\n",
  ...fields,
});

/** A Reference as `GET R/references` lists it. */
export const reference = (number: number, fields: Record<string, unknown> = {}) => ({
  number,
  title: "Crash on start",
  is_pull: false,
  state: "open",
  draft: false,
  updated_at: "2026-11-19T10:00:00Z",
  html_url: `https://${HOST}/team/app/issues/${number}`,
  ...fields,
});

/** A file of `GET R/pulls/{n}/viewed`, with no mark by default. */
export const viewedFile = (path: string, fields: Record<string, unknown> = {}) => ({
  path,
  sha: HEAD_SHA,
  viewed: false,
  dismissed: false,
  viewed_at: null,
  ...fields,
});

/** `GET R/pulls/{n}/viewed`, counting the files it is given. */
export const viewed = (files: ReadonlyArray<ReturnType<typeof viewedFile>>) => ({
  files,
  viewed_count: files.filter((file) => file.viewed).length,
  total_count: files.length,
});

/** A layer of `GET R/pulls/{n}/stack`, open on `main` with nothing below or above it. */
export const stackLayer = (number: number, fields: Record<string, unknown> = {}) => ({
  number,
  title: `Layer ${number}`,
  state: "open",
  draft: false,
  head: `layer-${number}`,
  head_label: `layer-${number}`,
  cross_repo: false,
  head_sha: HEAD_SHA,
  base: "main",
  base_sha: BASE_SHA,
  parent: null,
  children: [],
  needs_restack: false,
  checks_state: null,
  auto_merge: false,
  current: false,
  merged_at: null,
  closed_at: null,
  merge_commit_sha: null,
  html_url: pullUrl("team/app", number),
  ...fields,
});

/** `GET R/pulls/{n}/stack` of team/app. */
export const stack = (
  number: number,
  layers: ReadonlyArray<ReturnType<typeof stackLayer>>,
  fields: Record<string, unknown> = {},
) => ({
  number,
  trunk: "main",
  trunk_pull: null,
  merge_into: "main",
  branched: false,
  layers: layers.map((layer) => ({ ...layer, current: layer.number === number })),
  viewer_permissions: { can_merge: true, can_restack: true },
  ...fields,
});
