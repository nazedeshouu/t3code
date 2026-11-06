import * as Schema from "effect/Schema";

import {
  CommandId,
  MessageId,
  NonNegativeInt,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** What a rewind restores. `summarize_from_here` also replaces later turns with a summary. */
export const ThreadRewindMode = Schema.Literals([
  "code_and_conversation",
  "conversation",
  "code",
  "summarize_from_here",
]);
export type ThreadRewindMode = typeof ThreadRewindMode.Type;

export const ThreadRewindCodeStats = Schema.Struct({
  filesChanged: NonNegativeInt,
  insertions: NonNegativeInt,
  deletions: NonNegativeInt,
  /** Shown instead of "N files" when exactly one file changed. */
  primaryPath: Schema.NullOr(TrimmedNonEmptyString),
});
export type ThreadRewindCodeStats = typeof ThreadRewindCodeStats.Type;

/** What the turn itself did to code, for the picker row. */
export const ThreadRewindTurnCode = Schema.Union([
  Schema.Struct({ state: Schema.Literal("changed"), stats: ThreadRewindCodeStats }),
  Schema.Struct({ state: Schema.Literal("unchanged") }),
  /** A snapshot exists but the turn's stats are not known, as while it runs. */
  Schema.Struct({ state: Schema.Literal("pending") }),
  /** No file snapshot exists for this turn, so code cannot be restored to it. */
  Schema.Struct({ state: Schema.Literal("unavailable") }),
]);
export type ThreadRewindTurnCode = typeof ThreadRewindTurnCode.Type;

export const ThreadRewindTarget = Schema.Struct({
  messageId: MessageId,
  runId: RunId,
  /** Single-line prompt preview. */
  text: Schema.String,
  createdAt: Schema.DateTimeUtc,
  code: ThreadRewindTurnCode,
});
export type ThreadRewindTarget = typeof ThreadRewindTarget.Type;

export const ThreadRewindListTargetsInput = Schema.Struct({ threadId: ThreadId });
export type ThreadRewindListTargetsInput = typeof ThreadRewindListTargetsInput.Type;

/** Oldest first. Covers the whole thread, independent of what the timeline has paged in. */
export const ThreadRewindListTargetsResult = Schema.Struct({
  targets: Schema.Array(ThreadRewindTarget),
});
export type ThreadRewindListTargetsResult = typeof ThreadRewindListTargetsResult.Type;

export const ThreadRewindPreviewInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});
export type ThreadRewindPreviewInput = typeof ThreadRewindPreviewInput.Type;

export const ThreadRewindPreview = Schema.Struct({
  messageId: MessageId,
  /** Available options, in display order. "Never mind" is client-only. */
  modes: Schema.Array(ThreadRewindMode),
  /** Target versus disk now. Null when code options are absent from `modes`. */
  code: Schema.NullOr(ThreadRewindCodeStats),
  /** Why code options are absent, when that is worth telling the user. */
  codeUnavailableReason: Schema.NullOr(TrimmedNonEmptyString),
  removedMessageCount: NonNegativeInt,
  /** Another active thread is working in this directory. */
  sharedWorkspaceActive: Schema.Boolean,
});
export type ThreadRewindPreview = typeof ThreadRewindPreview.Type;

/** Present on the thread until its next run starts, on every connected client. */
export const ThreadRewindUndo = Schema.Struct({
  rewindId: CommandId,
  mode: ThreadRewindMode,
  messageId: MessageId,
  removedMessageCount: NonNegativeInt,
  filesRestored: NonNegativeInt,
  createdAt: Schema.DateTimeUtc,
});
export type ThreadRewindUndo = typeof ThreadRewindUndo.Type;

export const ThreadRewindUndoJson = ThreadRewindUndo.mapFields((fields) => ({
  ...fields,
  createdAt: Schema.DateTimeUtcFromString,
}));
