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
  type PullRequestMergeCapabilities,
  type PullRequestMergeMethod,
  type PullRequestReaction,
  type PullRequestReactionContent,
  type PullRequestReferenceCandidate,
  type PullRequestReviewCommentDraft,
  type PullRequestReviewDecision,
  type PullRequestReviewThread,
  type PullRequestReviewerCandidate,
  type PullRequestStackMembership,
  type PullRequestThreadComment,
  type PullRequestViewerPermissions,
} from "@t3tools/contracts";
import { parseDiffFilePaths } from "@t3tools/source-control-core/server/diffFileRevisions";
import { sortChecks } from "@t3tools/source-control-core/server/pullRequestChecks";
import type {
  ProviderChangeRequest,
  ProviderChangeRequestStack,
  ProviderDiffSlice,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import { toIsoUtc } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Schema from "effect/Schema";

export const GiceUser = Schema.Struct({
  username: TrimmedNonEmptyString,
  display_name: Schema.optional(Schema.NullOr(Schema.String)),
  kind: Schema.optional(Schema.String),
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
});
type GiceUser = typeof GiceUser.Type;

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
export const Reacted = {
  reactions: ReactionCounts,
  viewer_reactions: Schema.Array(Schema.String),
};
interface ReactedTo {
  readonly reactions: typeof ReactionCounts.Type;
  readonly viewer_reactions: ReadonlyArray<string>;
}

const GiceViewerPermissions = Schema.Struct({
  can_edit: Schema.Boolean,
  can_close: Schema.Boolean,
  can_reopen: Schema.Boolean,
  can_merge: Schema.Boolean,
  can_update_branch: Schema.Boolean,
  can_delete_head_branch: Schema.Boolean,
  can_comment: Schema.Boolean,
  can_label: Schema.Boolean,
  can_review: Schema.Boolean,
  can_approve: Schema.Boolean,
  can_request_reviewers: Schema.Boolean,
  // Every method for a writer, none for anyone else.
  merge_methods: Schema.Array(Schema.String),
  // Write access to a merged pull request.
  can_revert: Schema.Boolean,
});

/** Where a pull request sits in its stack: the layers `GET R/pulls/{n}/stack` would answer. */
const GicePullStack = Schema.Struct({
  parent: Schema.NullOr(PositiveInt),
  children: Schema.Array(PositiveInt),
  position: PositiveInt,
  size: PositiveInt,
  // The bottom layer's number, which names the stack.
  bottom: PositiveInt,
});

/** A pull request as listings carry it, without what the caller may do with it. */
export const GicePullRow = Schema.Struct({
  number: PositiveInt,
  html_url: Schema.String,
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
  // Null once the fork a cross-repository pull request came from is deleted.
  head_repo: Schema.NullOr(
    Schema.Struct({ owner: TrimmedNonEmptyString, full_name: TrimmedNonEmptyString }),
  ),
  cross_repo: Schema.Boolean,
  merged_at: Schema.NullOr(Schema.String),
  merged_by: Schema.NullOr(GiceUser),
  merge_commit_sha: Schema.NullOr(Schema.String),
  // Only a single pull request read computes these; a listing leaves them out.
  mergeable: Schema.optional(Schema.NullOr(Schema.Boolean)),
  behind: Schema.optional(NonNegativeInt),
  draft: Schema.Boolean,
  head_sha: Schema.NullOr(Schema.String),
  merge_base_sha: Schema.NullOr(Schema.String),
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
  changed_files: NonNegativeInt,
  auto_merge: Schema.NullOr(Schema.Struct({ method: Schema.String })),
  checks_state: Schema.NullOr(Schema.Literals(["success", "failure", "pending"])),
  review_decision: Schema.NullOr(Schema.String),
  requested_reviewers: Schema.Array(GiceUser),
  labels: Schema.Array(GiceLabel),
  // Null in no stack. Lists across repositories leave it out for the rows of repositories past
  // the first ten of a page, where Gice did not work it out.
  stack: Schema.optional(Schema.NullOr(GicePullStack)),
  ...Reacted,
});
type GicePullRow = typeof GicePullRow.Type;
/** What naming a stack reads of the other rows listed with a layer. */
type StackRow = Pick<GicePullRow, "base">;

export const GicePull = GicePullRow.mapFields((fields) => ({
  ...fields,
  viewer_permissions: GiceViewerPermissions,
  // The open pull requests based on the head branch, while it exists; deleting it moves them.
  head_branch_pulls: Schema.optional(Schema.Array(PositiveInt)),
}));
export type GicePull = typeof GicePull.Type;

/**
 * A row of a list across repositories. Gice serves it without reading git, so it leaves out the
 * permissions that need the branches, and its head and line counts are those of the last push.
 */
export const GiceAcrossPull = GicePullRow.mapFields((fields) => ({
  ...fields,
  repository: Schema.Struct({ full_name: TrimmedNonEmptyString }),
  // Null while Gice has not worked them out for the row's head.
  additions: Schema.NullOr(NonNegativeInt),
  deletions: Schema.NullOr(NonNegativeInt),
  changed_files: Schema.NullOr(NonNegativeInt),
}));

/**
 * A row across repositories, read with the rows of its repository on the same page. Counts it
 * lacks are left at none, as listings that omit counts leave them for clients to show nothing
 * until they are read.
 */
export function toAcrossChangeRequest(
  pull: typeof GiceAcrossPull.Type,
  listed: ReadonlyMap<number, StackRow>,
) {
  const repository = pull.repository.full_name;
  const row = {
    ...pull,
    additions: pull.additions ?? 0,
    deletions: pull.deletions ?? 0,
    changed_files: pull.changed_files ?? 0,
  };
  return { ...toChangeRequest(row, { repository }, listed), repository };
}

export const GiceComment = Schema.Struct({
  id: PositiveInt,
  body: Schema.String,
  author: GiceUser,
  created_at: Schema.String,
  edited_at: Schema.NullOr(Schema.String),
  html_url: Schema.String,
  viewer_can_edit: Schema.Boolean,
  ...Reacted,
});

export const GiceReview = Schema.Struct({
  id: PositiveInt,
  user: GiceUser,
  body: Schema.String,
  state: Schema.String,
  submitted_at: Schema.String,
  html_url: Schema.String,
});

const GiceReviewComment = Schema.Struct({
  id: PositiveInt,
  pull_request_review_id: PositiveInt,
  user: GiceUser,
  body: Schema.String,
  created_at: Schema.String,
  edited_at: Schema.NullOr(Schema.String),
  html_url: Schema.String,
  viewer_can_edit: Schema.Boolean,
  ...Reacted,
});

export const GiceReviewThread = Schema.Struct({
  id: PositiveInt,
  path: TrimmedNonEmptyString,
  side: Schema.NullOr(Schema.String),
  line: Schema.NullOr(PositiveInt),
  original_line: Schema.NullOr(PositiveInt),
  outdated: Schema.Boolean,
  resolved: Schema.Boolean,
  viewer_can_resolve: Schema.Boolean,
  comments: Schema.Array(GiceReviewComment),
});

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
  // The blob on the head side, left out when the change deletes the file.
  sha: Schema.optional(Schema.String),
});

/** A pull request's files and a commit's own changes share this shape. */
export const GiceFiles = Schema.Struct({
  files: Schema.Array(GiceFile),
  patch: Schema.optional(Schema.String),
  truncated: Schema.optional(Schema.Boolean),
});
export type GiceFiles = typeof GiceFiles.Type;

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
  error: Schema.NullOr(Schema.String),
  html_url: Schema.String,
  jobs: Schema.Array(
    Schema.Struct({
      id: PositiveInt,
      name: Schema.String,
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
      html_url: Schema.String,
    }),
  ),
});

export const GiceCommitStatus = Schema.Struct({
  sha: TrimmedNonEmptyString,
  runs: Schema.Array(GiceRun),
});
export type GiceCommitStatus = typeof GiceCommitStatus.Type;

export function toActor(user: GiceUser): PullRequestActor {
  return {
    login: user.username,
    name: user.display_name || null,
    avatarUrl: user.avatar_url || null,
    ...(user.kind === "machine" ? { isBot: true } : {}),
  };
}

const mergeabilityOf = (pull: GicePullRow) =>
  pull.mergeable == null ? "unknown" : pull.mergeable ? "mergeable" : "conflicting";

export function toChangeRequest(
  pull: GicePullRow,
  target: { readonly repository: string },
  listed?: ReadonlyMap<number, StackRow>,
): ProviderChangeRequest {
  const stack = toStackMembership(pull, listed);
  return {
    ...(stack ? { stack } : {}),
    number: pull.number,
    title: pull.title,
    url: pull.html_url,
    author: toActor(pull.author),
    headBranch: pull.head,
    // A fork that was deleted leaves a cross-repository pull request without a head repository.
    headRepositoryNameWithOwner: pull.cross_repo
      ? (pull.head_repo?.full_name ?? null)
      : target.repository,
    baseBranch: pull.base,
    state: pull.state,
    isDraft: pull.draft,
    mergeability: mergeabilityOf(pull),
    additions: pull.additions,
    deletions: pull.deletions,
    createdAt: toIsoUtc(pull.created_at),
    updatedAt: toIsoUtc(pull.updated_at),
    closedAt: pull.closed_at === null ? null : toIsoUtc(pull.closed_at),
    mergedAt: pull.merged_at === null ? null : toIsoUtc(pull.merged_at),
    reviewRequestLogins: pull.requested_reviewers.map((user) => user.username),
    labels: pull.labels.map(toLabel),
    reviewDecision: reviewDecisionOf(pull.review_decision),
    checksState: pull.checks_state === null ? null : CHECKS_STATE[pull.checks_state],
  };
}

const CHECKS_STATE = {
  success: "passing",
  failure: "failing",
  pending: "pending",
} as const satisfies Record<NonNullable<GicePull["checks_state"]>, PullRequestChecksState>;

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

/**
 * Gice names no stack, so T3 Code names one after its bottom pull request and takes its base from
 * the bottom's row in `listed`. Rows do not carry the bottom's base, so without it the layer's own
 * stands in: no client shows a membership's base, and `toStack` reads the real one.
 */
export function toStackMembership(
  pull: GicePullRow,
  listed: ReadonlyMap<number, StackRow> = new Map(),
): PullRequestStackMembership | null | undefined {
  const { stack } = pull;
  if (stack == null) return stack;
  const bottom = stack.bottom === pull.number ? pull : listed.get(stack.bottom);
  return {
    number: stack.bottom,
    position: stack.position,
    size: stack.size,
    base: (bottom ?? pull).base,
  };
}

const GiceStackLayer = Schema.Struct({
  number: PositiveInt,
  title: Schema.String,
  state: Schema.Literals(["open", "closed", "merged"]),
  draft: Schema.Boolean,
  head: TrimmedNonEmptyString,
  head_sha: Schema.NullOr(Schema.String),
  base: TrimmedNonEmptyString,
  html_url: Schema.String,
});

/** `GET R/pulls/{n}/stack`: the layers below n, n, and every pull request built on n, bottom first. */
export const GiceStack = Schema.Struct({
  trunk: TrimmedNonEmptyString,
  // The base a stack merge of n lands every layer on; null when n is not open.
  merge_into: Schema.NullOr(TrimmedNonEmptyString),
  // Some layer has more than one built on it.
  branched: Schema.Boolean,
  layers: Schema.Array(GiceStackLayer),
  viewer_permissions: Schema.Struct({ can_merge: Schema.Boolean, can_restack: Schema.Boolean }),
});
export type GiceStack = typeof GiceStack.Type;

export function toStack(stack: GiceStack): ProviderChangeRequestStack | null {
  const bottom = stack.layers[0];
  // A pull request in no stack is its own only layer. One built on an integration branch is
  // too: the pull request whose head that branch is (`trunk_pull`) bounds a stack, not joins it.
  if (bottom === undefined || stack.layers.length === 1) return null;
  return {
    id: String(bottom.number),
    number: bottom.number,
    url: bottom.html_url,
    // Gice merges and restacks the open layers onto the base of the lowest of them.
    base:
      stack.merge_into ?? stack.layers.find((layer) => layer.state === "open")?.base ?? stack.trunk,
    layers: stack.layers.map((layer) => ({
      number: layer.number,
      title: layer.title,
      isDraft: layer.draft,
      ...(layer.head_sha ? { headSha: layer.head_sha } : {}),
      headBranch: layer.head,
      state: layer.state,
    })),
  };
}

const GiceStackStop = Schema.Struct({
  number: PositiveInt,
  code: Schema.String,
  message: Schema.String,
});

/** What `POST stack/merge` and `POST stack/restack` did before they finished or stopped. */
export const GiceStackResult = Schema.Struct({
  merged: Schema.optional(Schema.Array(PositiveInt)),
  restacked: Schema.optional(Schema.Array(PositiveInt)),
  stopped: Schema.NullOr(GiceStackStop),
});

export function toSummaryFields(pull: GicePull) {
  return {
    ...(pull.stack === null ? { stack: null } : {}),
    ...(pull.head_sha ? { headSha: pull.head_sha } : {}),
    changedFiles: pull.changed_files,
    ...autoMergeFields(pull),
  };
}

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
    mergeCommitSha: pull.merge_commit_sha,
    mergedBy: pull.merged_by === null ? null : toActor(pull.merged_by),
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
  if (pull.auto_merge === null) return { autoMergeEnabled: false };
  const { method } = pull.auto_merge;
  const autoMergeMethod: PullRequestMergeMethod =
    method === "squash" || method === "rebase" ? method : "merge";
  return { autoMergeEnabled: true, autoMergeMethod };
}

/** The methods Gice lets the viewer merge with; it refuses a rebase it cannot replay. */
export function toMergeCapabilities(pull: GicePull): PullRequestMergeCapabilities {
  const methods = new Set(pull.viewer_permissions.merge_methods);
  return {
    merge: methods.has("merge"),
    squash: methods.has("squash"),
    rebase: methods.has("rebase"),
  };
}

/** `stack` is the pull request's own, read when it is in one. */
export function toViewerPermissions(
  pull: GicePull,
  stack?: GiceStack | null,
): PullRequestViewerPermissions {
  const can = pull.viewer_permissions;
  return {
    actions: [
      ...(can.can_merge ? (["merge"] as const) : []),
      ...(can.can_edit && pull.state === "open" ? ([pull.draft ? "ready" : "draft"] as const) : []),
      ...(can.can_close ? (["close"] as const) : []),
      ...(can.can_reopen ? (["reopen"] as const) : []),
      ...(can.can_delete_head_branch ? (["delete-branch"] as const) : []),
      ...(can.can_update_branch ? (["update-branch"] as const) : []),
      ...(can.can_merge && pull.auto_merge === null ? (["enable-auto-merge"] as const) : []),
      ...(can.can_merge && pull.auto_merge !== null ? (["disable-auto-merge"] as const) : []),
      ...(can.can_revert ? (["revert"] as const) : []),
    ],
    comment: can.can_comment,
    // A thread says itself whether this caller may resolve it.
    resolve: can.can_review,
    verdicts: [
      ...(can.can_review ? (["comment"] as const) : []),
      ...(can.can_approve ? (["approve", "request-changes"] as const) : []),
    ],
    requestReviewers: can.can_request_reviewers,
    labels: can.can_label,
    editChangeRequest: can.can_edit,
    // Gice rebases a branch other open pull requests are based on only as a stack, with them.
    updateMethods: can.can_update_branch
      ? (pull.head_branch_pulls ?? []).length > 0
        ? ["merge"]
        : ["merge", "rebase"]
      : [],
    // T3 Code restacks the layers it shows, which leave out a branch of the stack.
    ...(stack?.viewer_permissions.can_restack && !stack.branched ? { stackRebase: true } : {}),
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
 * check, and a run without jobs is one. The event is part of the name because one workflow can
 * run for a push and a pull request alike.
 */
export function toChecks(status: GiceCommitStatus): ReadonlyArray<PullRequestCheck> {
  return sortChecks(
    status.runs.flatMap((run): ReadonlyArray<PullRequestCheck> => {
      const workflow = run.workflow.name.trim() || run.workflow.path;
      if (run.jobs.length === 0)
        return [
          {
            name: `${workflow} (${run.event})`,
            status: checkStatus(run),
            description: run.error || null,
            url: run.html_url,
          },
        ];
      return run.jobs.map((job) => ({
        name: `${workflow} / ${job.name.trim() || job.id} (${run.event})`,
        status: checkStatus(job),
        description: null,
        url: job.html_url,
      }));
    }),
  );
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

/** The counts the server keeps per content; it does not say who reacted. */
export function toReactions(subject: ReactedTo): ReadonlyArray<PullRequestReaction> {
  const mine = new Set(subject.viewer_reactions);
  return Object.entries(REACTIONS).flatMap(([content, key]) => {
    const count = subject.reactions[key] ?? 0;
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
    readonly edited_at: string | null;
    readonly html_url: string;
    readonly viewer_can_edit: boolean;
  },
) {
  return {
    createdAt: toIsoUtc(remark.created_at),
    editedAt: remark.edited_at === null ? null : toIsoUtc(remark.edited_at),
    url: remark.html_url,
    reactions: toReactions(remark),
    canEdit: remark.viewer_can_edit,
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
            url: review.html_url,
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
          reviewUrl: comment.html_url.replace(/#.*$/u, `#review-${comment.pull_request_review_id}`),
        })),
        canResolve: thread.viewer_can_resolve,
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

/** The feed's types that change what `getChangeRequestActivity` reads. */
export const REMARK_EVENT_TYPES = [
  "comment.created",
  "comment.updated",
  "comment.deleted",
  "review.submitted",
  "review.dismissed",
  "review_comment.created",
  "review_comment.updated",
  "review_comment.deleted",
  "review_thread.resolved",
  "review_thread.unresolved",
  "reactions.changed",
].join(",");

export function toCommit(commit: typeof GiceCommit.Type): PullRequestCommit {
  return {
    oid: commit.sha,
    messageHeadline: commit.message.split("\n", 1)[0] ?? "",
    committedDate: toIsoUtc(commit.committer.date),
  };
}

/** The reader's viewed marks on each file the pull request changes now. */
export const GiceViewed = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      path: TrimmedNonEmptyString,
      viewed: Schema.Boolean,
      // Marked, but the file changed since.
      dismissed: Schema.Boolean,
    }),
  ),
});

export function toFilesViewed(viewed: typeof GiceViewed.Type) {
  return {
    files: viewed.files.map((file) => ({
      path: file.path,
      state: file.viewed
        ? ("viewed" as const)
        : file.dismissed
          ? ("dismissed" as const)
          : ("unviewed" as const),
    })),
    truncated: false,
  };
}

/** A pull request or issue template, its front matter read out of the body by the server. */
export const GiceTemplate = Schema.Struct({
  kind: Schema.Literals(["pull", "issue"]),
  path: TrimmedNonEmptyString,
  // The file's name where the front matter names none.
  name: TrimmedNonEmptyString,
  about: Schema.String,
  title: Schema.String,
  labels: Schema.Array(TrimmedNonEmptyString),
  assignees: Schema.Array(TrimmedNonEmptyString),
  body: Schema.String,
});

/** An issue or a pull request as `GET R/references` lists it; the two share their numbers. */
export const GiceReference = Schema.Struct({
  number: PositiveInt,
  title: Schema.String,
  is_pull: Schema.Boolean,
  state: Schema.Literals(["open", "closed", "merged"]),
});

export function toReferenceCandidate(
  subject: typeof GiceReference.Type,
): PullRequestReferenceCandidate {
  return {
    reference: `#${subject.number}`,
    kind: subject.is_pull ? "change-request" : "issue",
    number: subject.number,
    title: subject.title,
    state: subject.state,
  };
}
