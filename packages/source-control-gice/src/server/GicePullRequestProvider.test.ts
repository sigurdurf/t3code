import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as GiceApi from "./GiceApi.ts";
import * as GicePullRequestProvider from "./GicePullRequestProvider.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const isApiError = Schema.is(GiceApi.GiceApiError);

type Route = unknown | ((request: GiceApi.GiceApiRequest) => unknown);

const refused = (status: number, code: string, detail: string) =>
  new GiceApi.GiceApiError({
    host: "gice.example.com",
    operation: "test",
    status,
    reason: status === 404 ? "not-found" : "failed",
    code,
    detail,
  });

const META = "GET /meta";

/**
 * Routes are keyed by method and path, query string included; a missing one answers 404. The
 * server is one that predates `features` unless it is given some, and the question every call
 * starts with is left out of what was sent.
 */
function fakeGice(routes: Record<string, Route>, features?: ReadonlyArray<GiceApi.GiceFeature>) {
  const sent: Array<GiceApi.GiceApiRequest> = [];
  const request = (request: GiceApi.GiceApiRequest) => {
    const key = `${request.method ?? "GET"} ${request.path}`;
    if (key !== META) sent.push(request);
    const route = key === META && !(META in routes) ? { features } : routes[key];
    const answer: unknown = typeof route === "function" ? route(request) : route;
    if (answer === undefined) return Effect.fail(refused(404, "not_found", "not found"));
    if (isApiError(answer)) return Effect.fail(answer);
    return Effect.succeed(typeof answer === "string" ? answer : encodeJson(answer));
  };
  const layer = Layer.effect(
    GiceApi.GiceApi,
    GiceApi.makeFeatures(request).pipe(Effect.map((features) => ({ request, features }))),
  );
  const paths = () => sent.map((request) => `${request.method ?? "GET"} ${request.path}`);
  return { layer, sent, paths };
}

const target = { cwd: "/repo", host: "gice.example.com", repository: "team/app", number: 7 };
const headSha = "21723f23022029e1ce4a03f0465998d7a48de838";
const baseSha = "a1f642c8cf28c0db4b98c80737eb2171b97088fe";
const user = (username: string) => ({ id: 1, username, display_name: "", kind: "user" });
const pull = (overrides: Record<string, unknown> = {}) => ({
  number: 7,
  title: "Change",
  body: "Body",
  state: "open",
  author: user("alice"),
  created_at: "2026-11-19T08:52:32Z",
  updated_at: "2026-11-19T09:01:40Z",
  closed_at: null,
  head: "feature",
  base: "main",
  head_repo: { owner: "team", name: "app", full_name: "team/app" },
  cross_repo: false,
  merged_at: null,
  merged_by: null,
  merge_commit_sha: null,
  revisions_count: 3,
  mergeable: true,
  ahead: 2,
  behind: 1,
  ...overrides,
});
const run = (number: number, conclusion: string | null) => ({
  number,
  workflow: { path: ".gice/workflows/ci.yml", name: "CI" },
  event: "pull_request",
  status: conclusion === null ? "in_progress" : "completed",
  conclusion,
  error: null,
});
const files = {
  files: [
    { path: "a.ts", status: "modified", additions: 4, deletions: 1, is_binary: false },
    { path: "new.ts", old_path: "old.ts", status: "renamed", additions: 2, deletions: 2 },
  ],
  patch: "diff --git a/a.ts b/a.ts\nindex 1111111..2222222 100644\n",
};
const STATUS = "GET /repos/team/app/status?ref=refs%2Fpull%2F7%2Fhead";

const provide = <A, E>(
  gice: ReturnType<typeof fakeGice>,
  use: (provider: Effect.Success<typeof GicePullRequestProvider.make>) => Effect.Effect<A, E>,
) => GicePullRequestProvider.make.pipe(Effect.flatMap(use), Effect.provide(gice.layer));

describe("GicePullRequestProvider", () => {
  it.effect("reads a pull request with its head, checks, line totals and permissions", () => {
    const gice = fakeGice({
      "GET /repos/team/app/pulls/7": pull(),
      [STATUS]: { sha: headSha, state: "failure", runs: [run(4, "failure")] },
      "GET /repos/team/app/pulls/7/files": files,
      "GET /user": user("bob"),
      "GET /repos/team/app": { full_name: "team/app", permission: "write" },
    });
    return provide(gice, (provider) => provider.getChangeRequest(target)).pipe(
      Effect.map((detail) => {
        assert.deepStrictEqual(
          {
            headSha: detail.headSha,
            body: detail.body,
            additions: detail.additions,
            deletions: detail.deletions,
            changedFiles: detail.changedFiles,
            mergeability: detail.mergeability,
            baseComparison: detail.baseComparison,
            behindBy: detail.behindBy,
            checksState: detail.checksState,
            checks: detail.checks,
            actions: detail.viewerPermissions.actions,
            mergeCapabilities: detail.mergeCapabilities,
          },
          {
            headSha,
            body: "Body",
            additions: 6,
            deletions: 3,
            changedFiles: 2,
            mergeability: "mergeable",
            baseComparison: "behind",
            behindBy: 1,
            checksState: "failing",
            checks: [
              {
                name: "CI (pull_request)",
                status: "failure",
                description: null,
                url: "https://gice.example.com/team/app/runs/4",
              },
            ],
            actions: ["merge", "close"],
            mergeCapabilities: { merge: true, squash: true, rebase: true },
          },
        );
      }),
    );
  });

  it.effect("reads a pull request whose commits are gone without a head or checks", () => {
    const gice = fakeGice({
      "GET /repos/team/app/pulls/7": pull({ state: "closed", mergeable: null }),
      "GET /user": user("alice"),
      "GET /repos/team/app": { permission: "read" },
    });
    return provide(gice, (provider) =>
      Effect.all([provider.getChangeRequest(target), provider.getChangeRequestSummary!(target)]),
    ).pipe(
      Effect.map(([detail, summary]) => {
        assert.strictEqual(detail.headSha, null);
        assert.deepStrictEqual(detail.checks, []);
        assert.isFalse("checksState" in detail);
        assert.strictEqual(detail.changedFiles, 0);
        assert.deepStrictEqual(detail.viewerPermissions.actions, ["reopen"]);
        assert.isFalse("headSha" in summary);
        assert.isFalse("additions" in summary);
        assert.strictEqual(summary.state, "closed");
      }),
    );
  });

  it.effect("summarizes a pull request from the pull and its status alone", () => {
    const gice = fakeGice({
      "GET /repos/team/app/pulls/7": pull(),
      [STATUS]: { sha: headSha, state: "pending", runs: [run(4, null), run(3, "success")] },
    });
    return provide(gice, (provider) =>
      Effect.all([
        provider.getChangeRequestSummary!(target),
        provider.getChangeRequestChecks!(target),
      ]),
    ).pipe(
      Effect.map(([summary, checks]) => {
        assert.strictEqual(summary.headSha, headSha);
        assert.strictEqual(summary.checksState, "pending");
        assert.strictEqual(summary.mergeability, "mergeable");
        assert.strictEqual(checks.state, "open");
        assert.deepStrictEqual(
          checks.checks.map((check) => check.status),
          ["pending", "success"],
        );
        assert.deepStrictEqual(
          new Set(gice.paths()),
          new Set(["GET /repos/team/app/pulls/7", STATUS]),
        );
      }),
    );
  });

  it.effect("lists a first page with one row to spare, which says whether more follow", () => {
    const gice = fakeGice({
      "GET /repos/team/app/pulls?state=open&per_page=3&page=1": [
        pull({ number: 9 }),
        pull({ number: 8 }),
        pull({ number: 7 }),
      ],
    });
    return provide(gice, (provider) =>
      provider.listChangeRequests({
        ...target,
        state: "open",
        involvement: "authored",
        viewer: "alice",
        limit: 2,
      }),
    ).pipe(
      Effect.map((page) => {
        assert.deepStrictEqual(
          page.items.map((item) => item.number),
          [9, 8],
        );
        assert.isTrue(page.truncated);
        assert.isTrue(page.continues);
        assert.strictEqual(page.resumeAfter, "8");
      }),
    );
  });

  it.effect("continues a listing below the last number delivered, whatever moved above it", () => {
    const numbered = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => pull({ number: from - index }));
    const gice = fakeGice({
      // Rows above the last one delivered have come and gone since the first page.
      "GET /repos/team/app/pulls?state=all&per_page=100&page=1": numbered(150, 100),
      "GET /repos/team/app/pulls?state=all&per_page=100&page=2": numbered(50, 50),
    });
    return provide(gice, (provider) =>
      provider.listChangeRequests({
        ...target,
        state: "all",
        involvement: "all",
        viewer: "alice",
        limit: 100,
        cursor: { updatedBefore: "2026-11-19T09:01:40Z", delivered: 30, resumeAfter: "120" },
      }),
    ).pipe(
      Effect.map((page) => {
        assert.strictEqual(page.items.length, 100);
        assert.strictEqual(page.items[0]?.number, 119);
        assert.strictEqual(page.resumeAfter, "20");
        assert.isTrue(page.truncated);
      }),
    );
  });

  it.effect("asks nothing for a reviewing listing, since Gice has no reviewers", () => {
    const gice = fakeGice({});
    return provide(gice, (provider) =>
      provider.listChangeRequests({
        ...target,
        state: "open",
        involvement: "reviewing",
        viewer: "alice",
        limit: 20,
      }),
    ).pipe(
      Effect.map((page) => {
        assert.deepStrictEqual(page, { items: [], truncated: false, continues: false });
        assert.deepStrictEqual(gice.sent, []);
      }),
    );
  });

  it.effect("reads comments across pages and commits oldest first", () => {
    const comment = (id: number) => ({
      id,
      body: `Comment ${id}`,
      author: user("alice"),
      created_at: "2026-11-19T08:52:32Z",
      updated_at: "2026-11-19T08:52:32Z",
    });
    const commit = (sha: string, message: string) => ({
      sha,
      parents: [],
      message,
      committer: { name: "Alice", email: "alice@example.com", date: "2026-11-19T08:50:20Z" },
    });
    const gice = fakeGice({
      "GET /repos/team/app/issues/7/comments?per_page=100&page=1": Array.from(
        { length: 100 },
        (_, index) => comment(index + 1),
      ),
      "GET /repos/team/app/issues/7/comments?per_page=100&page=2": [comment(101)],
      "GET /repos/team/app/pulls/7/commits?per_page=100&page=1": [
        commit(headSha, "Second"),
        commit(baseSha, "First\n\nBody"),
      ],
    });
    return provide(gice, (provider) => provider.getChangeRequestActivity(target)).pipe(
      Effect.map((activity) => {
        assert.strictEqual(activity.commentCount, 101);
        assert.isFalse(activity.commentsTruncated);
        assert.strictEqual(activity.comments.at(-1)?.id, "101");
        assert.deepStrictEqual(
          activity.commits.map((entry) => entry.messageHeadline),
          ["First", "Second"],
        );
        assert.deepStrictEqual(activity.reviewThreads, []);
      }),
    );
  });

  it.effect("reads a commit's diff and changed paths from the commit itself", () => {
    const gice = fakeGice({
      "GET /repos/team/app/pulls/7/files": files,
      [`GET /repos/team/app/commits/${headSha}`]: {
        sha: headSha,
        message: "Second",
        files: [files.files[0]],
        patch: "commit patch",
      },
    });
    return provide(gice, (provider) =>
      Effect.all([
        provider.getDiff({ ...target, commit: headSha }),
        provider.getDiffFilePaths!(target),
        provider.getFileRevisions!({ ...target, paths: ["a.ts", "other.ts"] }),
      ]),
    ).pipe(
      Effect.map(([diff, paths, revisions]) => {
        assert.deepStrictEqual(diff, { patch: "commit patch", truncated: false, nextCursor: null });
        assert.deepStrictEqual(paths, {
          files: [
            { oldPath: "a.ts", newPath: "a.ts" },
            { oldPath: "old.ts", newPath: "new.ts" },
          ],
          nextCursor: null,
        });
        assert.deepStrictEqual(revisions, {
          revisions: new Map([
            ["a.ts", "2222222"],
            ["other.ts", ""],
          ]),
          complete: true,
        });
      }),
    );
  });

  it.effect("reads both sides of a file at the newest revision's merge base and head", () => {
    const blob = (text: string) => ({
      path: "a.ts",
      size: text.length,
      is_binary: false,
      content: Buffer.from(text).toString("base64"),
    });
    const gice = fakeGice({
      "GET /repos/team/app/pulls/7": pull(),
      "GET /repos/team/app/pulls/7/revisions?per_page=1&page=3": [
        { number: 3, head_sha: headSha, base_sha: baseSha, kind: "push" },
      ],
      [`GET /repos/team/app/blob?ref=${baseSha}&path=src%2Fold+name.ts`]: blob("before ✓"),
      [`GET /repos/team/app/blob?ref=${headSha}&path=src%2Fa.ts`]: blob("after"),
    });
    return provide(gice, (provider) =>
      provider.getDiffFileContents!({
        ...target,
        changeType: "rename-changed",
        oldPath: "src/old name.ts",
        newPath: "src/a.ts",
      }),
    ).pipe(
      Effect.map((contents) => {
        assert.deepStrictEqual(contents, { oldContents: "before ✓", newContents: "after" });
      }),
    );
  });

  it.effect("refuses a file Gice holds no text for", () => {
    const gice = fakeGice({
      [`GET /repos/team/app/commits/${headSha}`]: {
        sha: headSha,
        parents: [baseSha],
        message: "Second",
        committer: { name: "Alice", email: "alice@example.com", date: "2026-11-19T08:50:20Z" },
      },
      [`GET /repos/team/app/blob?ref=${headSha}&path=logo.png`]: { size: 9, is_binary: true },
    });
    return provide(gice, (provider) =>
      provider.getDiffFileContents!({
        ...target,
        commit: headSha,
        changeType: "new",
        oldPath: "logo.png",
        newPath: "logo.png",
      }),
    ).pipe(
      Effect.flip,
      Effect.map((error) => {
        assert.strictEqual(error.detail, "Gice cannot provide this file as text.");
      }),
    );
  });

  it.effect("merges with the chosen method and returns the pull request Gice left", () => {
    const gice = fakeGice({
      "POST /repos/team/app/pulls/7/merge": pull({
        state: "merged",
        merged_at: "2026-11-19T09:01:40Z",
        closed_at: "2026-11-19T09:01:40Z",
        mergeable: null,
      }),
      "PATCH /repos/team/app/pulls/7": (request: GiceApi.GiceApiRequest) =>
        pull({ state: (request.body as { state: string }).state }),
    });
    return provide(gice, (provider) =>
      Effect.all([
        provider.runAction({ ...target, action: "merge", mergeMethod: "squash" }),
        provider.runAction({ ...target, action: "close" }),
        provider.runAction({ ...target, action: "reopen" }),
      ]),
    ).pipe(
      Effect.map(([merged, closed, reopened]) => {
        assert.deepStrictEqual(
          gice.sent.map((request) => request.body),
          [{ method: "squash" }, { state: "closed" }, { state: "open" }],
        );
        assert.strictEqual(merged?.state, "merged");
        assert.strictEqual(merged?.mergedAt, "2026-11-19T09:01:40.000Z");
        assert.strictEqual(closed?.state, "closed");
        assert.strictEqual(reopened?.state, "open");
      }),
    );
  });

  it.effect("passes Gice's refusal of a merge on, and a missing permission as forbidden", () => {
    const gice = fakeGice({
      "POST /repos/team/app/pulls/7/merge": refused(409, "conflict", "pull request is closed"),
      "PATCH /repos/team/app/pulls/7": refused(403, "forbidden", "only the author can edit this"),
    });
    return provide(gice, (provider) =>
      Effect.all([
        provider.runAction({ ...target, action: "merge" }).pipe(Effect.flip),
        provider.runAction({ ...target, action: "close" }).pipe(Effect.flip),
        provider
          .runAction({ ...target, action: "merge", mergeMethod: "fast-forward" })
          .pipe(Effect.flip),
        provider.runAction({ ...target, action: "draft" }).pipe(Effect.flip),
      ]),
    ).pipe(
      Effect.map(([closed, forbidden, fastForward, draft]) => {
        assert.deepStrictEqual(
          [closed.reason, closed.detail],
          ["failed", "pull request is closed"],
        );
        assert.strictEqual(forbidden.reason, "forbidden");
        assert.strictEqual(fastForward.detail, "Gice has no fast-forward merge.");
        assert.strictEqual(draft.detail, "Gice cannot draft a pull request.");
        assert.strictEqual(gice.sent.length, 2);
      }),
    );
  });

  it.effect("writes the description and comments through the issue routes they share", () => {
    const gice = fakeGice({
      "PATCH /repos/team/app/pulls/7": pull(),
      "POST /repos/team/app/issues/7/comments": { id: 31 },
      "PATCH /repos/team/app/comments/31": { id: 31 },
    });
    return provide(gice, (provider) =>
      Effect.all([
        provider.updateChangeRequest!({ ...target, body: "New body" }),
        provider.comment({ ...target, body: "Hello" }),
        provider.updateComment!({
          ...target,
          commentId: "31",
          kind: "issue-comment",
          body: "Edited",
        }),
        provider.updateComment!({
          ...target,
          commentId: "31/../../pulls/7",
          kind: "issue-comment",
          body: "Edited",
        }).pipe(Effect.flip),
      ]),
    ).pipe(
      Effect.map(() => {
        assert.deepStrictEqual(
          gice.sent.map((request) => [`${request.method} ${request.path}`, request.body]),
          [
            ["PATCH /repos/team/app/pulls/7", { body: "New body" }],
            ["POST /repos/team/app/issues/7/comments", { body: "Hello" }],
            ["PATCH /repos/team/app/comments/31", { body: "Edited" }],
          ],
        );
      }),
    );
  });

  it.effect("tails the failed jobs of a check's run and re-runs the run", () => {
    const checks = [
      { name: "CI (pull_request)", url: "https://gice.example.com/team/app/runs/4" },
      { name: "External", url: "https://ci.example.com/build/1" },
      { name: "Deploy (push)", url: "https://gice.example.com/team/app/runs/5" },
    ];
    const gice = fakeGice({
      "GET /repos/team/app/runs/4": {
        number: 4,
        jobs: [
          { id: 11, name: "lint", status: "completed", conclusion: "success" },
          { id: 12, name: "test", status: "completed", conclusion: "failure" },
        ],
      },
      "GET /repos/team/app/runs/4/jobs/12/logs": "one\ntwo\nthree\n",
      "POST /repos/team/app/runs/4/rerun": { number: 6, jobs: [] },
      "POST /repos/team/app/runs/5/rerun": refused(409, "conflict", "run is not completed"),
    });
    return provide(gice, (provider) =>
      Effect.all([
        provider.getCheckLogs!({ ...target, checks, tailLines: 2 }),
        provider.rerunChecks!({ ...target, checks }),
      ]),
    ).pipe(
      Effect.map(([logs, reruns]) => {
        assert.deepStrictEqual(logs, [
          { ...checks[0]!, log: "two\nthree", truncated: true, detail: null },
          {
            ...checks[1]!,
            log: null,
            truncated: false,
            detail: "Gice holds no log for this check.",
          },
          { ...checks[2]!, log: null, truncated: false, detail: "not found" },
        ]);
        assert.deepStrictEqual(reruns, [
          { name: "CI (pull_request)", rerun: true, detail: null },
          { name: "External", rerun: false, detail: "Gice cannot re-run this check." },
          { name: "Deploy (push)", rerun: false, detail: "run is not completed" },
        ]);
      }),
    );
  });

  it.effect("declines what Gice has no counterpart for without asking it", () => {
    const gice = fakeGice({});
    return provide(gice, (provider) =>
      Effect.all([
        provider
          .submitReview({ ...target, verdict: "approve", body: "", comments: [] })
          .pipe(Effect.flip),
        provider.listReviewerCandidates(target).pipe(Effect.flip),
        provider
          .setReviewerRequest({ ...target, reviewers: [], requested: true })
          .pipe(Effect.flip),
        provider.replyToThread({ ...target, threadId: "1", body: "Hi" }).pipe(Effect.flip),
        provider
          .setThreadResolution({ ...target, threadId: "1", resolved: true })
          .pipe(Effect.flip),
        provider.setReaction({ ...target, content: "heart", reacted: true }).pipe(Effect.flip),
        provider.getChangeRequest({ ...target, repository: "not-a-repository" }).pipe(Effect.flip),
      ]),
    ).pipe(
      Effect.map((errors) => {
        assert.isTrue(errors.every((error) => error.reason === "failed"));
        assert.deepStrictEqual(gice.sent, []);
      }),
    );
  });
});

const CURRENT: ReadonlyArray<GiceApi.GiceFeature> = [
  "labels",
  "reactions",
  "events",
  "check_jobs",
  "comment_meta",
  "avatars",
  "pull_stats",
  "pull_drafts",
  "pull_filters",
  "pull_labels_filter",
  "pull_file_paging",
  "pull_merge_options",
  "pull_update_branch",
  "pull_auto_merge",
  "pull_viewer_permissions",
  "pull_reviews",
  "pull_review_comments",
  "pull_review_threads",
  "pull_reviewer_requests",
  "review_comment_reactions",
];
const currentPull = (overrides: Record<string, unknown> = {}) =>
  pull({
    draft: false,
    head_sha: headSha,
    additions: 12,
    deletions: 4,
    changed_files: 3,
    auto_merge: null,
    review_decision: null,
    requested_reviewers: [],
    labels: [],
    reactions: { total_count: 1, heart: 1 },
    viewer_reactions: ["heart"],
    viewer_permissions: {
      can_edit: true,
      can_close: true,
      can_reopen: false,
      can_merge: true,
      can_update_branch: true,
      can_delete_head_branch: false,
      can_comment: true,
      can_review: true,
      can_approve: false,
      can_request_reviewers: true,
      merge_methods: ["merge", "squash", "rebase"],
    },
    ...overrides,
  });
const bodies = (gice: ReturnType<typeof fakeGice>) =>
  gice.sent.map((request) => [`${request.method ?? "GET"} ${request.path}`, request.body]);

describe("GicePullRequestProvider on a current server", () => {
  it.effect("reads size, head and permissions from the pull request alone", () => {
    const gice = fakeGice(
      {
        "GET /repos/team/app/pulls/7": currentPull({ requested_reviewers: [user("bob")] }),
        [STATUS]: { sha: headSha, state: "none", runs: [] },
      },
      CURRENT,
    );
    return provide(gice, (provider) =>
      Effect.all([provider.getChangeRequest(target), provider.getViewerPermissions(target)]),
    ).pipe(
      Effect.map(([detail, permissions]) => {
        assert.deepStrictEqual(
          {
            headSha: detail.headSha,
            additions: detail.additions,
            deletions: detail.deletions,
            changedFiles: detail.changedFiles,
            reviewers: detail.reviewers.map((reviewer) => reviewer.login),
            verdicts: detail.viewerPermissions.verdicts,
            actions: detail.viewerPermissions.actions,
          },
          {
            headSha,
            additions: 12,
            deletions: 4,
            changedFiles: 3,
            reviewers: ["bob"],
            verdicts: ["comment"],
            actions: [
              "merge",
              "draft",
              "close",
              "update-branch",
              "enable-auto-merge",
              "disable-auto-merge",
            ],
          },
        );
        assert.deepStrictEqual(permissions, detail.viewerPermissions);
        assert.deepStrictEqual(
          new Set(gice.paths()),
          new Set(["GET /repos/team/app/pulls/7", STATUS]),
        );
      }),
    );
  });

  it.effect("answers for what the server on a host can do, which an older one cannot", () => {
    const old = fakeGice({});
    const current = fakeGice({}, CURRENT);
    return Effect.all([
      provide(old, (provider) => provider.capabilitiesOnHost!(target.host)),
      provide(current, (provider) =>
        Effect.map(provider.capabilitiesOnHost!(target.host), (onHost) => [
          onHost,
          provider.capabilities,
        ]),
      ),
    ]).pipe(
      Effect.map(([capabilities, [onCurrent, declared]]) => {
        assert.deepStrictEqual(onCurrent, declared);
        assert.deepStrictEqual(
          {
            actions: capabilities.actions,
            deleteBranch: capabilities.deleteBranch,
            updateMethods: capabilities.updateMethods,
            reactions: capabilities.reactions,
            labels: capabilities.labels,
            review: capabilities.review,
            reviewers: capabilities.reviewers,
            withheldFileDiff: capabilities.withheldFileDiff,
          },
          {
            actions: ["merge", "close", "reopen"],
            deleteBranch: false,
            updateMethods: [],
            reactions: false,
            labels: false,
            review: {
              inlineComment: false,
              rangeComment: false,
              reply: false,
              resolve: false,
              verdicts: [],
            },
            reviewers: { request: false, listCandidates: false, searchCandidates: false },
            withheldFileDiff: false,
          },
        );
      }),
    );
  });

  it.effect("has the server narrow a listing, and narrows it here where the server cannot", () => {
    const narrowed =
      "GET /repos/team/app/pulls?state=open&per_page=21&page=1&author=carol&draft=false&fields=summary&q=fix+parser&labels=bug%2Cui";
    const reviewing = "GET /repos/team/app/pulls?state=open&per_page=100&page=1&fields=summary";
    const unsearched = "GET /repos/team/app/pulls?state=open&per_page=100&page=1";
    const rows = [
      currentPull({ number: 9, requested_reviewers: [user("Alice")] }),
      currentPull({ number: 8, title: "Fix the parser", requested_reviewers: [user("bob")] }),
    ];
    const list = {
      ...target,
      state: "open",
      involvement: "all",
      viewer: "alice",
      limit: 20,
    } as const;
    const current = fakeGice({ [narrowed]: rows, [reviewing]: rows }, CURRENT);
    const old = fakeGice({ [unsearched]: rows });
    return Effect.all([
      provide(current, (provider) =>
        Effect.all([
          provider.listChangeRequests({
            ...list,
            query: " fix parser ",
            filters: { author: "carol", draft: "hide", labels: [["bug"], ["a", "b"], ["ui"]] },
          }),
          provider.listChangeRequests({ ...list, involvement: "reviewing" }),
        ]),
      ),
      provide(old, (provider) => provider.listChangeRequests({ ...list, query: "parser" })),
    ]).pipe(
      Effect.map(([[filtered, asked], searched]) => {
        assert.deepStrictEqual(current.paths(), [narrowed, reviewing]);
        assert.deepStrictEqual(
          [filtered.items, asked.items, searched.items].map((items) =>
            items.map((item) => item.number),
          ),
          [[9, 8], [9], [8]],
        );
        assert.deepStrictEqual(old.paths(), [unsearched]);
      }),
    );
  });

  it.effect("reads reviews, threads and reactions into the activity", () => {
    const remark = { created_at: "2026-11-19T09:00:00Z", updated_at: "2026-11-19T09:00:00Z" };
    const gice = fakeGice(
      {
        "GET /repos/team/app/issues/7/comments?per_page=100&page=1": [
          {
            ...remark,
            id: 4,
            body: "Later",
            author: user("alice"),
            created_at: "2026-11-19T10:00:00Z",
            html_url: "https://gice.example.com/team/app/pulls/7#comment-4",
            viewer_can_edit: false,
            reactions: { "+1": 1 },
            viewer_reactions: [],
          },
        ],
        "GET /repos/team/app/pulls/7/commits?per_page=100&page=1": [],
        "GET /repos/team/app/pulls/7/reviews?per_page=100&page=1": [
          {
            id: 2,
            user: user("bob"),
            body: "Fix",
            state: "CHANGES_REQUESTED",
            submitted_at: remark.created_at,
          },
          {
            id: 3,
            user: user("carol"),
            body: "",
            state: "COMMENTED",
            submitted_at: remark.created_at,
          },
        ],
        "GET /repos/team/app/pulls/7/threads?per_page=100&page=1": [
          {
            id: 5,
            path: "a.ts",
            side: "RIGHT",
            line: 2,
            original_line: 2,
            outdated: false,
            resolved: false,
            viewer_can_resolve: true,
            comments: [{ ...remark, id: 8, user: user("carol"), body: "Here" }],
          },
        ],
        "GET /repos/team/app/pulls/7": currentPull({ requested_reviewers: [user("dave")] }),
      },
      CURRENT,
    );
    return provide(gice, (provider) => provider.getChangeRequestActivity(target)).pipe(
      Effect.map((activity) => {
        assert.deepStrictEqual(
          activity.comments.map((comment) => [comment.id, comment.kind, comment.canEdit]),
          [
            ["review:2", "review", undefined],
            ["4", "issue-comment", false],
          ],
        );
        assert.deepStrictEqual(activity.comments[1]?.reactions, [
          { content: "thumbs-up", count: 1, actors: [], viewerHasReacted: false },
        ]);
        assert.deepStrictEqual(
          activity.reviewThreads.map((thread) => [thread.id, thread.comments[0]?.id]),
          [["5:8", "review-comment:8"]],
        );
        assert.deepStrictEqual(
          activity.reviewers?.map((reviewer) => reviewer.login),
          ["dave", "bob"],
        );
        assert.deepStrictEqual(activity.reactions, [
          { content: "heart", count: 1, actors: [], viewerHasReacted: true },
        ]);
        assert.strictEqual(activity.commentCount, 2);
      }),
    );
  });

  it.effect("submits a review with its line comments, and answers and resolves a thread", () => {
    const gice = fakeGice(
      {
        "POST /repos/team/app/pulls/7/reviews": { id: 2 },
        "POST /repos/team/app/pulls/7/comments/8/replies": { id: 9 },
        "PUT /repos/team/app/pulls/threads/5/resolution": { id: 5 },
        "DELETE /repos/team/app/pulls/threads/5/resolution": { id: 5 },
        "PATCH /repos/team/app/pulls/comments/8": { id: 8 },
      },
      CURRENT,
    );
    return provide(gice, (provider) =>
      Effect.all([
        provider.submitReview({
          ...target,
          verdict: "request-changes",
          body: "Fix",
          comments: [{ path: "a.ts", position: { kind: "deleted", oldLine: 3 }, body: "Why?" }],
        }),
        provider.replyToThread({ ...target, threadId: "5:8", body: "Done" }),
        provider.setThreadResolution({ ...target, threadId: "5:8", resolved: true }),
        provider.setThreadResolution({ ...target, threadId: "5:8", resolved: false }),
        provider.updateComment!({
          ...target,
          commentId: "review-comment:8",
          kind: "review-comment",
          body: "Why not?",
        }),
        provider.replyToThread({ ...target, threadId: "5", body: "Done" }).pipe(Effect.flip),
        provider.updateComment!({
          ...target,
          commentId: "8",
          kind: "review-comment",
          body: "x",
        }).pipe(Effect.flip),
      ]),
    ).pipe(
      Effect.map(() => {
        assert.deepStrictEqual(bodies(gice), [
          [
            "POST /repos/team/app/pulls/7/reviews",
            {
              event: "REQUEST_CHANGES",
              body: "Fix",
              comments: [{ path: "a.ts", body: "Why?", side: "LEFT", line: 3 }],
            },
          ],
          ["POST /repos/team/app/pulls/7/comments/8/replies", { body: "Done" }],
          ["PUT /repos/team/app/pulls/threads/5/resolution", undefined],
          ["DELETE /repos/team/app/pulls/threads/5/resolution", undefined],
          ["PATCH /repos/team/app/pulls/comments/8", { body: "Why not?" }],
        ]);
      }),
    );
  });

  it.effect("reacts to the description, a comment and a line comment, and takes one back", () => {
    const gice = fakeGice(
      {
        "POST /repos/team/app/issues/7/reactions": { id: 21, content: "heart" },
        "POST /repos/team/app/comments/4/reactions": { id: 22, content: "+1" },
        "POST /repos/team/app/pulls/comments/8/reactions": { id: 23, content: "eyes" },
        "DELETE /repos/team/app/pulls/comments/8/reactions/23": "",
      },
      CURRENT,
    );
    const react = { ...target, reacted: true } as const;
    return provide(gice, (provider) =>
      Effect.all([
        provider.setReaction({ ...react, content: "heart" }),
        provider.setReaction({ ...react, subjectId: "4", content: "thumbs-up" }),
        provider.setReaction({
          ...react,
          subjectId: "review-comment:8",
          content: "eyes",
          reacted: false,
        }),
        provider
          .setReaction({ ...react, subjectId: "review:2", content: "heart" })
          .pipe(Effect.flip),
      ]),
    ).pipe(
      Effect.map(([, , , review]) => {
        assert.deepStrictEqual(bodies(gice), [
          ["POST /repos/team/app/issues/7/reactions", { content: "heart" }],
          ["POST /repos/team/app/comments/4/reactions", { content: "+1" }],
          ["POST /repos/team/app/pulls/comments/8/reactions", { content: "eyes" }],
          ["DELETE /repos/team/app/pulls/comments/8/reactions/23", undefined],
        ]);
        assert.strictEqual(review.detail, "Gice has no reactions on reviews.");
      }),
    );
  });

  it.effect("asks for reviewers and labels by name", () => {
    const gice = fakeGice(
      {
        "GET /repos/team/app/pulls/7": currentPull({ requested_reviewers: [user("Bob")] }),
        "GET /repos/team/app/pulls/7/reviewer-candidates?per_page=100&q=bo": [
          user("bob"),
          user("bo"),
        ],
        "POST /repos/team/app/pulls/7/requested_reviewers": currentPull(),
        "DELETE /repos/team/app/pulls/7/requested_reviewers": currentPull(),
        "GET /repos/team/app/labels?per_page=100&page=1": [
          { id: 1, name: "bug", color: "ff0000", description: "Broken" },
          { id: 2, name: "ui", color: "00ff00", description: "" },
        ],
        "GET /repos/team/app/issues/7/labels?per_page=100&page=1": [{ id: 1, name: "Bug" }],
        "POST /repos/team/app/issues/7/labels": [],
        "DELETE /repos/team/app/issues/7/labels/needs%20work": [],
      },
      CURRENT,
    );
    const reviewers = [{ id: "bob", kind: "user" }] as const;
    return provide(gice, (provider) =>
      Effect.all([
        provider.listReviewerCandidates({ ...target, query: " bo " }),
        provider.setReviewerRequest({ ...target, reviewers, requested: true }),
        provider.setReviewerRequest({ ...target, reviewers, requested: false }),
        provider.listLabelCandidates!(target),
        provider.setLabels!({ ...target, labels: ["bug", "ui"], applied: true }),
        // A label that is already off is no reason to leave the next one on.
        provider.setLabels!({ ...target, labels: ["gone", "needs work"], applied: false }),
        provider
          .setReviewerRequest({
            ...target,
            reviewers: [{ id: "core", kind: "team" }],
            requested: true,
          })
          .pipe(Effect.flip),
      ]),
    ).pipe(
      Effect.map(([candidates, , , labels]) => {
        assert.deepStrictEqual(
          candidates.candidates.map((candidate) => [candidate.id, candidate.isRequested]),
          [
            ["bob", true],
            ["bo", false],
          ],
        );
        assert.deepStrictEqual(labels.candidates, [
          { name: "bug", color: "ff0000", description: "Broken", isApplied: true },
          { name: "ui", color: "00ff00", description: null, isApplied: false },
        ]);
        assert.deepStrictEqual(
          bodies(gice).filter(([path]) => !String(path).startsWith("GET ")),
          [
            ["POST /repos/team/app/pulls/7/requested_reviewers", { reviewers: ["bob"] }],
            ["DELETE /repos/team/app/pulls/7/requested_reviewers", { reviewers: ["bob"] }],
            ["POST /repos/team/app/issues/7/labels", { labels: ["bug", "ui"] }],
            ["DELETE /repos/team/app/issues/7/labels/gone", undefined],
            ["DELETE /repos/team/app/issues/7/labels/needs%20work", undefined],
          ],
        );
      }),
    );
  });

  it.effect(
    "pins a merge to the head, rewrites a message with agent credits, and runs the newer actions",
    () => {
      const commit = (message: string) => ({
        sha: headSha,
        message,
        committer: { date: "2026-11-19T08:50:20Z" },
      });
      const answered = currentPull();
      const gice = fakeGice(
        {
          "GET /repos/team/app/pulls/7": currentPull({ title: "Generated with Claude Code" }),
          "GET /repos/team/app/pulls/7/commits?per_page=100": [
            commit("Generated with Claude Code"),
            commit("Add parser\n\nCo-Authored-By: Claude <noreply@anthropic.com>"),
          ],
          "POST /repos/team/app/pulls/7/merge": answered,
          "PATCH /repos/team/app/pulls/7": answered,
          "POST /repos/team/app/pulls/7/update-branch": answered,
          "PUT /repos/team/app/pulls/7/auto-merge": currentPull({
            auto_merge: { method: "merge" },
          }),
          "DELETE /repos/team/app/pulls/7/auto-merge": answered,
          "DELETE /repos/team/app/pulls/7/head-branch": "",
        },
        CURRENT,
      );
      const act = { ...target, expectedHeadSha: baseSha } as const;
      return provide(gice, (provider) =>
        Effect.all([
          provider.runAction({ ...act, action: "merge", mergeMethod: "squash" }),
          provider.runAction({
            ...target,
            action: "merge",
            mergeMethod: "squash",
            removeAgentCreditsOnMerge: true,
          }),
          // A rebase keeps each commit's own message, so there is none to rewrite.
          provider.runAction({
            ...target,
            action: "merge",
            mergeMethod: "rebase",
            removeAgentCreditsOnMerge: true,
          }),
          provider.runAction({ ...target, action: "ready" }),
          provider.runAction({ ...target, action: "draft" }),
          provider.runAction({ ...act, action: "update-branch", updateMethod: "rebase" }),
          provider.runAction({
            ...target,
            action: "enable-auto-merge",
            removeAgentCreditsOnMerge: true,
          }),
          provider.runAction({ ...target, action: "disable-auto-merge" }),
          provider.runAction({ ...target, action: "delete-branch" }),
          provider.runAction({ ...target, action: "revert" }).pipe(Effect.flip),
        ]),
      ).pipe(
        Effect.map((results) => {
          assert.deepStrictEqual(
            bodies(gice).filter(([path]) => !String(path).startsWith("GET ")),
            [
              [
                "POST /repos/team/app/pulls/7/merge",
                { method: "squash", expected_head_sha: baseSha },
              ],
              [
                "POST /repos/team/app/pulls/7/merge",
                { method: "squash", commit_message: "* Add parser", expected_head_sha: headSha },
              ],
              ["POST /repos/team/app/pulls/7/merge", { method: "rebase" }],
              ["PATCH /repos/team/app/pulls/7", { draft: false }],
              ["PATCH /repos/team/app/pulls/7", { draft: true }],
              [
                "POST /repos/team/app/pulls/7/update-branch",
                { method: "rebase", expected_head_sha: baseSha },
              ],
              ["PUT /repos/team/app/pulls/7/auto-merge", { method: "merge", commit_message: "" }],
              ["DELETE /repos/team/app/pulls/7/auto-merge", undefined],
              ["DELETE /repos/team/app/pulls/7/head-branch", undefined],
            ],
          );
          assert.strictEqual(results[0]?.headSha, headSha);
          assert.strictEqual(results[6]?.autoMergeEnabled, true);
          assert.strictEqual(results[8], undefined);
        }),
      );
    },
  );

  it.effect("tails the one job a check stands for, and reads a file the diff left out", () => {
    const cut = {
      files: [
        { path: "a.ts", status: "modified", additions: 1, deletions: 1 },
        { path: "big.ts", status: "modified", additions: 9000, deletions: 0 },
      ],
      patch:
        "diff --git a/a.ts b/a.ts\nindex 1111111..2222222 100644\ndiff --git a/big.ts b/big.ts\n",
      truncated: true,
    };
    const whole = { files: [cut.files[1]], patch: "diff --git a/big.ts b/big.ts\n" };
    const check = { name: "CI / test", url: "https://gice.example.com/team/app/runs/4?job=12" };
    const gice = fakeGice(
      {
        "GET /repos/team/app/runs/4/jobs/12/logs?tail=3": "one\ntwo\nthree\n",
        "GET /repos/team/app/pulls/7/files": cut,
        "GET /repos/team/app/pulls/7/files?path=big.ts": whole,
      },
      CURRENT,
    );
    return provide(gice, (provider) =>
      Effect.all([
        provider.getCheckLogs!({ ...target, checks: [check], tailLines: 2 }),
        provider.getDiff(target),
        provider.getDiff({ ...target, path: "big.ts" }),
      ]),
    ).pipe(
      Effect.map(([logs, diff, file]) => {
        assert.deepStrictEqual(logs, [
          { ...check, log: "two\nthree", truncated: true, detail: null },
        ]);
        assert.deepStrictEqual(
          [diff.truncated, diff.withheldFilesReadable, diff.omittedFileStats?.[0]?.path],
          [true, true, "big.ts"],
        );
        assert.deepStrictEqual(file, { patch: whole.patch, truncated: false, nextCursor: null });
      }),
    );
  });

  it.effect("fingerprints and follows a pull request through the events feed", () => {
    const event = (id: number, type: string) => ({ id, type });
    const gice = fakeGice(
      {
        "GET /repos/team/app/events?pull=7&limit=100": {
          events: [event(4, "comment.created"), event(5, "pull.pushed")],
          cursor: 5,
        },
        "GET /repos/team/app/events?pull=7&limit=1": {
          events: [event(5, "pull.pushed")],
          cursor: 5,
        },
        // Gice holds each request until something happens; the feed ends when it stops answering.
        "GET /repos/team/app/events?pull=7&since=5&wait=25": {
          events: [event(6, "comment.created")],
          cursor: 6,
        },
      },
      CURRENT,
    );
    const old = fakeGice({});
    return Effect.all([
      provide(gice, (provider) => provider.getChangeRequestWatchFingerprint!(target)),
      provide(gice, (provider) => provider.changeRequestEvents!(target).pipe(Stream.runCount)),
      provide(old, (provider) =>
        Effect.all([
          provider.getChangeRequestWatchFingerprint!(target),
          provider.changeRequestEvents!(target).pipe(Stream.runCount),
          provider.getDiff({ ...target, path: "big.ts" }).pipe(Effect.flip),
        ]),
      ),
    ]).pipe(
      Effect.map(([fingerprint, changes, [unknown, none, file]]) => {
        assert.deepStrictEqual(fingerprint, { status: "5", remarks: "4" });
        // Once on connecting, once for the event that followed.
        assert.strictEqual(changes, 2);
        assert.strictEqual(unknown, null);
        assert.strictEqual(none, 0);
        assert.strictEqual(file.detail, "Gice cannot read one file of this diff.");
        assert.deepStrictEqual(old.sent, []);
      }),
    );
  });
});

describe("GicePullRequestProvider on a server with the later additions", () => {
  const LATEST: ReadonlyArray<GiceApi.GiceFeature> = [
    ...CURRENT,
    "reaction_delete_by_content",
    "pull_review_requested_filter",
    "pull_merge_message",
    "pull_auto_merge_expected_head",
  ];

  it.effect("links a pull request where the server says its page is", () => {
    const page = "http://gice.internal:3947/code/team/app/pulls/7";
    const gice = fakeGice({
      "GET /repos/team/app/pulls/7": pull({ html_url: page }),
      "GET /repos/team/app/pulls/8": pull({ number: 8 }),
    });
    return provide(gice, (provider) =>
      Effect.all([
        provider.getChangeRequestPreview!(target),
        provider.getChangeRequestPreview!({ ...target, number: 8 }),
      ]),
    ).pipe(
      Effect.map((previews) => {
        assert.deepStrictEqual(
          previews.map((preview) => preview.url),
          [page, "https://gice.example.com/team/app/pulls/8"],
        );
      }),
    );
  });

  it.effect("has the server pick the pull requests asking the viewer for a review", () => {
    const asked =
      "GET /repos/team/app/pulls?state=open&per_page=21&page=1&fields=summary&review_requested=Alice";
    const gice = fakeGice({ [asked]: [currentPull({ number: 9 })] }, LATEST);
    return provide(gice, (provider) =>
      provider.listChangeRequests({
        ...target,
        state: "open",
        involvement: "reviewing",
        viewer: " Alice ",
        limit: 20,
      }),
    ).pipe(
      Effect.map((page) => {
        assert.deepStrictEqual(gice.paths(), [asked]);
        // The server's answer stands: the row need not repeat who was asked.
        assert.deepStrictEqual(
          page.items.map((item) => item.number),
          [9],
        );
      }),
    );
  });

  it.effect("takes a reaction back by its content, and one already gone stays gone", () => {
    const gice = fakeGice(
      {
        "DELETE /repos/team/app/issues/7/reactions?content=%2B1": "",
        "DELETE /repos/team/app/pulls/comments/8/reactions?content=eyes": "",
        "POST /repos/team/app/comments/4/reactions": { id: 22, content: "heart" },
      },
      LATEST,
    );
    const react = { ...target, reacted: false } as const;
    return provide(gice, (provider) =>
      Effect.all([
        provider.setReaction({ ...react, content: "thumbs-up" }),
        provider.setReaction({ ...react, subjectId: "review-comment:8", content: "eyes" }),
        provider.setReaction({ ...react, subjectId: "4", content: "rocket" }),
        provider.setReaction({ ...react, subjectId: "4", content: "heart", reacted: true }),
      ]),
    ).pipe(
      Effect.map(() => {
        assert.deepStrictEqual(gice.paths(), [
          "DELETE /repos/team/app/issues/7/reactions?content=%2B1",
          "DELETE /repos/team/app/pulls/comments/8/reactions?content=eyes",
          "DELETE /repos/team/app/comments/4/reactions?content=rocket",
          "POST /repos/team/app/comments/4/reactions",
        ]);
      }),
    );
  });

  it.effect("removes agent credits from the message the server would write", () => {
    const credited = {
      title: "Change (#7)",
      message: "* Add parser\n* Generated with Claude Code",
    };
    const gice = fakeGice(
      {
        "GET /repos/team/app/pulls/7": currentPull(),
        "GET /repos/team/app/pulls/7/merge-message?method=squash": credited,
        "GET /repos/team/app/pulls/7/merge-message?method=merge": {
          title: "Merge pull request #7 from feature",
          message: "Change",
        },
        "POST /repos/team/app/pulls/7/merge": currentPull(),
        "PUT /repos/team/app/pulls/7/auto-merge": currentPull(),
      },
      LATEST,
    );
    const clean = { ...target, removeAgentCreditsOnMerge: true } as const;
    return provide(gice, (provider) =>
      Effect.all([
        provider.runAction({ ...clean, action: "merge", mergeMethod: "squash" }),
        provider.runAction({ ...clean, action: "merge" }),
        provider.runAction({
          ...clean,
          action: "enable-auto-merge",
          mergeMethod: "squash",
          expectedHeadSha: baseSha,
        }),
      ]),
    ).pipe(
      Effect.map(() => {
        assert.deepStrictEqual(
          bodies(gice).filter(([path]) => !String(path).startsWith("GET ")),
          [
            [
              "POST /repos/team/app/pulls/7/merge",
              { method: "squash", commit_message: "* Add parser", expected_head_sha: headSha },
            ],
            // A message without credits is left for the server to write.
            ["POST /repos/team/app/pulls/7/merge", { method: "merge" }],
            [
              "PUT /repos/team/app/pulls/7/auto-merge",
              { method: "squash", commit_message: "* Add parser", expected_head_sha: baseSha },
            ],
          ],
        );
        assert.ok(!gice.paths().includes("GET /repos/team/app/pulls/7/commits?per_page=100"));
      }),
    );
  });

  it.effect("leaves the expected head out of auto-merge on a server that cannot check it", () => {
    const gice = fakeGice({ "PUT /repos/team/app/pulls/7/auto-merge": currentPull() }, CURRENT);
    return provide(gice, (provider) =>
      provider.runAction({ ...target, action: "enable-auto-merge", expectedHeadSha: baseSha }),
    ).pipe(
      Effect.map(() => {
        assert.deepStrictEqual(bodies(gice), [
          ["PUT /repos/team/app/pulls/7/auto-merge", { method: "merge" }],
        ]);
      }),
    );
  });
});
