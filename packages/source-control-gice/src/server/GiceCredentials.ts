// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous digest, kept in place of a token.
import * as NodeCrypto from "node:crypto";

import {
  requireSettingsSecretLiteral,
  type SettingsSecretUnresolvedError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { normalizeHost } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as GiceClient from "../shared/definition.ts";
import * as GiceAppSignIn from "./GiceAppSignIn.ts";

/** Where a credential came from, in the order they take precedence. */
export type GiceCredentialSource = "settings" | "app" | "environment" | "cli";

export interface GiceHeldServer extends GiceClient.GiceServer {
  /** False when the server is turned off in Settings. */
  readonly enabled: boolean;
  readonly source: GiceCredentialSource;
}

export interface GiceCredential extends GiceHeldServer {
  readonly token: Redacted.Redacted<string>;
}

export class GiceNotSignedInError extends Schema.TaggedError<
  GiceNotSignedInError,
  { readonly brand: unique symbol }
>()("GiceNotSignedInError", { host: Schema.String }) {
  override get message(): string {
    return `No Gice credential for ${this.host}: sign in or save a token for it in Settings, set GICE_HOST and GICE_TOKEN on the server, or run \`gice auth login --host https://${this.host}\`.`;
  }
}

export class GiceHostDisabledError extends Schema.TaggedError<
  GiceHostDisabledError,
  { readonly brand: unique symbol }
>()("GiceHostDisabledError", { host: Schema.String }) {
  override get message(): string {
    return `Gice host ${this.host} is turned off in Settings → Source control & issues.`;
  }
}

export class GiceCliLoginExpiredError extends Schema.TaggedError<
  GiceCliLoginExpiredError,
  { readonly brand: unique symbol }
>()("GiceCliLoginExpiredError", { host: Schema.String }) {
  override get message(): string {
    return `The gice CLI sign-in for ${this.host} has expired and the CLI could not renew it. Run \`gice auth status\` on the server (it renews the sign-in) or \`gice auth login\`, or sign in from Settings → Source control & issues.`;
  }
}

export type GiceCredentialUnavailableError =
  | GiceNotSignedInError
  | GiceHostDisabledError
  | GiceCliLoginExpiredError
  | GiceAppSignIn.GiceSignInEndedError
  | GiceAppSignIn.GiceSignInUnreachableError
  | SettingsSecretUnresolvedError;

export class GiceCredentials extends Context.Service<
  GiceCredentials,
  {
    /** `host` may leave out the port, as a host read from an SSH remote does. */
    readonly get: (host: string) => Effect.Effect<GiceCredential, GiceCredentialUnavailableError>;
    /**
     * Each server the server holds a credential for, the preferred server first, including one
     * whose credential cannot be read now: `get` reports that for its host alone.
     */
    readonly all: Effect.Effect<ReadonlyArray<GiceHeldServer>>;
    /**
     * Reports that the server refused `credential`, `reason` being Gice's: a sign-in renews and
     * the `gice` login is read again, either of which may give `get` a newer token.
     */
    readonly rejected: (
      credential: GiceCredential,
      reason: string | undefined,
    ) => Effect.Effect<void>;
  }
>()("@t3tools/source-control-gice/server/GiceCredentials") {}

// Settings are read on every request, so a token saved there applies at once. The login file is
// read again after this long, or as soon as a server refuses a token.
const LOGIN_TTL = Duration.minutes(5);
// A missing login is read again soon, so `gice auth login` while T3 runs takes effect.
const MISSING_TTL = Duration.seconds(10);
// gice renews its own sign-in this long before it expires (`refreshMargin` in its signin.go), so
// asking it then makes it renew.
const CLI_RENEW_MARGIN_MS = Duration.toMillis(Duration.minutes(5));
const CLI_RENEW_TIMEOUT_MS = 45_000;
// A login gice could not renew is not asked about again for this long, unless its token changes,
// so a lapsed login costs one `gice auth status` rather than one per request.
const UNRENEWED_TTL_MS = Duration.toMillis(MISSING_TTL);
// Refused and unrenewed logins are remembered by digest, so their tokens are not kept in memory.
const digestOf = (token: string) =>
  NodeCrypto.createHash("sha256").update(token).digest("base64url");

const ABSOLUTE_PATH = /^(?:[\\/]|[A-Za-z]:[\\/])/u;
const withoutTrailingSeparator = (path: string) => path.replace(/[\\/]+$/u, "");

/** A server on `host` itself, else, for a host named without its port, one on any port. */
const serverFor = <Server extends GiceClient.GiceServer>(
  servers: ReadonlyArray<Server>,
  host: string,
) =>
  servers.find((server) => server.host === host) ??
  servers.find((server) => URL.parse(server.baseUrl)?.hostname.toLowerCase() === host);

const Login = Schema.Struct({
  host: Schema.optional(Schema.String),
  token: Schema.optional(Schema.String),
  // Set by a browser sign-in, which gice renews itself: never by T3 Code, since a refresh token
  // works once and a second use ends the CLI's sign-in.
  refresh_token: Schema.optional(Schema.String),
  token_expires_at: Schema.optional(Schema.String),
});
type Login = typeof Login.Type;
const decodeConfig = Schema.decodeUnknownOption(Schema.fromJsonString(Login));

interface Candidate {
  readonly server: GiceClient.GiceServer | null;
  readonly source: GiceCredentialSource;
  readonly present: boolean;
  readonly token: Effect.Effect<string, GiceCredentialUnavailableError>;
}

const make = Effect.gen(function* () {
  const sourceControlHost = yield* SourceControlHost.SourceControlHost;
  const appSignIn = yield* GiceAppSignIn.GiceAppSignIn;
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = yield* HostProcess.Environment;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const workingDirectory = yield* HostProcess.WorkingDirectory;
  const renewLock = yield* Semaphore.make(1);
  const unrenewed = yield* Ref.make<{ readonly digest: string; readonly until: number } | null>(
    null,
  );

  // Where `gice auth login` keeps its one login.
  const configHome = environment.XDG_CONFIG_HOME;
  const configDirectory =
    configHome && ABSOLUTE_PATH.test(configHome)
      ? configHome
      : `${withoutTrailingSeparator(environment.HOME || homeDirectory)}/.config`;
  const configPath = `${withoutTrailingSeparator(configDirectory)}/gice/config.json`;

  const logins = yield* Cache.makeWith(
    (path: string) =>
      fileSystem.readFileString(path).pipe(
        Effect.map((text) => Option.getOrUndefined(decodeConfig(text))),
        Effect.orElseSucceed(() => undefined),
      ),
    {
      capacity: 1,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value?.token?.trim() ? LOGIN_TTL : MISSING_TTL,
    },
  );
  const login = Cache.get(logins, configPath);
  const forgetLogin = Cache.invalidate(logins, configPath);
  // The digest of the login token a server last refused. Read again for the retry, it is not
  // kept: the read after takes the file again, where `gice` may have put a newer one.
  const refusedLogin = yield* Ref.make<string | null>(null);
  const currentLogin = Effect.gen(function* () {
    const config = yield* login;
    const token = config?.token?.trim();
    const refused = yield* Ref.get(refusedLogin);
    if (token !== undefined && refused !== null && digestOf(token) === refused) yield* forgetLogin;
    return config;
  });

  /** The login's token while it has a while left; an expiring one gice has not renewed is not. */
  const freshToken = (config: Login | undefined, now: number) => {
    const token = config?.token?.trim() ?? "";
    if (!config?.refresh_token || !config.token_expires_at) return token;
    const expiresAt = Date.parse(config.token_expires_at);
    return Number.isFinite(expiresAt) && now < expiresAt - CLI_RENEW_MARGIN_MS ? token : null;
  };

  // `gice auth status` renews the CLI's sign-in under the CLI's own file lock, as any gice
  // command does. Its output names the account, never the token.
  const renewLogin = Effect.fn("GiceCredentials.renewLogin")(function* (
    host: string,
    rejectedToken?: string,
  ) {
    return yield* renewLock.withPermits(1)(
      Effect.gen(function* () {
        yield* forgetLogin;
        const config = yield* login;
        const now = yield* Clock.currentTimeMillis;
        const before = freshToken(config, now);
        if (before && before !== rejectedToken) return before;
        const lapsed = yield* Ref.get(unrenewed);
        const current = config?.token?.trim();
        if (lapsed && current && lapsed.digest === digestOf(current) && now < lapsed.until) {
          return yield* new GiceCliLoginExpiredError({ host });
        }
        yield* sourceControlHost.process
          .run({
            operation: "GiceCredentials.renewLogin",
            command: "gice",
            args: ["auth", "status"],
            cwd: workingDirectory,
            // The login file's server, not one a variable points at.
            env: { GICE_HOST: "", GICE_TOKEN: "" },
            timeoutMs: CLI_RENEW_TIMEOUT_MS,
            allowNonZeroExit: true,
          })
          .pipe(Effect.ignore);
        yield* forgetLogin;
        const renewed = yield* login;
        const checkedAt = yield* Clock.currentTimeMillis;
        const after = freshToken(renewed, checkedAt);
        if (after && after !== rejectedToken) return after;
        const token = renewed?.token?.trim();
        yield* Ref.set(
          unrenewed,
          token ? { digest: digestOf(token), until: checkedAt + UNRENEWED_TTL_MS } : null,
        );
        return yield* new GiceCliLoginExpiredError({ host });
      }),
    );
  });

  const saved = sourceControlHost.settings.getWithSecrets(GiceClient.definition.kind).pipe(
    Effect.map((settings) => ({
      ...readSourceControlHostSettings(
        GiceClient.settings,
        settings.sourceControlHosts[GiceClient.definition.kind],
      ),
      secretProviders: settings.secretProviders,
    })),
    Effect.orElseSucceed(() => ({
      ...readSourceControlHostSettings(GiceClient.settings, {}),
      secretProviders: {},
    })),
  );

  const held = Effect.gen(function* () {
    const { hosts, tokens, secretProviders } = yield* saved;
    const savedTokens = Object.entries(tokens).map(([host, token]): Candidate => ({
      server: GiceClient.parseGiceServer(host),
      source: "settings",
      present: typeof token === "string" ? token.trim() !== "" : true,
      token: requireSettingsSecretLiteral(token, secretProviders).pipe(
        Effect.map((literal) => literal.trim()),
      ),
    }));
    const signIns = (yield* appSignIn.servers).map((server): Candidate => ({
      server,
      source: "app",
      present: true,
      token: appSignIn.token(server.host).pipe(
        Effect.flatMap(
          Option.match({
            // Signed out since the list was read.
            onNone: () => Effect.fail(new GiceNotSignedInError({ host: server.host })),
            onSome: ({ token }) => Effect.succeed(token),
          }),
        ),
      ),
    }));
    const config = yield* currentLogin;
    const loginServer = GiceClient.parseGiceServer(config?.host);
    // Like `gice`, GICE_TOKEN goes to GICE_HOST, or to the login's server when that is unset.
    const environmentServer = environment.GICE_HOST?.trim()
      ? GiceClient.parseGiceServer(environment.GICE_HOST)
      : loginServer;
    const environmentToken = environment.GICE_TOKEN?.trim() ?? "";
    const candidates: ReadonlyArray<Candidate> = [
      ...savedTokens,
      ...signIns,
      {
        server: environmentServer,
        source: "environment",
        present: environmentToken !== "",
        token: Effect.succeed(environmentToken),
      },
      {
        server: loginServer,
        source: "cli",
        present: (config?.token?.trim() ?? "") !== "",
        token: Effect.gen(function* () {
          const token = freshToken(config, yield* Clock.currentTimeMillis);
          return token ?? (yield* renewLogin(loginServer?.host ?? ""));
        }),
      },
    ];
    const usable = candidates.flatMap(({ server, source, present, token }) =>
      server && present
        ? [{ ...server, source, enabled: hosts[server.host]?.enabled ?? true, token }]
        : [],
    );
    return usable.filter(
      (entry, index) => usable.findIndex((other) => other.host === entry.host) === index,
    );
  });

  return GiceCredentials.of({
    all: held.pipe(
      Effect.map((servers) =>
        servers.map(({ host, baseUrl, enabled, source }) => ({ host, baseUrl, enabled, source })),
      ),
    ),
    get: Effect.fn("GiceCredentials.get")(function* (host) {
      const wanted = normalizeHost(host);
      const server = serverFor(yield* held, wanted);
      if (server === undefined) {
        // A sign-in that ended says why, where a missing one would only say none is held.
        const note = (yield* appSignIn.notes).get(wanted);
        return yield* note === undefined
          ? new GiceNotSignedInError({ host: wanted })
          : new GiceAppSignIn.GiceSignInEndedError({ host: wanted, detail: note });
      }
      if (!server.enabled) return yield* new GiceHostDisabledError({ host: server.host });
      const token = yield* server.token;
      return {
        host: server.host,
        baseUrl: server.baseUrl,
        enabled: true,
        source: server.source,
        token: Redacted.make(token),
      };
    }),
    rejected: Effect.fn("GiceCredentials.rejected")(function* (credential, reason) {
      if (credential.source === "app")
        yield* appSignIn.rejected(credential.host, Redacted.value(credential.token));
      // The login file may hold a newer token than the one that was refused; if Gice says it
      // expired (for instance under clock skew), ask `gice` to renew a browser login now.
      if (credential.source === "cli") {
        yield* Ref.set(refusedLogin, digestOf(Redacted.value(credential.token)));
        yield* forgetLogin;
        if (reason === "token_expired") {
          const config = yield* login;
          if (config?.refresh_token) {
            yield* renewLogin(credential.host, Redacted.value(credential.token)).pipe(
              Effect.ignore,
            );
          }
        }
      }
    }),
  });
});

export const layer = Layer.effect(GiceCredentials, make);
