import { makeProviderSettingsSchema, SourceControlProviderKind } from "@t3tools/contracts";
import {
  buildCommitUrl,
  changeRequestUrlBelow,
  defineSourceControl,
  hostCredentialSettingsFields,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
  parseChangeRequestPath,
  parseCommitPath,
  parseIssuePath,
  serverChangeRequestHost,
  remoteWebOrigin,
  repositoryUrlFromPagePath,
  type SourceControlMediaUrl,
} from "@t3tools/source-control-core/shared/definition";
import { icon } from "./icon.ts";
import { giceReferenceAutolinks } from "./referenceAutolinks.ts";

const CHECKOUT_COMMAND = /^gice\s+(?:pr|pull)\s+checkout\s+(.+)$/i;

const CHANGE_REQUEST_PATH = /^\/([^/]+\/[^/]+)\/pulls\/(\d+)(?:\/|$)/u;
const COMMIT_PATH = /^\/([^/]+\/[^/]+)\/commit\/([0-9a-f]+)\/?$/iu;
const ISSUE_PATH = /^\/([^/]+\/[^/]+)\/issues\/(\d+)(?:\/|$)/u;
// Gice names the ref and path of a tree or blob page in its query string.
const REPOSITORY_PAGE_PATH = /^\/([^/]+\/[^/]+)\/(?:tree|blob|commits|branches)\/?$/u;

// `GET R/raw?ref=&path=`, below the server's base URL. Forgejo and Gitea name the file in the
// route instead (`/raw/{path}`), so this shape is Gice's on any hostname.
const RAW_PATH = /^(?:\/[^/]+)*\/api\/v1\/repos\/[^/]+\/[^/]+\/raw$/u;
const FULL_COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

const KIND = SourceControlProviderKind.make("gice");

export interface GiceServer {
  /** Lower case, with the port when the address names one. */
  readonly host: string;
  /** The server's web address without a trailing slash; the API lives below it. */
  readonly baseUrl: string;
}

const LOOPBACK_HOSTNAME = /^(?:localhost|127\.\d+\.\d+\.\d+|\[::1\])$/u;

/** Reads a server address the way `gice` does: no scheme means https, or http on loopback. */
export function parseGiceServer(address: string | undefined): GiceServer | null {
  const trimmed = address?.trim();
  if (!trimmed) return null;
  let url = URL.parse(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  if (url !== null && !trimmed.includes("://") && LOOPBACK_HOSTNAME.test(url.hostname)) {
    url = URL.parse(`http://${trimmed}`);
  }
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

/**
 * Gice runs on any hostname, and only a server the user signed in to is known to be one. A name
 * with a `gice` label is the one thing a client can tell without asking the server.
 */
function isGiceHost(hostname: string): boolean {
  return hostname.toLowerCase().split(".").includes("gice");
}

function parseChangeRequestUrl(url: URL, known = false) {
  if (!known && !isGiceHost(url.hostname)) return null;
  const link = parseChangeRequestPath(url, CHANGE_REQUEST_PATH);
  return link === null ? null : { ...link, authority: url.host.toLowerCase() };
}

/** A private repository's file, which only a request with the server's token can read. */
function mediaUrl(url: URL): SourceControlMediaUrl | null {
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const path = url.searchParams.get("path");
  if (url.username || url.password || !path || !RAW_PATH.test(url.pathname)) return null;
  const ref = url.searchParams.get("ref") ?? "";
  const fetchUrl = new URL(`${url.origin}${url.pathname}`);
  if (ref !== "") fetchUrl.searchParams.set("ref", ref);
  fetchUrl.searchParams.set("path", path);
  const name =
    path
      .split("/")
      .pop()
      ?.replace(/[\p{Cc}\\]/gu, "") ?? "";
  return {
    fetchUrl: fetchUrl.toString(),
    fileName: name || "gice-media",
    // A branch or tag can move; a file is fixed only when read at a full commit SHA.
    ...(FULL_COMMIT_SHA.test(ref) ? { immutable: true as const } : {}),
  };
}

function rawFileUrl(input: {
  readonly repositoryUrl: string;
  readonly sha: string;
  readonly path: string;
}): string | null {
  const repository = URL.parse(input.repositoryUrl);
  const segments = repository?.pathname.split("/").filter((segment) => segment !== "") ?? [];
  const [owner, name] = segments.slice(-2);
  if (repository === null || owner === undefined || name === undefined) return null;
  if (!FULL_COMMIT_SHA.test(input.sha)) return null;
  const url = new URL(
    `${repository.origin}/${[...segments.slice(0, -2), "api/v1/repos", owner, name, "raw"].join("/")}`,
  );
  url.searchParams.set("ref", input.sha);
  url.searchParams.set("path", input.path);
  return mediaUrl(url) === null ? null : url.toString();
}

export const settings = makeProviderSettingsSchema(hostCredentialSettingsFields);

export const definition = defineSourceControl({
  kind: KIND,
  label: "Gice",
  pickerLabel: "Gice",
  icon,
  credentials: {
    cliName: "gice",
    cliLabel: "Gice CLI",
    loginCommand: "gice auth login --host <server-url> --username <username>",
    tokenEnvVar: "GICE_TOKEN",
    tokenAccess: "repo:write, issues:write, and workflows:write scopes",
    // The page names the new token; the user still creates it.
    newTokenUrl: (address) =>
      `${parseGiceServer(address)?.baseUrl ?? `https://${address}`}/settings/tokens?name=T3%20Code`,
  },
  changeRequest: {
    shortLabel: "PR",
    shortLabelWithArticle: "a PR",
    singular: "pull request",
    plural: "pull requests",
  },
  repositoryPathHint: "owner/repo",
  publicHost: null,
  publishDescription: "Your signed-in server",
  publishHost: (signedInHost) => signedInHost ?? "your server",
  newRepositoryOwner: (account) => (account ? { owner: account } : null),
  defaultCloneTransport: "ssh",
  changeRequestUrl: ({ host, repository, number, remoteUrl, webUrl }) =>
    webUrl
      ? changeRequestUrlBelow(webUrl, `pulls/${number}`)
      : `${remoteWebOrigin(host, remoteUrl)}/${repository}/pulls/${number}`,
  // `/pulls/` is Forgejo's shape on any hostname, so only a host named after Gice, or one the
  // caller knows is Gice, claims it.
  parseChangeRequestUrl,
  parseIssueUrl: (url, known) =>
    known || isGiceHost(url.hostname) ? parseIssuePath(url, ISSUE_PATH) : null,
  commitUrl: (input) => buildCommitUrl(input, "commit"),
  parseCommitUrl: (url, known) =>
    known || isGiceHost(url.hostname) ? parseCommitPath(url, COMMIT_PATH) : null,
  repositoryUrlFromPage: (url, known) =>
    known || isGiceHost(url.hostname) ? repositoryUrlFromPagePath(url, REPOSITORY_PAGE_PATH) : null,
  // `#12` names a pull request or an issue alike, and its issue route answers for either.
  changeRequestUrlFromReferenceAutolink: (url) => {
    const match = isGiceHost(url.hostname) ? ISSUE_PATH.exec(url.pathname) : null;
    if (match?.[1] === undefined || match[2] === undefined) return null;
    const candidate = new URL(url);
    candidate.pathname = `/${match[1]}/pulls/${match[2]}`;
    return candidate.toString();
  },
  changeRequestActions: new Set([
    "merge",
    "ready",
    "draft",
    "close",
    "reopen",
    "delete-branch",
    "update-branch",
    "enable-auto-merge",
    "disable-auto-merge",
    "revert",
  ] as const),
  changeRequestListScope: "host",
  checkoutCommand: ({ number }) => `gice pr checkout ${number}`,
  changeRequestCloseCommand: /\bgice\s+(?:pr|pull)\s+(?:merge|close)\b/u,
  changeRequestCreateCommand: /\bgice\s+(?:pr|pull)\s+create\b/u,
  changeRequestListCommand: /\bgice\s+(?:(?:pr|pull)\s+list|api)\b/u,
  authorProfileUrl: (login, repositoryUrl) =>
    new URL(`/${encodeURIComponent(login)}`, repositoryUrl).toString(),
  referenceAutolinks: giceReferenceAutolinks,
  hardLineBreaks: true,
  changeRequestChecksUrl: (changeRequestUrl) => `${changeRequestUrl.replace(/\/+$/u, "")}/checks`,
  reviewSummaryRequired: (verdict) => verdict === "request-changes",
  checkoutCommandArgument: (input) => CHECKOUT_COMMAND.exec(input)?.[1]?.trim() ?? null,
  isChangeRequestReference: (url) => parsePullRequestUrl(url) !== null,
  checkoutChangeRequestHost: () => null,
  changeRequestHeadRef: (number) => `refs/pull/${number}/head`,
  recognizedNameFixesUrls: true,
  recognizeRemote: ({ remoteUrl, host, hostname }) =>
    isGiceHost(hostname)
      ? {
          kind: KIND,
          name: "Gice",
          baseUrl: /^https?:/iu.test(remoteUrl) ? new URL(remoteUrl).origin : `https://${host}`,
        }
      : null,
  // A server's identity includes its port.
  changeRequestHost: (identity) => serverChangeRequestHost(identity, KIND),
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(serverChangeRequestHost(identity, KIND), identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(serverChangeRequestHost(identity, KIND), identity, link),
  mediaUrl,
  rawFileUrl,
  settings,
});

function parsePullRequestUrl(value: string) {
  const url = URL.parse(value);
  return url === null ? null : parseChangeRequestUrl(url);
}
