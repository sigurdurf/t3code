import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import * as Json from "./gicePullRequestJson.ts";

const decodePull = Schema.decodeUnknownSync(Json.GicePull);
const decodeStatus = Schema.decodeUnknownSync(Json.GiceCommitStatus);
const decodeFiles = Schema.decodeUnknownSync(Json.GiceFiles);
const decodeComment = Schema.decodeUnknownSync(Json.GiceComment);
const decodeCommit = Schema.decodeUnknownSync(Json.GiceCommit);
const decodeThreads = Schema.decodeUnknownSync(Schema.Array(Json.GiceReviewThread));
const decodeReviews = Schema.decodeUnknownSync(Schema.Array(Json.GiceReview));
const decodeEvents = Schema.decodeUnknownSync(Json.GiceEvents);

const serverWith = (...features: ReadonlyArray<string>) => ({
  has: (feature: string) => features.includes(feature),
});

const target = { host: "gice.example.com:8443", repository: "team/app" };
const alice = {
  id: 2,
  username: "alice",
  display_name: "Alice",
  created_at: "2026-11-11T21:45:20Z",
  is_admin: false,
  kind: "user",
};
// The shape of `GET /repos/{owner}/{repo}/pulls/{n}` on a live server.
const pull = {
  number: 7,
  title: "Change",
  body: "Body",
  state: "open",
  author: alice,
  comments_count: 0,
  created_at: "2026-11-19T08:52:32Z",
  updated_at: "2026-11-19T10:01:40+01:00",
  closed_at: null,
  is_pull: true,
  head: "feature",
  base: "main",
  head_repo: { owner: "team", name: "app", full_name: "team/app" },
  cross_repo: false,
  head_label: "feature",
  merged: false,
  merged_at: null,
  merged_by: null,
  merge_commit_sha: null,
  revisions_count: 2,
  mergeable: true,
  ahead: 2,
  behind: 0,
};

const run = (overrides: Record<string, unknown>) => ({
  id: 9,
  number: 9,
  workflow: { path: ".gice/workflows/ci.yml", name: "CI" },
  event: "pull_request",
  ref: "refs/pull/7/head",
  sha: "21723f23022029e1ce4a03f0465998d7a48de838",
  status: "completed",
  conclusion: "success",
  error: null,
  ...overrides,
});

const section = (path: string, index: string, body = "@@ -1 +1 @@\n-old\n+new\n") =>
  `diff --git a/${path} b/${path}\nindex ${index} 100644\n--- a/${path}\n+++ b/${path}\n${body}`;
const file = (path: string, status = "modified") => ({
  path,
  status,
  additions: 3,
  deletions: 1,
  is_binary: false,
});

describe("gicePullRequestJson", () => {
  it("maps a pull request onto the host it was read from", () => {
    const changeRequest = Json.toChangeRequest(decodePull(pull), target);
    assert.deepStrictEqual(
      {
        url: changeRequest.url,
        author: changeRequest.author,
        headBranch: changeRequest.headBranch,
        head: changeRequest.headRepositoryNameWithOwner,
        state: changeRequest.state,
        mergeability: changeRequest.mergeability,
        updatedAt: changeRequest.updatedAt,
      },
      {
        url: "https://gice.example.com:8443/team/app/pulls/7",
        author: { login: "alice", name: "Alice", avatarUrl: null },
        headBranch: "feature",
        head: "team/app",
        state: "open",
        mergeability: "mergeable",
        updatedAt: "2026-11-19T09:01:40.000Z",
      },
    );
  });

  it("reads merge state, conflicts and distance from the base", () => {
    const merged = decodePull({
      ...pull,
      state: "merged",
      merged: true,
      closed_at: "2026-11-19T09:01:40Z",
      merged_at: "2026-11-19T09:01:40Z",
      merged_by: { ...alice, username: "bot", display_name: "", kind: "machine" },
      merge_commit_sha: "ffede7572ea6fccd3b97f7937252d966a9e432a3",
      mergeable: null,
      ahead: undefined,
      behind: undefined,
    });
    assert.strictEqual(Json.toChangeRequest(merged, target).state, "merged");
    assert.strictEqual(Json.toChangeRequest(merged, target).mergeability, "unknown");
    assert.deepStrictEqual(Json.toDetailFields(merged), {
      body: "Body",
      closedAt: "2026-11-19T09:01:40.000Z",
      mergedAt: "2026-11-19T09:01:40.000Z",
      mergeCommitSha: "ffede7572ea6fccd3b97f7937252d966a9e432a3",
      mergedBy: { login: "bot", name: null, avatarUrl: null, isBot: true },
      baseComparison: "unknown",
    });

    const conflicting = decodePull({ ...pull, mergeable: false, behind: 3 });
    assert.strictEqual(Json.toChangeRequest(conflicting, target).mergeability, "conflicting");
    assert.strictEqual(Json.toDetailFields(conflicting).baseComparison, "behind");
    assert.strictEqual(Json.toDetailFields(conflicting).behindBy, 3);
    assert.strictEqual(Json.toDetailFields(decodePull(pull)).baseComparison, "up-to-date");

    // A listing row carries none of the computed fields.
    const { mergeable: _mergeable, ahead: _ahead, behind: _behind, ...listed } = pull;
    assert.strictEqual(Json.toChangeRequest(decodePull(listed), target).mergeability, "unknown");
  });

  it("names a fork's repository as the head, and none once the fork is deleted", () => {
    const fork = {
      ...pull,
      cross_repo: true,
      head_label: "bob:feature",
      head_repo: { owner: "bob", name: "app", full_name: "bob/app" },
    };
    assert.strictEqual(
      Json.toChangeRequest(decodePull(fork), target).headRepositoryNameWithOwner,
      "bob/app",
    );
    assert.strictEqual(
      Json.toChangeRequest(decodePull({ ...fork, head_repo: null }), target)
        .headRepositoryNameWithOwner,
      null,
    );
    // An older same-repository pull request may name no head repository at all.
    assert.strictEqual(
      Json.toChangeRequest(decodePull({ ...pull, head_repo: null }), target)
        .headRepositoryNameWithOwner,
      "team/app",
    );
  });

  it.each([
    { permission: "read", viewer: "bob", state: "open", actions: [], edit: false },
    { permission: "read", viewer: "Alice", state: "open", actions: ["close"], edit: true },
    { permission: "write", viewer: "bob", state: "open", actions: ["merge", "close"], edit: true },
    { permission: "admin", viewer: "bob", state: "closed", actions: ["reopen"], edit: true },
    { permission: "admin", viewer: "bob", state: "merged", actions: [], edit: true },
  ])(
    "offers $actions to $viewer with $permission access on a pull request that is $state",
    ({ permission, viewer, state, actions, edit }) => {
      const permissions = Json.toViewerPermissions(decodePull({ ...pull, state }), {
        viewer,
        permission,
      });
      assert.deepStrictEqual<ReadonlyArray<string>>(permissions.actions, actions);
      assert.strictEqual(permissions.editChangeRequest, edit);
      assert.deepStrictEqual(permissions.verdicts, []);
      assert.isFalse(permissions.requestReviewers);
    },
  );

  it("turns the runs of a commit status into checks, failures first", () => {
    const status = decodeStatus({
      sha: "21723f23022029e1ce4a03f0465998d7a48de838",
      state: "pending",
      runs: [
        run({ number: 12, event: "push" }),
        run({ number: 11, status: "in_progress", conclusion: null }),
        run({
          number: 10,
          workflow: { path: ".gice/workflows/lint.yml", name: "" },
          conclusion: "failure",
          error: "workflow file is invalid",
        }),
        run({ number: 9, workflow: { path: "d.yml", name: "Deploy" }, conclusion: "cancelled" }),
        run({ number: 8, workflow: { path: "s.yml", name: "Skip" }, conclusion: "skipped" }),
      ],
    });
    assert.deepStrictEqual(Json.toChecks(status, target), {
      state: "failing",
      checks: [
        {
          name: ".gice/workflows/lint.yml (pull_request)",
          status: "failure",
          description: "workflow file is invalid",
          url: "https://gice.example.com:8443/team/app/runs/10",
        },
        {
          name: "Deploy (pull_request)",
          status: "cancelled",
          description: null,
          url: "https://gice.example.com:8443/team/app/runs/9",
        },
        {
          name: "CI (push)",
          status: "success",
          description: null,
          url: "https://gice.example.com:8443/team/app/runs/12",
        },
        {
          name: "CI (pull_request)",
          status: "pending",
          description: null,
          url: "https://gice.example.com:8443/team/app/runs/11",
        },
        {
          name: "Skip (pull_request)",
          status: "skipped",
          description: null,
          url: "https://gice.example.com:8443/team/app/runs/8",
        },
      ],
    });
    assert.deepStrictEqual(Json.toChecks(decodeStatus({ ...status, runs: [] }), target), {
      state: null,
      checks: [],
    });
  });

  it("finds the run a check links to", () => {
    assert.strictEqual(Json.runNumberOf("https://gice.example.com/team/app/runs/12"), 12);
    assert.strictEqual(Json.runNumberOf("https://gice.example.com/team/app/runs/12#job-3"), 12);
    assert.strictEqual(Json.runNumberOf("https://gice.example.com/team/app/pulls/12"), null);
    assert.strictEqual(Json.runNumberOf(null), null);
  });

  it("passes a whole patch through", () => {
    const patch = section("a.ts", "1111111..2222222") + section("b.ts", "3333333..4444444");
    assert.deepStrictEqual(
      Json.toDiff(decodeFiles({ files: [file("a.ts"), file("b.ts")], patch })),
      { patch, truncated: false, nextCursor: null },
    );
  });

  it("drops the section a cut patch ends in and reports the files it is missing", () => {
    const whole = section("a.ts", "1111111..2222222");
    const diff = decodeFiles({
      files: [file("a.ts"), file("b.ts"), file("c.ts")],
      patch: `${whole}${section("b.ts", "3333333..4444444", "@@ -1,9 +1,9 @@\n-old\n")}`,
      truncated: true,
    });
    assert.deepStrictEqual(Json.toDiff(diff), {
      patch: whole,
      truncated: true,
      nextCursor: null,
      omittedFileStats: [
        { path: "b.ts", additions: 3, deletions: 1 },
        { path: "c.ts", additions: 3, deletions: 1 },
      ],
    });
    // The cut files' versions are unknown; a path the pull request never lists has none.
    assert.deepStrictEqual(Json.toFileRevisions(diff, ["a.ts", "b.ts", "c.ts", "other.ts"]), {
      revisions: new Map([
        ["a.ts", "2222222"],
        ["other.ts", ""],
      ]),
      complete: false,
    });
  });

  it("reads file versions from a whole patch, deletions and renames included", () => {
    const patch =
      section("a.ts", "1111111..2222222") +
      "diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\nindex 5555555..0000000\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n" +
      "diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n";
    const diff = decodeFiles({
      files: [
        file("a.ts"),
        file("gone.ts", "deleted"),
        { ...file("new.ts", "renamed"), old_path: "old.ts" },
      ],
      patch,
    });
    assert.deepStrictEqual(Json.toFileRevisions(diff, ["a.ts", "gone.ts", "new.ts"]), {
      revisions: new Map([
        ["a.ts", "2222222"],
        ["gone.ts", "0000000"],
        ["new.ts", ""],
      ]),
      complete: true,
    });
  });

  it("marks a comment as edited only when its update time moved", () => {
    const comment = {
      id: 31,
      body: "Looks right",
      author: alice,
      created_at: "2026-11-19T08:52:32Z",
      updated_at: "2026-11-19T08:52:32Z",
    };
    assert.deepStrictEqual(Json.toComment(decodeComment(comment)), {
      id: "31",
      kind: "issue-comment",
      author: { login: "alice", name: "Alice", avatarUrl: null },
      body: "Looks right",
      createdAt: "2026-11-19T08:52:32.000Z",
      editedAt: null,
      url: null,
      path: null,
      reviewState: null,
    });
    assert.strictEqual(
      Json.toComment(decodeComment({ ...comment, updated_at: "2026-11-19T09:00:00Z" })).editedAt,
      "2026-11-19T09:00:00.000Z",
    );
  });

  it("takes a commit's headline from its message", () => {
    assert.deepStrictEqual(
      Json.toCommit(
        decodeCommit({
          sha: "21723f23022029e1ce4a03f0465998d7a48de838",
          parents: ["32da43b763b73628b0eaaabef75121bec43edd3d"],
          message: "Run the Go job with --init\n\nGitHub's job container never reaps.",
          author: { name: "Alice", email: "alice@example.com", date: "2026-11-19T08:50:20Z" },
          committer: {
            name: "Alice",
            email: "alice@example.com",
            date: "2026-11-19T09:50:20+01:00",
          },
        }),
      ),
      {
        oid: "21723f23022029e1ce4a03f0465998d7a48de838",
        messageHeadline: "Run the Go job with --init",
        committedDate: "2026-11-19T08:50:20.000Z",
      },
    );
  });

  // What a server with the parity API adds to the same pull request.
  const avatar = "https://gice.example.com/api/v1/users/alice/avatar";
  const reactions = {
    total_count: 3,
    "+1": 2,
    "-1": 0,
    laugh: 0,
    confused: 0,
    heart: 0,
    hooray: 0,
    rocket: 1,
    eyes: 0,
  };
  const permissions = {
    can_edit: true,
    can_close: true,
    can_reopen: false,
    can_merge: true,
    can_update_branch: true,
    can_delete_head_branch: false,
    can_comment: true,
    can_review: true,
    can_approve: true,
    can_request_reviewers: true,
    merge_methods: ["merge", "squash", "rebase"],
  };
  const current = {
    ...pull,
    author: { ...alice, avatar_url: avatar },
    draft: true,
    head_sha: "21723f23022029e1ce4a03f0465998d7a48de838",
    base_sha: "a1f642c8cf28c0db4b98c80737eb2171b97088fe",
    merge_base_sha: "a1f642c8cf28c0db4b98c80737eb2171b97088fe",
    additions: 12,
    deletions: 4,
    changed_files: 3,
    head_branch_exists: true,
    auto_merge: null,
    viewer_permissions: permissions,
    review_decision: "CHANGES_REQUESTED",
    requested_reviewers: [{ ...alice, username: "bob" }],
    labels: [{ id: 1, name: "bug", color: "ff0000", description: "" }],
    reactions,
    viewer_reactions: ["rocket"],
    merge_blockers: ["draft", "changes_requested"],
  };

  it("reads the draft, size, labels, reviewers and decision a current server reports", () => {
    const changeRequest = Json.toChangeRequest(decodePull(current), target);
    assert.deepStrictEqual(
      {
        author: changeRequest.author,
        isDraft: changeRequest.isDraft,
        additions: changeRequest.additions,
        deletions: changeRequest.deletions,
        labels: changeRequest.labels,
        reviewRequestLogins: changeRequest.reviewRequestLogins,
        reviewDecision: changeRequest.reviewDecision,
      },
      {
        author: { login: "alice", name: "Alice", avatarUrl: avatar },
        isDraft: true,
        additions: 12,
        deletions: 4,
        labels: [{ name: "bug", color: "ff0000", description: null }],
        reviewRequestLogins: ["bob"],
        reviewDecision: "changes-requested",
      },
    );
    assert.deepStrictEqual(Json.toSummaryFields(decodePull(current)), {
      headSha: "21723f23022029e1ce4a03f0465998d7a48de838",
      additions: 12,
      deletions: 4,
      changedFiles: 3,
      autoMergeEnabled: false,
    });
    const waiting = decodePull({ ...current, auto_merge: { method: "squash", enabled_by: null } });
    assert.deepStrictEqual(
      [Json.toDetailFields(waiting).autoMergeEnabled, Json.toDetailFields(waiting).autoMergeMethod],
      [true, "squash"],
    );
    assert.deepStrictEqual(Json.toReactions(decodePull(current)), [
      { content: "thumbs-up", count: 2, actors: [], viewerHasReacted: false },
      { content: "rocket", count: 1, actors: [], viewerHasReacted: true },
    ]);

    // An older server says nothing about any of it, and a summary row leaves the body out.
    const { body: _body, ...row } = pull;
    const old = Json.toChangeRequest(decodePull(row), target);
    assert.strictEqual(old.reviewDecision, undefined);
    assert.deepStrictEqual([old.isDraft, old.labels, old.reviewRequestLogins], [false, [], []]);
    assert.deepStrictEqual(Json.toSummaryFields(decodePull(row)), {});
    assert.strictEqual(Json.toDetailFields(decodePull(row)).body, "");
    assert.strictEqual(
      Json.toChangeRequest(decodePull({ ...current, review_decision: null }), target)
        .reviewDecision,
      null,
    );
  });

  it("offers what the server lets this caller do, as far as the server can do it", () => {
    const every = serverWith(
      "labels",
      "pull_drafts",
      "pull_merge_options",
      "pull_update_branch",
      "pull_auto_merge",
      "pull_reviews",
      "pull_review_threads",
      "pull_reviewer_requests",
    );
    const read = (fields: Record<string, unknown>, can: Record<string, unknown>, server = every) =>
      Json.toReportedViewerPermissions(
        decodePull({ ...current, ...fields }),
        { ...permissions, ...can },
        server,
      );

    assert.deepStrictEqual(read({}, {}), {
      actions: [
        "merge",
        "ready",
        "close",
        "update-branch",
        "enable-auto-merge",
        "disable-auto-merge",
      ],
      comment: true,
      resolve: true,
      verdicts: ["comment", "approve", "request-changes"],
      requestReviewers: true,
      labels: true,
      editChangeRequest: true,
      updateMethods: ["merge", "rebase"],
    });
    // The author, who cannot push: no merge, no labels, no verdict on their own work.
    const author = read(
      { draft: false },
      {
        can_merge: false,
        can_update_branch: false,
        can_approve: false,
        merge_methods: [],
      },
    );
    assert.deepStrictEqual(author.actions, ["draft", "close"]);
    assert.deepStrictEqual(
      [author.verdicts, author.labels, author.updateMethods],
      [["comment"], false, []],
    );
    assert.deepStrictEqual(
      read(
        { state: "merged", auto_merge: null },
        {
          can_close: false,
          can_merge: false,
          can_update_branch: false,
          can_delete_head_branch: true,
          can_request_reviewers: false,
        },
      ).actions,
      ["delete-branch"],
    );
    assert.deepStrictEqual(
      read({ auto_merge: { method: "merge" } }, {}).actions.filter((action) =>
        action.endsWith("auto-merge"),
      ),
      ["disable-auto-merge"],
    );
    // A server that reports permissions but predates the rest offers none of the rest.
    assert.deepStrictEqual(read({}, {}, serverWith()), {
      actions: ["merge", "close"],
      comment: true,
      resolve: false,
      verdicts: [],
      requestReviewers: false,
      labels: false,
      editChangeRequest: true,
      updateMethods: [],
    });
  });

  it("turns each job of a run into a check, and a run without jobs into one", () => {
    const status = decodeStatus({
      sha: "21723f23022029e1ce4a03f0465998d7a48de838",
      state: "failure",
      runs: [
        run({
          number: 12,
          html_url: "https://code.example/team/app/runs/12",
          jobs: [
            {
              id: 31,
              key: "test",
              name: "Unit tests",
              status: "completed",
              conclusion: "failure",
              html_url: "https://code.example/team/app/runs/12?job=31",
            },
            { id: 32, key: "lint", name: "", status: "queued", conclusion: null },
          ],
        }),
        run({ number: 13, event: "push", conclusion: "failure", error: "invalid", jobs: [] }),
      ],
    });
    assert.deepStrictEqual(Json.toChecks(status, target), {
      state: "failing",
      checks: [
        {
          name: "CI / Unit tests (pull_request)",
          status: "failure",
          description: null,
          url: "https://code.example/team/app/runs/12?job=31",
        },
        {
          name: "CI (push)",
          status: "failure",
          description: "invalid",
          url: "https://gice.example.com:8443/team/app/runs/13",
        },
        {
          name: "CI / 32 (pull_request)",
          status: "pending",
          description: null,
          url: "https://code.example/team/app/runs/12?job=32",
        },
      ],
    });
    assert.strictEqual(Json.jobIdOf("https://code.example/team/app/runs/12?job=31"), 31);
    assert.strictEqual(Json.runNumberOf("https://code.example/team/app/runs/12?job=31"), 12);
    assert.strictEqual(Json.jobIdOf("https://code.example/team/app/runs/12"), null);
    assert.strictEqual(Json.jobIdOf("https://code.example/team/app/pulls/12?job=31"), null);
  });

  it("reads reviews and threads, leaving out the reviews that only carry a line comment", () => {
    const review = (id: number, state: string, body: string) => ({
      id,
      pull_number: 7,
      user: { ...alice, username: "bob" },
      body,
      state,
      commit_id: "21723f23022029e1ce4a03f0465998d7a48de838",
      comments_count: 1,
      submitted_at: "2026-11-19T09:00:00Z",
      html_url: `https://code.example/team/app/pulls/7#review-${id}`,
    });
    assert.deepStrictEqual(
      Json.toReviews(
        decodeReviews([
          review(1, "CHANGES_REQUESTED", "Fix this"),
          review(2, "COMMENTED", " "),
          review(3, "COMMENTED", "A remark"),
          review(4, "APPROVED", ""),
        ]),
      ).map((remark) => [remark.id, remark.kind, remark.reviewState, remark.url]),
      [
        [
          "review:1",
          "review",
          "CHANGES_REQUESTED",
          "https://code.example/team/app/pulls/7#review-1",
        ],
        ["review:3", "review", "COMMENTED", "https://code.example/team/app/pulls/7#review-3"],
        ["review:4", "review", "APPROVED", "https://code.example/team/app/pulls/7#review-4"],
      ],
    );

    const comment = (id: number, fields: Record<string, unknown> = {}) => ({
      id,
      pull_number: 7,
      pull_request_review_id: 1,
      thread_id: 5,
      in_reply_to_id: null,
      user: alice,
      body: `Comment ${id}`,
      created_at: "2026-11-19T09:00:00Z",
      updated_at: "2026-11-19T09:00:00Z",
      html_url: `https://code.example/team/app/pulls/7#discussion-${id}`,
      viewer_can_edit: true,
      viewer_can_delete: true,
      reactions,
      viewer_reactions: [],
      ...fields,
    });
    const thread = (fields: Record<string, unknown>) => ({
      id: 5,
      pull_number: 7,
      path: "src/a.ts",
      subject_type: "line",
      side: "RIGHT",
      line: 12,
      start_line: null,
      original_line: 10,
      outdated: false,
      resolved: false,
      viewer_can_resolve: true,
      comments: [comment(8), comment(9, { updated_at: "2026-11-19T09:05:00Z" })],
      ...fields,
    });
    const threads = Json.toReviewThreads(
      decodeThreads([
        thread({}),
        thread({
          id: 6,
          side: "LEFT",
          line: null,
          outdated: true,
          resolved: true,
          viewer_can_resolve: false,
          comments: [comment(11)],
        }),
        thread({ id: 7, subject_type: "file", side: null, line: null, original_line: null }),
        thread({ id: 8, comments: [] }),
      ]),
    );
    assert.deepStrictEqual(
      threads.map(({ comments: _comments, ...rest }) => rest),
      [
        {
          id: "5:8",
          path: "src/a.ts",
          line: 12,
          side: "right",
          isResolved: false,
          isOutdated: false,
          canResolve: true,
        },
        {
          id: "6:11",
          path: "src/a.ts",
          line: 10,
          side: "left",
          isResolved: true,
          isOutdated: true,
          canResolve: false,
        },
        {
          id: "7:8",
          path: "src/a.ts",
          line: null,
          side: "right",
          isResolved: false,
          isOutdated: false,
          canResolve: true,
        },
      ],
    );
    assert.deepStrictEqual(threads[0]?.comments[1], {
      id: "review-comment:9",
      author: { login: "alice", name: "Alice", avatarUrl: null },
      body: "Comment 9",
      createdAt: "2026-11-19T09:00:00.000Z",
      editedAt: "2026-11-19T09:05:00.000Z",
      url: "https://code.example/team/app/pulls/7#discussion-9",
      reactions: [
        { content: "thumbs-up", count: 2, actors: [], viewerHasReacted: false },
        { content: "rocket", count: 1, actors: [], viewerHasReacted: false },
      ],
      canEdit: true,
      reviewUrl: "https://code.example/team/app/pulls/7#review-1",
    });
    assert.deepStrictEqual(Json.threadIdParts("5:8"), { thread: "5", comment: "8" });
    assert.strictEqual(Json.threadIdParts("5"), null);
    assert.strictEqual(Json.reviewCommentIdOf("review-comment:9"), "9");
    assert.strictEqual(Json.reviewCommentIdOf("9"), null);
  });

  it("anchors a line comment to the side of the file its line is on", () => {
    const draft = { path: "src/a.ts", body: "Here" };
    assert.deepStrictEqual(
      [
        Json.toReviewComment({ ...draft, position: { kind: "added", newLine: 4 } }),
        Json.toReviewComment({ ...draft, position: { kind: "deleted", oldLine: 3 } }),
        Json.toReviewComment({
          ...draft,
          position: { kind: "context", oldLine: 7, newLine: 9, side: "left" },
        }),
        Json.toReviewComment({
          ...draft,
          position: { kind: "context", oldLine: 7, newLine: 9, side: "right" },
          startPosition: { kind: "added", newLine: 6 },
        }),
        // A range Gice cannot hold, across both sides, keeps its last line.
        Json.toReviewComment({
          ...draft,
          position: { kind: "added", newLine: 9 },
          startPosition: { kind: "deleted", oldLine: 6 },
        }),
      ],
      [
        { ...draft, side: "RIGHT", line: 4 },
        { ...draft, side: "LEFT", line: 3 },
        { ...draft, side: "LEFT", line: 7 },
        { ...draft, side: "RIGHT", line: 9, start_line: 6, start_side: "RIGHT" },
        { ...draft, side: "RIGHT", line: 9 },
      ],
    );
  });

  it("fingerprints a pull request by its newest event, and its remarks by theirs", () => {
    const event = (id: number, type: string) => ({
      id,
      type,
      number: 7,
      actor: null,
      created_at: "2026-11-19T09:00:00Z",
      payload: {},
    });
    assert.deepStrictEqual(
      Json.toWatchFingerprint(
        decodeEvents({
          events: [
            event(3, "pull.opened"),
            event(5, "review.submitted"),
            event(6, "review_requested"),
            event(8, "review_thread.resolved"),
            event(9, "checks.updated"),
            event(10, "pull.base_updated"),
          ],
          cursor: 10,
          has_more: false,
        }),
      ),
      { status: "10", remarks: "8" },
    );
    assert.deepStrictEqual(
      Json.toWatchFingerprint(decodeEvents({ events: [], cursor: 0, has_more: false })),
      { status: "0", remarks: "" },
    );
  });

  it("matches a search the way Gice does, for a server that cannot search", () => {
    const row = decodePull({ ...pull, title: "Fix the Parser", body: "Handles tabs" });
    assert.deepStrictEqual(
      ["parser fix", "tabs", "#7", "7", "parser spaces", "8", ""].map((query) =>
        Json.matchesQuery(row, query),
      ),
      [true, true, true, true, false, false, true],
    );
  });
});
