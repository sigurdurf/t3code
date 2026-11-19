import {
  requireSettingsSecretLiteral,
  type SettingsSecretUnresolvedError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as GiceClient from "../shared/definition.ts";

export interface GiceServer {
  /** Lower case, with the port when the address names one. */
  readonly host: string;
  /** The server's web address without a trailing slash; the API lives below it. */
  readonly baseUrl: string;
}

export interface GiceCredential extends GiceServer {
  readonly token: Redacted.Redacted<string>;
  readonly source: "settings" | "env" | "gice";
}

export class GiceNotSignedInError extends Schema.TaggedError<GiceNotSignedInError>()(
  "GiceNotSignedInError",
  { host: Schema.String },
) {
  override get message(): string {
    return `No Gice credential for ${this.host}: save its address and a token in Settings, set GICE_HOST and GICE_TOKEN on the server, or run \`gice auth login --host https://${this.host}\`.`;
  }
}

export type GiceCredentialUnavailableError = GiceNotSignedInError | SettingsSecretUnresolvedError;

export class GiceCredentials extends Context.Service<
  GiceCredentials,
  {
    /** `host` may leave out the port, as a host read from an SSH remote does. */
    readonly get: (host: string) => Effect.Effect<GiceCredential, GiceCredentialUnavailableError>;
    /** Every credential the server holds, the one it prefers first. */
    readonly all: Effect.Effect<ReadonlyArray<GiceCredential>, SettingsSecretUnresolvedError>;
  }
>()("@t3tools/source-control-gice/server/GiceCredentials") {}

const LOOPBACK = /^(?:localhost$|127\.|\[::1\]$)/u;

/** Reads a server address the way `gice` does: no scheme means https, or http on loopback. */
export function parseGiceServer(address: string | undefined): GiceServer | null {
  const trimmed = address?.trim();
  if (!trimmed) return null;
  const withScheme = trimmed.includes("://")
    ? trimmed
    : `${LOOPBACK.test(trimmed.split(/[/:]/u, 1)[0] ?? "") ? "http" : "https"}://${trimmed}`;
  const url = URL.parse(withScheme);
  if (
    url === null ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.host === "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    return null;
  return {
    host: url.host.toLowerCase(),
    baseUrl: `${url.origin}${url.pathname}`.replace(/\/+$/u, ""),
  };
}

const ABSOLUTE_PATH = /^(?:[\\/]|[A-Za-z]:[\\/])/u;
const withoutTrailingSeparator = (path: string) => path.replace(/[\\/]+$/u, "");

const servesHost = (server: GiceServer, host: string) =>
  server.host === host || URL.parse(server.baseUrl)?.hostname.toLowerCase() === host;

const decodeConfig = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ host: Schema.optional(Schema.String), token: Schema.optional(Schema.String) }),
  ),
);

/** @public */
export const make = Effect.gen(function* () {
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

  const login = fileSystem.readFileString(configPath).pipe(
    Effect.map((text) => Option.getOrUndefined(decodeConfig(text))),
    Effect.orElseSucceed(() => undefined),
  );

  const saved = sourceControlHost.settings.getWithSecrets(GiceClient.definition.kind).pipe(
    Effect.map((settings) => ({
      ...readSourceControlHostSettings(
        GiceClient.settings,
        settings.sourceControlHosts[GiceClient.definition.kind],
      ),
      secretProviders: settings.secretProviders,
    })),
    Effect.orElseSucceed(() => ({ host: "", token: undefined, secretProviders: {} })),
    Effect.flatMap(({ host, token, secretProviders }) =>
      requireSettingsSecretLiteral(token, secretProviders).pipe(
        Effect.map((literal) => ({ host, token: literal.trim() })),
      ),
    ),
  );

  const all = Effect.gen(function* () {
    const settings = yield* saved;
    const config = yield* login;
    const loginServer = parseGiceServer(config?.host);
    // Like `gice`, GICE_TOKEN goes to GICE_HOST, or to the login's server when that is unset.
    const environmentServer = environment.GICE_HOST?.trim()
      ? parseGiceServer(environment.GICE_HOST)
      : loginServer;
    const candidates = [
      {
        server: settings.host ? parseGiceServer(settings.host) : environmentServer,
        token: settings.token,
        source: "settings",
      },
      { server: environmentServer, token: environment.GICE_TOKEN?.trim(), source: "env" },
      { server: loginServer, token: config?.token?.trim(), source: "gice" },
    ] as const;
    return candidates.flatMap(({ server, token, source }): ReadonlyArray<GiceCredential> =>
      server && token ? [{ ...server, token: Redacted.make(token), source }] : [],
    );
  });

  return GiceCredentials.of({
    all,
    get: Effect.fn("GiceCredentials.get")(function* (host) {
      const wanted = host.trim().toLowerCase();
      const credential = (yield* all).find((candidate) => servesHost(candidate, wanted));
      return credential ?? (yield* new GiceNotSignedInError({ host: wanted }));
    }),
  });
});

export const layer = Layer.effect(GiceCredentials, make);
