import type {
  ThreadRewindCodeStats,
  ThreadRewindMode,
  ThreadRewindPreview,
  ThreadRewindTarget,
  ThreadRewindTurnCode,
  ThreadRewindUndo,
} from "@t3tools/contracts";

import { basenameOfPath } from "../../pierre-icons";
import { formatCompactDiffCount } from "./DiffStatLabel";

const REWIND_ESCAPE_WINDOW_MS = 500;

/** When the first Escape landed, while a second one would open the dock. */
export type RewindEscapeState = number | null;

export interface RewindEscapePress {
  readonly key: string;
  readonly repeat: boolean;
  /** Something else took this key, or the focused surface owns Escape. */
  readonly blocked: boolean;
  readonly now: number;
}

export function advanceRewindEscape(
  armedAt: RewindEscapeState,
  press: RewindEscapePress,
): { readonly armedAt: RewindEscapeState; readonly open: boolean } {
  if (press.key !== "Escape" || press.blocked) return { armedAt: null, open: false };
  if (press.repeat) return { armedAt, open: false };
  if (armedAt !== null && press.now - armedAt <= REWIND_ESCAPE_WINDOW_MS) {
    return { armedAt: null, open: true };
  }
  return { armedAt: press.now, open: false };
}

export interface RewindStat {
  readonly label: string;
  readonly insertions: string | null;
  readonly deletions: string | null;
}

export function formatRewindStat(stats: ThreadRewindCodeStats): RewindStat {
  return {
    label:
      stats.primaryPath !== null && stats.filesChanged === 1
        ? basenameOfPath(stats.primaryPath)
        : `${stats.filesChanged} ${stats.filesChanged === 1 ? "file" : "files"}`,
    insertions: stats.insertions === 0 ? null : `+${formatCompactDiffCount(stats.insertions)}`,
    deletions: stats.deletions === 0 ? null : `−${formatCompactDiffCount(stats.deletions)}`,
  };
}

type RewindRowCode =
  | { readonly kind: "stat"; readonly stat: RewindStat }
  | { readonly kind: "text"; readonly text: string; readonly warning: boolean };

export function rewindRowCode(code: ThreadRewindTurnCode): RewindRowCode {
  switch (code.state) {
    case "changed":
      return { kind: "stat", stat: formatRewindStat(code.stats) };
    case "unchanged":
      return { kind: "text", text: "No code changes", warning: false };
    case "pending":
      return { kind: "text", text: "", warning: false };
    case "unavailable":
      return { kind: "text", text: "No code restore", warning: true };
  }
}

export type RewindChoice = ThreadRewindMode | "cancel";

export const REWIND_MODE_LABELS: Record<RewindChoice, string> = {
  code_and_conversation: "Restore code and conversation",
  conversation: "Restore conversation",
  code: "Restore code",
  summarize_from_here: "Summarize from here",
  cancel: "Never mind",
};

export function rewindChoices(modes: ReadonlyArray<ThreadRewindMode>): RewindChoice[] {
  return [...modes, "cancel"];
}

export function restoresCode(choice: RewindChoice): boolean {
  return choice === "code" || choice === "code_and_conversation";
}

/**
 * What the options step shows until the preview answers, so its rows rarely move
 * when the real list arrives.
 */
export function assumedRewindModes(
  code: ThreadRewindTurnCode,
  supportsConversationRollback: boolean,
): ThreadRewindMode[] {
  const canRestoreCode = code.state !== "unavailable";
  return [
    ...(canRestoreCode && supportsConversationRollback ? (["code_and_conversation"] as const) : []),
    ...(supportsConversationRollback ? (["conversation"] as const) : []),
    ...(canRestoreCode ? (["code"] as const) : []),
    ...(supportsConversationRollback ? (["summarize_from_here"] as const) : []),
  ];
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

interface RewindConsequence {
  readonly stat: RewindStat | null;
  readonly text: string;
}

export function rewindConsequence(
  choice: ThreadRewindMode,
  preview: Pick<ThreadRewindPreview, "code" | "removedMessageCount">,
): RewindConsequence {
  switch (choice) {
    case "code_and_conversation": {
      const removed = `${pluralize(preview.removedMessageCount, "message")} removed`;
      return preview.code === null || preview.code.filesChanged === 0
        ? { stat: null, text: `No file changes, ${removed}` }
        : { stat: formatRewindStat(preview.code), text: `reverted, ${removed}` };
    }
    case "conversation":
      return { stat: null, text: "Files stay as they are now" };
    case "code":
      return preview.code === null || preview.code.filesChanged === 0
        ? { stat: null, text: "No file changes, conversation stays" }
        : { stat: null, text: "Conversation stays" };
    case "summarize_from_here":
      return { stat: null, text: "Replaces later messages with a summary" };
  }
}

/** The dock's one line when no target can be rewound at all. */
export function rewindUnavailableReason(
  targets: ReadonlyArray<Pick<ThreadRewindTarget, "code">>,
  supportsConversationRollback: boolean,
): string | null {
  if (supportsConversationRollback || targets.length === 0) return null;
  return targets.every((target) => target.code.state === "unavailable")
    ? "This provider can't rewind conversations, and this thread has no file snapshots."
    : null;
}

export function rewindUndoDescription(undo: ThreadRewindUndo): string {
  const removed =
    undo.removedMessageCount === 0
      ? null
      : `${pluralize(undo.removedMessageCount, "message")} ${
          undo.mode === "summarize_from_here" ? "summarized" : "removed"
        }`;
  const restored =
    undo.filesRestored === 0 ? null : `${pluralize(undo.filesRestored, "file")} restored`;
  const parts = undo.mode === "code" ? [restored] : [removed, restored];
  return parts.filter((part) => part !== null).join(" · ");
}
