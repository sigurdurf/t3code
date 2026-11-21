import {
  PositiveInt,
  SourceControlProviderError,
  TrimmedNonEmptyString,
  type ChangeRequest,
} from "@t3tools/contracts";
import { isSshRemoteUrl } from "@t3tools/shared/sourceControl";
import {
  providerAuth,
  type SourceControlApiDiscoverySpec,
  type SourceControlUnknownRemoteRefinement,
} from "@t3tools/source-control-core/server/discovery";
import { normalizeHost } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import {
  parseGitRemoteHost,
  unknownRemoteProvider,
} from "@t3tools/source-control-core/shared/definition";
import * as Cache from "effect/Cache";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { definition, parseGiceServer } from "../shared/definition.ts";

import * as GiceApi from "./GiceApi.ts";
import * as GiceCredentials from "./GiceCredentials.ts";
import { decodeMeta } from "./giceHttp.ts";
import * as Json from "./gicePullRequestJson.ts";

const KIND = definition.kind;
const PROBE_TIMEOUT = "3 seconds";
// Clients translate this exact text (client-runtime contractLabels.ts): change both together.
const INSTALL_HINT = `Save your Gice server's address and an access token in Settings, set GICE_HOST and GICE_TOKEN on the server, or run \`${definition.credentials.loginCommand}\`.`;

/** The `GET /meta` features T3 Code relies on beyond Gice's first API. */
export const REQUIRED_FEATURES = [
  "pull_checks_state",
  "pull_viewer_can_label",
  "pull_checks_filter",
  "pull_file_shas",
  "events_filter",
  "comment_edited_at",
  "pull_files_no_patch",
  "templates",
  "reference_search",
  "pull_viewed_files",
  "pull_revert",
  "cross_repo_lists",
  "pull_stacks",
  "pull_stack_actions",
  "delete_branch_on_merge",
  "link_draft_count",
  "cross_repo_stacks",
  "stack_bottom",
  "delete_expected_pulls",
] as const;
const SSH_HOST_TTL = Duration.minutes(5);
const SSH_HOST_FAILURE_TTL = Duration.seconds(30);

interface GiceRepositoryTarget {
  /** The web host: an HTTP remote's host with its port, an SSH remote's without one. */
  readonly host: string;
  readonly repository: string;
}

/** `owner/name` from a remote's path or a name typed by hand, `.git` and slashes trimmed. */
function repositoryName(path: string): string | null {
  const repository = path
    .trim()
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "");
  return GiceApi.REPOSITORY_NAME.test(repository) ? repository : null;
}

/** Null for anything but a remote naming `owner/name` on some host. */
function parseGiceRemote(remoteUrl: string): GiceRepositoryTarget | null {
  const trimmed = remoteUrl.trim();
  const url = /^(?:https?|ssh):\/\//iu.test(trimmed) ? URL.parse(trimmed) : null;
  const scp = url === null ? /^(?:[^@/:]+@)?([^/:]+):(.+)$/u.exec(trimmed) : null;
  // An SSH remote's port is the SSH server's, which says nothing about the web server.
  const host = url ? (url.protocol === "ssh:" ? url.hostname : url.host) : scp?.[1];
  const repository = repositoryName(url ? url.pathname.replace(/^\/+/u, "") : (scp?.[2] ?? ""));
  return host && repository ? { host: normalizeHost(host), repository } : null;
}

/** A context's remote, on the web host its Gice provider names, which an SSH host may not be. */
function remoteOfContext(context: SourceControlProvider.SourceControlProviderContext) {
  const remote = parseGiceRemote(context.remoteUrl);
  const server = context.provider.kind === KIND ? parseGiceServer(context.provider.baseUrl) : null;
  return remote && server ? { ...remote, host: server.host } : remote;
}

// A remote on a host with no telling name, or on a server's SSH host, is Gice's when discovery
// finds a credential's server for it, and that server's web host serves its pages.
const refineRepositoryIdentity: NonNullable<
  SourceControlProvider.SourceControlProvider["Service"]["refineRepositoryIdentity"]
> = Effect.fn("GiceSourceControlProvider.refineRepositoryIdentity")(function* ({
  identity,
  resolveContext,
}) {
  const remote = parseGiceRemote(identity.locator.remoteUrl);
  const remoteHost = parseGitRemoteHost(identity.locator.remoteUrl);
  if (
    remote === null ||
    !remoteHost ||
    !identity.rootPath ||
    (identity.provider !== undefined &&
      identity.provider !== "unknown" &&
      identity.provider !== KIND)
  )
    return identity;
  const context = yield* resolveContext({
    cwd: identity.rootPath,
    context: {
      provider: unknownRemoteProvider(remoteHost),
      remoteName: identity.locator.remoteName,
      remoteUrl: identity.locator.remoteUrl,
    },
  });
  return context?.provider.kind === KIND
    ? { ...identity, provider: KIND, webUrl: `${context.provider.baseUrl}/${remote.repository}` }
    : identity;
});

const resolveRemoteWebHost: NonNullable<
  SourceControlProvider.SourceControlProvider["Service"]["resolveRemoteWebHost"]
> = Effect.fn("GiceSourceControlProvider.resolveRemoteWebHost")(function* ({
  cwd,
  context,
  resolveContext,
}) {
  if (!isSshRemoteUrl(context.remoteUrl)) return null;
  const remoteHost = parseGitRemoteHost(context.remoteUrl);
  if (!remoteHost) return null;
  const resolved = yield* resolveContext({
    cwd,
    context: { ...context, provider: unknownRemoteProvider(remoteHost) },
  });
  return resolved?.provider.kind === KIND
    ? (parseGiceServer(resolved.provider.baseUrl)?.host ?? null)
    : null;
});

const User = Schema.Struct({ username: TrimmedNonEmptyString });
const Repository = Schema.Struct({
  full_name: TrimmedNonEmptyString,
  default_branch: Schema.String,
  clone_url_http: TrimmedNonEmptyString,
  // Empty on a server with SSH turned off.
  clone_url_ssh: Schema.String,
});
const CreatedPull = Schema.Struct({ number: PositiveInt });
const LinkSubject = Schema.Struct({ title: Schema.String, body: Schema.String });
const LINKED_SUBJECT = /^\/([^/]+\/[^/]+)\/(?:pulls|issues)\/([1-9]\d*)(?:\/|$)/u;

const sameName = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

// The single-file template, in one of the places Gice looks; a directory's are named by the file.
const DEFAULT_PULL_TEMPLATE = /^(?:(?:\.gice|\.github|docs)\/)?pull_request_template\.md$/iu;
// A template goes into the prompt that writes the description, so it is cut as GitHub's is.
const TEMPLATE_MAX_CHARACTERS = 8_000;

/** The default template, or the only one; a choice among several is left to the writer. */
function pullRequestTemplate(
  templates: ReadonlyArray<typeof Json.GiceTemplate.Type>,
): Option.Option<string> {
  const [first] = templates;
  const chosen =
    first !== undefined && (DEFAULT_PULL_TEMPLATE.test(first.path) || templates.length === 1)
      ? first.body.trim()
      : "";
  if (chosen === "") return Option.none();
  return Option.some(
    chosen.length > TEMPLATE_MAX_CHARACTERS
      ? `${chosen.slice(0, TEMPLATE_MAX_CHARACTERS)}\n\n[truncated]`
      : chosen,
  );
}

export const makeDiscovery = Effect.gen(function* () {
  const api = yield* GiceApi.GiceApi;
  const credentials = yield* GiceCredentials.GiceCredentials;
  const decodeUser = Schema.decodeUnknownOption(Schema.fromJsonString(User));

  const probeServer = Effect.fn("GiceSourceControlProvider.probeServer")(function* (
    credential: GiceCredentials.GiceHeldServer,
  ) {
    const { host } = credential;
    const [user, meta] = yield* Effect.all(
      [
        api.request({ host, operation: "discovery", path: "/user" }).pipe(Effect.result),
        api.request({ host, operation: "discovery", path: "/meta" }).pipe(Effect.result),
      ],
      { concurrency: 2 },
    );
    if (Result.isFailure(user))
      return {
        // A server that is down or forbidding does not establish that the token is gone.
        status: user.failure.reason === "unauthenticated" ? "unauthenticated" : "unknown",
        host,
        // A token that could not be read never reached the server, which says so in the detail.
        detail:
          user.failure.status === 401
            ? `Gice refused the token for ${host}. Replace it in Settings, or run \`gice auth login --host ${credential.baseUrl} --username <username>\`.`
            : user.failure.detail,
      } as const;
    if (Result.isFailure(meta))
      return { status: "unknown", host, detail: meta.failure.detail } as const;
    const decoded = Option.getOrUndefined(decodeMeta(meta.success));
    const version = decoded?.site?.version?.trim() || undefined;
    const features = new Set(decoded?.features);
    if (!REQUIRED_FEATURES.every((feature) => features.has(feature)))
      return {
        status: "unknown",
        host,
        detail: `The Gice server at ${host} is too old for T3 Code. Update Gice on that server, then refresh.`,
        version,
      } as const;
    const account = Option.getOrUndefined(decodeUser(user.success))?.username;
    return account === undefined
      ? ({ status: "unknown", host, detail: "Gice returned an unreadable account." } as const)
      : ({ status: "authenticated", host, account, version } as const);
  });

  const probeAuth = Effect.gen(function* () {
    const held = yield* credentials.all;
    if (held.length === 0)
      return { auth: providerAuth({ status: "unauthenticated", detail: INSTALL_HINT }) };
    // A server turned off in Settings is asked nothing, yet keeps its row so Settings can turn it
    // back on.
    const servers = yield* Effect.forEach(
      held.filter((server) => server.enabled),
      probeServer,
      { concurrency: "unbounded" },
    );
    const chosen = servers.find((server) => server.status === "authenticated") ?? servers[0];
    const problems = servers.flatMap((server) =>
      server.detail === undefined ? [] : [server.detail],
    );
    return {
      version: chosen?.version,
      auth: {
        ...providerAuth(
          chosen
            ? { ...chosen, detail: problems.join(" ") }
            : {
                status: "unauthenticated",
                detail: "Every Gice server is turned off in Settings → Source control & issues.",
              },
        ),
        accounts: [
          ...servers.flatMap((server) =>
            server.account === undefined
              ? []
              : [{ host: server.host, account: server.account, active: true, authenticated: true }],
          ),
          ...held
            .filter((server) => !server.enabled)
            .map((server) => ({
              host: server.host,
              account: server.host,
              active: true,
              authenticated: false,
              error: "turned off in Settings",
            })),
        ],
      },
    };
  });

  // Where a server's SSH host differs from its web host, only its `GET /meta` tells. The registry
  // asks one host after another, so a slow server must not hold up the rest.
  const sshHosts = yield* Cache.makeWith(
    (host: string) =>
      api.request({ host, operation: "discovery", path: "/meta" }).pipe(
        Effect.timeout(PROBE_TIMEOUT),
        Effect.map((raw) => Option.getOrUndefined(decodeMeta(raw))?.ssh?.host.toLowerCase()),
      ),
    {
      capacity: 32,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? SSH_HOST_TTL : SSH_HOST_FAILURE_TTL),
    },
  );
  const providerInfo = (credential: GiceCredentials.GiceHeldServer) => ({
    kind: KIND,
    name: definition.label,
    baseUrl: credential.baseUrl,
  });

  return {
    type: "api",
    kind: KIND,
    label: definition.label,
    installHint: INSTALL_HINT,
    probeAuth: probeAuth.pipe(Effect.map(({ version, auth }) => ({ ...auth, version }))),
    // A Gice server has no telling name: the remote is one when a credential names its host, or
    // names its SSH host whatever the port, since one server may listen on several.
    // A failed lookup fails, which the registry does not keep as an answer.
    refineUnknownRemote: Effect.fn("GiceSourceControlProvider.refineUnknownRemote")(function* ({
      context,
    }: Parameters<SourceControlUnknownRemoteRefinement>[0]) {
      const remote = parseGiceRemote(context.remoteUrl);
      if (remote === null) return null;
      const named = yield* credentials.get(remote.host).pipe(
        Effect.map(providerInfo),
        Effect.catchTags({
          GiceNotSignedInError: () => Effect.succeed(null),
          GiceHostDisabledError: () => Effect.succeed(null),
        }),
      );
      if (named !== null || !isSshRemoteUrl(context.remoteUrl)) return named;
      const held = (yield* credentials.all).filter((server) => server.enabled);
      const sshHostsOfHeld = yield* Effect.forEach(
        held,
        (server) => Cache.get(sshHosts, server.host).pipe(Effect.result),
        { concurrency: "unbounded" },
      );
      const server =
        held[sshHostsOfHeld.findIndex((found) => Result.getOrUndefined(found) === remote.host)];
      if (server !== undefined) return providerInfo(server);
      const failed = sshHostsOfHeld.find(Result.isFailure);
      return failed === undefined ? null : yield* failed.failure;
    }),
  } satisfies SourceControlApiDiscoverySpec;
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
  const requests = GiceApi.targetRequests(api, {
    repositoryOf: (target: {
      readonly cwd: string;
      readonly host: string;
      readonly repository?: string;
    }) => target.repository,
    mapError: (operation, target) => (cause) => error(operation, target.cwd, cause.detail, cause),
  });
  const read = <S extends Schema.Codec<unknown, unknown, never, never>>(
    operation: string,
    cwd: string,
    { host, repository, ...request }: Omit<GiceApi.GiceApiRequest, "operation">,
    schema: S,
  ) =>
    requests.read(
      operation,
      { cwd, host, ...(repository === undefined ? {} : { repository }) },
      request,
      schema,
    );
  const signedInHost = credentials.all.pipe(
    Effect.map((held) => held.find((credential) => credential.enabled)?.host),
    Effect.orElseSucceed(() => undefined),
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
    if (input.repository === undefined) {
      const remote = input.context
        ? remoteOfContext(input.context)
        : parseGiceRemote(
            (yield* readRemote.pipe(
              Effect.mapError((cause) =>
                error(operation, input.cwd, "Could not read the Gice remote.", cause),
              ),
            )) ?? "",
          );
      if (remote) return remote;
      return yield* error(operation, input.cwd, "No Gice repository remote was found.");
    }
    const repository = repositoryName(input.repository);
    if (repository === null)
      return yield* error(
        operation,
        input.cwd,
        "A Gice repository is named owner/name or by its URL.",
      );
    if (input.host !== undefined)
      return { host: normalizeHost(input.host), repository } satisfies GiceRepositoryTarget;
    // The checkout's server when its remote is on a Gice server, and the signed-in one otherwise.
    const remote = input.context
      ? remoteOfContext(input.context)
      : parseGiceRemote((yield* readRemote.pipe(Effect.orElseSucceed(() => null))) ?? "");
    const remoteServer =
      remote === null
        ? undefined
        : yield* credentials.get(remote.host).pipe(
            Effect.map((credential) => credential.host),
            Effect.orElseSucceed(() => undefined),
          );
    const targetHost = remoteServer ?? (yield* signedInHost);
    if (targetHost === undefined)
      return yield* error(operation, input.cwd, `No Gice server is signed in. ${INSTALL_HINT}`);
    return { host: targetHost, repository } satisfies GiceRepositoryTarget;
  });

  const toChangeRequest = (pull: Json.GicePull) =>
    ({
      provider: KIND,
      number: pull.number,
      title: pull.title,
      url: pull.html_url,
      baseRefName: pull.base,
      headRefName: pull.head,
      ...(pull.head_sha ? { headSha: pull.head_sha } : {}),
      isDraft: pull.draft,
      state: pull.state,
      closedAt: pull.closed_at,
      mergedAt: pull.merged_at,
      updatedAt: Option.map(DateTime.make(pull.updated_at), DateTime.toUtc),
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
    const url = URL.parse(reference);
    const link = url === null ? null : definition.parseChangeRequestUrl(url, true);
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
      { host: target.host, repository: target.repository, path: `/pulls/${number}` },
      Json.GicePull,
    );
    return { target, changeRequest: toChangeRequest(pull) };
  });

  return SourceControlProvider.SourceControlProvider.of({
    kind: KIND,
    takesSourceRepository: true,
    refineRepositoryIdentity,
    // A token goes only to the server it was saved for, so a link to any other host fails here.
    // The issue routes answer for a pull request's number too.
    resolveLink: (input) => {
      const match = LINKED_SUBJECT.exec(input.url.pathname);
      if (match === null) return undefined;
      return read(
        "resolveLink",
        input.cwd,
        { host: input.url.host, repository: match[1]!, path: `/issues/${match[2]}` },
        LinkSubject,
      ).pipe(Effect.map(({ title, body }) => ({ title, body: body || null })));
    },
    resolveRemoteWebHost,
    // Gice reads several heads, comma-separated, in one listing; a bare branch is the
    // repository's own, so a fork reusing the name never fills the page.
    headBranchProbe: ({ headSelectors, ownerHeadSelector }) => ({
      headSelectors: [
        [...new Set([...headSelectors, ...(ownerHeadSelector ? [ownerHeadSelector] : [])])].join(
          ",",
        ),
      ],
      limit: 100,
    }),
    // The server reads the templates at the base's commit, which a pushed base has there too.
    readChangeRequestTemplate: Effect.fn("GiceSourceControlProvider.readChangeRequestTemplate")(
      function* (input) {
        const operation = "readChangeRequestTemplate";
        const [target, { commitSha }] = yield* Effect.all([
          resolveTarget(operation, input),
          host.git.resolveCommit({ cwd: input.cwd, revision: input.treeish }),
        ]);
        const query = new URLSearchParams({ kind: "pull", ref: commitSha });
        const templates = yield* read(
          operation,
          input.cwd,
          { host: target.host, repository: target.repository, path: `/templates?${query}` },
          Schema.Array(Json.GiceTemplate),
        );
        return pullRequestTemplate(templates);
      },
      Effect.orElseSucceed(() => Option.none<string>()),
    ),
    repositoryNameFromRemoteUrl: (url) => parseGiceRemote(url)?.repository ?? null,
    getChangeRequest: Effect.fn("GiceSourceControlProvider.getChangeRequest")(function* (input) {
      return (yield* getPull(input)).changeRequest;
    }),
    listChangeRequests: Effect.fn("GiceSourceControlProvider.listChangeRequests")(
      function* (input) {
        const target = yield* resolveTarget("listChangeRequests", input);
        const source = SourceControlProvider.sourceControlRefFromInput(input);
        const owner = source?.owner ?? source?.repository?.split("/")[0];
        const branch = SourceControlProvider.sourceBranch(input);
        // `head=owner:branch` also finds the branch in the owner's fork. Several heads are the
        // probe's, already in Gice's form.
        const several = input.source === undefined && input.headSelector.includes(",");
        const query = new URLSearchParams({
          state: input.state,
          head: several ? input.headSelector : owner ? `${owner}:${branch}` : branch,
          fields: "summary",
          per_page: String(input.limit ?? 20),
        });
        const pulls = yield* read(
          "listChangeRequests",
          input.cwd,
          { host: target.host, repository: target.repository, path: `/pulls?${query}` },
          Schema.Array(Json.GicePull),
        );
        return pulls.map(toChangeRequest);
      },
    ),
    createsDraftChangeRequests: true,
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
            repository: target.repository,
            path: "/pulls",
            body: {
              title: input.title,
              body,
              head: SourceControlProvider.sourceBranch(input),
              base: input.target?.refName ?? input.baseRefName,
              ...(input.draft === true ? { draft: true } : {}),
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
          { host: target.host, repository: target.repository, path: "" },
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
      const [owner, name] =
        (named?.repository ?? repositoryName(input.repository))?.split("/") ?? [];
      // A new repository's checkout has no Gice remote yet, so only the sign-in names the server.
      const targetHost = named?.host ?? (yield* signedInHost);
      if (owner === undefined || name === undefined || targetHost === undefined)
        return yield* error(
          "createRepository",
          input.cwd,
          name === undefined
            ? "A Gice repository is named owner/name or by its URL."
            : `No Gice server is signed in. ${INSTALL_HINT}`,
        );
      // Gice creates repositories under the signed-in account only.
      const { username } = yield* read(
        "createRepository",
        input.cwd,
        { host: targetHost, path: "/user" },
        User,
      );
      if (!sameName(owner, username))
        return yield* error(
          "createRepository",
          input.cwd,
          `Gice creates repositories only under your own account, ${username}, not under ${owner}.`,
        );
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
        { host: target.host, repository: target.repository, path: "" },
        Repository,
      );
      return repository.default_branch.trim() || null;
    }),
    checkoutChangeRequest: Effect.fn("GiceSourceControlProvider.checkoutChangeRequest")(
      function* (input) {
        const { target, changeRequest: pull } = yield* getPull(input);
        const contextRemote = input.context ? remoteOfContext(input.context) : null;
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
                { host: target.host, repository: target.repository, path: "" },
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
            const run = (args: ReadonlyArray<string>) =>
              git.execute({
                operation: "GiceSourceControlProvider.checkoutChangeRequest",
                cwd: input.cwd,
                args,
              });
            yield* run(["fetch", remoteName, definition.changeRequestHeadRef(pull.number)]);
            const { commitSha } = yield* git.resolveCommit({
              cwd: input.cwd,
              revision: "FETCH_HEAD",
            });
            const exists = branches.includes(localBranch);
            if (!exists)
              yield* git.createBranch({
                cwd: input.cwd,
                branch: localBranch,
                startPoint: commitSha,
              });
            yield* Effect.scoped(git.switchRef({ cwd: input.cwd, refName: localBranch }));
            // The branch has no upstream to pull from, so a checkout again brings it up to date.
            if (exists)
              yield* run(
                input.force === true
                  ? ["reset", "--hard", "--quiet", commitSha]
                  : ["merge", "--ff-only", "--quiet", commitSha],
              );
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
