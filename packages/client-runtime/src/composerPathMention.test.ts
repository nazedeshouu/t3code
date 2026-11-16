import { describe, expect, it } from "vite-plus/test";

import {
  composerBrowsePartialPath,
  composerMentionPath,
  composerPathQueryInside,
  formatComposerPathToken,
  isComposerPathMenuHidden,
  isComposerPathQueryProse,
  matchEmphasis,
  orderComposerMentionItems,
  parseComposerPathQuery,
  rankComposerBrowseEntries,
  rankSearchMatches,
} from "./composerPathMention.ts";

describe("parseComposerPathQuery", () => {
  it.each([
    ["readme", { mode: "search", query: "readme" }],
    ["~notes", { mode: "search", query: "~notes" }],
    ["", { mode: "browse", directory: "", fragment: "" }],
    ["src/", { mode: "browse", directory: "src/", fragment: "" }],
    ["src/comp", { mode: "browse", directory: "src/", fragment: "comp" }],
    ["./src/comp", { mode: "browse", directory: "./src/", fragment: "comp" }],
    ["../sibling/", { mode: "browse", directory: "../sibling/", fragment: "" }],
    ["..", { mode: "browse", directory: "../", fragment: "" }],
    ["~", { mode: "browse", directory: "~/", fragment: "" }],
    ["~/thing", { mode: "browse", directory: "~/", fragment: "thing" }],
    ["~/Users/naze/thing", { mode: "browse", directory: "~/Users/naze/", fragment: "thing" }],
    ["/Users/naze/th", { mode: "browse", directory: "/Users/naze/", fragment: "th" }],
    ["/", { mode: "browse", directory: "/", fragment: "" }],
    [".env", { mode: "browse", directory: "", fragment: ".env" }],
    [
      "design notes/color pal",
      { mode: "browse", directory: "design notes/", fragment: "color pal" },
    ],
    ["src/.git", { mode: "browse", directory: "src/", fragment: ".git" }],
  ] as const)("reads %j", (query, expected) => {
    expect(parseComposerPathQuery(query)).toEqual(expected);
  });
});

describe("composerBrowsePartialPath", () => {
  it.each([
    ["", "./"],
    ["src/", "./src/"],
    ["design notes/", "./design notes/"],
    ["./src/", "./src/"],
    ["../sibling/", "../sibling/"],
    ["~/", "~/"],
    ["~/Users/naze/", "~/Users/naze/"],
    ["/Users/naze/", "/Users/naze/"],
    ["C:/Users/", "C:/Users/"],
  ])("anchors %j as %j", (directory, partialPath) => {
    expect(composerBrowsePartialPath(directory)).toBe(partialPath);
  });
});

describe("opening a folder", () => {
  it("extends the typed directory, keeping how the path was written", () => {
    expect(composerPathQueryInside("", "src")).toBe("src/");
    expect(composerPathQueryInside("~/Projects/", "t3code")).toBe("~/Projects/t3code/");
    expect(composerPathQueryInside("../", "design notes")).toBe("../design notes/");
  });

  it("quotes the token only when the path has whitespace", () => {
    expect(formatComposerPathToken("src/components/")).toBe("@src/components/");
    expect(formatComposerPathToken("design notes/")).toBe('@"design notes/');
  });
});

describe("composerMentionPath", () => {
  it.each([
    ["/work/app/src/index.ts", "/work/app", "src/index.ts"],
    ["/work/app/design notes/a b.md", "/work/app/", "design notes/a b.md"],
    ["/work/app-two/index.ts", "/work/app", "/work/app-two/index.ts"],
    ["/Users/naze/thing", "/work/app", "/Users/naze/thing"],
    ["/work/app", "/work/app", "/work/app"],
    ["/Users/naze/thing", null, "/Users/naze/thing"],
    ["C:\\work\\app\\src\\index.ts", "C:\\work\\app", "src/index.ts"],
  ])("mentions %j from %j as %j", (fullPath, cwd, expected) => {
    expect(composerMentionPath(fullPath, cwd)).toBe(expected);
  });
});

describe("rankComposerBrowseEntries", () => {
  const entry = (name: string, kind: "file" | "directory") => ({
    name,
    fullPath: `/work/app/${name}`,
    kind,
  });
  const entries = [
    entry(".prettierrc", "file"),
    entry(".gitignore", "file"),
    entry(".github", "directory"),
    entry(".git", "directory"),
    entry(".env.example", "file"),
    entry("README.md", "file"),
    entry("my-components", "directory"),
    entry("compose.yaml", "file"),
    entry("components", "directory"),
    entry("docs", "directory"),
    entry("notes10.md", "file"),
    entry("notes2.md", "file"),
  ];
  const names = (fragment: string) =>
    rankComposerBrowseEntries(entries, fragment).map((candidate) => candidate.name);

  it("lists folders before files, A to Z, and leaves dotfiles out until asked", () => {
    expect(names("")).toEqual([
      "components",
      "docs",
      "my-components",
      "compose.yaml",
      "notes2.md",
      "notes10.md",
      "README.md",
    ]);
  });

  it("orders a typed fragment by match tier, then A to Z with folders and files together", () => {
    expect(names("comp")).toEqual(["components", "compose.yaml", "my-components"]);
    expect(names("cmpn")).toEqual(["components", "my-components"]);
    expect(names("no")).toEqual(["notes2.md", "notes10.md"]);
  });

  it("lists only dotfiles for a fragment that starts with a dot", () => {
    expect(names(".")).toEqual([".env.example", ".git", ".github", ".gitignore", ".prettierrc"]);
    expect(names(".e")).toEqual([".env.example", ".gitignore", ".prettierrc"]);
  });

  it("treats an entry without a kind, from an older server, as a folder", () => {
    const legacy = [{ name: "src", fullPath: "/work/app/src" }, entry("a.ts", "file")];
    expect(rankComposerBrowseEntries(legacy, "").map((candidate) => candidate.name)).toEqual([
      "src",
      "a.ts",
    ]);
  });
});

describe("rankSearchMatches", () => {
  const rank = (paths: ReadonlyArray<string>, query: string) => {
    const ranked = rankSearchMatches(
      paths.map((path) => ({ path })),
      query,
    );
    return {
      paths: ranked.entries.map((match) => match.path),
      close: ranked.closeNameMatchCount,
      names: ranked.nameMatchCount,
    };
  };

  it("puts name matches first, then loose and path matches, and drops the rest", () => {
    expect(
      rank(
        [
          "design/color palette.md",
          "docs/readme/intro.md",
          "src/thread.ts",
          ".env.example",
          "src/unrelated.ts",
          "README.md",
        ],
        "read",
      ),
    ).toEqual({
      paths: ["src/thread.ts", "README.md", "src/unrelated.ts", "docs/readme/intro.md"],
      close: 2,
      names: 3,
    });
  });

  it("keeps what the search found when nothing matches by name or path", () => {
    expect(rank(["design/typography.md", ".env.example"], "raed")).toEqual({
      paths: ["design/typography.md", ".env.example"],
      close: 0,
      names: 0,
    });
  });
});

describe("matchEmphasis", () => {
  it("emphasises matches when rows match in different places", () => {
    expect(matchEmphasis(["components", "my-components"], "comp")).toEqual([
      [{ start: 0, end: 4 }],
      [{ start: 3, end: 7 }],
    ]);
  });

  it("leaves the list plain when every row only starts with the query", () => {
    expect(matchEmphasis([".env", ".git"], ".")).toEqual([null, null]);
    expect(matchEmphasis(["notes.md", "node_modules"], "no")).toEqual([null, null]);
  });
});

describe("orderComposerMentionItems", () => {
  const files = ["f1", "f2", "f3", "f4", "f5", "f6"];
  const others = ["thread", "model"];
  const matches = (closeNameMatchCount: number, nameMatchCount = closeNameMatchCount) => ({
    closeNameMatchCount,
    nameMatchCount,
  });

  it("leads with at most four name matches, then other mentions, then the remaining files", () => {
    expect(orderComposerMentionItems(files, matches(6), others)).toEqual([
      "f1",
      "f2",
      "f3",
      "f4",
      "thread",
      "model",
      "f5",
      "f6",
    ]);
  });

  it("keeps files that match only loosely or along their path below other mentions", () => {
    expect(orderComposerMentionItems(files, matches(1), others)).toEqual([
      "f1",
      ...others,
      ...files.slice(1),
    ]);
    expect(orderComposerMentionItems(files, matches(0), others)).toEqual([...others, ...files]);
  });

  it("offers nothing for a word that only matches along file paths, which is likely prose", () => {
    expect(orderComposerMentionItems(files, matches(0), [])).toEqual([]);
    // One loose name match is a real candidate, and brings the path matches along.
    expect(orderComposerMentionItems(files, matches(0, 1), [])).toEqual(files);
  });
});

describe("isComposerPathQueryProse", () => {
  it.each([
    // A bare word or quoted words are prose until something matches.
    ["sam", false, "no-match", true],
    ["sam", false, "failed", true],
    ["so-called", true, "no-match", true],
    [".hidden gem", true, "no-match", true],
    // A relative path is prose only when its folder is known to be missing.
    ["types/node", false, "missing-folder", true],
    ["either/or was fine", true, "missing-folder", true],
    ["docs/", false, "no-match", false],
    ["design notes/", true, "no-match", false],
    ["src/zzz", false, "no-match", false],
    // A folder that could not be read may well exist, so its path is not prose.
    ["src/private/", false, "failed", false],
    // A path that says where it starts is a path whatever it finds.
    ["~/nope/", false, "missing-folder", false],
    ["/nope/x", false, "missing-folder", false],
    ["./nope/", false, "missing-folder", false],
    ["../nope/", false, "failed", false],
    // The project root and its dotfiles, unquoted, are always a listing.
    ["", false, "no-match", false],
    [".env", false, "no-match", false],
  ] as const)("reads @%j (quoted: %j, %s) as prose: %j", (query, quoted, miss, prose) => {
    expect(isComposerPathQueryProse(query, quoted, miss)).toBe(prose);
  });
});

describe("isComposerPathMenuHidden", () => {
  it.each([
    // Settled: prose hides the menu, a mention being typed keeps it.
    ["sam", "no-match", false, true],
    ["types/node", "missing-folder", false, true],
    ["docs/", "no-match", true, false],
    ["~/nope/", "missing-folder", true, false],
    // A lookup that failed always says so, prose or not.
    ["sam", "failed", true, false],
    ["src/private/", "failed", true, false],
    // Pending: the menu stays as it was for the previous query.
    ["src/", "pending", false, false],
    ["src", "pending", false, false],
    ["types/", "pending", true, true],
    ["~/Library/", "pending", true, true],
    // Pending with no previous query: only what must be a path opens the menu.
    ["", "pending", null, false],
    ["~/Library/", "pending", null, false],
    ["types/node", "pending", null, true],
    ["sam", "pending", null, true],
  ] as const)("@%j (%s, was hidden: %j) is hidden: %j", (query, miss, wasHidden, hidden) => {
    expect(isComposerPathMenuHidden(query, false, miss, wasHidden)).toBe(hidden);
  });
});
