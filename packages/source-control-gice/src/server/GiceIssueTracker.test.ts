import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  comment as commentOf,
  event,
  fakeGiceServer,
  feed,
  issue as issueOf,
  listing,
  problem,
  reactions,
  template,
  user,
} from "./GiceApi.testkit.ts";
import { TIMELINE_EVENT_TYPES } from "./giceIssueJson.ts";
import * as GiceIssueTracker from "./GiceIssueTracker.ts";

type Tracker = Effect.Success<typeof GiceIssueTracker.make>;

const withServer = <A, E>(
  routes: Parameters<typeof fakeGiceServer>[0],
  use: (tracker: Tracker) => Effect.Effect<A, E>,
) => {
  const gice = fakeGiceServer(routes);
  return GiceIssueTracker.make.pipe(
    Effect.flatMap(use),
    Effect.map((result) => ({ result, gice })),
    Effect.provide(gice.layer),
  );
};

const target = { cwd: "/repo", host: "code.example", scope: "team/app" };
const R = "/repos/team/app";
const ISSUE_URL = "https://code.example/team/app/issues/4";
const issue = (fields: Record<string, unknown> = {}) =>
  issueOf("team/app", 4, {
    comments_count: 51,
    assignees: [user("alice")],
    reactions: reactions({ heart: 1 }),
    viewer_reactions: ["heart"],
    ...fields,
  });
const comment = (id: number) => commentOf(ISSUE_URL, id);

describe("GiceIssueTracker reading", () => {
  const routes = {
    [`GET ${R}/issues/4`]: issue({
      linked_pulls: [
        {
          number: 5,
          title: "Fix the crash",
          state: "merged",
          is_pull: true,
          draft: false,
          html_url: "https://code.example/team/app/pulls/5",
        },
        {
          number: 6,
          title: "Fix it another way",
          state: "open",
          is_pull: true,
          draft: true,
          html_url: "https://code.example/team/app/pulls/6",
        },
      ],
    }),
    "GET /user": { ...user("carol"), email: "carol@example.com" },
    [`GET ${R}/issues/4/comments?per_page=50&page=2`]: [comment(51)],
    [`GET ${R}/issues/4/comments?per_page=50&page=1`]: [comment(1)],
    [`GET ${R}/issues/4/comments?per_page=50&page=3`]: [],
    [`GET ${R}/events?issue=4&types=${TIMELINE_EVENT_TYPES}&limit=100`]: feed([
      event(2, "assigned", { number: 4, actor: user("bob"), payload: { assignees: ["alice"] } }),
      event(3, "issue.closed", {
        number: 4,
        actor: user("carol"),
        created_at: "2026-11-19T20:46:00Z",
      }),
    ]),
  };
  const detail = withServer(routes, (tracker) => tracker.getIssue({ ...target, key: "4" })).pipe(
    Effect.map(({ result }) => result),
  );

  it.effect("reads an issue with its newest page of comments and a cursor to the one before", () =>
    detail.pipe(
      Effect.map((read) => {
        assert.deepStrictEqual(
          read.comments.map((entry) => entry.id),
          ["51"],
        );
        assert.strictEqual(read.commentsCursor, "1");
      }),
    ),
  );

  it.effect("reads the issue's events, its reactions and what the viewer may do", () =>
    detail.pipe(
      Effect.map((read) => {
        assert.deepStrictEqual(
          read.events.map((entry) => entry.kind),
          ["assigned", "closed"],
        );
        assert.deepStrictEqual(read.reactions, [
          { content: "heart", count: 1, actors: [], viewerHasReacted: true },
        ]);
        assert.deepStrictEqual(read.viewerPermissions, {
          setState: true,
          comment: true,
          edit: true,
          labels: false,
          assignees: false,
        });
        assert.strictEqual(read.viewer, "carol");
      }),
    ),
  );

  it.effect("links the pull requests that close the issue", () =>
    detail.pipe(
      Effect.map((read) =>
        assert.deepStrictEqual(read.linkedPullRequests, [
          {
            repository: "team/app",
            number: 5,
            title: "Fix the crash",
            url: "https://code.example/team/app/pulls/5",
            state: "merged",
            isDraft: false,
            closesIssue: true,
          },
          {
            repository: "team/app",
            number: 6,
            title: "Fix it another way",
            url: "https://code.example/team/app/pulls/6",
            state: "open",
            isDraft: true,
            closesIssue: true,
          },
        ]),
      ),
    ),
  );

  it.effect("walks back to the first page of comments, which has no cursor", () =>
    withServer(routes, (tracker) => tracker.getComments({ ...target, key: "4", cursor: "1" })).pipe(
      Effect.map(({ result }) => {
        assert.deepStrictEqual(
          result.comments.map((entry) => entry.id),
          ["1"],
        );
        assert.strictEqual(result.nextCursor, null);
      }),
    ),
  );

  it.effect("has nothing to walk back through once comments are deleted past a cursor", () =>
    withServer(routes, (tracker) => tracker.getComments({ ...target, key: "4", cursor: "3" })).pipe(
      Effect.map(({ result }) =>
        assert.deepStrictEqual(result, { comments: [], nextCursor: null }),
      ),
    ),
  );

  it.effect("treats a pull request's number as no issue", () =>
    withServer({ [`GET ${R}/issues/7`]: issueOf("team/app", 7, { is_pull: true }) }, (tracker) =>
      Effect.flip(tracker.getIssue({ ...target, key: "7" })),
    ).pipe(
      Effect.map(({ result }) => {
        assert.strictEqual(result.reason, "not-found");
        assert.match(result.detail, /pull request/u);
      }),
    ),
  );

  it.effect("treats a key that is no number as no issue, without asking", () =>
    withServer({}, (tracker) => Effect.flip(tracker.getIssue({ ...target, key: "#7" }))).pipe(
      Effect.map(({ result, gice }) => {
        assert.strictEqual(result.reason, "not-found");
        assert.deepStrictEqual(gice.sent, []);
      }),
    ),
  );
});

describe("GiceIssueTracker listing", () => {
  it.effect(
    "has the server narrow a listing, and keeps 'assigned to me' beside an assignee",
    () => {
      const query =
        "state=open&sort=created&per_page=50&page=2&labels=bug%2Cui&q=crash&assignee=bob";
      return withServer(
        {
          [`GET ${R}/issues?${query}`]: [
            issue({ assignees: [user("bob"), user("Carol")] }),
            issueOf("team/app", 5, { assignees: [user("bob")] }),
          ],
        },
        (tracker) =>
          tracker.listIssues({
            ...target,
            state: "open",
            involvement: "assigned",
            viewer: "carol",
            assignee: "bob",
            labels: ["bug", "ui"],
            query: " crash ",
            sort: "created",
            limit: 20,
            cursor: "2:50",
          }),
      ).pipe(
        Effect.map(({ result }) => {
          assert.deepStrictEqual(
            result.items.map((item) => item.key),
            ["4"],
          );
          assert.strictEqual(result.nextCursor, null);
        }),
      );
    },
  );

  it.effect("hands out a cursor to the next page after a full one", () =>
    withServer(
      {
        [`GET ${R}/issues?state=all&sort=updated&per_page=20&page=1&mentioned=carol`]: Array.from(
          { length: 20 },
          (_, index) => issueOf("team/app", index + 1),
        ),
      },
      (tracker) =>
        tracker.listIssues({
          ...target,
          state: "all",
          involvement: "mentioned",
          viewer: "carol",
          sort: "updated",
          limit: 20,
        }),
    ).pipe(Effect.map(({ result }) => assert.strictEqual(result.nextCursor, "2:20"))),
  );

  it.effect("hands out no cursor after a full page the server counts as the last", () =>
    withServer(
      {
        [`GET ${R}/issues?state=all&sort=updated&per_page=20&page=1&mentioned=carol`]: listing(
          Array.from({ length: 20 }, (_, index) => issueOf("team/app", index + 1)),
          20,
        ),
      },
      (tracker) =>
        tracker.listIssues({
          ...target,
          state: "all",
          involvement: "mentioned",
          viewer: "carol",
          sort: "updated",
          limit: 20,
        }),
    ).pipe(Effect.map(({ result }) => assert.strictEqual(result.nextCursor, null))),
  );

  it.effect("refuses a cursor it did not hand out", () =>
    withServer({}, (tracker) =>
      Effect.flip(
        tracker.listIssues({
          ...target,
          state: "all",
          involvement: "all",
          sort: "updated",
          limit: 20,
          cursor: "x",
        }),
      ),
    ).pipe(
      Effect.map(({ result, gice }) => {
        assert.strictEqual(result.reason, "failed");
        assert.deepStrictEqual(gice.sent, []);
      }),
    ),
  );
});

describe("GiceIssueTracker templates", () => {
  it.effect("offers the default branch's issue templates, keyed by their paths", () =>
    withServer(
      {
        [`GET ${R}/templates?kind=issue`]: [
          template("issue", ".github/ISSUE_TEMPLATE/bug_report.md", {
            name: "Bug report",
            about: "Something does not work",
            title: "[bug] ",
            labels: ["bug"],
            assignees: ["alice"],
            body: "**What happened**\n",
          }),
        ],
      },
      (tracker) => tracker.listTemplates!(target),
    ).pipe(
      Effect.map(({ result }) =>
        assert.deepStrictEqual(result, {
          templates: [
            {
              key: ".github/ISSUE_TEMPLATE/bug_report.md",
              name: "Bug report",
              about: "Something does not work",
              title: "[bug] ",
              body: "**What happened**\n",
              labels: ["bug"],
              assignees: ["alice"],
            },
          ],
          blankIssuesEnabled: true,
        }),
      ),
    ),
  );
});

describe("GiceIssueTracker writing", () => {
  it.effect("writes the whole assignee set as the people added and removed", () =>
    withServer(
      {
        [`PATCH ${R}/issues/4`]: issue(),
        [`PUT ${R}/issues/4/labels`]: [],
        [`GET ${R}/issues/4`]: issue({ assignees: [user("alice"), user("Bob")] }),
        [`POST ${R}/issues/4/assignees`]: issue(),
        [`DELETE ${R}/issues/4/assignees`]: issue(),
      },
      (tracker) =>
        tracker.update!({
          ...target,
          key: "4",
          title: "Crash on launch",
          labels: ["bug"],
          assignees: ["bob", "dave"],
        }),
    ).pipe(
      Effect.map(({ gice }) =>
        assert.deepStrictEqual(gice.bodies(), [
          [`PATCH ${R}/issues/4`, { title: "Crash on launch" }],
          [`PUT ${R}/issues/4/labels`, { labels: ["bug"] }],
          [`GET ${R}/issues/4`, undefined],
          [`POST ${R}/issues/4/assignees`, { assignees: ["dave"] }],
          [`DELETE ${R}/issues/4/assignees`, { assignees: ["alice"] }],
        ]),
      ),
    ),
  );

  it.effect("closes an issue by the state's name", () =>
    withServer({ [`PATCH ${R}/issues/4`]: issue({ state: "closed" }) }, (tracker) =>
      tracker.setState!({ ...target, key: "4", state: "Closed" }),
    ).pipe(
      Effect.map(({ gice }) =>
        assert.deepStrictEqual(gice.bodies(), [[`PATCH ${R}/issues/4`, { state: "closed" }]]),
      ),
    ),
  );

  it.effect("refuses a state Gice does not have", () =>
    withServer({}, (tracker) =>
      Effect.flip(tracker.setState!({ ...target, key: "4", state: "closed" })),
    ).pipe(
      Effect.map(({ result, gice }) => {
        assert.strictEqual(result.reason, "failed");
        assert.deepStrictEqual(gice.sent, []);
      }),
    ),
  );
});

describe("GiceIssueTracker refusals", () => {
  it.effect("passes a refused write on with Gice's message", () =>
    withServer(
      {
        [`POST ${R}/issues`]: problem(
          422,
          "validation_failed",
          "labels: label nope does not exist",
        ),
      },
      (tracker) =>
        Effect.flip(
          tracker.create!({ ...target, title: "T", body: "", labels: ["nope"], assignees: [] }),
        ),
    ).pipe(
      Effect.map(({ result }) =>
        assert.deepStrictEqual(
          [result.reason, result.detail],
          ["failed", "labels: label nope does not exist"],
        ),
      ),
    ),
  );

  it.effect("reports a missing permission as a failure, there being no forbidden reason", () =>
    withServer(
      { [`POST ${R}/issues/4/comments`]: problem(403, "forbidden", "you cannot comment") },
      (tracker) => Effect.flip(tracker.comment!({ ...target, key: "4", body: "Hi" })),
    ).pipe(
      Effect.map(({ result }) =>
        assert.deepStrictEqual([result.reason, result.detail], ["failed", "you cannot comment"]),
      ),
    ),
  );

  it.effect("reports a server it holds no token for as a missing tool", () =>
    withServer({}, (tracker) =>
      Effect.flip(tracker.comment!({ ...target, host: "other.example", key: "5", body: "Hi" })),
    ).pipe(Effect.map(({ result }) => assert.strictEqual(result.reason, "missing-tool"))),
  );

  it.effect("reports a refused token as unauthenticated", () =>
    withServer({ "GET /user": problem(401, "unauthorized", "invalid credentials") }, (tracker) =>
      Effect.flip(tracker.getViewer(target)),
    ).pipe(Effect.map(({ result }) => assert.strictEqual(result.reason, "unauthenticated"))),
  );

  it.effect("passes on when a throttled server said to try again", () =>
    withServer(
      { "GET /user": problem(429, "rate_limited", "slow down", { "retry-after": "30" }) },
      (tracker) => Effect.flip(tracker.getViewer(target)),
    ).pipe(
      Effect.map(({ result }) => {
        assert.strictEqual(result.reason, "rate-limited");
        assert.isNumber(result.retryAt);
      }),
    ),
  );

  it.effect("reports an issue Gice does not have as not found", () =>
    withServer({}, (tracker) =>
      Effect.flip(tracker.getComments({ ...target, key: "9", cursor: "1" })),
    ).pipe(Effect.map(({ result }) => assert.strictEqual(result.reason, "not-found"))),
  );
});
