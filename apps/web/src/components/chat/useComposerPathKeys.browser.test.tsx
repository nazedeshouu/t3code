import { EnvironmentId } from "@t3tools/contracts";
import { useLayoutEffect } from "react";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import {
  type PathMenuKey,
  type RenderedPathMenu,
  useComposerPathKeys,
} from "./useComposerPathKeys";
import type { PathMentionTarget } from "./useComposerPathMention";

const target = (query: string): PathMentionTarget => ({
  environmentId: EnvironmentId.make("environment-a"),
  cwd: "/work/a",
  query,
});
const loading = (query: string): RenderedPathMenu => ({
  target: target(query),
  settled: false,
  item: null,
  folder: null,
  prose: false,
});

/** Mounts the hook with the editor on `@{query}` and hands back its key handler. */
function mountPathKeys(query: string) {
  const live: { current: PathMentionTarget | null } = { current: target(query) };
  const select = vi.fn();
  const handler: { current: (key: PathMenuKey, whenUnclaimed: () => void) => boolean } = {
    current: () => false,
  };
  function PathKeys({
    menu,
    draftKey = "draft-a",
  }: {
    readonly menu: RenderedPathMenu;
    readonly draftKey?: string;
  }) {
    const onKey = useComposerPathKeys({
      draftKey,
      menu,
      readLiveQuery: () => live.current,
      select,
    });
    useLayoutEffect(() => {
      handler.current = onKey;
    });
    return null;
  }
  return {
    live,
    select,
    press: (key: PathMenuKey, whenUnclaimed: () => void) => handler.current(key, whenUnclaimed),
    Menu: PathKeys,
  };
}

it("an Enter pressed ahead of the search sends once the word turns out to be prose", async () => {
  const keys = mountPathKeys("sam");
  const send = vi.fn();
  await using screen = await render(<keys.Menu menu={loading("sam")} />, { router: false });

  // The menu holds the key while its rows are on their way, so the editor must not act on it.
  expect(keys.press("choose", send)).toBe(true);
  expect(send).not.toHaveBeenCalled();

  await screen.rerender(<keys.Menu menu={{ ...loading("sam"), settled: true, prose: true }} />);
  expect(send).toHaveBeenCalledTimes(1);
  expect(keys.select).not.toHaveBeenCalled();

  // The key ran; later renders do not run it again.
  await screen.rerender(<keys.Menu menu={{ ...loading("sam"), settled: true, prose: true }} />);
  expect(send).toHaveBeenCalledTimes(1);
});

it("a held key that finds a row chooses it and never falls through to sending", async () => {
  const keys = mountPathKeys("readme");
  const send = vi.fn();
  await using screen = await render(<keys.Menu menu={loading("readme")} />, { router: false });
  keys.press("choose", send);

  const item = {
    id: "path-entry:README.md",
    type: "path-entry",
    path: "README.md",
    pathKind: "file",
    opensQuery: null,
    source: target("readme"),
    stale: false,
    label: "README.md",
    labelMatches: null,
    description: "",
  } as const;
  await screen.rerender(<keys.Menu menu={{ ...loading("readme"), settled: true, item }} />);
  expect(keys.select).toHaveBeenCalledExactlyOnceWith(item);
  expect(send).not.toHaveBeenCalled();
});

it("editing the query or leaving it drops a held Enter", async () => {
  const keys = mountPathKeys("sam");
  const send = vi.fn();
  await using screen = await render(<keys.Menu menu={loading("sam")} />, { router: false });

  // Typed on: the menu now asks something else.
  keys.press("choose", send);
  keys.live.current = target("samp");
  await screen.rerender(<keys.Menu menu={loading("samp")} />);
  await screen.rerender(<keys.Menu menu={{ ...loading("samp"), settled: true, prose: true }} />);
  expect(send).not.toHaveBeenCalled();

  // Dismissed: no path menu is up any more.
  await screen.rerender(<keys.Menu menu={loading("samp")} />);
  keys.press("choose", send);
  await screen.rerender(<keys.Menu menu={{ ...loading("samp"), target: null, settled: true }} />);
  await screen.rerender(<keys.Menu menu={{ ...loading("samp"), settled: true, prose: true }} />);
  expect(send).not.toHaveBeenCalled();
});

it("typing on past a held Space still types the Space, once", async () => {
  const keys = mountPathKeys("src/");
  const typeSpace = vi.fn();
  await using screen = await render(<keys.Menu menu={loading("src/")} />, { router: false });

  // Space waits to learn whether src/ can be mentioned.
  expect(keys.press("space", typeSpace)).toBe(true);
  expect(typeSpace).not.toHaveBeenCalled();

  // The user types on before the listing lands. The Space was a character too.
  keys.live.current = target("src/a");
  await screen.rerender(<keys.Menu menu={loading("src/a")} />);
  expect(typeSpace).toHaveBeenCalledTimes(1);
  await screen.rerender(<keys.Menu menu={{ ...loading("src/a"), settled: true }} />);
  expect(typeSpace).toHaveBeenCalledTimes(1);
  expect(keys.select).not.toHaveBeenCalled();
});

it("closing the menu still types a held Space, once", async () => {
  const keys = mountPathKeys("src/");
  const typeSpace = vi.fn();
  await using screen = await render(<keys.Menu menu={loading("src/")} />, { router: false });
  keys.press("space", typeSpace);
  await screen.rerender(<keys.Menu menu={{ ...loading("src/"), target: null }} />);
  expect(typeSpace).toHaveBeenCalledTimes(1);
  await screen.rerender(<keys.Menu menu={{ ...loading("src/"), settled: true }} />);
  expect(typeSpace).toHaveBeenCalledTimes(1);
});

it("a held key never runs in another draft, even one asking the same thing", async () => {
  const keys = mountPathKeys("src/");
  const typeSpace = vi.fn();
  const send = vi.fn();
  await using screen = await render(<keys.Menu menu={loading("src/")} />, { router: false });

  // The composer moves to another draft, whose own `@src/` then settles, then closes.
  keys.press("space", typeSpace);
  await screen.rerender(<keys.Menu menu={loading("src/")} draftKey="draft-b" />);
  await screen.rerender(
    <keys.Menu menu={{ ...loading("src/"), settled: true }} draftKey="draft-b" />,
  );
  await screen.rerender(
    <keys.Menu menu={{ ...loading("src/"), target: null }} draftKey="draft-b" />,
  );
  expect(typeSpace).not.toHaveBeenCalled();

  keys.press("choose", send);
  await screen.rerender(<keys.Menu menu={loading("src/")} draftKey="draft-c" />);
  await screen.rerender(
    <keys.Menu menu={{ ...loading("src/"), settled: true, prose: true }} draftKey="draft-c" />,
  );
  expect(send).not.toHaveBeenCalled();
  expect(keys.select).not.toHaveBeenCalled();
});

it("a key that did not wait is left to the editor, which acts on it itself", async () => {
  const keys = mountPathKeys("sam");
  const send = vi.fn();
  await using _screen = await render(
    <keys.Menu menu={{ ...loading("sam"), settled: true, prose: true }} />,
    { router: false },
  );
  expect(keys.press("choose", send)).toBe(false);
  expect(send).not.toHaveBeenCalled();
});
