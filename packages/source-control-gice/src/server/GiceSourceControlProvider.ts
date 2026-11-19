import {
  PositiveInt,
  SourceControlProviderError,
  TrimmedNonEmptyString,
  type ChangeRequest,
  type SourceControlProviderDiscoveryItem,
} from "@t3tools/contracts";
import { isSshRemoteUrl } from "@t3tools/shared/sourceControl";
import {
  providerAuth,
  type SourceControlManagedCliDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { definition, parsePullRequestUrlOnKnownHost } from "../shared/definition.ts";

import * as GiceApi from "./GiceApi.ts";
import * as GiceCredentials from "./GiceCredentials.ts";

const KIND = definition.kind;
const PAGE_SIZE = 100;
/** An older Gice cannot list pull requests by head branch, so a lookup reads at most this many pages. */
const MAX_LIST_PAGES = 10;
const PROBE_TIMEOUT = "3 seconds";
const INSTALL_HINT =
  "Save your Gice server's address and an access token in Settings, set GICE_HOST and GICE_TOKEN on the server, or run `gice auth login --host <server-url>`.";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

interface GiceRepositoryTarget {
  /** The web host: an HTTP remote's host with its port, an SSH remote's without one. */
  readonly host: string;
  readonly repository: string;
}

function repositoryPath(path: string): string | null {
  const repository = path
    .trim()
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "");
  return REPOSITORY.test(repository) ? repository : null;
}

/** Null for anything but a remote naming `owner/name` on some host. */
function parseGiceRemote(remoteUrl: string): GiceRepositoryTarget | null {
  const trimmed = remoteUrl.trim();
  const url = /^(?:https?|ssh):\/\//iu.test(trimmed) ? URL.parse(trimmed) : null;
  const scp = url === null ? /^(?:[^@/:]+@)?([^/:]+):(.+)$/u.exec(trimmed) : null;
  // An SSH remote's port is the SSH server's, which says nothing about the web server.
  const host = url ? (url.protocol === "ssh:" ? url.hostname : url.host) : scp?.[1];
  const repository = repositoryPath(url ? url.pathname.replace(/^\/+/u, "") : (scp?.[2] ?? ""));
  return host && repository ? { host: host.toLowerCase(), repository } : null;
}

const User = Schema.Struct({ username: TrimmedNonEmptyString });
const Repository = Schema.Struct({
  full_name: TrimmedNonEmptyString,
  default_branch: Schema.String,
  clone_url_http: TrimmedNonEmptyString,
  // Empty on a server with SSH turned off.
  clone_url_ssh: Schema.String,
});
const Pull = Schema.Struct({
  number: PositiveInt,
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  title: TrimmedNonEmptyString,
  state: Schema.Literals(["open", "closed", "merged"]),
  head: TrimmedNonEmptyString,
  base: TrimmedNonEmptyString,
  // Null once the fork a cross-repository pull request came from is deleted.
  head_repo: Schema.NullOr(
    Schema.Struct({ owner: TrimmedNonEmptyString, full_name: TrimmedNonEmptyString }),
  ),
  cross_repo: Schema.Boolean,
  // Absent on a server that predates them.
  head_sha: Schema.optional(Schema.NullOr(Schema.String)),
  draft: Schema.optional(Schema.Boolean),
  updated_at: Schema.DateTimeUtcFromString,
  closed_at: Schema.NullOr(Schema.String),
  merged_at: Schema.NullOr(Schema.String),
});
const CreatedPull = Schema.Struct({ number: PositiveInt });

const sameName = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

export const makeDiscovery = Effect.gen(function* () {
  const api = yield* GiceApi.GiceApi;
  const credentials = yield* GiceCredentials.GiceCredentials;
  const decodeUser = Schema.decodeUnknownOption(Schema.fromJsonString(User));

  const probeAuth = Effect.gen(function* () {
    const held = yield* Effect.result(credentials.all);
    if (Result.isFailure(held))
      return providerAuth({ status: "unauthenticated", detail: held.failure.message });
    const credential = held.success[0];
    if (credential === undefined)
      return providerAuth({ status: "unauthenticated", detail: INSTALL_HINT });
    const { host } = credential;
    const user = yield* api
      .request({ host, operation: "discovery", path: "/user" })
      .pipe(Effect.result);
    if (Result.isFailure(user))
      return providerAuth({
        // A server that is down or forbidding does not establish that the token is gone.
        status: user.failure.reason === "unauthenticated" ? "unauthenticated" : "unknown",
        host,
        detail:
          user.failure.reason === "unauthenticated"
            ? `Gice refused the token for ${host}. Replace it in Settings, or run \`gice auth login --host ${credential.baseUrl}\`.`
            : user.failure.detail,
      });
    const account = Option.getOrUndefined(decodeUser(user.success))?.username;
    return account === undefined
      ? providerAuth({ status: "unknown", host, detail: "Gice returned an unreadable account." })
      : providerAuth({ status: "authenticated", host, account });
  });

  return {
    type: "managed-cli",
    kind: KIND,
    label: definition.label,
    installHint: INSTALL_HINT,
    probe: () =>
      probeAuth.pipe(
        Effect.timeoutOption(PROBE_TIMEOUT),
        Effect.map(
          Option.getOrElse(() =>
            providerAuth({
              status: "unknown",
              detail: "Gice did not answer in time. Refresh to try again.",
            }),
          ),
        ),
        Effect.map(
          (auth) =>
            ({
              kind: KIND,
              label: definition.label,
              status: "available",
              version: Option.none(),
              installHint: INSTALL_HINT,
              detail: Option.none(),
              auth,
            }) satisfies SourceControlProviderDiscoveryItem,
        ),
      ),
    // A Gice server has no telling name: the remote is one when a credential names its host.
    // An unreadable saved token fails, which the registry does not keep as an answer.
    refineUnknownRemote: ({ context }) => {
      const remote = parseGiceRemote(context.remoteUrl);
      if (remote === null) return Effect.succeed(null);
      return credentials.get(remote.host).pipe(
        Effect.map((credential) => ({
          kind: KIND,
          name: definition.label,
          baseUrl: credential.baseUrl,
        })),
        Effect.catchTags({ GiceNotSignedInError: () => Effect.succeed(null) }),
      );
    },
  } satisfies SourceControlManagedCliDiscoverySpec;
});

export const make = Effect.gen(function* () {
  const api = yield* GiceApi.GiceApi;
  const credentials = yield* GiceCredentials.GiceCredentials;
  const host = yield* SourceControlHost.SourceControlHost;
  const fileSystem = yield* FileSystem.FileSystem;

  const error = (operation: string, cwd: string, detail: string, cause?: unknown) =>
    new SourceControlProviderError({
      provider: KIND,
      operation,
      cwd,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const read = <S extends Schema.Codec<unknown, unknown, never, never>>(
    operation: string,
    cwd: string,
    request: Omit<GiceApi.GiceApiRequest, "operation">,
    schema: S,
  ) =>
    api.request({ ...request, operation }).pipe(
      Effect.mapError((cause) => error(operation, cwd, cause.detail, cause)),
      Effect.flatMap((raw) =>
        Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
          Effect.mapError((cause) =>
            error(operation, cwd, "Gice returned an unreadable response.", cause),
          ),
        ),
      ),
    );
  const webUrl = (target: GiceRepositoryTarget) =>
    credentials.get(target.host).pipe(
      Effect.map((credential) => credential.baseUrl),
      Effect.orElseSucceed(() => `https://${target.host}`),
      Effect.map((baseUrl) => `${baseUrl}/${target.repository}`),
    );

  const resolveTarget = Effect.fn("GiceSourceControlProvider.resolveTarget")(function* (
    operation: string,
    input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly repository?: string;
      readonly host?: string;
    },
  ) {
    const named = input.repository === undefined ? null : parseGiceRemote(input.repository);
    if (named) return named;
    const readRemote = host.git
      .resolvePrimaryRemoteName(input.cwd)
      .pipe(
        Effect.flatMap((remote) => host.git.readConfigValue(input.cwd, `remote.${remote}.url`)),
      );
    const remoteUrl =
      input.context?.remoteUrl ??
      (input.repository === undefined
        ? yield* readRemote.pipe(
            Effect.mapError((cause) =>
              error(operation, input.cwd, "Could not read the Gice remote.", cause),
            ),
          )
        : yield* readRemote.pipe(Effect.orElseSucceed(() => null)));
    const remote = remoteUrl ? parseGiceRemote(remoteUrl) : null;
    if (input.repository === undefined) {
      if (remote) return remote;
      return yield* error(operation, input.cwd, "No Gice repository remote was found.");
    }
    const repository = repositoryPath(input.repository);
    if (repository === null)
      return yield* error(
        operation,
        input.cwd,
        "A Gice repository is named owner/name or by its URL.",
      );
    const signedInHost = yield* credentials.all.pipe(
      Effect.map((held) => held[0]?.host),
      Effect.orElseSucceed(() => undefined),
    );
    const targetHost = input.host?.toLowerCase() ?? remote?.host ?? signedInHost;
    if (targetHost === undefined)
      return yield* error(operation, input.cwd, `No Gice server is signed in. ${INSTALL_HINT}`);
    return { host: targetHost, repository } satisfies GiceRepositoryTarget;
  });

  const toChangeRequest = (
    target: GiceRepositoryTarget,
    repositoryUrl: string,
    pull: typeof Pull.Type,
  ) =>
    ({
      provider: KIND,
      number: pull.number,
      title: pull.title,
      url: pull.html_url || `${repositoryUrl}/pulls/${pull.number}`,
      baseRefName: pull.base,
      headRefName: pull.head,
      ...(pull.head_sha ? { headSha: pull.head_sha } : {}),
      ...(pull.draft === undefined ? {} : { isDraft: pull.draft }),
      state: pull.state,
      closedAt: pull.closed_at,
      mergedAt: pull.merged_at,
      updatedAt: Option.some(pull.updated_at),
      isCrossRepository: pull.cross_repo,
      headRepositoryNameWithOwner: pull.head_repo?.full_name ?? null,
      headRepositoryOwnerLogin: pull.head_repo?.owner ?? null,
    }) satisfies ChangeRequest;

  const getPull = Effect.fn("GiceSourceControlProvider.getPull")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly reference: string;
  }) {
    const reference = input.reference.trim();
    const link = parsePullRequestUrlOnKnownHost(reference);
    const target: GiceRepositoryTarget = link
      ? { host: link.authority ?? link.host, repository: link.repository }
      : yield* resolveTarget("getChangeRequest", input);
    const number = link?.number ?? /^#?([1-9]\d*)$/u.exec(reference)?.[1];
    if (number === undefined)
      return yield* error(
        "getChangeRequest",
        input.cwd,
        "A Gice pull request is a number or a pull request URL.",
      );
    const pull = yield* read(
      "getChangeRequest",
      input.cwd,
      { host: target.host, path: `/repos/${target.repository}/pulls/${number}` },
      Pull,
    );
    return { target, changeRequest: toChangeRequest(target, yield* webUrl(target), pull) };
  });

  return SourceControlProvider.SourceControlProvider.of({
    kind: KIND,
    repositoryNameFromRemoteUrl: (url) => parseGiceRemote(url)?.repository ?? null,
    getChangeRequest: Effect.fn("GiceSourceControlProvider.getChangeRequest")(function* (input) {
      return (yield* getPull(input)).changeRequest;
    }),
    listChangeRequests: Effect.fn("GiceSourceControlProvider.listChangeRequests")(
      function* (input) {
        const target = yield* resolveTarget("listChangeRequests", input);
        const repositoryUrl = yield* webUrl(target);
        const source = SourceControlProvider.sourceControlRefFromInput(input);
        const branch = SourceControlProvider.sourceBranch(input);
        const limit = input.limit ?? 20;
        const items: Array<ChangeRequest> = [];
        // `head=owner:branch` also finds the branch in the owner's fork.
        const byHead = (yield* api.features(target.host)).has("pull_filters")
          ? {
              head: source?.owner ? `${source.owner}:${branch}` : branch,
              fields: "summary",
            }
          : {};
        for (let page = 1; page <= MAX_LIST_PAGES && items.length < limit; page++) {
          const query = new URLSearchParams({
            state: input.state,
            per_page: String(PAGE_SIZE),
            page: String(page),
            ...byHead,
          });
          const pulls = yield* read(
            "listChangeRequests",
            input.cwd,
            { host: target.host, path: `/repos/${target.repository}/pulls?${query}` },
            Schema.Array(Pull),
          );
          for (const pull of pulls) {
            if (pull.head !== branch || items.length >= limit) continue;
            if (source?.repository && !sameName(pull.head_repo?.full_name ?? "", source.repository))
              continue;
            if (source?.owner && !sameName(pull.head_repo?.owner ?? "", source.owner)) continue;
            items.push(toChangeRequest(target, repositoryUrl, pull));
          }
          if (pulls.length < PAGE_SIZE) break;
        }
        return items;
      },
    ),
    createChangeRequest: Effect.fn("GiceSourceControlProvider.createChangeRequest")(
      function* (input) {
        const target = yield* resolveTarget("createChangeRequest", {
          ...input,
          ...(input.target?.repository ? { repository: input.target.repository } : {}),
        });
        const source = SourceControlProvider.sourceControlRefFromInput(input);
        const headRepository =
          source?.repository ??
          (source?.owner ? `${source.owner}/${target.repository.split("/")[1]}` : undefined);
        const body = yield* fileSystem
          .readFileString(input.bodyFile)
          .pipe(
            Effect.mapError((cause) =>
              error(
                "createChangeRequest",
                input.cwd,
                "Could not read the pull request description.",
                cause,
              ),
            ),
          );
        yield* read(
          "createChangeRequest",
          input.cwd,
          {
            host: target.host,
            method: "POST",
            path: `/repos/${target.repository}/pulls`,
            body: {
              title: input.title,
              body,
              head: SourceControlProvider.sourceBranch(input),
              base: input.target?.refName ?? input.baseRefName,
              // Gice takes `head_repo` only for a head in another repository of the fork network.
              ...(headRepository && !sameName(headRepository, target.repository)
                ? { head_repo: headRepository }
                : {}),
            },
          },
          CreatedPull,
        );
      },
    ),
    getRepositoryCloneUrls: Effect.fn("GiceSourceControlProvider.getRepositoryCloneUrls")(
      function* (input) {
        const target = yield* resolveTarget("getRepositoryCloneUrls", input);
        const repository = yield* read(
          "getRepositoryCloneUrls",
          input.cwd,
          { host: target.host, path: `/repos/${target.repository}` },
          Repository,
        );
        return {
          nameWithOwner: repository.full_name,
          url: repository.clone_url_http,
          sshUrl: repository.clone_url_ssh.trim() || repository.clone_url_http,
        };
      },
    ),
    createRepository: Effect.fn("GiceSourceControlProvider.createRepository")(function* (input) {
      const named = parseGiceRemote(input.repository);
      const name = (named?.repository ?? repositoryPath(input.repository))?.split("/")[1];
      // A new repository's checkout has no Gice remote yet, so only the sign-in names the server.
      const targetHost =
        named?.host ?? (yield* credentials.all.pipe(Effect.orElseSucceed(() => [])))[0]?.host;
      if (name === undefined || targetHost === undefined)
        return yield* error(
          "createRepository",
          input.cwd,
          name === undefined
            ? "A Gice repository is named owner/name or by its URL."
            : `No Gice server is signed in. ${INSTALL_HINT}`,
        );
      // Gice creates repositories under the signed-in account only.
      const repository = yield* read(
        "createRepository",
        input.cwd,
        {
          host: targetHost,
          method: "POST",
          path: "/user/repos",
          body: { name, is_private: input.visibility === "private" },
        },
        Repository,
      );
      return {
        nameWithOwner: repository.full_name,
        url: repository.clone_url_http,
        sshUrl: repository.clone_url_ssh.trim() || repository.clone_url_http,
      };
    }),
    getDefaultBranch: Effect.fn("GiceSourceControlProvider.getDefaultBranch")(function* (input) {
      const target = yield* resolveTarget("getDefaultBranch", input);
      const repository = yield* read(
        "getDefaultBranch",
        input.cwd,
        { host: target.host, path: `/repos/${target.repository}` },
        Repository,
      );
      return repository.default_branch.trim() || null;
    }),
    checkoutChangeRequest: Effect.fn("GiceSourceControlProvider.checkoutChangeRequest")(
      function* (input) {
        const { target, changeRequest: pull } = yield* getPull(input);
        const contextRemote = input.context ? parseGiceRemote(input.context.remoteUrl) : null;
        const git = host.git;
        const failed = (cause: unknown) =>
          error(
            "checkoutChangeRequest",
            input.cwd,
            "Could not check out the Gice pull request.",
            cause,
          );
        const remoteName =
          input.context &&
          contextRemote?.host === target.host &&
          sameName(contextRemote.repository, target.repository)
            ? input.context.remoteName
            : yield* read(
                "checkoutChangeRequest",
                input.cwd,
                { host: target.host, path: `/repos/${target.repository}` },
                Repository,
              ).pipe(
                Effect.flatMap((repository) =>
                  git
                    .ensureRemote({
                      cwd: input.cwd,
                      preferredName: "gice",
                      url:
                        (input.context === undefined || isSshRemoteUrl(input.context.remoteUrl)) &&
                        repository.clone_url_ssh.trim()
                          ? repository.clone_url_ssh
                          : repository.clone_url_http,
                    })
                    .pipe(Effect.mapError(failed)),
                ),
              );
        yield* Effect.gen(function* () {
          const branches = yield* git.listLocalBranchNames(input.cwd);
          if (pull.isCrossRepository) {
            // The fork may be gone or unreadable; the base repository keeps the head under this ref.
            const localBranch = `pr-${pull.number}`;
            yield* git.execute({
              operation: "GiceSourceControlProvider.checkoutChangeRequest",
              cwd: input.cwd,
              args: ["fetch", remoteName, definition.changeRequestHeadRef(pull.number)],
            });
            if (!branches.includes(localBranch))
              yield* git.createBranch({
                cwd: input.cwd,
                branch: localBranch,
                startPoint: "FETCH_HEAD",
              });
            else if (input.force === true)
              yield* git.execute({
                operation: "GiceSourceControlProvider.checkoutChangeRequest",
                cwd: input.cwd,
                args: ["checkout", "-B", localBranch, "FETCH_HEAD", "--"],
              });
            yield* Effect.scoped(git.switchRef({ cwd: input.cwd, refName: localBranch }));
            return;
          }
          const localBranch = pull.headRefName;
          const remoteBranch = { cwd: input.cwd, remoteName, remoteBranch: pull.headRefName };
          if (input.force !== true && !branches.includes(localBranch))
            yield* git.fetchRemoteBranch({ ...remoteBranch, localBranch });
          else yield* git.fetchRemoteTrackingBranch(remoteBranch);
          if (input.force === true)
            yield* git.execute({
              operation: "GiceSourceControlProvider.checkoutChangeRequest",
              cwd: input.cwd,
              // The upstream is recorded next, through the host's serialized config write.
              args: [
                "checkout",
                "--no-track",
                "-B",
                localBranch,
                `refs/remotes/${remoteName}/${pull.headRefName}`,
                "--",
              ],
            });
          yield* git.setBranchUpstream({ ...remoteBranch, branch: localBranch });
          yield* Effect.scoped(git.switchRef({ cwd: input.cwd, refName: localBranch }));
        }).pipe(Effect.mapError(failed));
      },
    ),
  });
});
