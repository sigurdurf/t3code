import {
  NonNegativeInt,
  PositiveInt,
  type IssueComment,
  type IssueEvent,
  type IssueLinkedPullRequest,
  type IssueState,
  type IssueViewerPermissions,
} from "@t3tools/contracts";
import type { TrackerIssueSummary } from "@t3tools/source-control-core/server/IssueTracker";
import { toIsoUtc } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Schema from "effect/Schema";

import {
  GiceComment,
  GiceLabel,
  GiceUser,
  Reacted,
  toActor,
  toLabel,
  toReactions,
} from "./gicePullRequestJson.ts";

/** An issue or a pull request one links to, by a closing keyword. */
const GiceIssueLink = Schema.Struct({
  number: PositiveInt,
  title: Schema.String,
  state: Schema.Literals(["open", "closed", "merged"]),
  // False for an issue.
  draft: Schema.Boolean,
  html_url: Schema.String,
});

/** An issue, or a pull request read through the issue routes, which share its numbers. */
export const GiceIssue = Schema.Struct({
  number: PositiveInt,
  html_url: Schema.String,
  title: Schema.String,
  body: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  author: GiceUser,
  comments_count: NonNegativeInt,
  created_at: Schema.String,
  updated_at: Schema.String,
  closed_at: Schema.NullOr(Schema.String),
  is_pull: Schema.Boolean,
  labels: Schema.Array(GiceLabel),
  assignees: Schema.Array(GiceUser),
  viewer_permissions: Schema.Struct({
    can_edit: Schema.Boolean,
    can_close: Schema.Boolean,
    can_reopen: Schema.Boolean,
    can_comment: Schema.Boolean,
    can_label: Schema.Boolean,
    can_assign: Schema.Boolean,
  }),
  // The newest 20 pull requests of the repository whose description or commits close this issue.
  linked_pulls: Schema.Array(GiceIssueLink),
  ...Reacted,
});
export type GiceIssue = typeof GiceIssue.Type;

const Change = Schema.Struct({ from: Schema.String, to: Schema.String });

export const GiceIssueFeed = Schema.Struct({
  events: Schema.Array(
    Schema.Struct({
      id: PositiveInt,
      type: Schema.String,
      actor: Schema.NullOr(GiceUser),
      created_at: Schema.String,
      payload: Schema.Struct({
        labels: Schema.optional(Schema.Array(Schema.String)),
        assignees: Schema.optional(Schema.Array(Schema.String)),
        label: Schema.optional(Schema.String),
        action: Schema.optional(Schema.String),
        name: Schema.optional(Change),
        title: Schema.optional(Change),
      }),
    }),
  ),
});
type GiceIssueFeedEvent = (typeof GiceIssueFeed.Type)["events"][number];

const OPEN: IssueState = { category: "open", name: "Open" };
const CLOSED: IssueState = { category: "closed", name: "Closed" };

/** Gice has exactly the two states and records no reason for a close. */
export const ISSUE_STATES: ReadonlyArray<IssueState> = [OPEN, CLOSED];

export function toIssueSummary(issue: GiceIssue): TrackerIssueSummary {
  return {
    key: String(issue.number),
    displayKey: `#${issue.number}`,
    title: issue.title,
    url: issue.html_url,
    author: toActor(issue.author),
    state: issue.state === "closed" ? CLOSED : OPEN,
    createdAt: toIsoUtc(issue.created_at),
    updatedAt: toIsoUtc(issue.updated_at),
    closedAt: issue.closed_at === null ? null : toIsoUtc(issue.closed_at),
    assignees: issue.assignees.map(toActor),
    labels: issue.labels.map(toLabel),
    commentCount: issue.comments_count,
  };
}

/** Gice links only the pull requests that close an issue, all in its own repository. */
export function toLinkedPullRequests(
  issue: GiceIssue,
  repository: string,
): ReadonlyArray<IssueLinkedPullRequest> {
  return issue.linked_pulls.map((pull) => ({
    repository,
    number: pull.number,
    title: pull.title.trim() || `#${pull.number}`,
    url: pull.html_url,
    state: pull.state,
    isDraft: pull.draft,
    closesIssue: true,
  }));
}

export function toIssueViewerPermissions(issue: GiceIssue): IssueViewerPermissions {
  const can = issue.viewer_permissions;
  return {
    setState: can.can_close || can.can_reopen,
    comment: can.can_comment,
    edit: can.can_edit,
    labels: can.can_label,
    assignees: can.can_assign,
  };
}

export function toIssueComment(comment: typeof GiceComment.Type): IssueComment {
  return {
    id: String(comment.id),
    author: toActor(comment.author),
    body: comment.body,
    createdAt: toIsoUtc(comment.created_at),
    url: comment.html_url,
    reactions: toReactions(comment),
  };
}

/** The feed's types `toIssueEvents` reads, so comments do not crowd them out of a page. */
export const TIMELINE_EVENT_TYPES = [
  "issue.opened",
  "issue.updated",
  "issue.closed",
  "issue.reopened",
  "assigned",
  "unassigned",
  "labels.changed",
].join(",");

/**
 * The feed's events in the shared vocabulary, oldest first. A labelling names the whole set after
 * it, so what changed is read against the set before it, which is unknown until the opening or a
 * labelling in view names one.
 */
export function toIssueEvents(
  events: ReadonlyArray<GiceIssueFeedEvent>,
): ReadonlyArray<IssueEvent> {
  let labels: Set<string> | null = null;
  return events.flatMap((event) => {
    const make = (kind: IssueEvent["kind"], detail: string | null = null): IssueEvent => ({
      id: detail === null ? String(event.id) : `${event.id}:${kind}:${detail}`,
      kind,
      actor: event.actor === null ? null : toActor(event.actor),
      createdAt: toIsoUtc(event.created_at),
      detail,
    });
    const { payload } = event;
    switch (event.type) {
      case "issue.opened":
        if (payload.labels !== undefined) labels = new Set(payload.labels);
        return [];
      case "issue.updated": {
        const title = payload.title?.to.trim();
        return title ? [make("renamed", title)] : [];
      }
      case "issue.closed":
        return [make("closed")];
      case "issue.reopened":
        return [make("reopened")];
      case "assigned":
      case "unassigned":
        return (payload.assignees ?? []).map((login) =>
          make(event.type === "assigned" ? "assigned" : "unassigned", login),
        );
      case "labels.changed": {
        if (payload.labels !== undefined) {
          const before = labels;
          const after = new Set(payload.labels);
          labels = after;
          if (before === null) return [];
          return [
            ...[...after].filter((name) => !before.has(name)).map((name) => make("labeled", name)),
            ...[...before]
              .filter((name) => !after.has(name))
              .map((name) => make("unlabeled", name)),
          ];
        }
        // A repository-wide change, recorded only on the issues carrying the label.
        const { label, action, name } = payload;
        if (label === undefined) return [];
        if (action === "deleted") {
          labels?.delete(label);
          return [make("unlabeled", label)];
        }
        if (name !== undefined && labels?.delete(name.from)) labels.add(name.to);
        return [];
      }
      default:
        return [];
    }
  });
}
