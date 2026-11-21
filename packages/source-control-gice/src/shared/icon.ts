import type { SourceControlIcon } from "@t3tools/source-control-core/shared/definition";

const node = (cx: number, cy: number, r: number) =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;

export const icon: SourceControlIcon = {
  viewBox: "0 0 64 64",
  paths: [
    {
      d: "M32 3 57.1 17.5v29L32 61 6.9 46.5v-29z",
      fill: "#ea580c",
      stroke: "#ea580c",
      strokeWidth: 4,
    },
    { d: "M32 32 57.1 17.5v29L32 61z", fill: "#c2410c", stroke: "#c2410c", strokeWidth: 4 },
    { d: "M32 3 57.1 17.5 32 32 6.9 17.5z", fill: "#f97316", stroke: "#f97316", strokeWidth: 4 },
    { d: "M32 48V32M32 32 17.3 23.5M32 32l14.7-8.5", stroke: "#fff", strokeWidth: 6 },
    // Stands in for the artwork's round line caps, which an icon path cannot carry.
    { d: node(32, 32, 3), fill: "#fff" },
    { d: node(32, 48, 5.5), fill: "#fff" },
    { d: node(17.3, 23.5, 5.5), fill: "#fff" },
    { d: node(46.7, 23.5, 5.5), fill: "#fff" },
  ],
};
