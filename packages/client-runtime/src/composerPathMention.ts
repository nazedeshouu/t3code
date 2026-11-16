import type { FilesystemBrowseEntry } from "@t3tools/contracts";

import { filterFilesystemBrowseEntries } from "./state/filesystem.ts";

/**
 * The text after `@` in the composer, read the way a shell reads a path being typed.
 *
 * A bare word searches the project by name. Anything shaped like a path (it has a `/`, or starts
 * with `~` or `.`) browses one directory instead: `directory` is the part already typed through
 * its last `/`, and `fragment` is the name being typed inside it.
 */
export type ComposerPathQuery =
  | { readonly mode: "search"; readonly query: string }
  | { readonly mode: "browse"; readonly directory: string; readonly fragment: string };

export function parseComposerPathQuery(query: string): ComposerPathQuery {
  // `~` and `..` name a directory even before their slash is typed.
  if (query === "~" || query === "..") {
    return { mode: "browse", directory: `${query}/`, fragment: "" };
  }
  const lastSeparator = query.lastIndexOf("/");
  if (lastSeparator >= 0) {
    return {
      mode: "browse",
      directory: query.slice(0, lastSeparator + 1),
      fragment: query.slice(lastSeparator + 1),
    };
  }
  // Nothing typed lists the project root; a leading dot asks for its dotfiles.
  if (query === "" || query.startsWith(".")) {
    return { mode: "browse", directory: "", fragment: query };
  }
  return { mode: "search", query };
}

const ANCHORED_DIRECTORY = /^(?:\/|~\/|\.\.?\/|[A-Za-z]:[\\/])/;

/**
 * The `partialPath` that makes `filesystem.browse` list a typed directory. The server resolves a
 * path against the project only when it starts with `./` or `../`, so `src/` becomes `./src/`.
 */
export function composerBrowsePartialPath(directory: string): string {
  return ANCHORED_DIRECTORY.test(directory) ? directory : `./${directory}`;
}

/** The query that browses inside a directory entry: the drill-in after choosing a folder. */
export function composerPathQueryInside(directory: string, name: string): string {
  return `${directory}${name}/`;
}

/**
 * The composer text for an unfinished path mention. A path with whitespace opens a quote so the
 * whole of it stays one token, the same `@"…"` form a finished mention can take.
 */
export function formatComposerPathToken(query: string): string {
  return /\s/.test(query) ? `@"${query}` : `@${query}`;
}

/**
 * The path a mention carries for an entry the server listed: relative to the project when the
 * entry is inside it, like every other project mention, and absolute anywhere else so each
 * provider can open it whatever its own working directory is.
 */
export function composerMentionPath(fullPath: string, cwd: string | null): string {
  const root = cwd?.replace(/[\\/]+$/, "") ?? "";
  if (
    root.length > 0 &&
    fullPath.startsWith(root) &&
    /[\\/]/.test(fullPath[root.length] ?? "") &&
    fullPath.length > root.length + 1
  ) {
    return fullPath.slice(root.length + 1).replaceAll("\\", "/");
  }
  return fullPath;
}

/**
 * A browsed directory's entries narrowed to the fragment typed inside it: directories first,
 * closest name match first, dotfiles only for a fragment that starts with a dot. A dot fragment
 * also keeps plain names out, so `@.` lists the dotfiles rather than every `name.ext`.
 */
export function rankComposerBrowseEntries(
  entries: ReadonlyArray<FilesystemBrowseEntry>,
  fragment: string,
): ReadonlyArray<FilesystemBrowseEntry> {
  const { visibleEntries } = filterFilesystemBrowseEntries(entries, fragment);
  return fragment.startsWith(".")
    ? visibleEntries.filter((entry) => entry.name.startsWith("."))
    : visibleEntries;
}

/**
 * Project search matches reordered so a hit in the entry's own name outranks one scattered along
 * its path: a name starting with the query, then a name containing it, then the rest. The
 * search's order holds within each group.
 */
export function orderSearchMatchesByName<Entry extends { readonly path: string }>(
  entries: ReadonlyArray<Entry>,
  query: string,
): ReadonlyArray<Entry> {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return entries;
  const group = (entry: Entry) => {
    const name = entry.path.slice(entry.path.lastIndexOf("/") + 1).toLowerCase();
    return name.startsWith(needle) ? 0 : name.includes(needle) ? 1 : 2;
  };
  return [...entries].sort((left, right) => group(left) - group(right));
}

export interface TextRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Where `query` shows up in `text`, for emphasising the characters that matched: the first
 * case-insensitive substring, or else each character of a left-to-right subsequence. Empty when
 * the query does not match.
 */
export function matchedTextRanges(text: string, query: string): ReadonlyArray<TextRange> {
  if (query.length === 0) return [];
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  // Case folding can change a string's length; indices would then point at the wrong characters.
  if (haystack.length !== text.length) return [];
  const substringStart = haystack.indexOf(needle);
  if (substringStart >= 0) {
    return [{ start: substringStart, end: substringStart + needle.length }];
  }
  const ranges: Array<{ start: number; end: number }> = [];
  let from = 0;
  for (const character of needle) {
    const index = haystack.indexOf(character, from);
    if (index < 0) return [];
    const last = ranges.at(-1);
    if (last && last.end === index) last.end = index + character.length;
    else ranges.push({ start: index, end: index + character.length });
    from = index + character.length;
  }
  return ranges;
}

/**
 * Menu order when a bare `@word` matches files and other things (threads, machines, models):
 * the best few files stay on top, the other matches follow while they are still in view, then
 * the remaining files.
 */
export function orderComposerMentionItems<File, Other>(
  files: ReadonlyArray<File>,
  others: ReadonlyArray<Other>,
): Array<File | Other> {
  return [...files.slice(0, LEADING_FILE_MATCHES), ...others, ...files.slice(LEADING_FILE_MATCHES)];
}

const LEADING_FILE_MATCHES = 4;
