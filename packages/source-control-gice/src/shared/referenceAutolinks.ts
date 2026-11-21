import type { ReferenceAutolink } from "@t3tools/source-control-core/shared/definition";

// Gice links `#12` to the issue or pull request of that number in the same repository; the two
// share one sequence and the issue route answers for both.
const REFERENCE = /(?<![\w./\\#-])#([1-9]\d*)(?![\w])/gu;

export function giceReferenceAutolinks(
  text: string,
  repositoryUrl: string,
): ReadonlyArray<ReferenceAutolink> {
  if (!text.includes("#")) return [];
  const url = URL.parse(repositoryUrl);
  if (url === null || !/^https?:$/u.test(url.protocol)) return [];
  const repository = url.href.replace(/\/+$/u, "");
  return Array.from(text.matchAll(REFERENCE), (match) => ({
    index: match.index,
    text: match[0],
    label: match[0],
    url: `${repository}/issues/${match[1]}`,
    kind: "reference" as const,
  }));
}
