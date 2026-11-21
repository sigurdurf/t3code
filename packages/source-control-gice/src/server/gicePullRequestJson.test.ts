import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  acrossPull,
  comment as commentOf,
  HEAD_SHA,
  job,
  label,
  pull as pullOf,
  pullSummary,
  reactions,
  review,
  reviewComment,
  run,
  stack,
  stackLayer,
  thread,
  user,
} from "./GiceApi.testkit.ts";
import * as Json from "./gicePullRequestJson.ts";

const decodePull = Schema.decodeUnknownSync(Json.GicePull);
const decodeStatus = Schema.decodeUnknownSync(Json.GiceCommitStatus);
const decodeFiles = Schema.decodeUnknownSync(Json.GiceFiles);
const decodeComment = Schema.decodeUnknownSync(Json.GiceComment);
const decodeThreads = Schema.decodeUnknownSync(Schema.Array(Json.GiceReviewThread));
const decodeReviews = Schema.decodeUnknownSync(Schema.Array(Json.GiceReview));
const decodeStack = Schema.decodeUnknownSync(Json.GiceStack);
const decodeRow = Schema.decodeUnknownSync(Json.GicePullRow);

const target = { repository: "team/app" };
const alice = user("alice", { display_name: "Alice" });
const ALICE = { login: "alice", name: "Alice", avatarUrl: alice.avatar_url };
const pull = (fields: Record<string, unknown> = {}) =>
  decodePull(
    pullOf("team/app", 7, {
      author: alice,
      updated_at: "2026-11-19T10:01:40+01:00",
      behind: 0,
      draft: true,
      checks_state: "pending",
      review_decision: "CHANGES_REQUESTED",
      requested_reviewers: [user("bob")],
      labels: [label(1, "bug", { color: "ff0000" })],
      reactions: reactions({ "+1": 2, rocket: 1 }),
      viewer_reactions: ["rocket"],
      merge_blockers: ["draft", "changes_requested"],
      ...fields,
    }),
  );
const changeRequest = (fields: Record<string, unknown> = {}) =>
  Json.toChangeRequest(pull(fields), target);

describe("a pull request", () => {
  it("maps its draft, size, labels, reviewers and decision", () => {
    const read = changeRequest();
    assert.deepStrictEqual(
      {
        url: read.url,
        author: read.author,
        headBranch: read.headBranch,
        head: read.headRepositoryNameWithOwner,
        state: read.state,
        mergeability: read.mergeability,
        updatedAt: read.updatedAt,
        isDraft: read.isDraft,
        additions: read.additions,
        labels: read.labels,
        reviewRequestLogins: read.reviewRequestLogins,
        reviewDecision: read.reviewDecision,
        checksState: read.checksState,
      },
      {
        url: "https://code.example/team/app/pulls/7",
        author: ALICE,
        headBranch: "feature",
        head: "team/app",
        state: "open",
        mergeability: "mergeable",
        updatedAt: "2026-11-19T09:01:40.000Z",
        isDraft: true,
        additions: 12,
        labels: [{ name: "bug", color: "ff0000", description: null }],
        reviewRequestLogins: ["bob"],
        reviewDecision: "changes-requested",
        checksState: "pending",
      },
    );
  });

  it("has no review decision when Gice reports none", () => {
    assert.isNull(changeRequest({ review_decision: null }).reviewDecision);
  });

  it.each([
    ["success", "passing"],
    ["failure", "failing"],
    [null, null],
  ] as const)("reads checks state %s as %s", (state, read) => {
    assert.strictEqual(changeRequest({ checks_state: state }).checksState, read);
  });

  it("summarizes its head, size, auto-merge and that it is in no stack", () => {
    assert.deepStrictEqual(Json.toSummaryFields(pull()), {
      stack: null,
      headSha: HEAD_SHA,
      changedFiles: 3,
      autoMergeEnabled: false,
    });
  });

  it("reads the method auto-merge waits to merge with", () => {
    const waiting = Json.toDetailFields(
      pull({
        auto_merge: {
          enabled_by: alice,
          method: "squash",
          commit_title: null,
          commit_message: null,
          enabled_at: "2026-11-19T09:00:00Z",
        },
      }),
    );
    assert.deepStrictEqual([waiting.autoMergeEnabled, waiting.autoMergeMethod], [true, "squash"]);
  });

  it("counts reactions by content, marking the viewer's", () => {
    assert.deepStrictEqual(Json.toReactions(pull()), [
      { content: "thumbs-up", count: 2, actors: [], viewerHasReacted: false },
      { content: "rocket", count: 1, actors: [], viewerHasReacted: true },
    ]);
  });

  it("reads a listing row, which leaves out the description and what is computed", () => {
    const row = decodePull(pullSummary("team/app", 7));
    assert.strictEqual(Json.toDetailFields(row).body, "");
    assert.strictEqual(Json.toDetailFields(row).baseComparison, "unknown");
    assert.strictEqual(Json.toChangeRequest(row, target).mergeability, "unknown");
  });
});

describe("a pull request's merge state", () => {
  it("reads a merged pull request, merged by a machine account", () => {
    const merged = pull({
      state: "merged",
      merged: true,
      closed_at: "2026-11-19T09:01:40Z",
      merged_at: "2026-11-19T09:01:40Z",
      merged_by: user("bot", { kind: "machine" }),
      merge_commit_sha: "ffede7572ea6fccd3b97f7937252d966a9e432a3",
      mergeable: null,
      ahead: undefined,
      behind: undefined,
    });
    assert.deepStrictEqual(
      [
        Json.toChangeRequest(merged, target).state,
        Json.toChangeRequest(merged, target).mergeability,
      ],
      ["merged", "unknown"],
    );
    assert.deepStrictEqual(Json.toDetailFields(merged), {
      body: "Body",
      closedAt: "2026-11-19T09:01:40.000Z",
      mergedAt: "2026-11-19T09:01:40.000Z",
      mergeCommitSha: "ffede7572ea6fccd3b97f7937252d966a9e432a3",
      mergedBy: {
        login: "bot",
        name: null,
        avatarUrl: "https://code.example/api/v1/users/bot/avatar",
        isBot: true,
      },
      baseComparison: "unknown",
      autoMergeEnabled: false,
    });
  });

  it("reads conflicts and how far the base has moved on", () => {
    const conflicting = pull({ mergeable: false, behind: 3 });
    assert.strictEqual(Json.toChangeRequest(conflicting, target).mergeability, "conflicting");
    assert.deepStrictEqual(
      [Json.toDetailFields(conflicting).baseComparison, Json.toDetailFields(conflicting).behindBy],
      ["behind", 3],
    );
  });

  it("reads a pull request level with its base as up to date", () => {
    assert.strictEqual(Json.toDetailFields(pull()).baseComparison, "up-to-date");
  });
});

describe("a pull request's head repository", () => {
  const fork = {
    cross_repo: true,
    head_label: "bob:feature",
    head_repo: { owner: "bob", name: "app", full_name: "bob/app" },
  };

  it("is the fork a cross-repository pull request comes from", () => {
    assert.strictEqual(changeRequest(fork).headRepositoryNameWithOwner, "bob/app");
  });

  it("is unknown once that fork is deleted", () => {
    assert.isNull(changeRequest({ ...fork, head_repo: null }).headRepositoryNameWithOwner);
  });

  it("is the pull request's own repository when none is recorded", () => {
    assert.strictEqual(changeRequest({ head_repo: null }).headRepositoryNameWithOwner, "team/app");
  });
});

describe("checks", () => {
  const runUrl = (number: number) => `https://code.example/team/app/runs/${number}`;

  it("turns each job of a run into a check, and a run without jobs into one, failures first", () => {
    const status = decodeStatus({
      sha: HEAD_SHA,
      state: "pending",
      runs: [
        run(12, {
          jobs: [
            job(12, 31, { name: "Unit tests", conclusion: "failure" }),
            job(12, 32, {
              name: "",
              status: "queued",
              conclusion: null,
              started_at: null,
              completed_at: null,
            }),
          ],
        }),
        run(13, { event: "push" }),
        run(11, { status: "in_progress", conclusion: null, finished_at: null }),
        run(10, {
          workflow: { path: ".gice/workflows/lint.yml", name: "" },
          conclusion: "failure",
          error: "workflow file is invalid",
        }),
        run(9, { workflow: { path: "d.yml", name: "Deploy" }, conclusion: "cancelled" }),
        run(8, { workflow: { path: "s.yml", name: "Skip" }, conclusion: "skipped" }),
      ],
    });
    assert.deepStrictEqual(Json.toChecks(status), [
      {
        name: "CI / Unit tests (pull_request)",
        status: "failure",
        description: null,
        url: `${runUrl(12)}?job=31`,
      },
      {
        name: ".gice/workflows/lint.yml (pull_request)",
        status: "failure",
        description: "workflow file is invalid",
        url: runUrl(10),
      },
      { name: "Deploy (pull_request)", status: "cancelled", description: null, url: runUrl(9) },
      {
        name: "CI / 32 (pull_request)",
        status: "pending",
        description: null,
        url: `${runUrl(12)}?job=32`,
      },
      { name: "CI (push)", status: "success", description: null, url: runUrl(13) },
      { name: "CI (pull_request)", status: "pending", description: null, url: runUrl(11) },
      { name: "Skip (pull_request)", status: "skipped", description: null, url: runUrl(8) },
    ]);
  });

  // Links as internal/api/workflows.go writes them: a run's, and a job's with `?job=`.
  it.each([
    [`${runUrl(12)}?job=31`, 12, 31],
    [runUrl(12), 12, null],
    ["https://code.example/team/app/pulls/12?job=31", null, null],
    [null, null, null],
  ] as const)("reads the run and job of %s", (url, runNumber, jobId) => {
    assert.deepStrictEqual([Json.runNumberOf(url), Json.jobIdOf(url)], [runNumber, jobId]);
  });
});

describe("diffs", () => {
  const section = (path: string, index: string, body = "@@ -1 +1 @@\n-old\n+new\n") =>
    `diff --git a/${path} b/${path}\nindex ${index} 100644\n--- a/${path}\n+++ b/${path}\n${body}`;
  const file = (path: string, status = "modified") => ({
    path,
    status,
    additions: 3,
    deletions: 1,
    is_binary: false,
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
  });
});

describe("comments", () => {
  it("reads a comment on the conversation", () => {
    const url = "https://code.example/team/app/pulls/7";
    const comment = decodeComment(
      commentOf(url, 31, { body: "Looks right", author: alice, viewer_can_edit: true }),
    );
    assert.deepStrictEqual(Json.toComment(comment), {
      id: "31",
      kind: "issue-comment",
      author: ALICE,
      body: "Looks right",
      createdAt: "2026-11-19T09:00:00.000Z",
      editedAt: null,
      url: `${url}#comment-31`,
      reactions: [],
      canEdit: true,
      path: null,
      reviewState: null,
    });
  });
});

describe("what the viewer may do", () => {
  const permissions = {
    can_edit: true,
    can_close: true,
    can_reopen: false,
    can_merge: true,
    can_update_branch: true,
    can_delete_head_branch: false,
    can_comment: true,
    can_label: true,
    can_review: true,
    can_approve: true,
    can_request_reviewers: true,
    merge_methods: ["merge", "squash", "rebase"],
    can_revert: false,
  };
  const read = (fields: Record<string, unknown>, can: Record<string, unknown>) =>
    Json.toViewerPermissions(pull({ ...fields, viewer_permissions: { ...permissions, ...can } }));

  it("offers everything to a maintainer of an open draft", () => {
    assert.deepStrictEqual(read({}, {}), {
      actions: ["merge", "ready", "close", "update-branch", "enable-auto-merge"],
      comment: true,
      resolve: true,
      verdicts: ["comment", "approve", "request-changes"],
      requestReviewers: true,
      labels: true,
      editChangeRequest: true,
      updateMethods: ["merge", "rebase"],
    });
  });

  it("offers to rebase a stack as the stack itself says, and not one that branches", () => {
    const inStack = (fields: Record<string, unknown>, can: Record<string, unknown> = {}) =>
      Json.toViewerPermissions(
        pull({ viewer_permissions: { ...permissions, ...can } }),
        decodeStack(stack(7, [stackLayer(6, { children: [7] }), stackLayer(7)], fields)),
      ).stackRebase;
    assert.deepStrictEqual(
      [
        inStack({}),
        inStack({}, { can_label: false }),
        inStack({ viewer_permissions: { can_merge: true, can_restack: false } }),
        inStack({ branched: true }),
      ],
      [true, true, undefined, undefined],
    );
  });

  it.each([
    ["a writer", ["merge", "squash", "rebase"], { merge: true, squash: true, rebase: true }],
    ["a reader", [], { merge: false, squash: false, rebase: false }],
    ["one method", ["squash"], { merge: false, squash: true, rebase: false }],
  ])("merges with the methods Gice names for %s", (_name, methods, expected) => {
    assert.deepStrictEqual(
      Json.toMergeCapabilities(
        pull({ viewer_permissions: { ...permissions, merge_methods: methods } }),
      ),
      expected,
    );
  });

  it("offers no rebase of a branch other pull requests are based on", () => {
    assert.deepStrictEqual(read({ head_branch_pulls: [8] }, {}).updateMethods, ["merge"]);
  });

  it("offers an author who cannot push no merge, labels or verdict on their own work", () => {
    const author = read(
      { draft: false },
      { can_merge: false, can_update_branch: false, can_approve: false, can_label: false },
    );
    assert.deepStrictEqual(
      [author.actions, author.verdicts, author.labels, author.updateMethods],
      [["draft", "close"], ["comment"], false, []],
    );
  });

  it("offers only deleting the branch of a merged pull request, and reverting it", () => {
    assert.deepStrictEqual(
      read(
        { state: "merged", auto_merge: null },
        {
          can_close: false,
          can_merge: false,
          can_update_branch: false,
          can_delete_head_branch: true,
          can_request_reviewers: false,
          can_revert: true,
        },
      ).actions,
      ["delete-branch", "revert"],
    );
  });

  it("offers to turn off an auto-merge that is waiting", () => {
    assert.deepStrictEqual(
      read({ auto_merge: { method: "merge" } }, {}).actions.filter((action) =>
        action.endsWith("auto-merge"),
      ),
      ["disable-auto-merge"],
    );
  });
});

describe("stacks", () => {
  // Three pull requests of a stack, as `GET R/pulls/{n}` and `GET R/pulls` carry them.
  const row = (number: number, base: string, stackFields: Record<string, unknown>) =>
    decodeRow(
      pullSummary("team/app", number, {
        base,
        stack: { parent: null, children: [], size: 3, bottom: 6, ...stackFields },
      }),
    );
  const one = row(6, "main", { position: 1, children: [7] });
  const two = row(7, "layer-6", { position: 2, parent: 6, children: [8] });
  const three = row(8, "layer-7", { position: 3, parent: 7 });

  it("names a stack after its bottom pull request, on the base of the bottom listed with it", () => {
    const listed = new Map([one, three].map((pull) => [pull.number, pull]));
    assert.deepStrictEqual(
      [one, two, three].map((pull) => Json.toStackMembership(pull, listed)),
      [6, 6, 6].map((number, index) => ({ number, position: index + 1, size: 3, base: "main" })),
    );
  });

  it("takes a layer's own base where the bottom is not read with it", () => {
    assert.deepStrictEqual(Json.toStackMembership(two), {
      number: 6,
      position: 2,
      size: 3,
      base: "layer-6",
    });
  });

  it("says when a pull request is in no stack, and when Gice did not say", () => {
    const { stack: _, ...unstacked }: Record<string, unknown> = acrossPull("team/app", 9);
    assert.deepStrictEqual(
      [
        Json.toStackMembership(decodeRow(acrossPull("team/app", 9))),
        Json.toStackMembership(decodeRow(unstacked)),
      ],
      [null, undefined],
    );
  });

  it("reads a stack bottom first, merging into the base of its lowest open layer", () => {
    // A real stack after #6 was squash-merged and deleting its branch moved #7 onto main.
    const read = Json.toStack(
      decodeStack(
        stack(8, [
          stackLayer(6, { state: "merged", children: [7], base_sha: null }),
          stackLayer(7, { parent: 6, children: [8], draft: true, needs_restack: true }),
          stackLayer(8, { parent: 7, base: "layer-7", head_sha: null }),
        ]),
      ),
    );
    assert.deepStrictEqual(read, {
      id: "6",
      number: 6,
      url: "https://code.example/team/app/pulls/6",
      base: "main",
      layers: [
        {
          number: 6,
          title: "Layer 6",
          isDraft: false,
          headSha: HEAD_SHA,
          headBranch: "layer-6",
          state: "merged",
        },
        {
          number: 7,
          title: "Layer 7",
          isDraft: true,
          headSha: HEAD_SHA,
          headBranch: "layer-7",
          state: "open",
        },
        { number: 8, title: "Layer 8", isDraft: false, headBranch: "layer-8", state: "open" },
      ],
    });
  });

  it("lands a stack where Gice says it merges", () => {
    const read = Json.toStack(
      decodeStack(
        stack(
          8,
          [stackLayer(7, { children: [8] }), stackLayer(8, { parent: 7, base: "layer-7" })],
          {
            merge_into: "release",
          },
        ),
      ),
    );
    assert.strictEqual(read?.base, "release");
  });

  it("has no stack for a pull request built on an integration branch", () => {
    // `develop` is the head of the release pull request #1, which bounds the stack.
    const boundary = stack(2, [stackLayer(2, { base: "develop" })], {
      trunk: "develop",
      trunk_pull: { number: 1, title: "Release 1.0", state: "open" },
      merge_into: "develop",
    });
    assert.isNull(Json.toStack(decodeStack(boundary)));
  });
});

describe("reviews and threads", () => {
  it("reads reviews, leaving out the empty ones that only carry a line comment", () => {
    const reviews = decodeReviews([
      review(1, { state: "CHANGES_REQUESTED", body: "Fix this" }),
      review(2, { body: " " }),
      review(3, { body: "A remark" }),
      review(4, { state: "APPROVED" }),
    ]);
    assert.deepStrictEqual(
      Json.toReviews(reviews).map((remark) => [remark.id, remark.kind, remark.reviewState]),
      [
        ["review:1", "review", "CHANGES_REQUESTED"],
        ["review:3", "review", "COMMENTED"],
        ["review:4", "review", "APPROVED"],
      ],
    );
  });

  it("reads a thread's place, falling back to its first line once outdated", () => {
    const threads = Json.toReviewThreads(
      decodeThreads([
        thread(5),
        thread(6, {
          side: "LEFT",
          line: null,
          outdated: true,
          resolved: true,
          viewer_can_resolve: false,
          comments: [reviewComment(11)],
        }),
        thread(7, { subject_type: "file", side: null, line: null, original_line: null }),
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
  });

  it("leaves out a thread whose comments are all gone", () => {
    assert.deepStrictEqual(Json.toReviewThreads(decodeThreads([thread(8, { comments: [] })])), []);
  });

  it("reads a thread's comment with its edit, reactions and review", () => {
    const [read] = Json.toReviewThreads(
      decodeThreads([
        thread(5, {
          comments: [
            reviewComment(9, {
              user: alice,
              edited_at: "2026-11-19T09:05:00Z",
              reactions: reactions({ "+1": 2, rocket: 1 }),
            }),
          ],
        }),
      ]),
    );
    assert.deepStrictEqual(read?.comments[0], {
      id: "review-comment:9",
      author: ALICE,
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
  });

  it("reads back only the ids it handed out", () => {
    assert.deepStrictEqual(Json.threadIdParts("5:8"), { thread: "5", comment: "8" });
    assert.strictEqual(Json.threadIdParts("5"), null);
    assert.strictEqual(Json.reviewCommentIdOf("review-comment:9"), "9");
    assert.strictEqual(Json.reviewCommentIdOf("9"), null);
  });
});

describe("a line comment being written", () => {
  const draft = { path: "src/a.ts", body: "Here" };

  it.each([
    [
      { kind: "added", newLine: 4 },
      { side: "RIGHT", line: 4 },
    ],
    [
      { kind: "deleted", oldLine: 3 },
      { side: "LEFT", line: 3 },
    ],
    [
      { kind: "context", oldLine: 7, newLine: 9, side: "left" },
      { side: "LEFT", line: 7 },
    ],
  ] as const)("is anchored to the side its line is on: %o", (position, anchor) => {
    assert.deepStrictEqual(Json.toReviewComment({ ...draft, position }), { ...draft, ...anchor });
  });

  it("keeps a range on one side", () => {
    assert.deepStrictEqual(
      Json.toReviewComment({
        ...draft,
        position: { kind: "context", oldLine: 7, newLine: 9, side: "right" },
        startPosition: { kind: "added", newLine: 6 },
      }),
      { ...draft, side: "RIGHT", line: 9, start_line: 6, start_side: "RIGHT" },
    );
  });

  it("anchors a range across both sides, which Gice cannot hold, to its last line", () => {
    assert.deepStrictEqual(
      Json.toReviewComment({
        ...draft,
        position: { kind: "added", newLine: 9 },
        startPosition: { kind: "deleted", oldLine: 6 },
      }),
      { ...draft, side: "RIGHT", line: 9 },
    );
  });
});
