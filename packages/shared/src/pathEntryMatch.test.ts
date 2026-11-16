import { describe, expect, it } from "vite-plus/test";

import { rankPathEntries } from "./pathEntryMatch.ts";

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
