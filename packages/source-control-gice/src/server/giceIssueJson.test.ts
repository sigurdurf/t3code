import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  comment as commentOf,
  event as eventOf,
  feed,
  issue as issueOf,
  label,
  reactions,
  user,
} from "./GiceApi.testkit.ts";
import * as Json from "./giceIssueJson.ts";
import { GiceComment } from "./gicePullRequestJson.ts";

const decodeIssue = Schema.decodeUnknownSync(Json.GiceIssue);
const decodeComment = Schema.decodeUnknownSync(GiceComment);
const decodeFeed = Schema.decodeUnknownSync(Json.GiceIssueFeed);

const gice = user("gice", { display_name: "Gice", is_admin: true });
const GICE = { login: "gice", name: "Gice", avatarUrl: gice.avatar_url };
const ISSUE_URL = "https://code.example/team/app/issues/1";

describe("Gice issue JSON", () => {
  const issue = decodeIssue(
    issueOf("team/app", 1, {
      state: "closed",
      author: gice,
      comments_count: 2,
      closed_at: "2026-11-19T20:45:02Z",
      labels: [label(1, "enhancement")],
      assignees: [user("bob")],
      viewer_permissions: {
        can_edit: true,
        can_close: false,
        can_reopen: true,
        can_comment: true,
        can_label: false,
        can_assign: false,
      },
    }),
  );

  it("reads an issue as the issues route answers it", () => {
    assert.deepStrictEqual(Json.toIssueSummary(issue), {
      key: "1",
      displayKey: "#1",
      title: "Crash on start",
      url: ISSUE_URL,
      author: GICE,
      state: { category: "closed", name: "Closed" },
      createdAt: "2026-11-19T20:44:49.000Z",
      updatedAt: "2026-11-19T20:45:02.000Z",
      closedAt: "2026-11-19T20:45:02.000Z",
      assignees: [
        { login: "bob", name: null, avatarUrl: "https://code.example/api/v1/users/bob/avatar" },
      ],
      labels: [{ name: "enhancement", color: "a2eeef", description: null }],
      commentCount: 2,
    });
  });

  it("lets a viewer who may reopen an issue set its state", () => {
    assert.deepStrictEqual(Json.toIssueViewerPermissions(issue), {
      setState: true,
      comment: true,
      edit: true,
      labels: false,
      assignees: false,
    });
  });

  it("reads a comment with the viewer's reactions", () => {
    const comment = decodeComment(
      commentOf(ISSUE_URL, 1, {
        author: gice,
        reactions: reactions({ rocket: 1 }),
        viewer_reactions: ["rocket"],
      }),
    );
    assert.deepStrictEqual(Json.toIssueComment(comment), {
      id: "1",
      author: GICE,
      body: "Comment 1",
      createdAt: "2026-11-19T09:00:00.000Z",
      url: `${ISSUE_URL}#comment-1`,
      reactions: [{ content: "rocket", count: 1, actors: [], viewerHasReacted: true }],
    });
  });
});

describe("an issue's events", () => {
  const event = (id: number, type: string, payload: object, actor: unknown = gice) =>
    eventOf(id, type, { number: 1, actor, payload });
  const events = (...entries: ReadonlyArray<ReturnType<typeof event>>) =>
    Json.toIssueEvents(decodeFeed(feed(entries)).events).map(({ id, kind, actor, detail }) => [
      id,
      kind,
      actor?.login ?? null,
      detail,
    ]);
  const opened = event(2, "issue.opened", { labels: ["bug"], assignees: ["bob"] });

  it("reads a labelling against the set before it", () => {
    assert.deepStrictEqual(
      events(
        opened,
        event(3, "comment.created", { comment_id: 1 }),
        event(4, "labels.changed", { labels: ["bug", "ui"] }),
        event(5, "labels.changed", { labels: ["ui", "triage"] }),
      ),
      [
        ["4:labeled:ui", "labeled", "gice", "ui"],
        ["5:labeled:triage", "labeled", "gice", "triage"],
        ["5:unlabeled:bug", "unlabeled", "gice", "bug"],
      ],
    );
  });

  it("follows a label renamed or deleted across the repository", () => {
    assert.deepStrictEqual(
      events(
        opened,
        event(4, "labels.changed", {
          action: "updated",
          label: "defect",
          name: { from: "bug", to: "defect" },
        }),
        event(5, "labels.changed", { label: "triage", action: "updated" }),
        event(6, "labels.changed", { labels: [] }),
        event(7, "labels.changed", { label: "ui", action: "deleted" }),
      ),
      [
        ["6:unlabeled:defect", "unlabeled", "gice", "defect"],
        ["7:unlabeled:ui", "unlabeled", "gice", "ui"],
      ],
    );
  });

  // Without the opening in view, or before Gice recorded its labels, the first set is no change.
  it("reads no change from the first set of labels it sees", () => {
    assert.deepStrictEqual(
      events(
        event(2, "issue.opened", {}),
        event(3, "labels.changed", { labels: ["bug"] }),
        event(4, "labels.changed", { labels: [] }),
      ),
      [["4:unlabeled:bug", "unlabeled", "gice", "bug"]],
    );
  });

  it("reads each person assigned or unassigned", () => {
    assert.deepStrictEqual(
      events(
        event(9, "assigned", { assignees: ["bob", "gice"] }),
        event(10, "unassigned", { assignees: ["bob"] }),
      ),
      [
        ["9:assigned:bob", "assigned", "gice", "bob"],
        ["9:assigned:gice", "assigned", "gice", "gice"],
        ["10:unassigned:bob", "unassigned", "gice", "bob"],
      ],
    );
  });

  it("reads a new title, a close by no one in particular and a reopening", () => {
    assert.deepStrictEqual(
      events(
        event(11, "issue.updated", { title: { from: "Crash", to: "Crash on start" } }),
        event(12, "issue.updated", { body_changed: true }),
        event(13, "issue.closed", {}, null),
        event(14, "issue.reopened", {}),
      ),
      [
        ["11:renamed:Crash on start", "renamed", "gice", "Crash on start"],
        ["13", "closed", null, null],
        ["14", "reopened", "gice", null],
      ],
    );
  });
});
