import { recognizeRemoteWith } from "@t3tools/source-control-core/shared/definition";
import { describe, expect, it } from "vite-plus/test";

import { definition, parseGiceServer } from "./definition.ts";

const parse = (url: string) => definition.parseChangeRequestUrl(new URL(url));

describe("Gice change request URLs", () => {
  it.each(["", "/", "/commits", "/files?revision=2#diff"])(
    "reads a pull request's tab %o on a host named after Gice",
    (tab) => {
      const url = `https://gice.sed.is/Gice/Gice/pulls/12${tab}`;
      expect(parse(url)).toEqual({
        host: "gice.sed.is",
        authority: "gice.sed.is",
        repository: "gice/gice",
        number: 12,
        repositoryUrl: "https://gice.sed.is/Gice/Gice",
      });
      expect(definition.isChangeRequestReference(url)).toBe(true);
    },
  );

  it("keeps the port of a pull request's server", () => {
    expect(parse("http://gice.localhost:3000/a/b/pulls/3")).toMatchObject({
      host: "gice.localhost",
      authority: "gice.localhost:3000",
    });
    // A repository key drops the port, so a project on that server names it from its remote.
    const project = {
      canonicalKey: "code.example/a/b",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "http://code.example:3000/a/b.git",
      },
      displayName: "a/b",
    };
    expect(definition.changeRequestHost?.(project)).toBe("code.example:3000");
    expect(
      definition.canReadChangeRequestOnHost?.(project, {
        host: "code.example",
        authority: "code.example:3000",
        repository: "a/b",
        number: 3,
      }),
    ).toBe(true);
  });

  it.each([
    "https://codeberg.org/team/repo/pulls/7",
    "https://gice.evil.test.example/pulls/7",
    "https://notgice.example/team/repo/pulls/7",
    "https://gice.sed.is/team/repo/pull/7",
    "https://gice.sed.is/team/repo/issues/7",
    "https://gice.sed.is/team/repo/pulls/0",
    "https://gice.sed.is/team/repo/pulls",
  ])("leaves %s alone", (url) => {
    expect(parse(url)).toBeNull();
    expect(definition.isChangeRequestReference(url)).toBe(false);
  });

  // The server knows a host by its credential, so it reads the route whatever the name.
  it("reads Forgejo's identical route on a host the caller knows is Gice", () => {
    expect(
      definition.parseChangeRequestUrl(new URL("https://code.example:8443/a/b/pulls/7"), true),
    ).toMatchObject({
      host: "code.example",
      authority: "code.example:8443",
      repository: "a/b",
      number: 7,
    });
  });

  const sha = "a".repeat(40);
  const commit = (url: string, known = false) => definition.parseCommitUrl(new URL(url), known);

  it("reads a commit URL on a Gice host, or any host a project vouches for", () => {
    expect(commit(`https://gice.sed.is/Gice/Gice/commit/${sha}`)).toEqual({
      host: "gice.sed.is",
      repository: "gice/gice",
      sha,
    });
    expect(commit(`https://code.example/a/b/commit/${sha}`)).toBeNull();
    expect(commit(`https://code.example/a/b/commit/${sha}`, true)).toMatchObject({ sha });
  });

  it("builds a commit URL on the web origin of an SSH remote", () => {
    expect(
      definition.commitUrl({
        host: "gice.sed.is",
        repository: "gice/gice",
        sha,
        remoteUrl: "ssh://git@gice.sed.is:2222/gice/gice.git",
      }),
    ).toBe(`https://gice.sed.is/gice/gice/commit/${sha}`);
  });

  it.each([
    ["ssh://git@gice.sed.is:2222/gice/gice.git", "https://gice.sed.is/gice/gice/pulls/8"],
    ["http://gice.sed.is:3000/gice/gice.git", "http://gice.sed.is:3000/gice/gice/pulls/8"],
  ])("builds a pull request URL on the web origin of remote %s", (remoteUrl, url) => {
    expect(
      definition.changeRequestUrl({
        host: "gice.sed.is",
        repository: "gice/gice",
        number: 8,
        remoteUrl,
      }),
    ).toBe(url);
  });

  it("builds a pull request URL below the repository's own web address", () => {
    expect(
      definition.changeRequestUrl({
        host: "gice.sed.is",
        repository: "gice/gice",
        number: 8,
        webUrl: "https://gice.sed.is/Gice/Gice/",
      }),
    ).toBe("https://gice.sed.is/Gice/Gice/pulls/8");
  });

  it("finds the repository of a page whose ref and path are in the query", () => {
    const page = new URL("https://code.example/a/b/tree?ref=main&path=src");
    expect(definition.repositoryUrlFromPage(page, true)).toBe("https://code.example/a/b");
    expect(definition.repositoryUrlFromPage(page, false)).toBeNull();
    expect(
      definition.repositoryUrlFromPage(new URL("https://gice.sed.is/a/b/blob?path=x"), false),
    ).toBe("https://gice.sed.is/a/b");
  });
});

describe("Gice issue URLs", () => {
  const issue = (url: string, known = false) => definition.parseIssueUrl?.(new URL(url), known);

  it.each([
    "https://gice.sed.is/Gice/Gice/issues/4",
    "https://gice.sed.is/Gice/Gice/issues/4/",
    "https://gice.sed.is/Gice/Gice/issues/4#comment-9",
  ])("reads the issue %s on a Gice host", (url) => {
    expect(issue(url)).toEqual({ host: "gice.sed.is", scope: "gice/gice", key: "4" });
  });

  it("reads an issue on any host a project vouches for", () => {
    expect(issue("https://code.example:8443/a/b/issues/4", true)).toEqual({
      host: "code.example",
      scope: "a/b",
      key: "4",
    });
  });

  it.each([
    "https://code.example/a/b/issues/4",
    "https://gice.sed.is/a/b/issues/0",
    "https://gice.sed.is/a/b/issues",
    "https://gice.sed.is/a/b/pulls/4",
  ])("reads no issue from %s", (url) => {
    expect(issue(url)).toBeNull();
  });
});

describe("Gice remotes", () => {
  it("recognises a host named after Gice and gives its web origin", () => {
    expect(recognizeRemoteWith(definition, "ssh://git@gice.sed.is:2222/gice/gice.git")).toEqual({
      kind: "gice",
      name: "Gice",
      baseUrl: "https://gice.sed.is",
    });
    expect(recognizeRemoteWith(definition, "http://gice.localhost:3000/a/b.git")?.baseUrl).toBe(
      "http://gice.localhost:3000",
    );
    expect(recognizeRemoteWith(definition, "git@code.example:a/b.git")).toBeNull();
    expect(recognizeRemoteWith(definition, "https://service.example/a/b")).toBeNull();
  });
});

describe("Gice media", () => {
  const sha = "a".repeat(40);
  const media = (url: string) => definition.mediaUrl?.(new URL(url)) ?? null;
  const rawFileUrl = (repositoryUrl: string, path: string, revision = sha) =>
    definition.rawFileUrl?.({ repositoryUrl, sha: revision, path }) ?? null;

  it("claims a file read through the raw route on any host, in one spelling", () => {
    expect(
      media(`https://Code.Example/api/v1/repos/a/b/raw?path=docs%2Fshot.png&x=1&ref=${sha}#top`),
    ).toEqual({
      fetchUrl: `https://code.example/api/v1/repos/a/b/raw?ref=${sha}&path=docs%2Fshot.png`,
      fileName: "shot.png",
      immutable: true,
    });
  });

  it("marks a file read at a branch as one that can change", () => {
    expect(media("https://code.example/gice/api/v1/repos/a/b/raw?ref=main&path=a.png")).toEqual({
      fetchUrl: "https://code.example/gice/api/v1/repos/a/b/raw?ref=main&path=a.png",
      fileName: "a.png",
    });
  });

  it.each([
    "https://code.example/api/v1/repos/a/b/raw/docs/a.png",
    "https://code.example/api/v1/repos/a/b/raw",
    "https://code.example/a/b/blob?path=a.png",
    "https://user:pw@code.example/api/v1/repos/a/b/raw?path=a.png",
  ])("leaves %s alone", (url) => {
    expect(media(url)).toBeNull();
  });

  it("builds the raw URL of a file at a commit, below a server's sub-path too", () => {
    const url = rawFileUrl("https://code.example/gice/a/b", "docs/a #1?.png");
    expect(url).toBe(
      `https://code.example/gice/api/v1/repos/a/b/raw?ref=${sha}&path=docs%2Fa+%231%3F.png`,
    );
    expect(media(url ?? "")?.fileName).toBe("a #1?.png");
  });

  it("builds no raw URL for a revision that is not a full commit SHA", () => {
    expect(rawFileUrl("https://code.example/a/b", "a.png", "main")).toBeNull();
  });
});

describe("parseGiceServer", () => {
  it.each([
    ["https://Gice.Example/", "gice.example", "https://gice.example"],
    ["gice.example:8443", "gice.example:8443", "https://gice.example:8443"],
    ["localhost:3000", "localhost:3000", "http://localhost:3000"],
    ["127.0.0.1:3000", "127.0.0.1:3000", "http://127.0.0.1:3000"],
    ["[::1]:3000", "[::1]:3000", "http://[::1]:3000"],
    ["https://example.com/gice/", "example.com", "https://example.com/gice"],
  ] as const)("reads %s the way gice does", (address, host, baseUrl) => {
    expect(parseGiceServer(address)).toEqual({ host, baseUrl });
  });

  it.each([
    undefined,
    " ",
    "ftp://gice.example",
    "https://user:pw@gice.example",
    "https://gice.example/?a=1",
  ])("refuses %s", (address) => {
    expect(parseGiceServer(address)).toBeNull();
  });

  it.each([
    ["gice.example", "https://gice.example/settings/tokens?name=T3%20Code"],
    ["http://git.lan:3000", "http://git.lan:3000/settings/tokens?name=T3%20Code"],
    ["localhost:3000", "http://localhost:3000/settings/tokens?name=T3%20Code"],
    ["https://example.com/gice/", "https://example.com/gice/settings/tokens?name=T3%20Code"],
  ])("links %s to its token page", (address, url) => {
    expect(definition.credentials?.newTokenUrl(address)).toBe(url);
  });
});
