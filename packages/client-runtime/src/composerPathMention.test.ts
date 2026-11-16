import { describe, expect, it } from "vite-plus/test";

import {
  composerBrowsePartialPath,
  composerMentionPath,
  composerPathQueryInside,
  formatComposerPathToken,
  matchedTextRanges,
  orderComposerMentionItems,
  orderSearchMatchesByName,
  parseComposerPathQuery,
  rankComposerBrowseEntries,
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
    entry(".env", "file"),
    entry(".github", "directory"),
    entry("README.md", "file"),
    entry("my-components", "directory"),
    entry("compose.yaml", "file"),
    entry("components", "directory"),
    entry("docs", "directory"),
  ];
  const names = (fragment: string) =>
    rankComposerBrowseEntries(entries, fragment).map((candidate) => candidate.name);

  it("lists folders before files and leaves dotfiles out until asked", () => {
    expect(names("")).toEqual(["my-components", "components", "docs", "README.md", "compose.yaml"]);
  });

  it("puts prefix matches first, folders leading each tier, then looser matches", () => {
    expect(names("comp")).toEqual(["components", "compose.yaml", "my-components"]);
    expect(names("cmpn")).toEqual(["components", "my-components"]);
  });

  it("lists only dotfiles for a fragment that starts with a dot", () => {
    expect(names(".")).toEqual([".github", ".env"]);
    expect(names(".e")).toEqual([".env"]);
  });

  it("treats an entry without a kind, from an older server, as a folder", () => {
    const legacy = [{ name: "src", fullPath: "/work/app/src" }, entry("a.ts", "file")];
    expect(rankComposerBrowseEntries(legacy, "").map((candidate) => candidate.name)).toEqual([
      "src",
      "a.ts",
    ]);
  });
});

describe("orderSearchMatchesByName", () => {
  it("lifts matches in the file name above matches along the path", () => {
    const paths = ["docs/readme/intro.md", "src/thread.ts", "README.md", "src/unrelated.ts"];
    const ordered = orderSearchMatchesByName(
      paths.map((path) => ({ path })),
      "read",
    );
    expect(ordered.map((match) => match.path)).toEqual([
      "README.md",
      "src/thread.ts",
      "docs/readme/intro.md",
      "src/unrelated.ts",
    ]);
  });
});

describe("matchedTextRanges", () => {
  it.each([
    ["README.md", "read", [{ start: 0, end: 4 }]],
    ["Button.tsx", "TON", [{ start: 3, end: 6 }]],
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
  ])("finds %j in %j", (text, query, ranges) => {
    expect(matchedTextRanges(text, query)).toEqual(ranges);
  });
});

describe("orderComposerMentionItems", () => {
  it("keeps the best files on top, then other matches, then the remaining files", () => {
    const files = ["f1", "f2", "f3", "f4", "f5", "f6"];
    expect(orderComposerMentionItems(files, ["thread", "model"])).toEqual([
      "f1",
      "f2",
      "f3",
      "f4",
      "thread",
      "model",
      "f5",
      "f6",
    ]);
    expect(orderComposerMentionItems(files, [])).toEqual(files);
  });
});
