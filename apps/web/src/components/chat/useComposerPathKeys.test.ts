import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { type RenderedPathMenu, resolvePathMenuKey } from "./useComposerPathKeys";
import type { PathEntryItem, PathMentionTarget } from "./useComposerPathMention";

const target = (query: string, cwd = "/work/a"): PathMentionTarget => ({
  environmentId: EnvironmentId.make("environment-a"),
  cwd,
  query,
});
const live = target;
const row = (source: PathMentionTarget, name = "README.md"): PathEntryItem => ({
  id: `path-entry:${name}`,
  type: "path-entry",
  path: name,
  pathKind: "file",
  opensQuery: null,
  source,
  stale: false,
  label: name,
  labelMatches: null,
  description: "",
});
const menu = (overrides: Partial<RenderedPathMenu>): RenderedPathMenu => ({
  target: null,
  settled: true,
  item: null,
  folder: null,
  prose: false,
  ...overrides,
});

describe("resolvePathMenuKey", () => {
  it("chooses a row that answers the query in the editor", () => {
    const item = row(target("readme"));
    expect(
      resolvePathMenuKey("choose", live("readme"), menu({ target: target("readme"), item })),
    ).toEqual({ type: "select", item });
  });

  it("never chooses a row that answered another project, even for the same text", () => {
    const fromOtherProject = row(target("readme", "/work/b"));
    expect(
      resolvePathMenuKey(
        "choose",
        live("readme"),
        menu({ target: target("readme"), settled: false, item: fromOtherProject }),
      ),
    ).toEqual({ type: "wait" });
  });

  it("holds a key pressed before the rows for the typed query have landed", () => {
    const leftover = row(target("read"));
    // Still debouncing: the menu shows the previous query's rows.
    expect(
      resolvePathMenuKey(
        "choose",
        live("readme"),
        menu({ target: target("readme"), settled: false, item: leftover }),
      ),
    ).toEqual({ type: "wait" });
    // Typed past what was last rendered.
    expect(
      resolvePathMenuKey(
        "choose",
        live("readme"),
        menu({ target: target("read"), item: leftover }),
      ),
    ).toEqual({ type: "wait" });
    // Nothing rendered yet at all.
    expect(
      resolvePathMenuKey("choose", live("src/"), menu({ target: target("src/"), settled: false })),
    ).toEqual({ type: "wait" });
  });

  it("swallows Enter on a missing or unreadable folder instead of sending", () => {
    expect(
      resolvePathMenuKey("choose", live("~/gone/"), menu({ target: target("~/gone/") })),
    ).toEqual({ type: "ignore" });
  });

  it("mentions an empty folder on Enter, the one thing there is to choose", () => {
    const folder = row(target("empty/"), "empty");
    expect(
      resolvePathMenuKey("choose", live("empty/"), menu({ target: target("empty/"), folder })),
    ).toEqual({ type: "select", item: folder });
  });

  it("leaves Enter to send once a query with no rows reads as prose", () => {
    const prose = menu({ target: target("types/node"), prose: true });
    expect(resolvePathMenuKey("choose", live("types/node"), prose)).toEqual({ type: "pass" });
    // Not before the lookup that decides it has come back.
    expect(resolvePathMenuKey("choose", live("types/node"), { ...prose, settled: false })).toEqual({
      type: "wait",
    });
  });

  it("chooses rows of other kinds right away", () => {
    const thread = { id: "thread:1", type: "thread" } as ComposerCommandItem;
    expect(
      resolvePathMenuKey(
        "choose",
        live("deploy"),
        menu({ target: target("dep"), settled: false, item: thread }),
      ),
    ).toEqual({ type: "select", item: thread });
  });

  it("mentions the browsed folder on Space only right after its slash", () => {
    const folder = row(target("src/"), "src");
    const shown = menu({ target: target("src/"), folder });
    expect(resolvePathMenuKey("space", live("src/"), shown)).toEqual({
      type: "select",
      item: folder,
    });
    expect(
      resolvePathMenuKey("space", live("src/"), menu({ target: target("src/"), settled: false })),
    ).toEqual({ type: "wait" });
    // The listing came back without the folder: Space is an ordinary space.
    expect(resolvePathMenuKey("space", live("gone/"), menu({ target: target("gone/") }))).toEqual({
      type: "pass",
    });
    expect(resolvePathMenuKey("space", live("src/comp"), shown)).toEqual({ type: "pass" });
    expect(resolvePathMenuKey("space", live("readme"), shown)).toEqual({ type: "pass" });
  });
});
