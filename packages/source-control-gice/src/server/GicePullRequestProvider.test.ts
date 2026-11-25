import { assert, describe, it } from "@effect/vitest";
import type { PullRequestAction } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  acrossPull,
  BASE_SHA,
  comment,
  commit,
  encodeJson,
  event,
  fakeGiceServer,
  feed,
  HEAD_SHA,
  label,
  listing,
  problem,
  pull as pullOf,
  pullSummary,
  reactions,
  reference,
  review,
  reviewComment,
  invalid,
  run,
  type SentRequest,
  stack,
  stackLayer,
  thread,
  user,
  viewed,
  viewedFile,
} from "./GiceApi.testkit.ts";
import * as GicePullRequestProvider from "./GicePullRequestProvider.ts";
import { REMARK_EVENT_TYPES } from "./gicePullRequestJson.ts";

const target = { cwd: "/repo", host: "code.example", repository: "team/app", number: 7 };
const pull = (fields: Record<string, unknown> = {}) => pullOf("team/app", 7, fields);
const PULL_URL = "https://code.example/team/app/pulls/7";
const STATUS = "GET /repos/team/app/status?ref=refs%2Fpull%2F7%2Fhead";
const PULL = "GET /repos/team/app/pulls/7";

type Provider = Effect.Success<typeof GicePullRequestProvider.make>;

/** Runs `use` against a server answering `routes`, handing back what was sent. */
const withServer = <A, E>(
  routes: Parameters<typeof fakeGiceServer>[0],
  use: (provider: Provider) => Effect.Effect<A, E>,
) => {
  const gice = fakeGiceServer(routes);
  return GicePullRequestProvider.make.pipe(
    Effect.flatMap(use),
    Effect.map((result) => ({ result, gice })),
    Effect.provide(gice.layer),
  );
};

const writes = (bodies: ReadonlyArray<readonly [string, unknown]>) =>
  bodies.filter(([route]) => !route.startsWith("GET "));

describe("GicePullRequestProvider reads", () => {
  it.effect("summarizes a pull request from the pull request alone", () =>
    withServer({ [PULL]: pull({ checks_state: "failure" }) }, (provider) =>
      provider.getChangeRequestSummary!(target),
    ).pipe(
      Effect.map(({ result: summary, gice }) => {
        assert.deepStrictEqual(
          [summary.headSha, summary.checksState, summary.changedFiles, summary.autoMergeEnabled],
          [HEAD_SHA, "failing", 3, false],
        );
        assert.deepStrictEqual(gice.paths(), [PULL]);
      }),
    ),
  );

  it.effect("reads the detail from the pull request and the checks of its head", () =>
    withServer(
      {
        [PULL]: pull({ requested_reviewers: [user("bob")] }),
        [STATUS]: { sha: HEAD_SHA, state: "failure", runs: [run(4, { conclusion: "failure" })] },
      },
      (provider) => provider.getChangeRequest(target),
    ).pipe(
      Effect.map(({ result: detail }) => {
        assert.deepStrictEqual(
          {
            headSha: detail.headSha,
            additions: detail.additions,
            changedFiles: detail.changedFiles,
            reviewers: detail.reviewers.map((reviewer) => reviewer.login),
            checks: detail.checks.map((check) => [check.name, check.status, check.url]),
            baseComparison: detail.baseComparison,
            mergeCapabilities: detail.mergeCapabilities,
          },
          {
            headSha: HEAD_SHA,
            additions: 12,
            changedFiles: 3,
            reviewers: ["bob"],
            checks: [["CI (pull_request)", "failure", "https://code.example/team/app/runs/4"]],
            baseComparison: "behind",
            mergeCapabilities: { merge: true, squash: true, rebase: true },
          },
        );
      }),
    ),
  );

  it.effect("gives the same permissions and checks on their own as in the detail", () =>
    withServer(
      {
        // Restacking is the stack's own permission, read with a pull request in one.
        [PULL]: pull({ stack: { parent: 6, children: [], position: 2, size: 2, bottom: 6 } }),
        [`${PULL}/stack`]: stack(7, [
          stackLayer(6, { children: [7] }),
          stackLayer(7, { parent: 6 }),
        ]),
        [STATUS]: { sha: HEAD_SHA, state: "success", runs: [run(4)] },
      },
      (provider) =>
        Effect.all([
          provider.getChangeRequest(target),
          provider.getViewerPermissions(target),
          provider.getChangeRequestChecks!(target),
        ]),
    ).pipe(
      Effect.map(({ result: [detail, permissions, checks] }) => {
        assert.deepStrictEqual(permissions, detail.viewerPermissions);
        assert.isTrue(permissions.stackRebase);
        assert.deepStrictEqual(checks, { state: "open", checks: detail.checks });
      }),
    ),
  );

  it.effect("reads a pull request whose checks cannot be read, and fails the checks alone", () =>
    withServer(
      { [PULL]: pull(), [STATUS]: () => problem(500, "internal", "database is locked") },
      (provider) =>
        Effect.all([
          provider.getChangeRequest(target),
          Effect.flip(provider.getChangeRequestChecks!(target)),
        ]),
    ).pipe(
      Effect.map(({ result: [detail, checksError] }) => {
        assert.deepStrictEqual([detail.number, detail.checks], [7, []]);
        assert.strictEqual(checksError.detail, "database is locked");
      }),
    ),
  );

  it.effect("reads a pull request whose commits are gone without checks", () =>
    withServer({ [PULL]: pull({ state: "closed", head_sha: null, mergeable: null }) }, (provider) =>
      Effect.all([provider.getChangeRequest(target), provider.getChangeRequestSummary!(target)]),
    ).pipe(
      Effect.map(({ result: [detail, summary] }) => {
        assert.deepStrictEqual(
          [detail.headSha, detail.checks, detail.checksState],
          [null, [], null],
        );
        assert.isFalse("headSha" in summary);
      }),
    ),
  );
});

describe("GicePullRequestProvider listings", () => {
  const list = {
    ...target,
    state: "open",
    involvement: "all",
    viewer: " Alice ",
    limit: 20,
  } as const;

  it.effect("lists a page of the limit's size, and a full one may be followed", () =>
    withServer(
      {
        "GET /repos/team/app/pulls?state=open&sort=updated&per_page=2&page=1&fields=summary&author=alice":
          [pullSummary("team/app", 9), pullSummary("team/app", 8)],
      },
      (provider) =>
        provider.listChangeRequests({
          ...target,
          state: "open",
          involvement: "authored",
          viewer: "alice",
          limit: 2,
        }),
    ).pipe(
      Effect.map(({ result: page }) => {
        assert.deepStrictEqual(
          page.items.map((item) => item.number),
          [9, 8],
        );
        assert.deepStrictEqual(
          [page.truncated, page.continues, page.cursorAdvance],
          [true, true, 2],
        );
      }),
    ),
  );

  it.effect("names each listed layer's stack after its bottom pull request", () => {
    const layer = (number: number, stackFields: Record<string, unknown>) =>
      pullSummary("team/app", number, {
        stack: { parent: null, children: [], size: 3, bottom: 6, ...stackFields },
      });
    return withServer(
      {
        "GET /repos/team/app/pulls?state=open&sort=updated&per_page=20&page=1&fields=summary": [
          layer(8, { parent: 7, position: 3 }),
          layer(7, { parent: 6, children: [8], position: 2 }),
          layer(6, { children: [7], position: 1 }),
          pullSummary("team/app", 9),
        ],
      },
      (provider) => provider.listChangeRequests(list),
    ).pipe(
      Effect.map(({ result: page }) =>
        assert.deepStrictEqual(
          page.items.map((item) => [item.number, item.stack?.number, item.stack?.position]),
          [
            [8, 6, 3],
            [7, 6, 2],
            [6, 6, 1],
            [9, undefined, undefined],
          ],
        ),
      ),
    );
  });

  it.effect("continues from the row the cursor reached, below the time it reached", () => {
    const boundary = "2026-11-19T09:01:40Z";
    return withServer(
      {
        "GET /repos/team/app/pulls?state=all&sort=updated&per_page=20&page=1&fields=summary": [
          ...Array.from({ length: 3 }, (_, index) => pullSummary("team/app", 30 - index)),
          // Updated since the first page was read, so it moved up past rows already delivered.
          pullSummary("team/app", 12, { updated_at: "2026-11-19T10:00:00Z" }),
          pullSummary("team/app", 11, { updated_at: boundary }),
          pullSummary("team/app", 10, { updated_at: "2026-11-19T08:00:00Z" }),
        ],
      },
      (provider) =>
        provider.listChangeRequests({
          ...target,
          state: "all",
          involvement: "all",
          viewer: "alice",
          limit: 20,
          cursor: { updatedBefore: boundary, delivered: 3 },
        }),
    ).pipe(
      Effect.map(({ result: page }) => {
        assert.deepStrictEqual(
          [page.items.map((item) => item.number), page.cursorAdvance, page.truncated],
          [[11, 10], 3, false],
        );
      }),
    );
  });

  it.effect("has the server narrow by author, draft, text, single labels and checks", () => {
    const narrowed =
      "GET /repos/team/app/pulls?state=open&sort=updated&per_page=20&page=1&fields=summary&author=carol&draft=false&q=fix+parser&labels=bug%2Cui&checks=failure";
    return withServer({ [narrowed]: [pullSummary("team/app", 8)] }, (provider) =>
      provider.listChangeRequests({
        ...list,
        query: " fix parser ",
        filters: {
          author: "carol",
          draft: "hide",
          labels: [["bug"], ["a", "b"], ["ui"]],
          checks: "failing",
        },
      }),
    ).pipe(
      Effect.map(({ result, gice }) => {
        assert.deepStrictEqual(gice.paths(), [narrowed]);
        // The server's answer stands: a row need not repeat what it was picked by.
        assert.deepStrictEqual(
          result.items.map((item) => item.number),
          [8],
        );
      }),
    );
  });

  it.effect("asks for the pull requests awaiting the viewer's review", () => {
    const reviewing =
      "GET /repos/team/app/pulls?state=open&sort=updated&per_page=20&page=1&fields=summary&review_requested=Alice";
    return withServer({ [reviewing]: [pullSummary("team/app", 9)] }, (provider) =>
      provider.listChangeRequests({ ...list, involvement: "reviewing" }),
    ).pipe(Effect.map(({ gice }) => assert.deepStrictEqual(gice.paths(), [reviewing])));
  });
});

describe("GicePullRequestProvider listings across repositories", () => {
  const across = {
    cwd: "/repo",
    host: "code.example",
    repositories: ["team/app", "team/web"],
    state: "open",
    involvement: "reviewing",
    viewer: "alice",
    limit: 2,
  } as const;

  const ROUTE =
    "GET /pulls?state=open&sort=updated&per_page=2&page=1&fields=summary&review_requested=alice&repos=team%2Fapp%2Cteam%2Fweb";

  it.effect("reads the newest updated of several repositories in one request", () =>
    withServer(
      {
        [ROUTE]: listing(
          [
            acrossPull("team/web", 4, { updated_at: "2026-11-19T11:00:00Z" }),
            // Counts Gice has not worked out for the row's head yet.
            acrossPull("team/app", 9, {
              cross_repo: true,
              head_repo: null,
              additions: null,
              deletions: null,
              changed_files: null,
            }),
          ],
          3,
          "YzE6dXBkYXRlZDpkZXNjOjE3OTUxODk0NzA6MTM",
        ),
      },
      (provider) => provider.listChangeRequestsAcross!(across),
    ).pipe(
      Effect.map(({ result, gice }) => {
        assert.deepStrictEqual(gice.paths(), [ROUTE]);
        assert.deepStrictEqual(
          result.items.map((item) => [
            item.repository,
            item.number,
            item.headRepositoryNameWithOwner,
            item.additions + item.deletions > 0,
          ]),
          [
            ["team/web", 4, "team/web", true],
            // A listing without counts says none, which clients show as no counts at all.
            ["team/app", 9, null, false],
          ],
        );
        assert.deepStrictEqual(
          [result.truncated, result.resumeAfter],
          [true, "YzE6dXBkYXRlZDpkZXNjOjE3OTUxODk0NzA6MTM"],
        );
      }),
    ),
  );

  it.effect("carries on from where Gice said its last page stopped", () => {
    const route =
      "GET /pulls?state=open&sort=updated&per_page=2&fields=summary&review_requested=alice&repos=team%2Fapp%2Cteam%2Fweb&cursor=YzE6dXBkYXRlZDpkZXNjOjE3OTUxODk0NzA6MTM";
    return withServer({ [route]: listing([acrossPull("team/app", 2)], 3) }, (provider) =>
      provider.listChangeRequestsAcross!({
        ...across,
        cursor: {
          updatedBefore: "2026-11-19T09:01:40Z",
          delivered: 2,
          resumeAfter: "YzE6dXBkYXRlZDpkZXNjOjE3OTUxODk0NzA6MTM",
        },
      }),
    ).pipe(
      Effect.map(({ result, gice }) => {
        assert.deepStrictEqual(gice.paths(), [route]);
        assert.deepStrictEqual(
          [result.items.map((item) => item.number), result.truncated, result.resumeAfter],
          [[2], false, undefined],
        );
      }),
    );
  });

  it.effect("shows each layer's stack, and leaves rows Gice gave none to their own read", () => {
    const layer = (number: number, stackFields: Record<string, unknown>) =>
      acrossPull("team/app", number, {
        base: number === 6 ? "main" : `layer-${number - 1}`,
        stack: { parent: null, children: [], size: 2, bottom: 6, ...stackFields },
      });
    const { stack: _, ...unstacked }: Record<string, unknown> = acrossPull("team/web", 4);
    const input = { ...across, limit: 3 };
    return withServer(
      {
        [ROUTE.replace("per_page=2", "per_page=3")]: listing(
          [
            layer(7, { parent: 6, position: 2 }),
            layer(6, { children: [7], position: 1 }),
            unstacked,
          ],
          3,
        ),
      },
      (provider) => provider.listChangeRequestsAcross!(input),
    ).pipe(
      Effect.map(({ result }) => {
        assert.deepStrictEqual(
          result.items.map((item) => [item.number, item.stack]),
          [
            [7, { number: 6, position: 2, size: 2, base: "main" }],
            [6, { number: 6, position: 1, size: 2, base: "main" }],
          ],
        );
        assert.deepStrictEqual(result.unresolved, ["team/web"]);
      }),
    );
  });

  // Gice leaves out a repository the token cannot read as it does one with no rows, so silence
  // vouches only for a repository already read: the others are read on their own, once.
  it.effect("leaves a silent repository to its own read until it has been read", () => {
    const route =
      "GET /pulls?state=open&sort=updated&per_page=2&page=1&fields=summary&review_requested=alice&repos=team%2Fapp%2Cteam%2Fweb%2Cteam%2Fdocs";
    const own = (repository: string) =>
      `GET /repos/${repository}/pulls?state=open&sort=updated&per_page=2&page=1&fields=summary&review_requested=alice`;
    const input = { ...across, repositories: ["team/app", "team/web", "team/docs"] };
    return withServer(
      {
        [route]: () => listing([acrossPull("team/web", 4)], 1),
        [own("team/app")]: listing([], 0),
      },
      (provider) =>
        Effect.gen(function* () {
          const first = yield* provider.listChangeRequestsAcross!(input);
          const { repositories: _, ...one } = input;
          yield* provider.listChangeRequests({ ...one, repository: "team/app" });
          const second = yield* provider.listChangeRequestsAcross!(input);
          return [first.unresolved, second.unresolved];
        }),
    ).pipe(
      Effect.map(({ result }) =>
        assert.deepStrictEqual(result, [["team/app", "team/docs"], ["team/docs"]]),
      ),
    );
  });

  it.effect.each([
    {
      name: "a page carried on from each repository's own read",
      input: { cursor: { updatedBefore: "2026-11-19T09:01:40Z", delivered: 2 } },
    },
    { name: "a checks filter", input: { filters: { checks: "passing" } } },
  ] as const)("leaves $name to each repository's own read", ({ input }) =>
    withServer({}, (provider) => provider.listChangeRequestsAcross!({ ...across, ...input })).pipe(
      Effect.map(({ result, gice }) => {
        assert.deepStrictEqual(result, {
          items: [],
          truncated: false,
          unresolved: ["team/app", "team/web"],
        });
        assert.deepStrictEqual(gice.sent, []);
      }),
    ),
  );
});

describe("GicePullRequestProvider activity", () => {
  const COMMENTS = "GET /repos/team/app/issues/7/comments?per_page=100";
  const routes = {
    [`${COMMENTS}&page=1`]: Array.from({ length: 100 }, (_, index) => comment(PULL_URL, index + 1)),
    [`${COMMENTS}&page=2`]: [comment(PULL_URL, 101)],
    "GET /repos/team/app/pulls/7/commits?per_page=100&page=1": [
      commit(HEAD_SHA, { message: "Second" }),
      commit(BASE_SHA, { message: "First\n\nBody" }),
    ],
    "GET /repos/team/app/pulls/7/reviews?per_page=100&page=1": [
      review(2, { body: "Fix", state: "CHANGES_REQUESTED" }),
      review(3, { user: user("carol") }),
    ],
    "GET /repos/team/app/pulls/7/threads?per_page=100&page=1": [
      thread(5, { comments: [reviewComment(8, { pull_request_review_id: 3 })] }),
    ],
    [PULL]: pull({
      requested_reviewers: [user("dave")],
      reactions: reactions({ heart: 1 }),
      viewer_reactions: ["heart"],
    }),
  };
  const activity = withServer(routes, (provider) => provider.getChangeRequestActivity(target)).pipe(
    Effect.map(({ result }) => result),
  );

  it.effect("reads every page of comments", () =>
    activity.pipe(
      Effect.map((read) => {
        assert.deepStrictEqual(
          [read.commentCount, read.commentsTruncated, read.comments.at(-1)?.id],
          [102, false, "review:2"],
        );
      }),
    ),
  );

  it.effect("leaves out the empty review that carries an inline comment", () =>
    activity.pipe(
      Effect.map((read) =>
        assert.deepStrictEqual(
          read.comments.filter((remark) => remark.kind === "review").map((remark) => remark.id),
          ["review:2"],
        ),
      ),
    ),
  );

  it.effect("puts the commits oldest first", () =>
    activity.pipe(
      Effect.map((read) =>
        assert.deepStrictEqual(
          read.commits.map((entry) => entry.messageHeadline),
          ["First", "Second"],
        ),
      ),
    ),
  );

  it.effect("names a thread by itself and its first comment", () =>
    activity.pipe(
      Effect.map((read) => {
        assert.deepStrictEqual(
          read.reviewThreads.map((thread) => [thread.id, thread.comments[0]?.reviewUrl]),
          [["5:8", `${PULL_URL}#review-3`]],
        );
      }),
    ),
  );

  it.effect("names those asked to review, then those who reviewed", () =>
    activity.pipe(
      Effect.map((read) =>
        assert.deepStrictEqual(
          read.reviewers?.map((reviewer) => reviewer.login),
          ["dave", "bob"],
        ),
      ),
    ),
  );

  it.effect("carries the description's reactions", () =>
    activity.pipe(
      Effect.map((read) =>
        assert.deepStrictEqual(read.reactions, [
          { content: "heart", count: 1, actors: [], viewerHasReacted: true },
        ]),
      ),
    ),
  );
});

describe("GicePullRequestProvider diffs", () => {
  /** `GET R/commits/{sha}`: the commit with its own changes. */
  const commitDetail = (fields: Record<string, unknown>) =>
    commit(HEAD_SHA, { message: "Second", files: [], patch: "", ...fields });
  const files = [
    { path: "a.ts", status: "modified", additions: 1, deletions: 1, is_binary: false },
    {
      path: "new.ts",
      old_path: "old.ts",
      status: "renamed",
      additions: 2,
      deletions: 2,
      is_binary: false,
    },
    { path: "big.ts", status: "modified", additions: 9000, deletions: 0, is_binary: false },
  ];

  it.effect("reads a commit's own diff", () =>
    withServer(
      {
        [`GET /repos/team/app/commits/${HEAD_SHA}`]: commitDetail({ files, patch: "commit patch" }),
      },
      (provider) => provider.getDiff({ ...target, commit: HEAD_SHA }),
    ).pipe(
      Effect.map(({ result }) =>
        assert.deepStrictEqual(result, {
          patch: "commit patch",
          truncated: false,
          nextCursor: null,
        }),
      ),
    ),
  );

  it.effect("lists a pull request's changed paths without its patch", () =>
    withServer({ "GET /repos/team/app/pulls/7/files?patch=false": { files } }, (provider) =>
      provider.getDiffFilePaths!(target),
    ).pipe(
      Effect.map(({ result }) =>
        assert.deepStrictEqual(result, {
          files: [
            { oldPath: "a.ts", newPath: "a.ts" },
            { oldPath: "old.ts", newPath: "new.ts" },
            { oldPath: "big.ts", newPath: "big.ts" },
          ],
          nextCursor: null,
        }),
      ),
    ),
  );

  it.effect("reads one file a cut patch withheld", () => {
    const patch = "diff --git a/big.ts b/big.ts\nindex 3333333..4444444 100644\n";
    return withServer(
      { "GET /repos/team/app/pulls/7/files?path=big.ts": { files: [files[2]], patch } },
      (provider) => provider.getDiff({ ...target, path: "big.ts" }),
    ).pipe(
      Effect.map(({ result }) =>
        assert.deepStrictEqual(result, { patch, truncated: false, nextCursor: null }),
      ),
    );
  });

  it.effect("cannot read one file of a commit's diff", () =>
    withServer({}, (provider) =>
      provider.getDiff({ ...target, commit: HEAD_SHA, path: "big.ts" }).pipe(Effect.flip),
    ).pipe(
      Effect.map(({ result, gice }) => {
        assert.strictEqual(result.detail, "Gice cannot read one file of this diff.");
        assert.deepStrictEqual(gice.sent, []);
      }),
    ),
  );

  const blob = (path: string, text: string) => ({
    path,
    sha: "6553fd46d32386f84d3ccace520ab2af32293354",
    size: Buffer.byteLength(text),
    is_binary: false,
    content: Buffer.from(text).toString("base64"),
  });

  it.effect("reads both sides of a file at the pull request's merge base and head", () =>
    withServer(
      {
        [PULL]: pull(),
        [`GET /repos/team/app/blob?ref=${BASE_SHA}&path=src%2Fold+name.ts`]: blob(
          "src/old name.ts",
          "before ✓",
        ),
        [`GET /repos/team/app/blob?ref=${HEAD_SHA}&path=src%2Fa.ts`]: blob("src/a.ts", "after"),
      },
      (provider) =>
        provider.getDiffFileContents!({
          ...target,
          changeType: "rename-changed",
          oldPath: "src/old name.ts",
          newPath: "src/a.ts",
        }),
    ).pipe(
      Effect.map(({ result, gice }) => {
        assert.deepStrictEqual(result, { oldContents: "before ✓", newContents: "after" });
        assert.strictEqual(gice.sent.length, 3);
      }),
    ),
  );

  const added = (path: string) =>
    ({ ...target, commit: HEAD_SHA, changeType: "new", oldPath: path, newPath: path }) as const;
  const commitRoute = {
    [`GET /repos/team/app/commits/${HEAD_SHA}`]: commitDetail({}),
  };

  it.effect("refuses a binary file", () =>
    withServer(
      {
        ...commitRoute,
        [`GET /repos/team/app/blob?ref=${HEAD_SHA}&path=logo.png`]: {
          path: "logo.png",
          sha: HEAD_SHA,
          size: 9,
          is_binary: true,
        },
      },
      (provider) => provider.getDiffFileContents!(added("logo.png")).pipe(Effect.flip),
    ).pipe(
      Effect.map(({ result }) =>
        assert.strictEqual(result.detail, "Gice cannot provide this file as text."),
      ),
    ),
  );

  it.effect("refuses a file too large for Gice to send", () =>
    withServer(
      {
        ...commitRoute,
        [`GET /repos/team/app/blob?ref=${HEAD_SHA}&path=big.txt`]: {
          path: "big.txt",
          sha: HEAD_SHA,
          size: 2_000_000,
          is_binary: false,
        },
      },
      (provider) => provider.getDiffFileContents!(added("big.txt")).pipe(Effect.flip),
    ).pipe(
      Effect.map(({ result }) =>
        assert.strictEqual(result.detail, "This file is too large for Gice to provide as text."),
      ),
    ),
  );
});

describe("GicePullRequestProvider viewed files", () => {
  const VIEWED = "/repos/team/app/pulls/7/viewed";

  it.effect("reads the reader's marks, one changed since being marked", () =>
    withServer(
      {
        [`GET ${VIEWED}`]: viewed([
          viewedFile("README.md"),
          viewedFile("a.ts", { viewed: true, viewed_at: "2026-11-20T08:44:48Z" }),
          viewedFile("b.ts", { dismissed: true, viewed_at: "2026-11-20T08:44:48Z" }),
          viewedFile("gone.ts", { sha: null }),
        ]),
      },
      (provider) => provider.getFilesViewed!(target),
    ).pipe(
      Effect.map(({ result }) =>
        assert.deepStrictEqual(result, {
          files: [
            { path: "README.md", state: "unviewed" },
            { path: "a.ts", state: "viewed" },
            { path: "b.ts", state: "dismissed" },
            { path: "gone.ts", state: "unviewed" },
          ],
          truncated: false,
        }),
      ),
    ),
  );

  it.effect("marks each file at the version shown, and leaves one pushed since unmarked", () => {
    const shown = "bc3bc7d9b1a1e7d5f0c6a0b7e8d9c0f1a2b3c4d5";
    const pushed = "fc5b4fa0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6";
    return withServer(
      {
        "GET /repos/team/app/pulls/7/files?patch=false": {
          files: [
            { path: "a.ts", status: "modified", additions: 1, deletions: 0, sha: shown },
            { path: "b.ts", status: "modified", additions: 1, deletions: 0, sha: pushed },
            { path: "gone.ts", status: "deleted", additions: 0, deletions: 1 },
          ],
        },
        [`PUT ${VIEWED}`]: viewed([]),
      },
      (provider) =>
        provider.setFilesViewed!({
          ...target,
          files: [
            { path: "a.ts", viewed: true, revision: "BC3BC7D" },
            { path: "b.ts", viewed: true, revision: "bc3bc7d" },
            { path: "gone.ts", viewed: true, revision: "0000000" },
            { path: "c.ts", viewed: false, revision: "1234567" },
            { path: "d.ts", viewed: true },
          ],
        }),
    ).pipe(
      Effect.map(({ gice }) =>
        assert.deepStrictEqual(writes(gice.bodies()), [
          [
            `PUT ${VIEWED}`,
            {
              files: [
                { path: "a.ts", viewed: true, sha: shown },
                { path: "gone.ts", viewed: true, sha: "" },
                { path: "c.ts", viewed: false },
                { path: "d.ts", viewed: true },
              ],
            },
          ],
        ]),
      ),
    );
  });

  it.effect("writes nothing when every file shown was pushed since", () =>
    withServer(
      {
        "GET /repos/team/app/pulls/7/files?patch=false": {
          files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0, sha: HEAD_SHA }],
        },
      },
      (provider) =>
        provider.setFilesViewed!({
          ...target,
          files: [{ path: "a.ts", viewed: true, revision: "bc3bc7d" }],
        }),
    ).pipe(Effect.map(({ gice }) => assert.deepStrictEqual(writes(gice.bodies()), []))),
  );
});

describe("GicePullRequestProvider actions", () => {
  const P = "/repos/team/app/pulls/7";
  const pinned = { expectedHeadSha: BASE_SHA } as const;
  const answers = {
    [`POST ${P}/merge`]: pull({
      state: "merged",
      merged: true,
      merged_at: "2026-11-19T09:01:40Z",
      closed_at: "2026-11-19T09:01:40Z",
      mergeable: null,
    }),
    [`PATCH ${P}`]: (request: SentRequest) =>
      pull((request.body as { state?: string }).state === "closed" ? { state: "closed" } : {}),
    [`POST ${P}/update-branch`]: pull(),
    [`PUT ${P}/auto-merge`]: pull({
      auto_merge: {
        enabled_by: user("alice"),
        method: "merge",
        commit_title: null,
        commit_message: null,
        enabled_at: "2026-11-19T09:01:40Z",
      },
    }),
    [`DELETE ${P}/auto-merge`]: pull(),
    [`GET ${P}`]: pull({ state: "merged" }),
    [`DELETE ${P}/head-branch`]: new Response(null, { status: 204 }),
    [`POST ${P}/revert`]: () =>
      new Response(
        encodeJson(pull({ number: 8, title: 'Revert "Change"', head: "revert-7-feature" })),
        { status: 201 },
      ),
  };

  it.effect.each<{
    readonly action: PullRequestAction;
    readonly input?: Record<string, unknown>;
    readonly sent: readonly [string, unknown];
  }>([
    {
      action: "merge",
      input: { ...pinned, mergeMethod: "squash" },
      sent: [`POST ${P}/merge`, { method: "squash", expected_head_sha: BASE_SHA }],
    },
    // Gice refuses a pin that is not a full object id; the merge never runs unpinned.
    {
      action: "merge",
      input: { expectedHeadSha: "ABC1234" },
      sent: [`POST ${P}/merge`, { method: "merge", expected_head_sha: "ABC1234" }],
    },
    { action: "ready", sent: [`PATCH ${P}`, { draft: false }] },
    { action: "draft", sent: [`PATCH ${P}`, { draft: true }] },
    { action: "close", sent: [`PATCH ${P}`, { state: "closed" }] },
    { action: "reopen", sent: [`PATCH ${P}`, { state: "open" }] },
    {
      action: "update-branch",
      input: { ...pinned, updateMethod: "rebase" },
      sent: [`POST ${P}/update-branch`, { method: "rebase", expected_head_sha: BASE_SHA }],
    },
    {
      action: "enable-auto-merge",
      input: pinned,
      sent: [`PUT ${P}/auto-merge`, { method: "merge", expected_head_sha: BASE_SHA }],
    },
    { action: "disable-auto-merge", sent: [`DELETE ${P}/auto-merge`, undefined] },
    // Gice deletes it only while no pull request is based on it, as when it was read.
    {
      action: "delete-branch",
      sent: [`DELETE ${P}/head-branch`, { expected_head_branch_pulls: [] }],
    },
    { action: "revert", sent: [`POST ${P}/revert`, undefined] },
  ])("sends $action to its route", ({ action, input, sent }) =>
    withServer(answers, (provider) => provider.runAction({ ...target, ...input, action })).pipe(
      Effect.map(({ gice }) => assert.deepStrictEqual(writes(gice.bodies()), [sent])),
    ),
  );

  it.effect("keeps a branch other pull requests are based on, which only Gice lists", () =>
    withServer(
      { ...answers, [`GET ${P}`]: pull({ state: "merged", head_branch_pulls: [8, 9] }) },
      (provider) => provider.runAction({ ...target, action: "delete-branch" }).pipe(Effect.flip),
    ).pipe(
      Effect.map(({ result, gice }) => {
        assert.strictEqual(
          result.detail,
          "#8, #9 are based on feature, and deleting it moves them to another base. Delete it on Gice, which lists them first, or change their base.",
        );
        assert.deepStrictEqual(writes(gice.bodies()), []);
      }),
    ),
  );

  // The pull request Gice answers a revert with is the new one, not the reverted.
  it.effect("answers a revert with nothing of the pull request it reverts", () =>
    withServer(answers, (provider) => provider.runAction({ ...target, action: "revert" })).pipe(
      Effect.map(({ result }) => assert.isUndefined(result)),
    ),
  );

  it.effect("answers a merge with the merged pull request", () =>
    withServer(answers, (provider) => provider.runAction({ ...target, action: "merge" })).pipe(
      Effect.map(({ result }) =>
        assert.deepStrictEqual(
          [result?.state, result?.mergedAt],
          ["merged", "2026-11-19T09:01:40.000Z"],
        ),
      ),
    ),
  );

  it.effect("answers auto-merge with its method", () =>
    withServer(answers, (provider) =>
      provider.runAction({ ...target, action: "enable-auto-merge" }),
    ).pipe(
      Effect.map(({ result }) =>
        assert.deepStrictEqual(
          [result?.autoMergeEnabled, result?.autoMergeMethod],
          [true, "merge"],
        ),
      ),
    ),
  );

  const messages = {
    [PULL]: pull(),
    "GET /repos/team/app/pulls/7/merge-message?method=squash": {
      title: "Change (#7)",
      message: "* Add parser\n* Generated with Claude Code",
    },
    "GET /repos/team/app/pulls/7/merge-message?method=merge": {
      title: "Merge pull request #7 from feature",
      message: "Change",
    },
    [`POST ${P}/merge`]: pull(),
    [`PUT ${P}/auto-merge`]: pull(),
  };
  const clean = { ...target, removeAgentCreditsOnMerge: true } as const;

  it.effect("removes agent credits from the message Gice would write, pinned to its head", () =>
    withServer(messages, (provider) =>
      provider.runAction({ ...clean, action: "merge", mergeMethod: "squash" }),
    ).pipe(
      Effect.map(({ gice }) =>
        assert.deepStrictEqual(writes(gice.bodies()), [
          [
            `POST ${P}/merge`,
            { method: "squash", commit_message: "* Add parser", expected_head_sha: HEAD_SHA },
          ],
        ]),
      ),
    ),
  );

  it.effect("leaves a message without credits for Gice to write", () =>
    withServer(messages, (provider) => provider.runAction({ ...clean, action: "merge" })).pipe(
      Effect.map(({ gice }) =>
        assert.deepStrictEqual(writes(gice.bodies()), [[`POST ${P}/merge`, { method: "merge" }]]),
      ),
    ),
  );

  it.effect("has no message to rewrite for a rebase, which keeps each commit's own", () =>
    withServer(messages, (provider) =>
      provider.runAction({ ...clean, action: "merge", mergeMethod: "rebase" }),
    ).pipe(
      Effect.map(({ gice }) =>
        assert.deepStrictEqual(gice.bodies(), [[`POST ${P}/merge`, { method: "rebase" }]]),
      ),
    ),
  );

  it.effect("removes agent credits from an auto-merge's message, keeping the caller's head", () =>
    withServer(messages, (provider) =>
      provider.runAction({
        ...clean,
        action: "enable-auto-merge",
        mergeMethod: "squash",
        expectedHeadSha: BASE_SHA,
      }),
    ).pipe(
      Effect.map(({ gice }) =>
        assert.deepStrictEqual(writes(gice.bodies()), [
          [
            `PUT ${P}/auto-merge`,
            { method: "squash", commit_message: "* Add parser", expected_head_sha: BASE_SHA },
          ],
        ]),
      ),
    ),
  );

  it.effect("passes Gice's refusal of a merge on", () =>
    withServer(
      { [`POST ${P}/merge`]: problem(409, "conflict", "pull request is closed") },
      (provider) => provider.runAction({ ...target, action: "merge" }).pipe(Effect.flip),
    ).pipe(
      Effect.map(({ result }) =>
        assert.deepStrictEqual(
          [result.reason, result.detail],
          ["failed", "pull request is closed"],
        ),
      ),
    ),
  );

  it.effect("passes on when a throttled server said to try again", () =>
    withServer(
      { [`POST ${P}/merge`]: problem(429, "rate_limited", "slow down", { "retry-after": "30" }) },
      (provider) => provider.runAction({ ...target, action: "merge" }).pipe(Effect.flip),
    ).pipe(
      Effect.map(({ result }) => {
        assert.strictEqual(result.reason, "rate-limited");
        assert.isNumber(result.retryAt);
      }),
    ),
  );

  it.effect("reports a missing permission as forbidden", () =>
    withServer(
      { [`PATCH ${P}`]: problem(403, "forbidden", "only the author can edit this") },
      (provider) => provider.runAction({ ...target, action: "close" }).pipe(Effect.flip),
    ).pipe(Effect.map(({ result }) => assert.strictEqual(result.reason, "forbidden"))),
  );

  it.effect.each([
    {
      input: { action: "merge", mergeMethod: "fast-forward" },
      detail: "Gice has no fast-forward merge.",
    },
    {
      input: { action: "approve-workflows" },
      detail: "Gice cannot approve-workflows a pull request.",
    },
  ] as const)("declines $input.action $input.mergeMethod without asking", ({ input, detail }) =>
    withServer({}, (provider) =>
      provider.runAction({ ...target, ...input }).pipe(Effect.flip),
    ).pipe(
      Effect.map(({ result, gice }) => {
        assert.strictEqual(result.detail, detail);
        assert.deepStrictEqual(gice.sent, []);
      }),
    ),
  );
});

describe("GicePullRequestProvider stacks", () => {
  const P = "/repos/team/app/pulls";
  // #5 was squash-merged and deleting its branch moved #6 onto main; #7 is built on #6.
  const layers = [
    stackLayer(5, { state: "merged", children: [6] }),
    stackLayer(6, { parent: 5, children: [7], head_sha: HEAD_SHA, needs_restack: true }),
    stackLayer(7, { parent: 6, base: "layer-6", head_sha: BASE_SHA }),
  ];
  const shown = [
    { number: 6, headSha: HEAD_SHA },
    { number: 7, headSha: BASE_SHA },
  ];
  const sentHeads = [
    { number: 6, sha: HEAD_SHA },
    { number: 7, sha: BASE_SHA },
  ];
  const top = { ...target, stackNumber: 5, expectedStackHeads: shown } as const;
  const merge = { ...top, action: "merge", mergeMethod: "squash" } as const;
  const rebase = { ...top, action: "update-branch", updateMethod: "rebase" } as const;
  const done = (fields: Record<string, unknown>) => ({
    stopped: null,
    stack: stack(7, layers),
    ...fields,
  });

  it.effect("reads a pull request's stack", () =>
    withServer({ [`GET ${P}/7/stack`]: stack(7, layers) }, (provider) =>
      provider.getChangeRequestStack!(target),
    ).pipe(
      Effect.map(({ result }) =>
        assert.deepStrictEqual(
          [result?.number, result?.base, result?.layers.map((layer) => layer.number)],
          [5, "main", [5, 6, 7]],
        ),
      ),
    ),
  );

  it.effect("merges the layers up to the pull request at the heads shown", () =>
    withServer({ [`POST ${P}/7/stack/merge`]: done({ merged: [6, 7] }) }, (provider) =>
      provider.runAction(merge),
    ).pipe(
      Effect.map(({ gice }) =>
        assert.deepStrictEqual(gice.bodies(), [
          [`POST ${P}/7/stack/merge`, { method: "squash", expected_heads: sentHeads }],
        ]),
      ),
    ),
  );

  it.effect("rebases the stack from its lowest open layer, at the heads shown", () =>
    withServer(
      {
        [`GET ${P}/7/stack`]: stack(7, layers),
        [`POST ${P}/6/stack/restack`]: done({ restacked: [6, 7], up_to_date: [] }),
      },
      (provider) => provider.runAction(rebase),
    ).pipe(
      Effect.map(({ gice }) =>
        assert.deepStrictEqual(writes(gice.bodies()), [
          [`POST ${P}/6/stack/restack`, { expected_heads: sentHeads }],
        ]),
      ),
    ),
  );

  it.effect.each<{
    readonly name: string;
    readonly input: typeof merge | typeof rebase;
    readonly answer: unknown;
    readonly detail: string;
  }>([
    {
      name: "a rebase that would drop a commit of the layer below",
      input: rebase,
      answer: done({
        restacked: [],
        up_to_date: [6],
        stopped: {
          number: 7,
          code: "restack_drops_commits",
          message:
            "restacking #7 would leave out 1 commit(s) that an earlier head of #6 had (b86ad129277d), but whose changes are in neither #6's current head nor layer-6; nothing was changed. Rebase it yourself (git rebase --onto layer-6 <the last commit of #6 that it is built on>) or update it with a merge",
        },
      }),
      // Short enough that a client's cap on error text keeps the command at its end.
      detail:
        "Gice stopped at #7 before anything was rebased: #7 would leave out 1 commit(s) that an earlier head of #6 had. Rebase it yourself (git rebase --onto layer-6 <the last commit of #6 that it is built on>) or update it with a merge.",
    },
    {
      name: "a rebase that would drop a commit, in Gice's longer wording",
      input: rebase,
      answer: done({
        restacked: [],
        up_to_date: [6],
        stopped: {
          number: 7,
          code: "restack_drops_commits",
          message:
            "restacking #7 would leave out 1 commit(s) that an earlier head of #6 had (14b84a24ee1b \"work on b\"): a push moved #6's branch back to an earlier commit without them (were they #7's, pushed there by mistake?); their changes are in neither #6's current head nor layer-6; nothing was changed. If they are #6's, rebase #7 yourself (git rebase --onto origin/layer-6 14b84a24ee1b) and push it; if they are #7's own, push them to #7's branch on top of #6's current head; or update #7 with a merge",
        },
      }),
      detail:
        "Gice stopped at #7 before anything was rebased: #7 would leave out 1 commit(s) that an earlier head of #6 had. If they are #6's, rebase #7 yourself (git rebase --onto origin/layer-6 14b84a24ee1b) and push it; if they are #7's own, push them to #7's branch on top of #6's current head; or update #7 with a merge.",
    },
    {
      name: "a merge whose step failed on the server",
      input: merge,
      answer: done({
        merged: [6],
        stopped: {
          number: 7,
          code: "stack_step_failed",
          message:
            "the stack merge stopped at #7: an unexpected error while restacking it (the server log has the cause); what was done before stays done, #7 is still open, and the stack merge can be run again",
        },
      }),
      detail:
        "Gice merged #6; the stack merge stopped at #7: an unexpected error while restacking it (the server log has the cause); what was done before stays done, #7 is still open, and the stack merge can be run again",
    },
    {
      name: "a merge that stopped part way",
      input: merge,
      answer: done({
        merged: [6],
        stopped: { number: 7, code: "conflict", message: "pull request has merge conflicts" },
      }),
      detail: "Gice merged #6, then stopped at #7: pull request has merge conflicts",
    },
    {
      name: "a rebase that stopped at the first layer",
      input: rebase,
      answer: done({
        restacked: [],
        up_to_date: [],
        stopped: {
          number: 6,
          code: "head_changed",
          message: "the head branch is not at the expected commit",
        },
      }),
      detail:
        "Gice stopped at #6 before anything was rebased: the head branch is not at the expected commit: it has commits that were not shown here. Refresh, review them, and try again.",
    },
    {
      name: "a layer pushed since it was shown",
      input: merge,
      answer: problem(
        409,
        "head_changed",
        `the head of #6 is 2a1399cb4366f58dd323fa376bf94ea86902f982, not ${HEAD_SHA}`,
      ),
      detail: `the head of #6 is 2a1399cb4366f58dd323fa376bf94ea86902f982, not ${HEAD_SHA}: it has commits that were not shown here. Refresh, review them, and try again.`,
    },
    {
      name: "a layer opened since the stack was shown",
      input: rebase,
      answer: invalid("expected_heads: #8 is missing", {
        field: "expected_heads",
        reason: "required",
      }),
      detail:
        "The stack changed since it was shown (expected_heads: #8 is missing). Refresh it and try again.",
    },
    {
      name: "a layer that cannot be merged",
      input: merge,
      answer: problem(
        409,
        "stack_not_mergeable",
        "#7 cannot be merged (draft): pull request is a draft; mark it as ready before merging; nothing was merged",
      ),
      detail:
        "#7 cannot be merged (draft): pull request is a draft; mark it as ready before merging; nothing was merged",
    },
  ])("says which layer stopped $name, and why", ({ input, answer, detail }) =>
    withServer(
      {
        [`GET ${P}/7/stack`]: stack(7, layers),
        [`POST ${P}/7/stack/merge`]: answer,
        [`POST ${P}/6/stack/restack`]: answer,
      },
      (provider) => provider.runAction(input).pipe(Effect.flip),
    ).pipe(Effect.map(({ result }) => assert.strictEqual(result.detail, detail))),
  );

  it.effect("passes on Gice's refusal to rebase a branch others are based on", () =>
    withServer(
      {
        [`POST ${P}/7/update-branch`]: problem(
          409,
          "branch_in_use",
          "branch feature is the base of open pull request #8, which a rebase would leave on the old commits; restack the stack instead (it rebases #8 too) or update with a merge",
        ),
      },
      (provider) =>
        provider
          .runAction({ ...target, action: "update-branch", updateMethod: "rebase" })
          .pipe(Effect.flip),
    ).pipe(
      Effect.map(({ result }) =>
        assert.strictEqual(
          result.detail,
          "branch feature is the base of open pull request #8, which a rebase would leave on the old commits; restack the stack instead (it rebases #8 too) or update with a merge",
        ),
      ),
    ),
  );
});

describe("GicePullRequestProvider writing", () => {
  it.effect("edits the description on the pull request", () =>
    withServer({ "PATCH /repos/team/app/pulls/7": pull() }, (provider) =>
      provider.updateChangeRequest!({ ...target, body: "New body" }),
    ).pipe(
      Effect.map(({ gice }) =>
        assert.deepStrictEqual(gice.bodies(), [
          ["PATCH /repos/team/app/pulls/7", { body: "New body" }],
        ]),
      ),
    ),
  );

  it.effect("comments through the issue the pull request shares its number with", () =>
    withServer({ "POST /repos/team/app/issues/7/comments": comment(PULL_URL, 31) }, (provider) =>
      provider.comment({ ...target, body: "Hello" }),
    ).pipe(
      Effect.map(({ gice }) =>
        assert.deepStrictEqual(gice.bodies(), [
          ["POST /repos/team/app/issues/7/comments", { body: "Hello" }],
        ]),
      ),
    ),
  );

  it.effect.each([
    { commentId: "31", kind: "issue-comment", route: "PATCH /repos/team/app/comments/31" },
    {
      commentId: "review-comment:8",
      kind: "review-comment",
      route: "PATCH /repos/team/app/pulls/comments/8",
    },
  ] as const)("edits a $kind on its own route", ({ commentId, kind, route }) =>
    withServer({ [route]: {} }, (provider) =>
      provider.updateComment!({ ...target, body: "Edited", commentId, kind }),
    ).pipe(
      Effect.map(({ gice }) =>
        assert.deepStrictEqual(gice.bodies(), [[route, { body: "Edited" }]]),
      ),
    ),
  );

  it.effect.each([
    { commentId: "31/../../pulls/7", kind: "issue-comment" },
    { commentId: "8", kind: "review-comment" },
  ] as const)("edits no comment for the id $commentId", ({ commentId, kind }) =>
    withServer({}, (provider) =>
      provider.updateComment!({ ...target, body: "Edited", commentId, kind }).pipe(Effect.flip),
    ).pipe(
      Effect.map(({ result, gice }) => {
        assert.strictEqual(result.detail, "Gice has no such comment.");
        assert.deepStrictEqual(gice.sent, []);
      }),
    ),
  );
});

describe("GicePullRequestProvider checks", () => {
  const checks = [
    { name: "CI / test", url: "https://code.example/team/app/runs/4?job=12" },
    { name: "External", url: "https://ci.example.com/build/1" },
    { name: "Lint (push)", url: "https://code.example/team/app/runs/5" },
    { name: "Deploy / ship", url: "https://code.example/team/app/runs/6?job=13" },
  ];

  it.effect("tails the log of the job a check stands for, and says why others have none", () =>
    withServer(
      { "GET /repos/team/app/runs/4/jobs/12/logs?tail=3": "one\ntwo\nthree\n" },
      (provider) => provider.getCheckLogs!({ ...target, checks, tailLines: 2 }),
    ).pipe(
      Effect.map(({ result }) =>
        assert.deepStrictEqual(
          result.map((log) => [log.log, log.truncated, log.detail]),
          [
            ["two\nthree", true, null],
            [null, false, "Gice holds no log for this check."],
            [null, false, "This run has no jobs."],
            [null, false, "not found"],
          ],
        ),
      ),
    ),
  );

  it.effect("re-runs the named jobs of each run in one request", () =>
    withServer(
      {
        "POST /repos/team/app/runs/4/rerun": { number: 7, jobs: [] },
        "POST /repos/team/app/runs/5/rerun": problem(409, "conflict", "run is not completed"),
      },
      (provider) =>
        provider.rerunChecks!({
          ...target,
          checks: [
            checks[0]!,
            { name: "CI / lint", url: "https://code.example/team/app/runs/4?job=14" },
            ...checks.slice(1, 3),
          ],
        }),
    ).pipe(
      Effect.map(({ result, gice }) => {
        assert.deepStrictEqual(result, [
          { name: "CI / test", rerun: true, detail: null },
          { name: "CI / lint", rerun: true, detail: null },
          { name: "External", rerun: false, detail: "Gice cannot re-run this check." },
          { name: "Lint (push)", rerun: false, detail: "run is not completed" },
        ]);
        assert.deepStrictEqual(gice.bodies(), [
          ["POST /repos/team/app/runs/4/rerun", { jobs: [12, 14] }],
          ["POST /repos/team/app/runs/5/rerun", undefined],
        ]);
      }),
    ),
  );
});

describe("GicePullRequestProvider reviews", () => {
  it.effect("submits a review with its line comments anchored to a side", () =>
    withServer({ "POST /repos/team/app/pulls/7/reviews": { id: 2 } }, (provider) =>
      provider.submitReview({
        ...target,
        verdict: "request-changes",
        body: "Fix",
        comments: [{ path: "a.ts", position: { kind: "deleted", oldLine: 3 }, body: "Why?" }],
      }),
    ).pipe(
      Effect.map(({ gice }) =>
        assert.deepStrictEqual(gice.bodies(), [
          [
            "POST /repos/team/app/pulls/7/reviews",
            {
              event: "REQUEST_CHANGES",
              body: "Fix",
              comments: [{ path: "a.ts", body: "Why?", side: "LEFT", line: 3 }],
            },
          ],
        ]),
      ),
    ),
  );

  it.effect("says before sending that a review holds more line comments than Gice takes", () =>
    withServer({}, (provider) =>
      provider
        .submitReview({
          ...target,
          verdict: "comment",
          body: "",
          comments: Array.from({ length: 101 }, (_, index) => ({
            path: "a.ts",
            position: { kind: "added", newLine: index + 1 },
            body: "Why?",
          })),
        })
        .pipe(Effect.flip),
    ).pipe(
      Effect.map(({ result, gice }) => {
        assert.strictEqual(
          result.detail,
          "Gice takes at most 100 line comments in one review, and this one has 101. Remove some, or submit them in another review.",
        );
        assert.deepStrictEqual(gice.sent, []);
      }),
    ),
  );

  it.effect("answers a thread by replying to its first comment", () =>
    withServer({ "POST /repos/team/app/pulls/7/comments/8/replies": { id: 9 } }, (provider) =>
      provider.replyToThread({ ...target, threadId: "5:8", body: "Done" }),
    ).pipe(
      Effect.map(({ gice }) =>
        assert.deepStrictEqual(gice.bodies(), [
          ["POST /repos/team/app/pulls/7/comments/8/replies", { body: "Done" }],
        ]),
      ),
    ),
  );

  it.effect.each([
    { resolved: true, method: "PUT" },
    { resolved: false, method: "DELETE" },
  ] as const)("sets a thread's resolution to $resolved", ({ resolved, method }) => {
    const route = `${method} /repos/team/app/pulls/threads/5/resolution`;
    return withServer({ [route]: { id: 5 } }, (provider) =>
      provider.setThreadResolution({ ...target, threadId: "5:8", resolved }),
    ).pipe(Effect.map(({ gice }) => assert.deepStrictEqual(gice.paths(), [route])));
  });

  it.effect("asks for reviewers among the candidates, marking those already asked", () =>
    withServer(
      {
        [PULL]: pull({ requested_reviewers: [user("Bob")] }),
        "GET /repos/team/app/pulls/7/reviewer-candidates?per_page=100&q=bo": [
          user("bob"),
          user("bo"),
        ],
      },
      (provider) => provider.listReviewerCandidates({ ...target, query: " bo " }),
    ).pipe(
      Effect.map(({ result }) =>
        assert.deepStrictEqual(
          result.candidates.map((candidate) => [candidate.id, candidate.isRequested]),
          [
            ["bob", true],
            ["bo", false],
          ],
        ),
      ),
    ),
  );

  it.effect.each([
    { requested: true, method: "POST" },
    { requested: false, method: "DELETE" },
  ] as const)("names the reviewers asked or no longer asked ($method)", ({ requested, method }) => {
    const route = `${method} /repos/team/app/pulls/7/requested_reviewers`;
    return withServer({ [route]: pull() }, (provider) =>
      provider.setReviewerRequest({
        ...target,
        reviewers: [{ id: "bob", kind: "user" }],
        requested,
      }),
    ).pipe(
      Effect.map(({ gice }) =>
        assert.deepStrictEqual(gice.bodies(), [[route, { reviewers: ["bob"] }]]),
      ),
    );
  });
});

describe("GicePullRequestProvider people", () => {
  it.effect("finds authors and people to mention among those Gice can assign", () =>
    withServer(
      {
        "GET /repos/team/app/assignee-candidates?per_page=100&q=car": [
          user("carol", { display_name: "Carol", avatar_url: "https://code.example/a/carol" }),
        ],
      },
      (provider) => provider.searchRepositoryAuthors!({ ...target, query: " car " }),
    ).pipe(
      Effect.map(({ result }) =>
        assert.deepStrictEqual(result, {
          items: [{ login: "carol", name: "Carol", avatarUrl: "https://code.example/a/carol" }],
          truncated: false,
        }),
      ),
    ),
  );
});

describe("GicePullRequestProvider references", () => {
  it.effect("finds issues and pull requests in one search, in the server's order", () =>
    withServer(
      {
        "GET /repos/team/app/references?per_page=20&q=12": listing(
          [
            reference(12),
            reference(3, {
              title: "Fix #12",
              is_pull: true,
              state: "merged",
              html_url: "https://code.example/team/app/pulls/3",
            }),
          ],
          21,
        ),
      },
      (provider) => provider.searchRepositoryReferences!({ ...target, query: " 12 ", sigil: "#" }),
    ).pipe(
      Effect.map(({ result }) =>
        assert.deepStrictEqual(result, {
          items: [
            { reference: "#12", kind: "issue", number: 12, title: "Crash on start", state: "open" },
            {
              reference: "#3",
              kind: "change-request",
              number: 3,
              title: "Fix #12",
              state: "merged",
            },
          ],
          truncated: true,
        }),
      ),
    ),
  );

  it.effect("has nothing under a sigil Gice does not write", () =>
    withServer({}, (provider) =>
      provider.searchRepositoryReferences!({ ...target, query: "12", sigil: "!" }),
    ).pipe(
      Effect.map(({ result, gice }) => {
        assert.deepStrictEqual(result, { items: [], truncated: false });
        assert.deepStrictEqual(gice.sent, []);
      }),
    ),
  );
});

describe("GicePullRequestProvider labels and reactions", () => {
  it.effect("marks the labels a pull request carries, whatever their case", () =>
    withServer(
      {
        [PULL]: pull({ labels: [label(1, "Bug")] }),
        "GET /repos/team/app/labels?per_page=100&page=1": [
          label(1, "bug", { description: "Broken" }),
          label(2, "ui"),
        ],
      },
      (provider) => provider.listLabelCandidates!(target),
    ).pipe(
      Effect.map(({ result }) =>
        assert.deepStrictEqual(
          result.candidates.map((candidate) => [candidate.name, candidate.isApplied]),
          [
            ["bug", true],
            ["ui", false],
          ],
        ),
      ),
    ),
  );

  it.effect("stops at the end the server counts, even after a full page", () =>
    withServer(
      {
        "GET /repos/team/app/labels?per_page=100&page=1": listing(
          Array.from({ length: 100 }, (_, index) => label(index + 1, `label-${index}`)),
          100,
        ),
      },
      (provider) => provider.listRepositoryLabels!(target),
    ).pipe(
      Effect.map(({ result, gice }) => {
        assert.deepStrictEqual([result.items.length, result.truncated], [100, false]);
        assert.deepStrictEqual(gice.paths(), ["GET /repos/team/app/labels?per_page=100&page=1"]);
      }),
    ),
  );

  it.effect("adds labels in one request", () =>
    withServer({ "POST /repos/team/app/issues/7/labels": [] }, (provider) =>
      provider.setLabels!({ ...target, labels: ["bug", "ui"], applied: true }),
    ).pipe(
      Effect.map(({ gice }) =>
        assert.deepStrictEqual(gice.bodies(), [
          ["POST /repos/team/app/issues/7/labels", { labels: ["bug", "ui"] }],
        ]),
      ),
    ),
  );

  it.effect("takes labels off one by one, past one that is already off", () =>
    withServer(
      {
        "DELETE /repos/team/app/issues/7/labels/gone": problem(
          404,
          "not_found",
          "the issue does not have that label",
        ),
        "DELETE /repos/team/app/issues/7/labels/needs%20work": [],
      },
      (provider) =>
        provider.setLabels!({ ...target, labels: ["gone", "needs work"], applied: false }),
    ).pipe(
      Effect.map(({ gice }) =>
        assert.deepStrictEqual(gice.paths(), [
          "DELETE /repos/team/app/issues/7/labels/gone",
          "DELETE /repos/team/app/issues/7/labels/needs%20work",
        ]),
      ),
    ),
  );

  it.effect("fails to take a label off a pull request Gice no longer has", () =>
    withServer(
      {
        "DELETE /repos/team/app/issues/7/labels/bug": problem(404, "not_found", "issue not found"),
      },
      (provider) =>
        provider.setLabels!({ ...target, labels: ["bug"], applied: false }).pipe(Effect.flip),
    ).pipe(Effect.map(({ result }) => assert.strictEqual(result.reason, "not-found"))),
  );

  it.effect.each([
    { subjectId: undefined, route: "/repos/team/app/issues/7/reactions" },
    { subjectId: "4", route: "/repos/team/app/comments/4/reactions" },
    { subjectId: "review-comment:8", route: "/repos/team/app/pulls/comments/8/reactions" },
  ])("reacts to $route", ({ subjectId, route }) =>
    withServer({ [`POST ${route}`]: { id: 21, content: "+1" } }, (provider) =>
      provider.setReaction({
        ...target,
        ...(subjectId === undefined ? {} : { subjectId }),
        content: "thumbs-up",
        reacted: true,
      }),
    ).pipe(
      Effect.map(({ gice }) =>
        assert.deepStrictEqual(gice.bodies(), [[`POST ${route}`, { content: "+1" }]]),
      ),
    ),
  );

  it.effect("takes a reaction back by its content, and one already gone stays gone", () =>
    withServer(
      {
        "DELETE /repos/team/app/pulls/comments/8/reactions?content=eyes": "",
        "DELETE /repos/team/app/comments/4/reactions?content=rocket": problem(
          404,
          "not_found",
          "you have not reacted with rocket",
        ),
      },
      (provider) =>
        Effect.all([
          provider.setReaction({
            ...target,
            subjectId: "review-comment:8",
            content: "eyes",
            reacted: false,
          }),
          provider.setReaction({ ...target, subjectId: "4", content: "rocket", reacted: false }),
        ]),
    ).pipe(
      Effect.map(({ gice }) =>
        assert.deepStrictEqual(gice.paths(), [
          "DELETE /repos/team/app/pulls/comments/8/reactions?content=eyes",
          "DELETE /repos/team/app/comments/4/reactions?content=rocket",
        ]),
      ),
    ),
  );
});

describe("GicePullRequestProvider refusals", () => {
  it.effect.each<{
    readonly name: string;
    readonly call: (provider: Provider) => Effect.Effect<unknown, { readonly detail: string }>;
    readonly detail: string;
  }>([
    {
      name: "a team asked to review",
      call: (provider) =>
        provider.setReviewerRequest({
          ...target,
          reviewers: [{ id: "core", kind: "team" }],
          requested: true,
        }),
      detail: "Gice has no teams to ask for a review.",
    },
    {
      name: "a reply to a thread id it did not hand out",
      call: (provider) => provider.replyToThread({ ...target, threadId: "5", body: "Hi" }),
      detail: "Gice has no such review thread.",
    },
    {
      name: "resolving a thread id it did not hand out",
      call: (provider) =>
        provider.setThreadResolution({ ...target, threadId: "5", resolved: true }),
      detail: "Gice has no such review thread.",
    },
    {
      name: "a reaction to a review",
      call: (provider) =>
        provider.setReaction({ ...target, subjectId: "review:2", content: "heart", reacted: true }),
      detail: "Gice has no reactions on reviews.",
    },
    {
      name: "a repository that is not owner/name",
      call: (provider) => provider.getChangeRequest({ ...target, repository: "not-a-repository" }),
      detail: "Gice repositories are named owner/name.",
    },
  ])("declines $name without asking", ({ call, detail }) =>
    withServer({}, (provider) => Effect.flip(Effect.asVoid(call(provider)))).pipe(
      Effect.map(({ result, gice }) => {
        assert.strictEqual(result.detail, detail);
        assert.deepStrictEqual(gice.sent, []);
      }),
    ),
  );
});

describe("GicePullRequestProvider watching", () => {
  it.effect("fingerprints a pull request by its newest event and its newest remark", () =>
    withServer(
      {
        [`GET /repos/team/app/events?pull=7&types=${REMARK_EVENT_TYPES}&limit=1`]: feed([
          event(4, "comment.created"),
        ]),
        "GET /repos/team/app/events?pull=7&limit=1": feed([event(5, "pull.pushed")]),
      },
      (provider) => provider.getChangeRequestWatchFingerprint!(target),
    ).pipe(
      Effect.map(({ result }) =>
        assert.deepStrictEqual(result, { status: "5", remarks: "4", coversDetail: true }),
      ),
    ),
  );

  it.effect("follows the events feed once on connecting and once per change", () =>
    withServer(
      {
        "GET /repos/team/app/events?pull=7&limit=1": feed([event(5, "pull.pushed")]),
        // Gice holds each request until something happens; the feed ends when it stops answering.
        "GET /repos/team/app/events?pull=7&since=5&wait=25": feed([event(6, "comment.created")]),
      },
      (provider) => provider.changeRequestEvents!(target).pipe(Stream.runCount),
    ).pipe(Effect.map(({ result }) => assert.strictEqual(result, 2))),
  );

  it.effect(
    "sleeps briefly before repolling when an empty events reply returns immediately",
    () => {
      let emptyReplies = 0;
      let markFirstEmpty: (() => void) | undefined;
      const firstEmpty = new Promise<void>((resolve) => {
        markFirstEmpty = resolve;
      });
      return withServer(
        {
          "GET /repos/team/app/events?pull=7&limit=1": feed([event(5, "pull.pushed")]),
          "GET /repos/team/app/events?pull=7&since=5&wait=25": () => {
            if (emptyReplies++ === 0) {
              markFirstEmpty?.();
              return { cursor: 5, events: [] };
            }
            return feed([event(6, "comment.created")]);
          },
        },
        (provider) =>
          Effect.gen(function* () {
            const fiber = yield* provider.changeRequestEvents!(target).pipe(
              Stream.runCount,
              Effect.forkChild,
            );
            yield* Effect.promise(() => firstEmpty);
            yield* TestClock.adjust("500 millis");
            assert.strictEqual(emptyReplies, 1);
            yield* TestClock.adjust("500 millis");
            assert.strictEqual(yield* Fiber.join(fiber), 2);
            assert.strictEqual(emptyReplies, 2);
          }),
      );
    },
  );
});
