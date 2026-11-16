import type { FilesystemBrowseEntry } from "@t3tools/contracts";
import {
  rankPathEntries,
  scoreEntryName,
  SUBSEQUENCE_MATCH_SCORE,
} from "@t3tools/shared/pathEntryMatch";
import { scoreSubsequenceMatch } from "@t3tools/shared/searchRanking";

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
 * A browsed directory's entries for the fragment typed inside it. With nothing typed, folders
 * lead; a typed fragment orders folders and files together by how closely their names match.
 * An entry without a kind comes from a server that lists folders only.
 */
export function rankComposerBrowseEntries(
  entries: ReadonlyArray<FilesystemBrowseEntry>,
  fragment: string,
): ReadonlyArray<FilesystemBrowseEntry> {
  const ranked = rankPathEntries(entries, fragment);
  if (fragment.length > 0) return ranked;
  return ranked.sort((left, right) => Number(left.kind === "file") - Number(right.kind === "file"));
}

/**
 * Project search results for a bare `@word`, strongest first: entries whose own name holds the
 * word (`nameMatchCount` of them), then names matching it loosely, then matches along the path.
 * The search's order holds within each group. The server's search is looser still, so entries
 * matching neither way are dropped unless they are all there is.
 */
export function rankSearchMatches<Entry extends { readonly path: string }>(
  entries: ReadonlyArray<Entry>,
  query: string,
): { readonly entries: ReadonlyArray<Entry>; readonly nameMatchCount: number } {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return { entries, nameMatchCount: 0 };
  const groups: [Array<Entry>, Array<Entry>, Array<Entry>] = [[], [], []];
  for (const entry of entries) {
    const path = entry.path.toLowerCase();
    const nameScore = scoreEntryName(path.slice(path.lastIndexOf("/") + 1), needle);
    if (nameScore !== null) groups[nameScore < SUBSEQUENCE_MATCH_SCORE ? 0 : 1].push(entry);
    else if (scoreSubsequenceMatch(path, needle) !== null) groups[2].push(entry);
  }
  const matched = groups.flat();
  return matched.length === 0
    ? { entries, nameMatchCount: 0 }
    : { entries: matched, nameMatchCount: groups[0].length };
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
 * Per-label emphasis for a menu's rows, or null for a row left plain. When every row matches the
 * same way, by starting with the query, emphasis would only dim the rest of each name, so the
 * whole list stays plain.
 */
export function matchEmphasis(
  labels: ReadonlyArray<string>,
  query: string,
): ReadonlyArray<ReadonlyArray<TextRange> | null> {
  const ranges = labels.map((label) => matchedTextRanges(label, query));
  const onlyPrefixes = ranges.every(
    (labelRanges) =>
      labelRanges.length === 0 || (labelRanges.length === 1 && labelRanges[0]?.start === 0),
  );
  return onlyPrefixes ? labels.map(() => null) : ranges;
}

/**
 * Menu order when a bare `@word` matches files and other things (threads, machines, models):
 * the first few files whose name matches lead, the other matches follow while they are still in
 * view, then the remaining files. `files` are ranked with `nameMatchCount` name matches first.
 */
export function orderComposerMentionItems<File, Other>(
  files: ReadonlyArray<File>,
  nameMatchCount: number,
  others: ReadonlyArray<Other>,
): Array<File | Other> {
  const leading = Math.min(nameMatchCount, LEADING_FILE_MATCHES);
  return [...files.slice(0, leading), ...others, ...files.slice(leading)];
}

const LEADING_FILE_MATCHES = 4;
