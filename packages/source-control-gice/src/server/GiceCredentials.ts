import {
  requireSettingsSecretLiteral,
  type SettingsSecretUnresolvedError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { normalizeHost } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as GiceClient from "../shared/definition.ts";

export interface GiceHeldServer extends GiceClient.GiceServer {
  /** False when the server is turned off in Settings. */
  readonly enabled: boolean;
}

export interface GiceCredential extends GiceHeldServer {
  readonly token: Redacted.Redacted<string>;
}

export class GiceNotSignedInError extends Schema.TaggedError<
  GiceNotSignedInError,
  { readonly brand: unique symbol }
>()("GiceNotSignedInError", { host: Schema.String }) {
  override get message(): string {
    return `No Gice credential for ${this.host}: save a token for it in Settings, set GICE_HOST and GICE_TOKEN on the server, or run \`gice auth login --host https://${this.host} --username <username>\`.`;
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

export type GiceCredentialUnavailableError =
  | GiceNotSignedInError
  | GiceHostDisabledError
  | SettingsSecretUnresolvedError;

export class GiceCredentials extends Context.Service<
  GiceCredentials,
  {
    /** `host` may leave out the port, as a host read from an SSH remote does. */
    readonly get: (host: string) => Effect.Effect<GiceCredential, GiceCredentialUnavailableError>;
    /**
     * Each server the server holds a token for, the preferred server first, including one whose
     * saved token cannot be read: `get` reports that for its host alone.
     */
    readonly all: Effect.Effect<ReadonlyArray<GiceHeldServer>>;
    /** Forgets the `gice` login read earlier, whose token a server may since have refused. */
    readonly invalidate: Effect.Effect<void>;
  }
>()("@t3tools/source-control-gice/server/GiceCredentials") {}

// Settings are read on every request, so a token saved there applies at once. The login file is
// read again after this long, or as soon as a server refuses a token.
const LOGIN_TTL = Duration.minutes(5);
// A missing login is read again soon, so `gice auth login` while T3 runs takes effect.
const MISSING_TTL = Duration.seconds(10);

const ABSOLUTE_PATH = /^(?:[\\/]|[A-Za-z]:[\\/])/u;
const withoutTrailingSeparator = (path: string) => path.replace(/[\\/]+$/u, "");

/** A server on `host` itself, else, for a host named without its port, one on any port. */
const serverFor = <Server extends GiceClient.GiceServer>(
  servers: ReadonlyArray<Server>,
  host: string,
) =>
  servers.find((server) => server.host === host) ??
  servers.find((server) => URL.parse(server.baseUrl)?.hostname.toLowerCase() === host);

const decodeConfig = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ host: Schema.optional(Schema.String), token: Schema.optional(Schema.String) }),
  ),
);

const make = Effect.gen(function* () {
  const sourceControlHost = yield* SourceControlHost.SourceControlHost;
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = yield* HostProcess.Environment;
  const homeDirectory = yield* HostProcess.HomeDirectory;

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
    const savedTokens = yield* Effect.forEach(Object.entries(tokens), ([host, token]) =>
      requireSettingsSecretLiteral(token, secretProviders).pipe(
        Effect.map((literal) => literal.trim()),
        Effect.result,
        Effect.map((result) => ({ server: GiceClient.parseGiceServer(host), token: result })),
      ),
    );
    const config = yield* login;
    const loginServer = GiceClient.parseGiceServer(config?.host);
    // Like `gice`, GICE_TOKEN goes to GICE_HOST, or to the login's server when that is unset.
    const environmentServer = environment.GICE_HOST?.trim()
      ? GiceClient.parseGiceServer(environment.GICE_HOST)
      : loginServer;
    const candidates = [
      ...savedTokens,
      { server: environmentServer, token: Result.succeed(environment.GICE_TOKEN?.trim() ?? "") },
      { server: loginServer, token: Result.succeed(config?.token?.trim() ?? "") },
    ];
    const usable = candidates.flatMap(({ server, token }) =>
      server && Result.getOrUndefined(token) !== ""
        ? [{ ...server, enabled: hosts[server.host]?.enabled ?? true, token }]
        : [],
    );
    return usable.filter(
      (entry, index) => usable.findIndex((other) => other.host === entry.host) === index,
    );
  });

  return GiceCredentials.of({
    invalidate: Cache.invalidate(logins, configPath),
    all: held.pipe(
      Effect.map((servers) =>
        servers.map(({ host, baseUrl, enabled }) => ({ host, baseUrl, enabled })),
      ),
    ),
    get: Effect.fn("GiceCredentials.get")(function* (host) {
      const wanted = normalizeHost(host);
      const server = serverFor(yield* held, wanted);
      if (server === undefined) return yield* new GiceNotSignedInError({ host: wanted });
      if (!server.enabled) return yield* new GiceHostDisabledError({ host: server.host });
      const token = yield* Effect.fromResult(server.token);
      return {
        host: server.host,
        baseUrl: server.baseUrl,
        enabled: true,
        token: Redacted.make(token),
      };
    }),
  });
});

export const layer = Layer.effect(GiceCredentials, make);
