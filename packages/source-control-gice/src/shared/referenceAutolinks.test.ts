import { describe, expect, it } from "vite-plus/test";

import { definition } from "./definition.ts";
import { giceReferenceAutolinks } from "./referenceAutolinks.ts";

const linked = (text: string, repositoryUrl = "https://git.example.com/team/repo") =>
  giceReferenceAutolinks(text, repositoryUrl).map(({ index, label, url }) => [index, label, url]);

describe("giceReferenceAutolinks", () => {
  it("links #N in the same repository, below the server's base path too", () => {
    expect(linked("Closes #12, see (#3).")).toEqual([
      [7, "#12", "https://git.example.com/team/repo/issues/12"],
      [17, "#3", "https://git.example.com/team/repo/issues/3"],
    ]);
    expect(linked("#4", "http://example.com:3000/gice/team/repo/")).toEqual([
      [0, "#4", "http://example.com:3000/gice/team/repo/issues/4"],
    ]);
  });

  it.each(["other#4", "team/repo#4", "##4", "#0", "#12a", "a/#4", "https://x.test/#4"])(
    "leaves %s alone",
    (text) => {
      expect(linked(text)).toEqual([]);
    },
  );

  it("offers the pull request a #N on a Gice-named or known Gice server may name", () => {
    const candidate = (url: string, known = false) =>
      definition.changeRequestUrlFromReferenceAutolink(new URL(url), known);
    expect(candidate("https://gice.example.com/team/repo/issues/12")).toBe(
      "https://gice.example.com/team/repo/pulls/12",
    );
    expect(candidate("https://git.example.com/team/repo/issues/12")).toBeNull();
    expect(candidate("https://git.example.com/team/repo/issues/12", true)).toBe(
      "https://git.example.com/team/repo/pulls/12",
    );
    expect(candidate("https://github.com/team/repo/issues/12")).toBeNull();
  });
});
