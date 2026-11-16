import type { FilesystemBrowseEntry, FilesystemBrowseResult } from "@t3tools/contracts";
import {
  entryNameMatchRanges,
  rankPathEntries,
  scoreEntryName,
  SUBSEQUENCE_MATCH_SCORE,
  type TextRange,
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
 * A browsed directory's rows for the typed fragment: folders first with nothing typed, else
 * folders and files together by closeness of name. An entry without a kind is a folder, from a
 * server that lists only those. One from outside the folder shows only for a typed name (`~/Us`).
 */
export function rankComposerBrowseEntries(
  listing: Pick<FilesystemBrowseResult, "entries">,
  fragment: string,
): ReadonlyArray<FilesystemBrowseEntry> {
  if (fragment.length > 0) return rankPathEntries(listing.entries, fragment);
  return rankPathEntries(listing.entries.filter(isInListedFolder), fragment).sort(
    (left, right) => Number(left.kind === "file") - Number(right.kind === "file"),
  );
}

function isInListedFolder(entry: FilesystemBrowseEntry): boolean {
  return entry.outsideListing !== true;
}

/** Why a browsed folder has no row to show. */
export type ComposerBrowseGap =
  /** The folder holds nothing. */
  | "empty"
  /** It holds only dotfiles, which show once a `.` is typed. */
  | "only-hidden"
  /** It has entries, and none matches the typed name. */
  | "no-match";

/** Entries from outside the folder do not count: a home holding nothing is still empty. */
export function composerBrowseGap(
  listing: Pick<FilesystemBrowseResult, "entries">,
  fragment: string,
): ComposerBrowseGap {
  if (!listing.entries.some(isInListedFolder)) return "empty";
  return fragment.length === 0 ? "only-hidden" : "no-match";
}

/** A bare `@word`'s search results, ranked. */
export interface RankedSearchMatches<Entry> {
  readonly entries: ReadonlyArray<Entry>;
  /** How many leading entries hold the word in their own name, as one run. */
  readonly closeNameMatchCount: number;
  /** How many leading entries match by name at all, closely or as scattered letters. */
  readonly nameMatchCount: number;
}

/**
 * Project search results for a bare `@word`, strongest first: entries whose own name holds the
 * word, then names matching it loosely, then matches along the path. The search's order holds
 * within each group. The server's search is looser still, so entries matching neither way are
 * dropped unless they are all there is.
 */
export function rankSearchMatches<Entry extends { readonly path: string }>(
  entries: ReadonlyArray<Entry>,
  query: string,
): RankedSearchMatches<Entry> {
  const unranked = { entries, closeNameMatchCount: 0, nameMatchCount: 0 };
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return unranked;
  const close: Array<Entry> = [];
  const loose: Array<Entry> = [];
  const alongPath: Array<Entry> = [];
  for (const entry of entries) {
    const path = entry.path.toLowerCase();
    const nameScore = scoreEntryName(path.slice(path.lastIndexOf("/") + 1), needle);
    if (nameScore !== null) (nameScore < SUBSEQUENCE_MATCH_SCORE ? close : loose).push(entry);
    else if (scoreSubsequenceMatch(path, needle) !== null) alongPath.push(entry);
  }
  const matched = [...close, ...loose, ...alongPath];
  return matched.length === 0
    ? unranked
    : {
        entries: matched,
        closeNameMatchCount: close.length,
        nameMatchCount: close.length + loose.length,
      };
}

/**
 * Per-label emphasis for a menu's rows, or null for a row left plain. The emphasised characters
 * are the ones the ranking matched. When every row matches the same way, by starting with the
 * query, emphasis would only dim the rest of each name, so the whole list stays plain.
 */
export function matchEmphasis(
  labels: ReadonlyArray<string>,
  query: string,
): ReadonlyArray<ReadonlyArray<TextRange> | null> {
  const ranges = labels.map((label) => entryNameMatchRanges(label, query));
  const onlyPrefixes = ranges.every(
    (labelRanges) =>
      labelRanges.length === 0 || (labelRanges.length === 1 && labelRanges[0]?.start === 0),
  );
  return onlyPrefixes ? labels.map(() => null) : ranges;
}

/**
 * The menu's rows for a bare `@word`: the first few files whose name holds the word, then other
 * matches (threads, machines, models) while they are still in view, then the remaining files.
 * The word may be prose (`thanks @sam`), so files alone open the menu only when one matches by
 * name; letters scattered along a path are too easy to come by.
 */
export function orderComposerMentionItems<File, Other>(
  files: ReadonlyArray<File>,
  matches: Pick<RankedSearchMatches<unknown>, "closeNameMatchCount" | "nameMatchCount">,
  others: ReadonlyArray<Other>,
): Array<File | Other> {
  if (matches.nameMatchCount === 0 && others.length === 0) return [];
  const leading = Math.min(matches.closeNameMatchCount, LEADING_FILE_MATCHES);
  return [...files.slice(0, leading), ...others, ...files.slice(leading)];
}

const LEADING_FILE_MATCHES = 4;

/** Why an `@` query has no row to choose. */
export type ComposerPathMiss =
  /** The answer is still on its way. */
  | "pending"
  /** The place was read and nothing in it matches. */
  | "no-match"
  /** The typed folder does not exist. */
  | "missing-folder"
  /** This connection is not allowed to read files, so nothing was looked up. */
  | "no-access"
  /** The lookup broke: no permission for that folder, no connection, a server error. */
  | "failed";

/**
 * Whether a settled `@` query with no row to choose is ordinary text rather than a mention being
 * typed. Prose gets no menu, and Enter sends the message.
 *
 * A pending query has no reading yet, which is why `miss` cannot be `"pending"` here: until its
 * answer lands, Enter waits and the menu follows `isComposerPathMenuHidden`.
 */
export function isComposerPathQueryProse(
  query: string,
  quoted: boolean,
  miss: Exclude<ComposerPathMiss, "pending">,
): boolean {
  // A lookup that broke says nothing about the text. The menu stays up to report it, and Enter
  // stays with the menu, so a draft is never sent on the strength of an error.
  if (miss === "failed") return false;
  const parsed = parseComposerPathQuery(query);
  // A bare word (`@sam`) is a mention only once something matches it. Where files cannot be read
  // at all there is nothing to match, and an error under every `@word` would only be noise.
  if (parsed.mode === "search") return true;
  // So are quoted words (`@"so-called`). Unquoted, no directory means the project root's listing.
  if (parsed.directory.length === 0) return quoted;
  // A path that says where it starts (`~/`, `/`, `./`, `../`) is a path, found or not.
  if (ANCHORED_DIRECTORY.test(parsed.directory)) return false;
  // A relative one is prose only once its folder is known to be missing: `@types/node` sends.
  // An empty `docs/` browses, and without file access `docs/` keeps the menu to say so.
  return miss === "missing-folder";
}

/**
 * Whether the `@` menu stays out of sight for a query with no row to choose. Settled, prose hides
 * it. Pending, it keeps the visibility it had for the previous query (`wasHidden`), so it neither
 * flashes open on `@types/` nor blinks shut between `@src` and `@src/`; with no previous query it
 * opens only for what must be a path.
 */
export function isComposerPathMenuHidden(
  query: string,
  quoted: boolean,
  miss: ComposerPathMiss,
  wasHidden: boolean | null,
): boolean {
  if (miss === "pending") {
    return wasHidden ?? isComposerPathQueryProse(query, quoted, "missing-folder");
  }
  return isComposerPathQueryProse(query, quoted, miss);
}
