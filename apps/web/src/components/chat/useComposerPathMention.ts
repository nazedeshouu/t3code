import {
  composerBrowsePartialPath,
  composerMentionPath,
  composerPathQueryInside,
  matchedTextRanges,
  orderSearchMatchesByName,
  parseComposerPathQuery,
  rankComposerBrowseEntries,
} from "@t3tools/client-runtime/composerPathMention";
import { FilesystemBrowseError, type EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { basenameOfPath } from "../../pierre-icons";
import { filesystemEnvironment, useFilesystemReadAccess } from "~/state/filesystem";
import { useEnvironmentQuery } from "~/state/query";
import { useComposerPathSearch, useDebouncedValue } from "~/state/queries";
import type { ComposerCommandItem } from "./ComposerCommandMenu";

type PathEntryItem = Extract<ComposerCommandItem, { type: "path-entry" }>;

export interface ComposerPathMention {
  readonly items: ReadonlyArray<PathEntryItem>;
  /** Browsing one directory rather than searching the project; other `@` matches stay out. */
  readonly isBrowsing: boolean;
  /** The directory being browsed, as an item that mentions the directory itself. */
  readonly currentFolder: PathEntryItem | null;
  /** Nothing is typed after the folder's slash yet, so a Space there mentions the folder. */
  readonly spaceMentionsFolder: boolean;
  /** Matches left out of `items` because the menu caps its rows. */
  readonly hiddenCount: number;
  readonly isLoading: boolean;
  readonly emptyState: string;
}

interface PathMentionTarget {
  readonly environmentId: EnvironmentId;
  /** The thread's project or worktree directory; null when it has none. */
  readonly cwd: string | null;
  /** The text after `@`. */
  readonly query: string;
}

const MENU_ROW_LIMIT = 80;
const NARROWING_DEBOUNCE_MS = 120;
const NO_MATCHES = "No matching files or folders.";
const isBrowseError = Schema.is(FilesystemBrowseError);

/**
 * File and folder suggestions for the composer's `@` query: a project-wide name search for a bare
 * word, one directory's listing once the query is shaped like a path. Pass null while no `@`
 * query is open.
 */
export function useComposerPathMention(target: PathMentionTarget | null): ComposerPathMention {
  const parsed = target === null ? null : parseComposerPathQuery(target.query);
  const search = useProjectSearch(
    target !== null && parsed?.mode === "search"
      ? { environmentId: target.environmentId, cwd: target.cwd, query: parsed.query }
      : null,
  );
  const browse = useDirectoryListing(
    target !== null && parsed?.mode === "browse"
      ? { environmentId: target.environmentId, cwd: target.cwd, ...parsed }
      : null,
  );
  return parsed?.mode === "search" ? search : browse;
}

const NOTHING: ComposerPathMention = {
  items: [],
  isBrowsing: false,
  currentFolder: null,
  spaceMentionsFolder: false,
  hiddenCount: 0,
  isLoading: false,
  emptyState: NO_MATCHES,
};

/**
 * The newest settled result, kept through the load of the next one so the menu holds its rows
 * and height instead of blinking empty. `key` names the request the kept result answered.
 */
function useLastSettled<Result>(result: Result | null, key: string) {
  const [last, setLast] = useState<{ readonly result: Result; readonly key: string } | null>(null);
  if (result !== null && last?.result !== result) {
    setLast({ result, key });
  }
  return result === null ? last : { result, key };
}

function useProjectSearch(
  target: {
    readonly environmentId: EnvironmentId;
    readonly cwd: string | null;
    readonly query: string;
  } | null,
): ComposerPathMention {
  const search = useComposerPathSearch({
    environmentId: target?.environmentId ?? null,
    cwd: target?.cwd ?? null,
    query: target?.query ?? null,
  });
  const shown = useLastSettled(search.isPending ? null : search.entries, target?.query ?? "");
  if (target === null) return NOTHING;

  const stale = shown?.key !== target.query;
  return {
    ...NOTHING,
    items: orderSearchMatchesByName(shown?.result ?? [], stale ? "" : target.query).map((entry) => {
      const label = basenameOfPath(entry.path);
      return {
        id: `path-entry:${entry.path}`,
        type: "path-entry",
        path: entry.path,
        pathKind: entry.kind,
        opensQuery: entry.kind === "directory" ? `${entry.path}/` : null,
        stale,
        label,
        labelMatches: stale ? null : matchedTextRanges(label, target.query),
        description: entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))),
      };
    }),
    isLoading: search.isPending,
    emptyState: search.error ?? NO_MATCHES,
  };
}

interface DirectoryTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
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
  const request =
    target !== null && fileAccess.canReadFiles && !needsProject
      ? {
          environmentId: target.environmentId,
          cwd: target.cwd,
          partialPath: composerBrowsePartialPath(target.directory),
        }
      : null;
  const listing = useEnvironmentQuery(browseAtom(request, ""));

  // One listing carries a capped number of entries. Past the cap, the server filters by the
  // typed prefix instead, so entries beyond it stay reachable.
  const debouncedFragment = useDebouncedValue(target?.fragment ?? "", NARROWING_DEBOUNCE_MS);
  const narrowingPrefix =
    listing.data?.truncated === true && target !== null && target.fragment.length > 0
      ? debouncedFragment
      : "";
  const narrowed = useEnvironmentQuery(
    narrowingPrefix.length > 0 ? browseAtom(request, narrowingPrefix) : null,
  );

  const settled = narrowed.data ?? listing.data;
  const shown = useLastSettled(settled, target?.directory ?? "");
  const isLoading = fileAccess.isPending || listing.isPending || narrowed.isPending;
  const browsing = { ...NOTHING, isBrowsing: true, isLoading };

  if (target === null) return NOTHING;
  if (!fileAccess.isPending && !fileAccess.canReadFiles) {
    return {
      ...browsing,
      emptyState: fileAccess.error ?? "This connection can't read files on this machine.",
    };
  }
  if (needsProject) {
    return {
      ...browsing,
      emptyState: "This thread has no project folder. Start the path with ~/ or /.",
    };
  }
  if (settled === null && !isLoading) {
    return {
      ...browsing,
      emptyState:
        isBrowseError(listing.failure) && listing.failure.pathMissing
          ? `No folder at ${target.directory}`
          : `Couldn't read ${target.directory || "the project folder"}`,
    };
  }
  if (shown === null) return browsing;

  const stale = shown.key !== target.directory;
  const fragment = stale ? "" : target.fragment;
  const matches = rankComposerBrowseEntries(shown.result.entries, fragment);
  return {
    ...browsing,
    items: matches.slice(0, MENU_ROW_LIMIT).map((entry) => {
      const pathKind = entry.kind ?? "directory";
      return {
        id: `path-entry:${entry.fullPath}`,
        type: "path-entry",
        path: composerMentionPath(entry.fullPath, target.cwd),
        pathKind,
        opensQuery:
          pathKind === "directory" ? composerPathQueryInside(shown.key, entry.name) : null,
        stale,
        label: entry.name,
        labelMatches: fragment.length === 0 ? null : matchedTextRanges(entry.name, fragment),
        description: "",
      };
    }),
    currentFolder:
      stale || target.directory.length === 0
        ? null
        : {
            id: `path-entry:current:${shown.result.parentPath}`,
            type: "path-entry",
            path: composerMentionPath(shown.result.parentPath, target.cwd),
            pathKind: "directory",
            opensQuery: null,
            stale: false,
            label: target.directory,
            labelMatches: null,
            description: "",
          },
    spaceMentionsFolder: !stale && target.directory.length > 0 && target.fragment.length === 0,
    hiddenCount: Math.max(0, matches.length - MENU_ROW_LIMIT),
    emptyState:
      shown.result.entries.length === 0
        ? "This folder is empty."
        : fragment.length === 0
          ? "Only hidden files here. Type . to list them."
          : NO_MATCHES,
  };
}

function browseAtom(
  request: {
    readonly environmentId: EnvironmentId;
    readonly cwd: string | null;
    readonly partialPath: string;
  } | null,
  prefix: string,
) {
  if (request === null) return null;
  return filesystemEnvironment.browse({
    environmentId: request.environmentId,
    input: {
      partialPath: `${request.partialPath}${prefix}`,
      ...(request.cwd === null ? {} : { cwd: request.cwd }),
      includeFiles: true,
    },
  });
}
