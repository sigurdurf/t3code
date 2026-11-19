import {
  makeProviderSettingsSchema,
  SettingsSecretValue,
  SourceControlProviderKind,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  buildCommitUrl,
  changeRequestUrlBelow,
  defineSourceControl,
  isChangeRequestInProjectRepository,
  isChangeRequestOnProjectHost,
  parseChangeRequestPath,
  parseCommitPath,
  projectChangeRequestHost,
  remoteWebOrigin,
  repositoryUrlFromPagePath,
} from "@t3tools/source-control-core/shared/definition";
import { icon } from "./icon.ts";

const CHECKOUT_COMMAND = /^gice\s+(?:pr|pull)\s+checkout\s+(.+)$/i;

const CHANGE_REQUEST_PATH = /^\/([^/]+\/[^/]+)\/pulls\/(\d+)(?:\/|$)/u;
const COMMIT_PATH = /^\/([^/]+\/[^/]+)\/commit\/([0-9a-f]+)\/?$/iu;
// Gice names the ref and path of a tree or blob page in its query string.
const REPOSITORY_PAGE_PATH = /^\/([^/]+\/[^/]+)\/(?:tree|blob|commits|branches)\/?$/u;

const KIND = SourceControlProviderKind.make("gice");

/**
 * Gice runs on any hostname, and only a server the user signed in to is known to be one. A name
 * with a `gice` label is the one thing a client can tell without asking the server.
 */
function isGiceHost(hostname: string): boolean {
  return hostname.toLowerCase().split(".").includes("gice");
}

function parsePullRequestPath(url: URL) {
  const link = parseChangeRequestPath(url, CHANGE_REQUEST_PATH);
  if (link === null) return null;
  return url.port ? { ...link, authority: url.host.toLowerCase() } : link;
}

function parseChangeRequestUrl(url: URL) {
  return isGiceHost(url.hostname) ? parsePullRequestPath(url) : null;
}

export const settings = makeProviderSettingsSchema(
  {
    host: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Server",
        description:
          "Your Gice server's address. Left empty, GICE_HOST or the server the gice CLI is signed in to is used.",
        providerSettingsForm: { placeholder: "gice.example.com", clearWhenEmpty: "omit" },
      }),
    ),
    token: SettingsSecretValue.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Token",
        description:
          "A Gice access token for that server, used before GICE_TOKEN and the gice login, so Gice works without the CLI signed in.",
        providerSettingsForm: { control: "password" },
      }),
    ),
  },
  { order: ["host", "token"] },
);
export type GiceSettings = typeof settings.Type;

export const definition = defineSourceControl({
  kind: KIND,
  label: "Gice",
  pickerLabel: "Gice",
  icon,
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
  // `/pulls/` is Forgejo's shape on any hostname, so only a host named after Gice claims it.
  parseChangeRequestUrl,
  commitUrl: (input) => buildCommitUrl(input, "commit"),
  parseCommitUrl: (url, known) =>
    known || isGiceHost(url.hostname) ? parseCommitPath(url, COMMIT_PATH) : null,
  repositoryUrlFromPage: (url, known) =>
    known || isGiceHost(url.hostname) ? repositoryUrlFromPagePath(url, REPOSITORY_PAGE_PATH) : null,
  changeRequestUrlFromReferenceAutolink: () => null,
  // A server that predates one of these says so, and its pull requests leave the action out.
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
  ] as const),
  checkoutCommand: ({ number }) => `gice pr checkout ${number}`,
  changeRequestCloseCommand: /\bgice\s+(?:pr|pull)\s+(?:merge|close)\b/u,
  authorProfileUrl: (login, repositoryUrl) =>
    new URL(`/${encodeURIComponent(login)}`, repositoryUrl).toString(),
  hardLineBreaks: true,
  reviewSummaryRequired: (verdict) => verdict === "request-changes",
  checkoutCommandArgument: (input) => CHECKOUT_COMMAND.exec(input)?.[1]?.trim() ?? null,
  isChangeRequestReference: (url) => parsePullRequestUrl(url) !== null,
  checkoutChangeRequestHost: () => null,
  changeRequestHeadRef: (number) => `refs/pull/${number}/head`,
  recognizeRemote: ({ remoteUrl, host, hostname }) =>
    isGiceHost(hostname)
      ? {
          kind: KIND,
          name: "Gice",
          baseUrl: /^https?:/iu.test(remoteUrl) ? new URL(remoteUrl).origin : `https://${host}`,
        }
      : null,
  isChangeRequestInRepository: (identity, link) =>
    isChangeRequestInProjectRepository(projectChangeRequestHost(identity, KIND), identity, link),
  canReadChangeRequestOnHost: (identity, link) =>
    isChangeRequestOnProjectHost(projectChangeRequestHost(identity, KIND), identity, link),
  settings,
});

function parsePullRequestUrl(value: string) {
  const url = URL.parse(value);
  return url === null ? null : parseChangeRequestUrl(url);
}

/** For a caller that already knows the URL's host is a Gice server, whatever its name. */
export function parsePullRequestUrlOnKnownHost(value: string) {
  const url = URL.parse(value);
  return url === null ? null : parsePullRequestPath(url);
}
