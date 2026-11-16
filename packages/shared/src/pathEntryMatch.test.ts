import { describe, expect, it } from "vite-plus/test";

import { entryNameMatchRanges, rankPathEntries } from "./pathEntryMatch.ts";

describe("rankPathEntries", () => {
  const entries = ["z-components.ts", "compose.yaml", ".compat", "Components", "docs", "café"].map(
    (name) => ({ name }),
  );
  const names = (fragment: string) => rankPathEntries(entries, fragment).map((entry) => entry.name);

  it("orders by match tier and then by name, whatever the case", () => {
    expect(names("comp")).toEqual(["Components", "compose.yaml", "z-components.ts"]);
    expect(names("cs")).toEqual(["docs", "Components", "compose.yaml", "z-components.ts"]);
  });

  it("keeps dotfiles for a fragment that starts with a dot, and only then", () => {
    expect(names("")).toEqual(["café", "Components", "compose.yaml", "docs", "z-components.ts"]);
    expect(names(".")).toEqual([".compat"]);
    expect(names(".comp")).toEqual([".compat"]);
  });

  it("matches a composed fragment against a decomposed name", () => {
    expect(rankPathEntries([{ name: "café" }], "café")).toHaveLength(1);
  });
});

describe("entryNameMatchRanges", () => {
  it.each([
    ["README.md", "read", [{ start: 0, end: 4 }]],
    ["Button.tsx", "TON", [{ start: 3, end: 6 }]],
    // The word start is what ranked this name, not the earlier occurrence inside `thread`.
    ["thread-reader.ts", "read", [{ start: 7, end: 11 }]],
    [
      "ButtonGroup.tsx",
      "bgx",
      [
        { start: 0, end: 1 },
        { start: 6, end: 7 },
        { start: 14, end: 15 },
      ],
    ],
    ["index.ts", "zz", []],
    ["index.ts", "", []],
  ])("finds in %j what %j matched", (name, query, ranges) => {
    expect(entryNameMatchRanges(name, query)).toEqual(ranges);
  });

  // macOS stores `é` as `e` plus a combining accent; typed text holds the one composed character.
  const decomposed = "re\u0301sume\u0301.pdf";

  it("emphasises a decomposed name's whole accented letters for a composed query", () => {
    expect(entryNameMatchRanges(decomposed, "r\u00e9s")).toEqual([{ start: 0, end: 4 }]);
    expect(entryNameMatchRanges(decomposed, "m\u00e9")).toEqual([{ start: 5, end: 8 }]);
    // Scattered letters: each range covers its letter's accent.
    expect(entryNameMatchRanges(decomposed, "\u00e9\u00e9")).toEqual([
      { start: 1, end: 3 },
      { start: 6, end: 8 },
    ]);
  });

  it("still reads the name as stored first", () => {
    expect(entryNameMatchRanges(decomposed, "re")).toEqual([{ start: 0, end: 2 }]);
    expect(entryNameMatchRanges("r\u00e9sum\u00e9.pdf", "r\u00e9s")).toEqual([
      { start: 0, end: 3 },
    ]);
  });
});
