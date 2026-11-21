import { builtInSourceControlDefinitions } from "@t3tools/source-control-definitions/registry";
import {
  HostCredentialSettings,
  readSourceControlHostSettings,
  type SourceControlAppSignIn,
  type SourceControlDefinition,
} from "@t3tools/source-control-core/shared/definition";
import type {
  ClientServerSettingsPatch,
  ExecutionEnvironmentCapabilities,
  ServerSettings,
  SourceControlAppAccessInput,
  SourceControlProviderAuth,
  SourceControlSignInInput,
} from "@t3tools/contracts";
import { parseGitRemoteRepository } from "@t3tools/shared/git";

export {
  isMonochromeSourceControlIcon,
  UNKNOWN_SOURCE_CONTROL_CLIENT,
  type ChangeRequestLink,
  type ChangeRequestTerminology,
  type HostAccountChoice,
  type HostCredentialSettings,
  type ParsedChangeRequestUrl,
  type ReferenceAutolink,
  type SourceControlAppSignIn,
  type SourceControlDefinition,
  type SourceControlHostCredentials,
  type SourceControlIcon,
} from "@t3tools/source-control-core/shared/definition";

export const sourceControlClients = builtInSourceControlDefinitions;

/** The saved per-hostname accounts and tokens of a host whose definition has `credentials`. */
export function readHostCredentialSettings(
  settings: Pick<ServerSettings, "sourceControlHosts">,
  kind: string,
): HostCredentialSettings {
  return readSourceControlHostSettings(HostCredentialSettings, settings.sourceControlHosts[kind]);
}

/**
 * How a client signs out of an app sign-in: through the host's driver where the server serves
 * `sourceControl.signOut`, else as servers before it expect, by clearing the saved sign-in.
 */
export function appSignOutRequest(
  capabilities: Pick<ExecutionEnvironmentCapabilities, "sourceControlSignOut"> | undefined,
  input: SourceControlSignInInput,
  signIns: Readonly<Record<string, string>>,
):
  | { readonly via: "sign-out"; readonly input: SourceControlSignInInput }
  | { readonly via: "settings"; readonly patch: typeof ClientServerSettingsPatch.Type } {
  if (capabilities?.sourceControlSignOut === true) return { via: "sign-out", input };
  return {
    via: "settings",
    // The whole map: other hosts' redaction markers keep their sign-ins.
    patch: {
      sourceControlHosts: { [input.provider]: { signIns: { ...signIns, [input.host]: "" } } },
    },
  };
}

/** The servers of a host with no fixed address that the settings hold a sign-in for. */
export function signedInServers(signIns: Readonly<Record<string, string>>): ReadonlyArray<string> {
  return Object.keys(signIns).filter((host) => (signIns[host] ?? "").length > 0);
}

/** The lower-case `host` (and port, if any) of a server address a user typed or pasted. */
export function normalizeServerAddressHost(address: string): string {
  const trimmed = address.trim();
  if (trimmed === "") return "";
  const url = URL.parse(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  return url !== null && url.host !== "" ? url.host.toLowerCase() : trimmed;
}

export type NamedServerSignInStatus =
  | { readonly kind: "overridden" }
  | { readonly kind: "authenticated"; readonly account: string }
  | { readonly kind: "error"; readonly error: string }
  | { readonly kind: "signed-in" };

/**
 * What a row for one signed-in named server says: a saved token overrides the sign-in; otherwise
 * only an authenticated discovery account names the signed-in user, and an unauthenticated entry
 * with an error, such as a server turned off in Settings, reports it rather than its placeholder
 * account.
 */
export function namedServerSignInStatus(
  accounts: SourceControlProviderAuth["accounts"],
  host: string,
  tokenOverrides: boolean,
): NamedServerSignInStatus {
  if (tokenOverrides) return { kind: "overridden" };
  const authenticated = accounts?.find((entry) => entry.host === host && entry.authenticated);
  if (authenticated !== undefined) return { kind: "authenticated", account: authenticated.account };
  const failed = accounts?.find(
    (entry) => entry.host === host && !entry.authenticated && entry.error !== undefined,
  );
  return failed?.error === undefined
    ? { kind: "signed-in" }
    : { kind: "error", error: failed.error };
}

/** Whether a saved token, or one read from a secret provider, overrides a host's sign-in. */
export function tokenOverridesSignIn(token: unknown): boolean {
  return typeof token === "string" ? token.length > 0 : token !== undefined;
}

/** A host's change request term where it opens a sentence: "Merge request merged". */
export function capitalizeTerm(term: string): string {
  return term.charAt(0).toUpperCase() + term.slice(1);
}

/**
 * The repository a remote names, when its host has an app sign-in that reaches only where it is
 * installed.
 */
export function appSignInTargetForRemote(remoteUrl: string): {
  readonly definition: SourceControlDefinition;
  readonly appSignIn: SourceControlAppSignIn;
  readonly installUrl: string;
  readonly input: SourceControlAppAccessInput;
} | null {
  const parsed = parseGitRemoteRepository(remoteUrl);
  const provider = sourceControlClients.recognizeRemote(remoteUrl);
  const definition = provider ? sourceControlClients.find(provider.kind) : undefined;
  const appSignIn = definition?.credentials?.appSignIn;
  const installUrl = appSignIn?.installUrl;
  if (parsed === null || definition === undefined || appSignIn === undefined) return null;
  if (installUrl === undefined || !appSignIn.hosts?.includes(parsed.host)) return null;
  // The parser lowercases; keep the remote's own casing for display when it names the same path.
  const asWritten = remoteUrl
    .trim()
    .replace(/\.git\/?$/i, "")
    .split(/[/:]/)
    .slice(-2)
    .join("/");
  const repository = asWritten.toLowerCase() === parsed.path ? asWritten : parsed.path;
  return {
    definition,
    appSignIn,
    installUrl,
    input: { provider: definition.kind, host: parsed.host, repository },
  };
}
