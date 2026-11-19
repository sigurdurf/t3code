import { recognizeRemoteWith } from "@t3tools/source-control-core/shared/definition";
import { describe, expect, it } from "vite-plus/test";

import { definition, parsePullRequestUrlOnKnownHost } from "./definition.ts";

const parse = (url: string) => definition.parseChangeRequestUrl(new URL(url));

describe("Gice change request URLs", () => {
  it("reads a pull request and its tabs on a host named after Gice", () => {
    for (const tab of ["", "/", "/commits", "/files?revision=2#diff"]) {
      const url = `https://gice.sed.is/Gice/Gice/pulls/12${tab}`;
      expect(parse(url), url).toEqual({
        host: "gice.sed.is",
        repository: "gice/gice",
        number: 12,
        repositoryUrl: "https://gice.sed.is/Gice/Gice",
      });
      expect(definition.isChangeRequestReference(url), url).toBe(true);
    }
    expect(parse("http://gice.localhost:3000/a/b/pulls/3")).toMatchObject({
      host: "gice.localhost",
      authority: "gice.localhost:3000",
    });
  });

  it("leaves Forgejo's identical route on other hosts, and other routes, alone", () => {
    for (const url of [
      "https://codeberg.org/team/repo/pulls/7",
      "https://gice.evil.test.example/pulls/7",
      "https://notgice.example/team/repo/pulls/7",
      "https://gice.sed.is/team/repo/pull/7",
      "https://gice.sed.is/team/repo/issues/7",
      "https://gice.sed.is/team/repo/pulls/0",
      "https://gice.sed.is/team/repo/pulls",
    ]) {
      expect(parse(url), url).toBeNull();
      expect(definition.isChangeRequestReference(url), url).toBe(false);
    }
    // The server knows a host by its credential, so it reads the route whatever the name.
    expect(parsePullRequestUrlOnKnownHost("https://code.example:8443/a/b/pulls/7")).toMatchObject({
      host: "code.example",
      authority: "code.example:8443",
      repository: "a/b",
      number: 7,
    });
  });

  it("builds pull request URLs on the web origin, which an SSH remote does not name", () => {
    const input = { host: "gice.sed.is", repository: "gice/gice", number: 8 };
    expect(
      definition.changeRequestUrl({
        ...input,
        remoteUrl: "ssh://git@gice.sed.is:2222/gice/gice.git",
      }),
    ).toBe("https://gice.sed.is/gice/gice/pulls/8");
    expect(
      definition.changeRequestUrl({
        host: "gice.localhost",
        repository: "a/b",
        number: 8,
        remoteUrl: "http://gice.localhost:3000/a/b.git",
      }),
    ).toBe("http://gice.localhost:3000/a/b/pulls/8");
    expect(
      definition.changeRequestUrl({ ...input, webUrl: "https://gice.sed.is/Gice/Gice/" }),
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
