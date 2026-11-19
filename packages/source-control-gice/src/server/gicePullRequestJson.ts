import {
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  type PullRequestActor,
  type PullRequestCheck,
  type PullRequestChecksState,
  type PullRequestComment,
  type PullRequestCommit,
  type PullRequestLabel,
  type PullRequestMergeMethod,
  type PullRequestReaction,
  type PullRequestReactionContent,
  type PullRequestReviewCommentDraft,
  type PullRequestReviewDecision,
  type PullRequestReviewThread,
  type PullRequestReviewerCandidate,
  type PullRequestThreadComment,
  type PullRequestViewerPermissions,
} from "@t3tools/contracts";
import {
  parseDiffFilePaths,
  parseDiffFileRevisions,
} from "@t3tools/source-control-core/server/diffFileRevisions";
import {
  rollupCheckStatuses,
  sortChecks,
} from "@t3tools/source-control-core/server/pullRequestChecks";
import type {
  ProviderChangeRequest,
  ProviderChangeRequestWatchFingerprint,
  ProviderDiffSlice,
  ProviderFileRevisions,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import { toIsoUtc } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Schema from "effect/Schema";

import type { GiceFeatures } from "./GiceApi.ts";

// Every field a server added after the original API is optional here: a server that predates it
// leaves the key out, and Go writes an empty list it never filled as null.
export const GiceUser = Schema.Struct({
  username: TrimmedNonEmptyString,
  display_name: Schema.optional(Schema.NullOr(Schema.String)),
  kind: Schema.optional(Schema.String),
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
});
type GiceUser = typeof GiceUser.Type;

export const GiceCollaborator = Schema.Struct({ user: GiceUser });

export const GiceLabel = Schema.Struct({
  name: TrimmedNonEmptyString,
  color: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
});

const REACTIONS = {
  "thumbs-up": "+1",
  "thumbs-down": "-1",
  laugh: "laugh",
  hooray: "hooray",
  confused: "confused",
  heart: "heart",
  rocket: "rocket",
  eyes: "eyes",
} as const satisfies Record<PullRequestReactionContent, string>;

export const reactionContent = (content: PullRequestReactionContent): string => REACTIONS[content];

const ReactionCount = Schema.optional(NonNegativeInt);
const ReactionCounts = Schema.Struct({
  "+1": ReactionCount,
  "-1": ReactionCount,
  laugh: ReactionCount,
  hooray: ReactionCount,
  confused: ReactionCount,
  heart: ReactionCount,
  rocket: ReactionCount,
  eyes: ReactionCount,
});
const Reacted = {
  reactions: Schema.optional(Schema.NullOr(ReactionCounts)),
  viewer_reactions: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
};
interface ReactedTo {
  readonly reactions?: typeof ReactionCounts.Type | null | undefined;
  readonly viewer_reactions?: ReadonlyArray<string> | null | undefined;
}

const GiceViewerPermissions = Schema.Struct({
  can_edit: Schema.Boolean,
  can_close: Schema.Boolean,
  can_reopen: Schema.Boolean,
  can_merge: Schema.Boolean,
  can_update_branch: Schema.Boolean,
  can_delete_head_branch: Schema.Boolean,
  can_comment: Schema.Boolean,
  can_review: Schema.Boolean,
  can_approve: Schema.Boolean,
  can_request_reviewers: Schema.Boolean,
  merge_methods: Schema.Array(Schema.String),
});

export const GiceRepository = Schema.Struct({ permission: Schema.String });

export const GicePull = Schema.Struct({
  number: PositiveInt,
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.String,
  // A listing asked for `fields=summary` leaves the description out.
  body: Schema.optional(Schema.String),
  state: Schema.Literals(["open", "closed", "merged"]),
  author: GiceUser,
  created_at: Schema.String,
  updated_at: Schema.String,
  closed_at: Schema.NullOr(Schema.String),
  head: Schema.String,
  base: Schema.String,
  head_repo: Schema.optional(Schema.NullOr(Schema.Struct({ full_name: TrimmedNonEmptyString }))),
  cross_repo: Schema.optional(Schema.Boolean),
  merged_at: Schema.NullOr(Schema.String),
  merged_by: Schema.optional(Schema.NullOr(GiceUser)),
  merge_commit_sha: Schema.optional(Schema.NullOr(Schema.String)),
  revisions_count: Schema.optional(PositiveInt),
  // Only a single pull request read computes these; a listing leaves them out.
  mergeable: Schema.optional(Schema.NullOr(Schema.Boolean)),
  behind: Schema.optional(NonNegativeInt),
  draft: Schema.optional(Schema.Boolean),
  head_sha: Schema.optional(Schema.NullOr(Schema.String)),
  additions: Schema.optional(NonNegativeInt),
  deletions: Schema.optional(NonNegativeInt),
  changed_files: Schema.optional(NonNegativeInt),
  auto_merge: Schema.optional(Schema.NullOr(Schema.Struct({ method: Schema.String }))),
  viewer_permissions: Schema.optional(Schema.NullOr(GiceViewerPermissions)),
  review_decision: Schema.optional(Schema.NullOr(Schema.String)),
  requested_reviewers: Schema.optional(Schema.NullOr(Schema.Array(GiceUser))),
  labels: Schema.optional(Schema.NullOr(Schema.Array(GiceLabel))),
  ...Reacted,
});
export type GicePull = typeof GicePull.Type;

export const GiceComment = Schema.Struct({
  id: PositiveInt,
  body: Schema.String,
  author: GiceUser,
  created_at: Schema.String,
  updated_at: Schema.String,
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  viewer_can_edit: Schema.optional(Schema.Boolean),
  ...Reacted,
});

export const GiceReview = Schema.Struct({
  id: PositiveInt,
  user: GiceUser,
  body: Schema.String,
  state: Schema.String,
  submitted_at: Schema.String,
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
});

const GiceReviewComment = Schema.Struct({
  id: PositiveInt,
  pull_request_review_id: Schema.optional(Schema.NullOr(PositiveInt)),
  user: GiceUser,
  body: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  viewer_can_edit: Schema.optional(Schema.Boolean),
  ...Reacted,
});

export const GiceReviewThread = Schema.Struct({
  id: PositiveInt,
  path: TrimmedNonEmptyString,
  side: Schema.NullOr(Schema.String),
  line: Schema.NullOr(PositiveInt),
  original_line: Schema.optional(Schema.NullOr(PositiveInt)),
  outdated: Schema.Boolean,
  resolved: Schema.Boolean,
  viewer_can_resolve: Schema.optional(Schema.Boolean),
  comments: Schema.Array(GiceReviewComment),
});

export const GiceReaction = Schema.Struct({ id: PositiveInt });

/** The commit message a merge would get, split where `commit_title` and `commit_message` replace it. */
export const GiceMergeMessage = Schema.Struct({ title: Schema.String, message: Schema.String });

export const GiceEvents = Schema.Struct({
  events: Schema.Array(Schema.Struct({ id: PositiveInt, type: Schema.String })),
  cursor: NonNegativeInt,
});

export const GiceCommit = Schema.Struct({
  sha: TrimmedNonEmptyString,
  parents: Schema.optional(Schema.Array(Schema.String)),
  message: Schema.String,
  committer: Schema.Struct({ date: Schema.String }),
});

const GiceFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  old_path: Schema.optional(Schema.String),
  status: Schema.String,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});

/** A pull request's files and a commit's own changes share this shape. */
export const GiceFiles = Schema.Struct({
  files: Schema.Array(GiceFile),
  patch: Schema.optional(Schema.String),
  truncated: Schema.optional(Schema.Boolean),
});
export type GiceFiles = typeof GiceFiles.Type;

export const GiceRevision = Schema.Struct({
  head_sha: TrimmedNonEmptyString,
  base_sha: TrimmedNonEmptyString,
});

export const GiceBlob = Schema.Struct({
  is_binary: Schema.Boolean,
  // Base64; left out above the server's size limit.
  content: Schema.optional(Schema.String),
});

const GiceRun = Schema.Struct({
  number: PositiveInt,
  workflow: Schema.Struct({ path: Schema.String, name: Schema.String }),
  event: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  error: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  jobs: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          id: PositiveInt,
          name: Schema.String,
          status: Schema.String,
          conclusion: Schema.NullOr(Schema.String),
          html_url: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  ),
});
type GiceRun = typeof GiceRun.Type;

export const GiceCommitStatus = Schema.Struct({
  sha: TrimmedNonEmptyString,
  runs: Schema.Array(GiceRun),
});
export type GiceCommitStatus = typeof GiceCommitStatus.Type;

export const GiceRunJobs = Schema.Struct({
  jobs: Schema.Array(
    Schema.Struct({
      id: PositiveInt,
      name: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
    }),
  ),
});

interface RepositoryOnHost {
  readonly repository: string;
  readonly host: string;
}

const repositoryUrl = (target: RepositoryOnHost) => `https://${target.host}/${target.repository}`;

export function toActor(user: GiceUser): PullRequestActor {
  return {
    login: user.username,
    name: user.display_name || null,
    avatarUrl: user.avatar_url || null,
    ...(user.kind === "machine" ? { isBot: true } : {}),
  };
}

const mergeabilityOf = (pull: GicePull) =>
  pull.mergeable == null ? "unknown" : pull.mergeable ? "mergeable" : "conflicting";

export function toChangeRequest(pull: GicePull, target: RepositoryOnHost): ProviderChangeRequest {
  return {
    number: pull.number,
    title: pull.title,
    // The server knows its own address; an older one leaves the host it was reached on.
    url: pull.html_url || `${repositoryUrl(target)}/pulls/${pull.number}`,
    author: toActor(pull.author),
    headBranch: pull.head,
    // A fork that was deleted leaves a cross-repository pull request without a head repository.
    headRepositoryNameWithOwner:
      pull.cross_repo === true ? (pull.head_repo?.full_name ?? null) : target.repository,
    baseBranch: pull.base,
    state: pull.state,
    isDraft: pull.draft === true,
    mergeability: mergeabilityOf(pull),
    additions: pull.additions ?? 0,
    deletions: pull.deletions ?? 0,
    createdAt: toIsoUtc(pull.created_at),
    updatedAt: toIsoUtc(pull.updated_at),
    closedAt: pull.closed_at === null ? null : toIsoUtc(pull.closed_at),
    mergedAt: pull.merged_at === null ? null : toIsoUtc(pull.merged_at),
    reviewRequestLogins: (pull.requested_reviewers ?? []).map((user) => user.username),
    labels: (pull.labels ?? []).map(toLabel),
    ...(pull.review_decision === undefined
      ? {}
      : { reviewDecision: reviewDecisionOf(pull.review_decision) }),
  };
}

export function toLabel(label: typeof GiceLabel.Type): PullRequestLabel {
  return {
    name: label.name,
    color: label.color || null,
    description: label.description || null,
  };
}

function reviewDecisionOf(decision: string | null): PullRequestReviewDecision | null {
  switch (decision) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes-requested";
    case "REVIEW_REQUIRED":
      return "review-required";
    default:
      return null;
  }
}

/** What the pull request itself says about its head, size and auto-merge, where it says it. */
export function toSummaryFields(pull: GicePull) {
  return {
    ...(pull.head_sha ? { headSha: pull.head_sha } : {}),
    ...(pull.additions === undefined || pull.deletions === undefined
      ? {}
      : { additions: pull.additions, deletions: pull.deletions }),
    ...(pull.changed_files === undefined ? {} : { changedFiles: pull.changed_files }),
    ...autoMergeFields(pull),
  };
}

export const requestedReviewers = (pull: GicePull): ReadonlyArray<PullRequestActor> =>
  (pull.requested_reviewers ?? []).map(toActor);

export function toReviewerCandidate(
  user: GiceUser,
  requested: ReadonlySet<string>,
): PullRequestReviewerCandidate {
  return {
    ...toActor(user),
    id: user.username,
    kind: "user",
    isRequested: requested.has(user.username.toLowerCase()),
  };
}

export function toDetailFields(pull: GicePull) {
  return {
    body: pull.body ?? "",
    closedAt: pull.closed_at === null ? null : toIsoUtc(pull.closed_at),
    mergedAt: pull.merged_at === null ? null : toIsoUtc(pull.merged_at),
    mergeCommitSha: pull.merge_commit_sha ?? null,
    mergedBy: pull.merged_by == null ? null : toActor(pull.merged_by),
    baseComparison:
      pull.behind === undefined
        ? ("unknown" as const)
        : pull.behind === 0
          ? ("up-to-date" as const)
          : ("behind" as const),
    ...(pull.behind === undefined ? {} : { behindBy: pull.behind }),
    ...autoMergeFields(pull),
  };
}

function autoMergeFields(pull: GicePull) {
  if (pull.auto_merge === undefined) return {};
  if (pull.auto_merge === null) return { autoMergeEnabled: false };
  const { method } = pull.auto_merge;
  const autoMergeMethod: PullRequestMergeMethod =
    method === "squash" || method === "rebase" ? method : "merge";
  return { autoMergeEnabled: true, autoMergeMethod };
}

/** Gice lets the author or anyone with write access edit, close and reopen; merging needs write. */
export function toViewerPermissions(
  pull: GicePull,
  access: { readonly viewer: string; readonly permission: string },
): PullRequestViewerPermissions {
  const canWrite = access.permission === "write" || access.permission === "admin";
  const canEdit =
    canWrite || pull.author.username.toLowerCase() === access.viewer.trim().toLowerCase();
  return {
    actions: [
      ...(canWrite && pull.state === "open" ? (["merge"] as const) : []),
      ...(canEdit && pull.state === "open" ? (["close"] as const) : []),
      ...(canEdit && pull.state === "closed" ? (["reopen"] as const) : []),
    ],
    comment: true,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
    labels: false,
    editChangeRequest: canEdit,
    updateMethods: [],
  };
}

/**
 * The server's own answer for the caller, narrowed to what it can carry out. Labelling needs
 * write access, which only the merge methods it offers give away.
 */
export function toReportedViewerPermissions(
  pull: GicePull,
  can: NonNullable<GicePull["viewer_permissions"]>,
  features: GiceFeatures,
): PullRequestViewerPermissions {
  const open = pull.state === "open";
  const autoMerge = can.can_merge && features.has("pull_auto_merge");
  const updateBranch = can.can_update_branch && features.has("pull_update_branch");
  return {
    actions: [
      ...(can.can_merge ? (["merge"] as const) : []),
      ...(can.can_edit && open && features.has("pull_drafts")
        ? ([pull.draft === true ? "ready" : "draft"] as const)
        : []),
      ...(can.can_close ? (["close"] as const) : []),
      ...(can.can_reopen ? (["reopen"] as const) : []),
      ...(can.can_delete_head_branch && features.has("pull_merge_options")
        ? (["delete-branch"] as const)
        : []),
      ...(updateBranch ? (["update-branch"] as const) : []),
      ...(autoMerge && pull.auto_merge == null ? (["enable-auto-merge"] as const) : []),
      ...(autoMerge ? (["disable-auto-merge"] as const) : []),
    ],
    comment: can.can_comment,
    // A thread says itself whether this caller may resolve it.
    resolve: can.can_review && features.has("pull_review_threads"),
    verdicts: features.has("pull_reviews")
      ? [
          ...(can.can_review ? (["comment"] as const) : []),
          ...(can.can_approve ? (["approve", "request-changes"] as const) : []),
        ]
      : [],
    requestReviewers: can.can_request_reviewers && features.has("pull_reviewer_requests"),
    labels: can.merge_methods.length > 0 && features.has("labels"),
    editChangeRequest: can.can_edit,
    updateMethods: updateBranch ? ["merge", "rebase"] : [],
  };
}

function checkStatus(run: {
  readonly status: string;
  readonly conclusion: string | null;
}): PullRequestCheck["status"] {
  if (run.status !== "completed") return "pending";
  switch (run.conclusion) {
    case "success":
      return "success";
    case "skipped":
      return "skipped";
    case "cancelled":
      return "cancelled";
    default:
      return "failure";
  }
}

/**
 * Gice's commit status holds the latest run of each workflow per event. Each of a run's jobs is a
 * check where the server lists them, and the run as a whole where it does not or has none. The
 * event is part of the name because one workflow can run for a push and a pull request alike.
 */
export function toChecks(
  status: GiceCommitStatus,
  target: RepositoryOnHost,
): {
  readonly checks: ReadonlyArray<PullRequestCheck>;
  readonly state: PullRequestChecksState | null;
} {
  const checks = sortChecks(
    status.runs.flatMap((run): ReadonlyArray<PullRequestCheck> => {
      const workflow = run.workflow.name.trim() || run.workflow.path;
      const url = run.html_url || `${repositoryUrl(target)}/runs/${run.number}`;
      if (run.jobs == null || run.jobs.length === 0)
        return [
          {
            name: `${workflow} (${run.event})`,
            status: checkStatus(run),
            description: run.error || null,
            url,
          },
        ];
      return run.jobs.map((job) => ({
        name: `${workflow} / ${job.name.trim() || job.id} (${run.event})`,
        status: checkStatus(job),
        description: null,
        url: job.html_url || `${url}?job=${job.id}`,
      }));
    }),
  );
  return { checks, state: rollupCheckStatuses(checks.map((check) => check.status)) };
}

/** The run a check's link names, which is what its jobs, logs and re-run hang off. */
export function runNumberOf(url: string | null): number | null {
  const match = url === null ? null : /\/runs\/(\d+)(?:[/?#]|$)/u.exec(url);
  return match === null ? null : Number(match[1]);
}

/** The one job a check stands for, when it is a job rather than a whole run. */
export function jobIdOf(url: string | null): number | null {
  const match = url === null ? null : /\/runs\/\d+\?(?:.*&)?job=(\d+)(?:[&#]|$)/u.exec(url);
  return match === null ? null : Number(match[1]);
}

/**
 * Gice cuts a patch at a byte limit, which can fall inside a file's hunks, so a cut patch loses
 * its last section. The file list is never cut and names what the kept patch is missing.
 */
function wholePatch(diff: GiceFiles) {
  const patch = diff.patch ?? "";
  if (diff.truncated !== true) return { patch, withheld: [] };
  const lastSection = patch.lastIndexOf("\ndiff --git ");
  const kept = lastSection === -1 ? "" : patch.slice(0, lastSection + 1);
  const present = new Set(parseDiffFilePaths(kept).map((file) => file.newPath ?? file.oldPath));
  return { patch: kept, withheld: diff.files.filter((file) => !present.has(file.path)) };
}

export function toDiff(diff: GiceFiles, withheldFilesReadable = false): ProviderDiffSlice {
  const { patch, withheld } = wholePatch(diff);
  return {
    patch,
    truncated: withheld.length > 0,
    nextCursor: null,
    ...(withheld.length === 0
      ? {}
      : {
          ...(withheldFilesReadable ? { withheldFilesReadable } : {}),
          omittedFileStats: withheld.map((file) => ({
            path: file.path,
            additions: file.additions,
            deletions: file.deletions,
          })),
        }),
  };
}

/**
 * A file the patch was cut before has a version Gice did not send, so it is left out. A path the
 * pull request does not list at all was looked at and has none.
 */
export function toFileRevisions(
  diff: GiceFiles,
  paths: ReadonlyArray<string>,
): ProviderFileRevisions {
  const { patch, withheld } = wholePatch(diff);
  const revisions = new Map(parseDiffFileRevisions(patch));
  const unread = new Set(withheld.map((file) => file.path));
  for (const path of paths) {
    if (!revisions.has(path) && !unread.has(path)) revisions.set(path, "");
  }
  return { revisions, complete: withheld.length === 0 };
}

/** The counts the server keeps per content; it does not say who reacted. */
export function toReactions(subject: ReactedTo): ReadonlyArray<PullRequestReaction> {
  const counts = subject.reactions;
  if (counts == null) return [];
  const mine = new Set(subject.viewer_reactions ?? []);
  return Object.entries(REACTIONS).flatMap(([content, key]) => {
    const count = counts[key] ?? 0;
    return count > 0
      ? [
          {
            content: content as PullRequestReactionContent,
            count,
            actors: [],
            viewerHasReacted: mine.has(key),
          },
        ]
      : [];
  });
}

function remarkFields(
  remark: ReactedTo & {
    readonly created_at: string;
    readonly updated_at: string;
    readonly html_url?: string | null | undefined;
    readonly viewer_can_edit?: boolean | undefined;
  },
) {
  const createdAt = toIsoUtc(remark.created_at);
  const updatedAt = toIsoUtc(remark.updated_at);
  return {
    createdAt,
    editedAt: updatedAt === createdAt ? null : updatedAt,
    url: remark.html_url || null,
    ...(remark.reactions == null ? {} : { reactions: toReactions(remark) }),
    ...(remark.viewer_can_edit === undefined ? {} : { canEdit: remark.viewer_can_edit }),
  };
}

export function toComment(comment: typeof GiceComment.Type): PullRequestComment {
  return {
    id: String(comment.id),
    kind: "issue-comment",
    author: toActor(comment.author),
    body: comment.body,
    ...remarkFields(comment),
    path: null,
    reviewState: null,
  };
}

// Issue comments, reviews and inline comments each count their own ids, so the two kinds T3
// Code did not have before carry their kind in theirs.
const REVIEW_ID = "review:";
const REVIEW_COMMENT_ID = "review-comment:";

/** The inline comment a remark id names, and null for any other remark. */
export function reviewCommentIdOf(id: string): string | null {
  return /^review-comment:([1-9]\d*)$/u.exec(id)?.[1] ?? null;
}

export const isReviewId = (id: string) => id.startsWith(REVIEW_ID);

/**
 * An inline comment or a reply is carried by a review of its own with no text, which is not a
 * review anyone wrote.
 */
export function toReviews(
  reviews: ReadonlyArray<typeof GiceReview.Type>,
): ReadonlyArray<PullRequestComment> {
  return reviews.flatMap((review) =>
    review.state === "COMMENTED" && review.body.trim() === ""
      ? []
      : [
          {
            id: `${REVIEW_ID}${review.id}`,
            kind: "review" as const,
            author: toActor(review.user),
            body: review.body,
            createdAt: toIsoUtc(review.submitted_at),
            url: review.html_url || null,
            path: null,
            reviewState: review.state,
          },
        ],
  );
}

/** Gice replies to a comment and resolves a thread, so a thread's id names both. */
export function threadIdParts(id: string) {
  const match = /^([1-9]\d*):([1-9]\d*)$/u.exec(id);
  return match === null ? null : { thread: match[1]!, comment: match[2]! };
}

export function toReviewThreads(
  threads: ReadonlyArray<typeof GiceReviewThread.Type>,
): ReadonlyArray<PullRequestReviewThread> {
  return threads.flatMap((thread) => {
    const root = thread.comments[0];
    if (root === undefined) return [];
    return [
      {
        id: `${thread.id}:${root.id}`,
        path: thread.path,
        // An outdated thread has left the diff; it keeps the line it was written on.
        line: thread.line ?? thread.original_line ?? null,
        side: thread.side === "LEFT" ? ("left" as const) : ("right" as const),
        isResolved: thread.resolved,
        isOutdated: thread.outdated,
        comments: thread.comments.map((comment): PullRequestThreadComment => ({
          id: `${REVIEW_COMMENT_ID}${comment.id}`,
          author: toActor(comment.user),
          body: comment.body,
          ...remarkFields(comment),
          ...(comment.html_url && comment.pull_request_review_id != null
            ? {
                reviewUrl: comment.html_url.replace(
                  /#.*$/u,
                  `#review-${comment.pull_request_review_id}`,
                ),
              }
            : {}),
        })),
        ...(thread.viewer_can_resolve === undefined
          ? {}
          : { canResolve: thread.viewer_can_resolve }),
      },
    ];
  });
}

/** Gice anchors an inline comment to a line of one side of the file. */
export function toReviewComment(draft: PullRequestReviewCommentDraft) {
  const anchor = (position: PullRequestReviewCommentDraft["position"]) =>
    position.kind === "deleted" || (position.kind === "context" && position.side === "left")
      ? { side: "LEFT", line: position.oldLine }
      : { side: "RIGHT", line: position.newLine };
  const end = anchor(draft.position);
  const start = draft.startPosition === undefined ? null : anchor(draft.startPosition);
  return {
    path: draft.path,
    body: draft.body,
    ...end,
    // A range stays on one side; one that does not is anchored to its last line.
    ...(start !== null && start.side === end.side && start.line < end.line
      ? { start_line: start.line, start_side: start.side }
      : {}),
  };
}

const REMARK_EVENT = /^(?:comment|review|review_comment|review_thread|reactions)\./u;

/**
 * Every change to a pull request appends an event, so the newest id is its state. Only a server
 * that reports `pull.base_updated` appends one for a push to the base branch; on an older one
 * mergeability waits for the next detail read.
 */
export function toWatchFingerprint(
  feed: typeof GiceEvents.Type,
): ProviderChangeRequestWatchFingerprint {
  return {
    status: String(feed.cursor),
    remarks: String(feed.events.findLast((event) => REMARK_EVENT.test(event.type))?.id ?? ""),
  };
}

const QUERY_WORDS = 8;

/** Gice's own `q=` rule, for a server that cannot search: every word in the text, or the number. */
export function matchesQuery(pull: GicePull, query: string): boolean {
  const text = `${pull.title}\n${pull.body ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word !== "")
    .slice(0, QUERY_WORDS)
    .every((word) => text.includes(word) || word.replace(/^#/u, "") === String(pull.number));
}

export function toCommit(commit: typeof GiceCommit.Type): PullRequestCommit {
  return {
    oid: commit.sha,
    messageHeadline: commit.message.split("\n", 1)[0] ?? "",
    committedDate: toIsoUtc(commit.committer.date),
  };
}
