import { parseComposerPathQuery } from "@t3tools/client-runtime/composerPathMention";
import { useLayoutEffect, useRef } from "react";

import type { ComposerCommandItem } from "./ComposerCommandMenu";
import {
  type PathEntryItem,
  type PathMentionTarget,
  samePathMentionTarget,
} from "./useComposerPathMention";

/** Enter and Tab choose a row; Space mentions the folder being browsed. */
export type PathMenuKey = "choose" | "space";

/** What the `@` path menu last rendered. */
export interface RenderedPathMenu {
  /** The query it rendered for; null while no path menu is up. */
  readonly target: PathMentionTarget | null;
  readonly settled: boolean;
  /** The highlighted row, or else the first. */
  readonly item: ComposerCommandItem | null;
  /** The browsed folder, while nothing is typed after its slash and so it can be mentioned. */
  readonly folder: PathEntryItem | null;
  /** With no row to choose, the query reads as ordinary text and not as a mention being typed. */
  readonly prose: boolean;
}

export type PathMenuKeyOutcome =
  | { readonly type: "select"; readonly item: ComposerCommandItem }
  /** The rows for this query are still loading; the key runs once they land. */
  | { readonly type: "wait" }
  /** Nothing to choose. The key still belongs to the open menu, so it must not send the prompt. */
  | { readonly type: "ignore" }
  /** Not the menu's key: it does what it does anywhere else in the composer. */
  | { readonly type: "pass" };

/**
 * What a key means to the `@` path menu. `live` is the query in the editor at the moment the key
 * arrives, which the menu's last render may not have seen yet.
 */
export function resolvePathMenuKey(
  key: PathMenuKey,
  live: PathMentionTarget,
  menu: RenderedPathMenu,
): PathMenuKeyOutcome {
  const answered = menu.settled && menu.target !== null && samePathMentionTarget(menu.target, live);
  if (key === "space") {
    const parsed = parseComposerPathQuery(live.query);
    const afterFolderSlash =
      parsed.mode === "browse" && parsed.directory.length > 0 && parsed.fragment.length === 0;
    if (!afterFolderSlash) return { type: "pass" };
    if (!answered) return { type: "wait" };
    return menu.folder ? { type: "select", item: menu.folder } : { type: "pass" };
  }
  // Rows that match at once (threads, models) wait for the files too: the key takes what the
  // answered menu shows first, however fast it was pressed.
  if (!answered) return { type: "wait" };
  if (menu.item) return { type: "select", item: menu.item };
  if (menu.prose) return { type: "pass" };
  // An empty folder leaves one thing to choose, the folder itself. A missing or unreadable
  // folder, a failed search, or a name matching nothing leaves none.
  return menu.folder ? { type: "select", item: menu.folder } : { type: "ignore" };
}

/**
 * Keys for the `@` path menu; the handler returns whether the menu took the key. One pressed
 * ahead of its rows waits for them. If the menu then has no use for it, `whenUnclaimed` runs:
 * what the key does outside the menu, such as sending. If the query changes or the menu closes
 * first, a choice is dropped and a Space is typed after all. Neither reaches another draft.
 */
export function useComposerPathKeys(input: {
  /** Names the draft being edited. The composer stays mounted when the draft under it changes. */
  readonly draftKey: string;
  readonly menu: RenderedPathMenu;
  /** The editor's current `@` query; null when the cursor is not in one. */
  readonly readLiveQuery: () => PathMentionTarget | null;
  readonly select: (item: ComposerCommandItem) => void;
}): (key: PathMenuKey, whenUnclaimed: () => void) => boolean {
  const latest = useRef(input);
  const waiting = useRef<{
    readonly draftKey: string;
    readonly key: PathMenuKey;
    readonly target: PathMentionTarget;
    readonly whenUnclaimed: () => void;
  } | null>(null);

  const press = (key: PathMenuKey, whenUnclaimed: () => void, waited: boolean): boolean => {
    const { draftKey, menu, readLiveQuery, select } = latest.current;
    const live = readLiveQuery();
    waiting.current = null;
    if (live === null) return false;
    const outcome = resolvePathMenuKey(key, live, menu);
    if (outcome.type === "wait") waiting.current = { draftKey, key, target: live, whenUnclaimed };
    if (outcome.type === "select") select(outcome.item);
    if (outcome.type === "pass" && waited) whenUnclaimed();
    return outcome.type !== "pass";
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the committed menu to the editor's key handler and runs a key that waited for it
  useLayoutEffect(() => {
    latest.current = input;
    const held = waiting.current;
    if (held === null) return;
    const { target, settled } = input.menu;
    if (input.draftKey !== held.draftKey) {
      waiting.current = null;
    } else if (target === null || !samePathMentionTarget(target, held.target)) {
      waiting.current = null;
      // The rows this key waited for will never show. That voids a choice, but a Space is a
      // character the user typed and is not to be lost.
      if (held.key === "space") queueMicrotask(held.whenUnclaimed);
    } else if (settled) {
      // After the commit: the key edits the editor, which flushes its own update synchronously.
      queueMicrotask(() => {
        if (waiting.current === held) press(held.key, held.whenUnclaimed, true);
      });
    }
  });

  return (key, whenUnclaimed) => press(key, whenUnclaimed, false);
}
