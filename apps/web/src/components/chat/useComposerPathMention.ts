import {
  type ComposerPathMiss,
  composerBrowseGap,
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
  /** The leading `items` that match by name at all: some of a bare `@word`'s, all of a folder's. */
  readonly nameMatchCount: number;
  /** Set while the query browses one directory; other `@` matches stay out then. */
  readonly browse: ComposerPathBrowse | null;
  /** The answer to this query is still on its way; `items` are then the last answer's, all stale. */
  readonly isLoading: boolean;
  readonly emptyState: string;
  /** Why the menu has no row to choose, when it has none. */
  readonly miss: ComposerPathMiss;
  /** Names the answer `items` came from; it changes only when another answer takes its place. */
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
const BROWSE_GAP_TEXT = {
  empty: "This folder is empty.",
  "only-hidden": "Only hidden files here. Type . to list them.",
  "no-match": NO_MATCHES,
} as const;
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
  const mention = parsed?.mode === "search" ? search : browse;

  // Until a query is answered the menu keeps the last answer's rows, dimmed and off offer, so it
  // holds its rows and height instead of blinking empty. One answer is kept for both sources, so
  // a search that turns into a folder listing (`@src`, then `/`) is bridged like any other step.
  const [answered, setAnswered] = useState<ComposerPathMention | null>(null);
  if (target === null) {
    // Rows bridge one open menu's queries; the next `@` starts clean.
    if (answered !== null) setAnswered(null);
  } else if (!mention.isLoading && !hasSameRows(answered, mention)) {
    setAnswered(mention);
  }
  if (!mention.isLoading || answered === null) return mention;
  return {
    ...mention,
    items: answered.items.map((item) => ({ ...item, stale: true })),
    closeNameMatchCount: answered.closeNameMatchCount,
    nameMatchCount: answered.nameMatchCount,
    resultKey: answered.resultKey,
  };
}

/** Whether two answers are one query's with the same rows; a quiet refresh can change the rows. */
function hasSameRows(left: ComposerPathMention | null, right: ComposerPathMention): boolean {
  return (
    left !== null &&
    left.resultKey === right.resultKey &&
    left.items.length === right.items.length &&
    left.items.every((item, index) => item.id === right.items[index]?.id)
  );
}

/**
 * A target's own result. It is held while that same query quietly refreshes, so rows already on
 * offer stay on offer; another target never sees it.
 */
function useOwnResult<Result>(result: Result | null, target: PathMentionTarget | null) {
  const [kept, setKept] = useState<{
    readonly result: Result;
    readonly target: PathMentionTarget;
  } | null>(null);
  if (target === null) return null;
  const keptIsOwn = kept !== null && samePathMentionTarget(kept.target, target);
  if (result === null) return keptIsOwn ? kept.result : null;
  if (!keptIsOwn || kept.result !== result) setKept({ result, target });
  return result;
}

function sourceOf(target: PathMentionTarget): PathMentionTarget {
  return { environmentId: target.environmentId, cwd: target.cwd, query: target.query };
}

function resultKeyOf(target: PathMentionTarget): string {
  return JSON.stringify(sourceOf(target));
}

/**
 * Whether this connection is known to lack permission to read files. A connection that is down,
 * or whose permissions could not be checked, carries an error instead and counts as a failure.
 */
function lacksReadAccess(access: ReturnType<typeof useFilesystemReadAccess>): boolean {
  return !access.isPending && !access.canReadFiles && access.error === null;
}

function useProjectSearch(target: PathMentionTarget | null): ComposerPathMention {
  const fileAccess = useFilesystemReadAccess(target?.environmentId ?? null);
  const search = useComposerPathSearch({
    environmentId: target?.environmentId ?? null,
    cwd: target?.cwd ?? null,
    query: target?.query ?? null,
  });
  const entries = useOwnResult(search.isPending ? null : search.entries, target);
  if (target === null) return NOTHING;
  // Without access no search runs, so there is no answer to wait for.
  if (lacksReadAccess(fileAccess)) return { ...NOTHING, miss: "no-access" };
  const isLoading = search.isPending && entries === null;
  const failed = !search.isPending && search.error !== null;
  const pending: ComposerPathMention = {
    ...NOTHING,
    isLoading,
    emptyState: failed ? SEARCH_FAILED : NO_MATCHES,
    miss: isLoading ? "pending" : failed ? "failed" : "no-match",
  };
  if (entries === null) return pending;

  const ranked = rankSearchMatches(entries, target.query);
  const labels = ranked.entries.map((entry) => basenameOfPath(entry.path));
  const emphasis = matchEmphasis(labels, target.query.trim());
  return {
    ...pending,
    items: ranked.entries.map((entry, index) => ({
      id: `path-entry:${entry.path}`,
      type: "path-entry",
      path: entry.path,
      pathKind: entry.kind,
      opensQuery: entry.kind === "directory" ? `${entry.path}/` : null,
      source: sourceOf(target),
      stale: false,
      label: labels[index] ?? entry.path,
      labelMatches: emphasis[index] ?? null,
      description: entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))),
    })),
    closeNameMatchCount: ranked.closeNameMatchCount,
    nameMatchCount: ranked.nameMatchCount,
    resultKey: resultKeyOf(target),
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

  const result = useOwnResult(narrows ? narrowedForFragment : listing.data, target);
  if (target === null) return NOTHING;

  // A listing already on screen stays the answer while it quietly refreshes.
  const isLoading =
    result === null &&
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
      miss: lacksReadAccess(fileAccess) ? "no-access" : "failed",
    };
  }
  if (needsProject) {
    return {
      ...unanswered,
      emptyState: "This thread has no project folder. Start the path with ~/ or /.",
      miss: "missing-folder",
    };
  }
  if (result === null && !isLoading) {
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
  if (result === null) return unanswered;

  const { directory, fragment, cwd } = target;
  const source = sourceOf(target);
  const matches = rankComposerBrowseEntries(result, fragment);
  const rows = matches.slice(0, MENU_ROW_LIMIT);
  const emphasis = matchEmphasis(
    rows.map((entry) => entry.name),
    fragment,
  );
  const hiddenCount = matches.length - rows.length;
  // A server from before file browsing ignores the request for files and marks no entry's kind.
  const foldersOnly =
    result.entries.length > 0 && result.entries.every((entry) => entry.kind === undefined);
  return {
    ...unanswered,
    resultKey: resultKeyOf(target),
    nameMatchCount: rows.length,
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
        stale: false,
        label: entry.name,
        labelMatches: emphasis[index] ?? null,
        description: "",
      };
    }),
    browse: {
      currentFolder:
        directory.length === 0
          ? null
          : {
              id: `path-entry:current:${result.parentPath}`,
              type: "path-entry",
              path: composerMentionPath(result.parentPath, cwd),
              pathKind: "directory",
              opensQuery: null,
              source,
              stale: false,
              label: directory,
              labelMatches: null,
              description: "",
            },
      spaceMentionsFolder: directory.length > 0 && fragment.length === 0,
      footnote: foldersOnly
        ? "Update T3 Code on this machine to browse files here."
        : hiddenCount > 0
          ? // Past the server's cap the count is only a floor.
            `${hiddenCount.toLocaleString()}${result.truncated ? "+" : ""} more. Keep typing to narrow.`
          : null,
    },
    emptyState: BROWSE_GAP_TEXT[composerBrowseGap(result, fragment, narrows)],
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
