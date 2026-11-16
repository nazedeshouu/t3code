import {
  type ComposerPathMiss,
  composerBrowsePartialPath,
  composerMentionPath,
  composerPathQueryInside,
  matchEmphasis,
  parseComposerPathQuery,
  rankComposerBrowseEntries,
  rankSearchMatches,
} from "@t3tools/client-runtime/composerPathMention";
import { FilesystemBrowseError, type EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { basenameOfPath } from "../../pierre-icons";
import { filesystemEnvironment, useFilesystemReadAccess } from "~/state/filesystem";
import { useEnvironmentQuery } from "~/state/query";
import { useComposerPathSearch, useDebouncedValue } from "~/state/queries";
import type { ComposerCommandItem } from "./ComposerCommandMenu";

export type PathEntryItem = Extract<ComposerCommandItem, { type: "path-entry" }>;

/** What an `@` query is asked of: a machine, the thread's directory on it, and the typed text. */
export interface PathMentionTarget {
  readonly environmentId: EnvironmentId;
  /** The thread's project or worktree directory; null when it has none. */
  readonly cwd: string | null;
  /** The text after `@`. */
  readonly query: string;
}

export function samePathMentionTarget(left: PathMentionTarget, right: PathMentionTarget): boolean {
  return (
    left.environmentId === right.environmentId &&
    left.cwd === right.cwd &&
    left.query === right.query
  );
}

export interface ComposerPathMention {
  readonly items: ReadonlyArray<PathEntryItem>;
  /** A bare `@word`'s leading `items` that hold the word in their name; only those lead other mentions. */
  readonly closeNameMatchCount: number;
  /** A bare `@word`'s leading `items` that match by name at all. */
  readonly nameMatchCount: number;
  /** Set while the query browses one directory; other `@` matches stay out then. */
  readonly browse: ComposerPathBrowse | null;
  /** The answer to this query is still on its way; `items` are then the previous query's, if any. */
  readonly isLoading: boolean;
  readonly emptyState: string;
  /** Why the menu has no row to choose, when it has none. */
  readonly miss: ComposerPathMiss;
  /** Names the result `items` came from; it changes only when another result takes its place. */
  readonly resultKey: string;
}

export interface ComposerPathBrowse {
  /** The directory being browsed, as an item that mentions the directory itself. */
  readonly currentFolder: PathEntryItem | null;
  /** Nothing is typed after the folder's slash yet, so a Space there mentions the folder. */
  readonly spaceMentionsFolder: boolean;
  /** A line under the rows: matches the menu left out, or why files are missing. */
  readonly footnote: string | null;
}

const MENU_ROW_LIMIT = 80;
const NARROWING_DEBOUNCE_MS = 120;
const NO_MATCHES = "No matching files or folders.";
const SEARCH_FAILED = "Couldn't search this project's files.";
const isBrowseError = Schema.is(FilesystemBrowseError);

const NOTHING: ComposerPathMention = {
  items: [],
  closeNameMatchCount: 0,
  nameMatchCount: 0,
  browse: null,
  isLoading: false,
  emptyState: NO_MATCHES,
  miss: "no-match",
  resultKey: "",
};

const NO_FOLDER: ComposerPathBrowse = {
  currentFolder: null,
  spaceMentionsFolder: false,
  footnote: null,
};

/**
 * File and folder suggestions for the composer's `@` query: a project-wide name search for a bare
 * word, one directory's listing once the query is shaped like a path. Pass null while no `@`
 * query is open.
 */
export function useComposerPathMention(target: PathMentionTarget | null): ComposerPathMention {
  const parsed = target === null ? null : parseComposerPathQuery(target.query);
  const search = useProjectSearch(parsed?.mode === "search" ? target : null);
  const browse = useDirectoryListing(
    target !== null && parsed?.mode === "browse" ? { ...target, ...parsed } : null,
  );
  return parsed?.mode === "search" ? search : browse;
}

/**
 * The result to show for a target: its own once it has one, and until then the last one shown,
 * so the menu holds its rows and height instead of blinking empty. A kept result still belongs
 * to the target it answered, which `stale` and every row built from it carry.
 */
function useShownResult<Result, Target extends PathMentionTarget>(
  result: Result | null,
  target: Target | null,
) {
  const [kept, setKept] = useState<{ readonly result: Result; readonly target: Target } | null>(
    null,
  );
  const fresh = result !== null && target !== null ? { result, target } : null;
  if (target === null) {
    // Rows bridge one open menu's queries; the next `@` starts clean.
    if (kept !== null) setKept(null);
  } else if (
    fresh !== null &&
    (kept?.result !== fresh.result || !samePathMentionTarget(kept.target, fresh.target))
  ) {
    setKept(fresh);
  }
  const shown = fresh ?? kept;
  return shown === null
    ? null
    : { ...shown, stale: fresh === null, resultKey: JSON.stringify(shown.target) };
}

function sourceOf(target: PathMentionTarget): PathMentionTarget {
  return { environmentId: target.environmentId, cwd: target.cwd, query: target.query };
}

function useProjectSearch(target: PathMentionTarget | null): ComposerPathMention {
  const search = useComposerPathSearch({
    environmentId: target?.environmentId ?? null,
    cwd: target?.cwd ?? null,
    query: target?.query ?? null,
  });
  const shown = useShownResult(search.isPending ? null : search.entries, target);
  if (target === null) return NOTHING;
  const failed = !search.isPending && search.error !== null;
  const pending: ComposerPathMention = {
    ...NOTHING,
    isLoading: search.isPending,
    emptyState: failed ? SEARCH_FAILED : NO_MATCHES,
    miss: search.isPending ? "pending" : failed ? "failed" : "no-match",
  };
  if (shown === null) return pending;

  const ranked = rankSearchMatches(shown.result, shown.target.query);
  const labels = ranked.entries.map((entry) => basenameOfPath(entry.path));
  const emphasis = matchEmphasis(labels, shown.target.query.trim());
  return {
    ...pending,
    items: ranked.entries.map((entry, index) => ({
      id: `path-entry:${entry.path}`,
      type: "path-entry",
      path: entry.path,
      pathKind: entry.kind,
      opensQuery: entry.kind === "directory" ? `${entry.path}/` : null,
      source: sourceOf(shown.target),
      stale: shown.stale,
      label: labels[index] ?? entry.path,
      labelMatches: emphasis[index] ?? null,
      description: entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))),
    })),
    closeNameMatchCount: ranked.closeNameMatchCount,
    nameMatchCount: ranked.nameMatchCount,
    resultKey: shown.resultKey,
  };
}

interface DirectoryTarget extends PathMentionTarget {
  /** The typed directory through its last `/`; empty for the project root. */
  readonly directory: string;
  readonly fragment: string;
}

function useDirectoryListing(target: DirectoryTarget | null): ComposerPathMention {
  const fileAccess = useFilesystemReadAccess(target?.environmentId ?? null);
  // A path relative to the project has nothing to resolve against in a thread without one.
  const needsProject =
    target !== null &&
    target.cwd === null &&
    composerBrowsePartialPath(target.directory).startsWith(".");
  const directoryPath =
    target !== null && fileAccess.canReadFiles && !needsProject
      ? composerBrowsePartialPath(target.directory)
      : null;
  const listing = useEnvironmentQuery(browseAtom(target, directoryPath));

  // One listing carries a capped number of entries. Past the cap the server narrows by the typed
  // fragment instead, with the matcher that ranks a whole listing here.
  const debouncedFragment = useDebouncedValue(target?.fragment ?? "", NARROWING_DEBOUNCE_MS);
  const narrows = listing.data?.truncated === true && target !== null && target.fragment.length > 0;
  const narrowed = useEnvironmentQuery(
    narrows && directoryPath !== null && debouncedFragment.length > 0
      ? browseAtom(target, `${directoryPath}${debouncedFragment}`)
      : null,
  );
  const narrowedForFragment = debouncedFragment === target?.fragment ? narrowed.data : null;

  const shown = useShownResult(narrows ? narrowedForFragment : listing.data, target);
  if (target === null) return NOTHING;

  const answered = shown !== null && !shown.stale;
  // A listing already on screen stays the answer while it quietly refreshes.
  const isLoading =
    !answered &&
    (fileAccess.isPending ||
      listing.isPending ||
      (narrows && (debouncedFragment !== target.fragment || narrowed.isPending)));
  const unanswered: ComposerPathMention = {
    ...NOTHING,
    browse: NO_FOLDER,
    isLoading,
    miss: isLoading ? "pending" : "no-match",
  };
  const folderName = target.directory || "the project folder";

  if (!fileAccess.isPending && !fileAccess.canReadFiles) {
    return {
      ...unanswered,
      emptyState: fileAccess.error ?? "This connection can't read files on this machine.",
      miss: "failed",
    };
  }
  if (needsProject) {
    return {
      ...unanswered,
      emptyState: "This thread has no project folder. Start the path with ~/ or /.",
      miss: "missing-folder",
    };
  }
  if (!answered && !isLoading) {
    const failure = narrows ? narrowed.failure : listing.failure;
    if (isBrowseError(failure) && failure.pathMissing) {
      return {
        ...unanswered,
        emptyState: `No folder at ${target.directory}`,
        miss: "missing-folder",
      };
    }
    return {
      ...unanswered,
      emptyState:
        isBrowseError(failure) && failure.permissionDenied
          ? `No permission to read ${folderName}.`
          : `Couldn't read ${folderName}.`,
      miss: "failed",
    };
  }
  if (shown === null) return unanswered;

  const { directory, fragment, cwd } = shown.target;
  const source = sourceOf(shown.target);
  const matches = rankComposerBrowseEntries(shown.result.entries, fragment);
  const rows = matches.slice(0, MENU_ROW_LIMIT);
  const emphasis = matchEmphasis(
    rows.map((entry) => entry.name),
    fragment,
  );
  const hiddenCount = matches.length - rows.length;
  // A server from before file browsing ignores the request for files and marks no entry's kind.
  const foldersOnly =
    shown.result.entries.length > 0 &&
    shown.result.entries.every((entry) => entry.kind === undefined);
  return {
    ...unanswered,
    resultKey: shown.resultKey,
    items: rows.map((entry, index) => {
      const pathKind = entry.kind ?? "directory";
      return {
        id: `path-entry:${entry.fullPath}`,
        type: "path-entry",
        path: composerMentionPath(entry.fullPath, cwd),
        pathKind,
        opensQuery:
          pathKind === "directory" ? composerPathQueryInside(directory, entry.name) : null,
        source,
        stale: shown.stale,
        label: entry.name,
        labelMatches: emphasis[index] ?? null,
        description: "",
      };
    }),
    browse: {
      currentFolder:
        shown.stale || directory.length === 0
          ? null
          : {
              id: `path-entry:current:${shown.result.parentPath}`,
              type: "path-entry",
              path: composerMentionPath(shown.result.parentPath, cwd),
              pathKind: "directory",
              opensQuery: null,
              source,
              stale: false,
              label: directory,
              labelMatches: null,
              description: "",
            },
      spaceMentionsFolder: !shown.stale && directory.length > 0 && fragment.length === 0,
      footnote: foldersOnly
        ? "Update T3 Code on this machine to browse files here."
        : hiddenCount > 0
          ? // Past the server's cap the count is only a floor.
            `${hiddenCount.toLocaleString()}${shown.result.truncated ? "+" : ""} more. Keep typing to narrow.`
          : null,
    },
    emptyState:
      shown.result.entries.length === 0
        ? "This folder is empty."
        : fragment.length === 0
          ? "Only hidden files here. Type . to list them."
          : NO_MATCHES,
  };
}

function browseAtom(target: PathMentionTarget | null, partialPath: string | null) {
  if (target === null || partialPath === null) return null;
  return filesystemEnvironment.browse({
    environmentId: target.environmentId,
    input: {
      partialPath,
      ...(target.cwd === null ? {} : { cwd: target.cwd }),
      includeFiles: true,
    },
  });
}
