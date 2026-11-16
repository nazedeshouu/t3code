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

/** The `@` query in the editor at the moment a key arrives, which a render may not have seen. */
export interface LivePathQuery extends PathMentionTarget {
  /** Typed as `@"…`, where the query runs on through spaces. */
  readonly quoted: boolean;
}

/**
 * A bare word or an open quote after `@` may be prose (`@sam`, `@"so-called`) rather than a file.
 * Finding nothing settles it as prose: the menu stays shut and Enter sends. Text shaped like a
 * path stays a path being typed, whatever it finds.
 */
export function pathQueryMayBeProse(query: string, quoted: boolean): boolean {
  return quoted || parseComposerPathQuery(query).mode === "search";
}

/** What the `@` path menu last rendered. */
export interface RenderedPathMenu {
  /** The query it rendered for; null while no path menu is up. */
  readonly target: PathMentionTarget | null;
  readonly settled: boolean;
  /** The highlighted row, or else the first. */
  readonly item: ComposerCommandItem | null;
  /** The browsed folder, while a Space would mention it. */
  readonly folder: PathEntryItem | null;
}

export type PathMenuKeyOutcome =
  | { readonly type: "select"; readonly item: ComposerCommandItem }
  /** The rows for this query are still loading; the key runs once they land. */
  | { readonly type: "wait" }
  /** Nothing to choose. The key still belongs to the open menu, so it must not send the prompt. */
  | { readonly type: "ignore" }
  /** Not the menu's key. */
  | { readonly type: "pass" };

export function resolvePathMenuKey(
  key: PathMenuKey,
  live: LivePathQuery,
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
  const { item } = menu;
  // Rows of other kinds (threads, machines, models) match locally and are never out of date.
  if (item && (item.type !== "path-entry" || samePathMentionTarget(item.source, live))) {
    return { type: "select", item };
  }
  if (!answered) return { type: "wait" };
  return pathQueryMayBeProse(live.query, live.quoted) ? { type: "pass" } : { type: "ignore" };
}

/**
 * Keys for the `@` path menu. One pressed ahead of its rows (Enter right after typing a name, or
 * a second Enter while the folder the first opened still loads) waits and runs when the rows for
 * that query land; editing the query or closing the menu drops it. Returns whether a key was taken.
 */
export function useComposerPathKeys(input: {
  readonly menu: RenderedPathMenu;
  /** The editor's current `@` query; null when the cursor is not in one. */
  readonly readLiveQuery: () => LivePathQuery | null;
  readonly select: (item: ComposerCommandItem) => void;
  /** Types the Space a waiting key held back, when the folder turned out not to exist. */
  readonly typeSpace: () => void;
}): (key: PathMenuKey) => boolean {
  const latest = useRef(input);
  const waiting = useRef<{ readonly key: PathMenuKey; readonly target: PathMentionTarget } | null>(
    null,
  );

  const press = (key: PathMenuKey, heldBack: boolean): boolean => {
    const { menu, readLiveQuery, select, typeSpace } = latest.current;
    const live = readLiveQuery();
    if (live === null) return false;
    const outcome = resolvePathMenuKey(key, live, menu);
    waiting.current = outcome.type === "wait" ? { key, target: live } : null;
    if (outcome.type === "select") select(outcome.item);
    if (outcome.type === "pass" && heldBack && key === "space") typeSpace();
    return outcome.type !== "pass";
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the committed menu to the editor's key handler and runs a key that waited for it
  useLayoutEffect(() => {
    latest.current = input;
    const held = waiting.current;
    if (held === null) return;
    const { target, settled } = input.menu;
    if (target === null || !samePathMentionTarget(target, held.target)) waiting.current = null;
    else if (settled) press(held.key, true);
  });

  return (key) => press(key, false);
}
