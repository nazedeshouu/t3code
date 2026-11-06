// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CheckpointId,
  CheckpointRef,
  type CommandId,
  ContextHandoffId,
  isProviderTextGenerationCapable,
  latestProviderTurnForAttempt,
  type MessageId,
  OrchestrationV2CheckpointJson,
  OrchestrationV2CheckpointScopeJson,
  type OrchestrationV2ContextHandoff,
  OrchestrationV2ContextHandoffJson,
  type OrchestrationV2DomainEvent,
  OrchestrationV2ExecutionNodeJson,
  type OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderThreadJson,
  OrchestrationV2RunJson,
  type ThreadId,
  type ThreadRewindCodeStats,
  type ThreadRewindListTargetsResult,
  type ThreadRewindMode,
  type ThreadRewindPreview,
  type ThreadRewindTurnCode,
} from "@t3tools/contracts";
import {
  DEFAULT_HANDOFF_TOKEN_CAP,
  historicalMessage,
  renderHistory,
  selectHistory,
} from "@t3tools/provider-core/server/handoffBudget";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { parseTurnDiffFilesFromNumstat } from "../checkpointing/Diffs.ts";
import { CheckpointStore } from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import {
  hasActiveRunInDirectory,
  isCheckpointRestoreIsolated,
  SHARED_WORKSPACE_RESTORE_MESSAGE,
} from "./CheckpointRestoreSafety.ts";
import {
  CheckpointRollbackExecutionError,
  CheckpointRollbackServiceV2,
  type ConversationRollbackInput,
  rollbackFailureClientMessage,
} from "./CheckpointRollbackService.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { visibleConversationItems } from "./ContextHandoffService.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { type ProjectionThreadRewindContext, ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const STASH_DIRECTORY = "rewind-undo";
const RECORD_FILE = "record.json";
const PREVIEW_REFS_PREFIX = "refs/t3/orchestration-v2/rewind-preview";
const UNDO_UNAVAILABLE = "This rewind can no longer be undone.";
const REWIND_FAILED = "The rewind could not finish. Nothing was changed.";
const NO_FILE_CHECKPOINT = "This turn has no file checkpoint, so its code can't be restored.";
const EARLIER_SESSION = "This turn's file checkpoints stayed with an earlier provider session.";
const NO_CONVERSATION = "This thread has no provider conversation to rewind.";
const CODE_NOT_RESTORED = "The conversation was rewound, but the code could not be restored.";
/** Recorded for a path holding anything but a regular file. It never matches at undo. */
const NOT_A_FILE = "not-a-file";

/** A refusal or failure the user sees through `rollbackFailure`. Retrying it would not help. */
export class ThreadRewindError extends Schema.TaggedError<ThreadRewindError>()(
  "ThreadRewindError",
  {
    threadId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const isThreadRewindError = Schema.is(ThreadRewindError);
const isRollbackError = Schema.is(CheckpointRollbackExecutionError);
const isRewindFilesError = Schema.is(ProviderAdapter.ProviderAdapterRewindFilesError);

const StashedFile = Schema.Struct({
  path: Schema.String,
  /** Stash entry holding the pre-rewind bytes. Null records that the file did not exist. */
  blob: Schema.NullOr(Schema.String),
  mode: Schema.NullOr(Schema.Number),
});

/** What a rewind left at a stashed path. Undo overwrites nothing that has moved on from this. */
const RestoredFile = Schema.Struct({
  path: Schema.String,
  /** Null records that the rewind left nothing here. */
  hash: Schema.NullOr(Schema.String),
  parent: Schema.String,
});

/** Everything undo needs, written once before the rewind mutates anything. */
const RewindUndoRecord = Schema.Struct({
  filesRestored: Schema.Number,
  files: Schema.Array(StashedFile),
  /** Filled in once the provider has restored the files. */
  restored: Schema.Array(RestoredFile),
  scope: Schema.NullOr(OrchestrationV2CheckpointScopeJson),
  /** Null when the conversation was left alone. */
  providerThread: Schema.NullOr(OrchestrationV2ProviderThreadJson),
  /** What the native rollback returned, so a replay never rolls an already short thread back. */
  rolledBackTo: Schema.NullOr(OrchestrationV2ProviderThreadJson),
  runs: Schema.Array(OrchestrationV2RunJson),
  nodes: Schema.Array(OrchestrationV2ExecutionNodeJson),
  checkpoints: Schema.Array(OrchestrationV2CheckpointJson),
  summary: Schema.NullOr(Schema.Struct({ text: Schema.String, handoffId: ContextHandoffId })),
  /** Earlier summaries of turns after this rewind's cut. Undo puts them back. */
  supersededSummaryIds: Schema.Array(ContextHandoffId),
  /** Earlier summaries whose receiving run this rewind dropped, as they were. Undo puts them back. */
  redeliveredSummaries: Schema.Array(OrchestrationV2ContextHandoffJson),
});
type RewindUndoRecord = typeof RewindUndoRecord.Type;
const decodeRecord = Schema.decodeEffect(Schema.fromJsonString(RewindUndoRecord));
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(RewindUndoRecord));

export interface ThreadRewindServiceShape {
  readonly listTargets: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadRewindListTargetsResult, ThreadRewindError>;
  readonly preview: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) => Effect.Effect<ThreadRewindPreview, ThreadRewindError>;
  readonly rewind: (input: {
    readonly threadId: ThreadId;
    readonly rewindId: CommandId;
    readonly messageId: MessageId;
    readonly mode: ThreadRewindMode;
    readonly summaryInstructions?: string;
  }) => Effect.Effect<void, ThreadRewindError>;
  readonly undo: (input: {
    readonly threadId: ThreadId;
    readonly rewindId: CommandId;
  }) => Effect.Effect<void, ThreadRewindError>;
  /** Ends the undo window, dropping its stash and the refs it kept. */
  readonly expireUndo: (threadId: ThreadId) => Effect.Effect<void, ThreadRewindError>;
}

export class ThreadRewindService extends Context.Service<
  ThreadRewindService,
  ThreadRewindServiceShape
>()("t3/orchestration-v2/ThreadRewindService") {}

const singleLine = (text: string) => text.replace(/\s+/g, " ").trim();

const pathKey = (id: string) => Base64Url.encode(new TextEncoder().encode(id));

const noneIfMissing = <A, R>(effect: Effect.Effect<A, PlatformError.PlatformError, R>) =>
  effect.pipe(
    Effect.asSome,
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeedNone,
    ),
  );

type CodeEngine =
  | { readonly type: "provider"; readonly providerTurn: ProviderTurn }
  | {
      readonly type: "git";
      readonly scope: NonNullable<ProjectionThreadRewindContext["scope"]>;
      readonly checkpoint: NonNullable<ProjectionThreadRewindContext["checkpoint"]>;
    }
  | { readonly type: "unavailable"; readonly reason: string };

type ProviderTurn = NonNullable<ProjectionThreadRewindContext["promptTurn"]>;

/** Opened on first use: a git restore needs none, and the picker may name another provider. */
type RewindSession = Effect.Effect<
  ProviderAdapter.ProviderAdapterV2SessionRuntime,
  CheckpointRollbackExecutionError
>;

interface LoadedRewind {
  readonly context: ProjectionThreadRewindContext;
  readonly providerThread: NonNullable<ProjectionThreadRewindContext["providerThread"]>;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly rollback: ConversationRollbackInput;
}

const conversationBlock = ({ context, providerThread, capabilities }: LoadedRewind) => {
  // A queued or imported provider thread has no session to roll back in.
  if (providerThread.providerSessionId === null) return NO_CONVERSATION;
  if (
    !capabilities.threads.canRollbackThread ||
    !capabilities.checkpointing.providerCanRollbackConversation ||
    !capabilities.checkpointing.providerRollbackReturnsSnapshot
  ) {
    return "This provider can't rewind its conversation.";
  }
  if (providerThread.providerInstanceId !== context.thread.modelSelection.instanceId) {
    return "This thread moved to another provider, so its earlier conversation can't be rewound.";
  }
  if (context.targetOrdinal > 0) {
    const kept =
      latestProviderTurnForAttempt(context.providerTurns, context.targetAttempt?.id) ??
      context.providerTurns.find((turn) => turn.id === context.targetAttempt?.providerTurnId);
    if (kept?.providerThreadId !== providerThread.id) {
      return "The provider no longer has this point in the conversation.";
    }
  }
  return null;
};

export const layer = Layer.effect(
  ThreadRewindService,
  Effect.gen(function* () {
    const adapters = yield* ProviderAdapterRegistryV2;
    const checkpointStore = yield* CheckpointStore;
    const checkpoints = yield* CheckpointServiceV2;
    const config = yield* ServerConfig.ServerConfig;
    const eventSink = yield* EventSinkV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const path = yield* Path.Path;
    const projections = yield* ProjectionStoreV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const rollback = yield* CheckpointRollbackServiceV2;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const textGeneration = yield* TextGeneration.TextGeneration;
    const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;

    const refuse = (threadId: ThreadId, detail: string, cause?: unknown) =>
      new ThreadRewindError({
        threadId,
        detail,
        ...(cause === undefined ? {} : { cause }),
      });

    /** Maps anything unexpected to `detail`, keeping the specific reasons it already carries. */
    const failWith =
      (threadId: ThreadId, detail: string) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.mapError((cause) => {
            if (isThreadRewindError(cause)) return cause;
            if (isRollbackError(cause)) {
              return refuse(threadId, rollbackFailureClientMessage(cause), cause);
            }
            if (isRewindFilesError(cause)) return refuse(threadId, cause.detail, cause);
            return refuse(threadId, detail, cause);
          }),
        );

    const relativeTo = (cwd: string | null | undefined, filePath: string) => {
      if (cwd == null) return filePath;
      const relative = path.relative(cwd, filePath);
      return relative.startsWith("..") || path.isAbsolute(relative) ? filePath : relative;
    };

    const stashDirectory = (threadId: ThreadId, rewindId: CommandId) =>
      path.join(config.stateDir, STASH_DIRECTORY, pathKey(threadId), pathKey(rewindId));

    const readRecord = Effect.fnUntraced(function* (threadId: ThreadId, rewindId: CommandId) {
      const file = path.join(stashDirectory(threadId, rewindId), RECORD_FILE);
      if (!(yield* fileSystem.exists(file))) return Option.none<RewindUndoRecord>();
      return Option.some(yield* decodeRecord(yield* fileSystem.readFileString(file)));
    });

    // Written beside its final path and renamed, so a retry after a restore sees the first copy
    // whole and can never stash restored content.
    const writeRecord = Effect.fnUntraced(function* (
      threadId: ThreadId,
      rewindId: CommandId,
      filesChanged: ReadonlyArray<string>,
      record: Omit<RewindUndoRecord, "files">,
    ) {
      const directory = stashDirectory(threadId, rewindId);
      const partial = `${directory}.partial`;
      yield* fileSystem.remove(partial, { recursive: true, force: true });
      yield* fileSystem.makeDirectory(partial, { recursive: true });
      const files = yield* Effect.forEach(filesChanged, (filePath, index) =>
        Effect.gen(function* () {
          const isLink = yield* fileSystem.readLink(filePath).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          if (isLink) return [];
          const info = yield* fileSystem.stat(filePath).pipe(
            Effect.asSome,
            Effect.catchIf(
              (error) => error.reason._tag === "NotFound",
              () => Effect.succeedNone,
            ),
          );
          if (Option.isNone(info)) return [{ path: filePath, blob: null, mode: null }];
          if (info.value.type !== "File") return [];
          const blob = String(index);
          yield* fileSystem.copyFile(filePath, path.join(partial, blob));
          return [{ path: filePath, blob, mode: info.value.mode }];
        }),
      );
      const complete = { ...record, files: files.flat() };
      yield* fileSystem.writeFileString(
        path.join(partial, RECORD_FILE),
        yield* encodeRecord(complete),
      );
      yield* fileSystem.rename(partial, directory);
      return complete;
    });

    // Renamed into place, so a crash leaves the record whole.
    const saveRecord = Effect.fnUntraced(function* (
      threadId: ThreadId,
      rewindId: CommandId,
      record: RewindUndoRecord,
    ) {
      const directory = stashDirectory(threadId, rewindId);
      const partial = path.join(directory, `${RECORD_FILE}.partial`);
      yield* fileSystem.writeFileString(partial, yield* encodeRecord(record));
      yield* fileSystem.rename(partial, path.join(directory, RECORD_FILE));
    });

    const fileState = Effect.fnUntraced(function* (filePath: string) {
      const info = yield* noneIfMissing(fileSystem.lstat(filePath));
      if (Option.isNone(info)) return null;
      if (info.value.type !== "File") return NOT_A_FILE;
      const bytes = yield* fileSystem.readFile(filePath);
      return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    });

    /** Resolves through the nearest surviving ancestor, as a rewind may have removed the parent. */
    const realParent = Effect.fnUntraced(function* (filePath: string) {
      let directory = path.dirname(filePath);
      let missing = "";
      while (true) {
        const real = yield* noneIfMissing(fileSystem.realPath(directory));
        if (Option.isSome(real)) return path.join(real.value, missing);
        missing = path.join(path.basename(directory), missing);
        directory = path.dirname(directory);
      }
    });

    const recordRestoredFiles = Effect.fnUntraced(function* (
      threadId: ThreadId,
      rewindId: CommandId,
      record: RewindUndoRecord,
    ) {
      const restored = yield* Effect.forEach(record.files, (file) =>
        Effect.all({
          path: Effect.succeed(file.path),
          hash: fileState(file.path),
          parent: realParent(file.path),
        }),
      );
      const complete = { ...record, restored };
      yield* saveRecord(threadId, rewindId, complete);
      return complete;
    });

    const refuseChangedFiles = Effect.fnUntraced(function* (
      threadId: ThreadId,
      rewindId: CommandId,
      cwd: string | null | undefined,
      record: RewindUndoRecord,
    ) {
      yield* Effect.forEach(
        record.restored,
        (file) =>
          Effect.gen(function* () {
            const name = relativeTo(cwd, file.path);
            const changed = `${name} changed after the rewind, so Undo would overwrite it.`;
            const blob = record.files.find(({ path }) => path === file.path)?.blob;
            const { parent, hash, undone } = yield* Effect.all({
              parent: realParent(file.path),
              hash: fileState(file.path),
              // A replay finds what an interrupted undo already put back.
              undone:
                blob == null
                  ? Effect.succeed(null)
                  : fileState(path.join(stashDirectory(threadId, rewindId), blob)),
            }).pipe(Effect.mapError((cause) => refuse(threadId, changed, cause)));
            if (parent !== file.parent) {
              return yield* refuse(
                threadId,
                `The folder holding ${name} moved after the rewind, so Undo can't restore it.`,
              );
            }
            if (hash === NOT_A_FILE || (hash !== file.hash && hash !== undone)) {
              return yield* refuse(threadId, changed);
            }
          }),
        { discard: true },
      );
    });

    const restoreFiles = Effect.fnUntraced(function* (
      threadId: ThreadId,
      rewindId: CommandId,
      record: RewindUndoRecord,
    ) {
      const directory = stashDirectory(threadId, rewindId);
      yield* Effect.forEach(
        record.files,
        (file) =>
          file.blob === null
            ? fileSystem.remove(file.path, { force: true })
            : Effect.gen(function* () {
                const parent = path.dirname(file.path);
                yield* fileSystem.makeDirectory(parent, { recursive: true });
                // Renamed into place, so a link at the path is replaced instead of followed.
                const temporary = path.join(parent, `.t3-rewind-${NodeCrypto.randomUUID()}`);
                yield* Effect.gen(function* () {
                  yield* fileSystem.copyFile(path.join(directory, file.blob ?? ""), temporary);
                  if (file.mode !== null) yield* fileSystem.chmod(temporary, file.mode);
                  yield* fileSystem.rename(temporary, file.path);
                }).pipe(
                  Effect.onError(() =>
                    fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore),
                  ),
                );
              }),
        { discard: true },
      );
    });

    const removeRecord = (threadId: ThreadId, rewindId: CommandId) =>
      fileSystem.remove(stashDirectory(threadId, rewindId), { recursive: true, force: true });

    const expireRecord = Effect.fnUntraced(function* (threadId: ThreadId, rewindId: CommandId) {
      const record = yield* readRecord(threadId, rewindId);
      if (Option.isNone(record)) return;
      if (record.value.scope !== null && record.value.checkpoints.length > 0) {
        yield* checkpoints
          .deleteStaleRefs({ scope: record.value.scope, checkpoints: record.value.checkpoints })
          .pipe(Effect.ignore);
      }
      yield* removeRecord(threadId, rewindId);
    });

    const load = Effect.fnUntraced(function* (threadId: ThreadId, messageId: MessageId) {
      const context = yield* projections.getThreadRewindContext(threadId, messageId);
      if (context === undefined) {
        return yield* refuse(threadId, "This message is no longer part of the thread.");
      }
      const { providerThread } = context;
      if (providerThread === undefined) {
        return yield* refuse(threadId, NO_CONVERSATION);
      }
      const adapter = yield* adapters.get(context.thread.modelSelection.instanceId);
      return {
        context,
        providerThread,
        capabilities: yield* adapter.getCapabilities(),
        rollback: {
          context,
          providerThread,
          // Adapters only label errors with it, and a run stopped before its first capture has none.
          checkpointId: context.checkpoint?.id ?? CheckpointId.make(`rewind:${messageId}`),
          targetOrdinal: context.targetOrdinal,
        },
      } satisfies LoadedRewind;
    });

    const codeEngine = Effect.fnUntraced(function* (loaded: LoadedRewind) {
      const { context, providerThread, capabilities } = loaded;
      if (capabilities.checkpointing.providerCanRewindFiles === true) {
        const providerTurn = context.promptTurn;
        if (providerTurn === undefined) {
          return { type: "unavailable", reason: NO_FILE_CHECKPOINT } satisfies CodeEngine;
        }
        return providerTurn.providerThreadId === providerThread.id &&
          providerThread.providerInstanceId === context.thread.modelSelection.instanceId
          ? ({ type: "provider", providerTurn } satisfies CodeEngine)
          : ({ type: "unavailable", reason: EARLIER_SESSION } satisfies CodeEngine);
      }
      const { checkpoint, scope } = context;
      if (scope === undefined || checkpoint?.status !== "ready") {
        return {
          type: "unavailable",
          reason: "No checkpoint exists for this point. Checkpoints need a git repository.",
        } satisfies CodeEngine;
      }
      const isolated = yield* isCheckpointRestoreIsolated(context.thread, scope, {
        fileSystem,
        projections,
        projects,
        path,
      });
      return isolated
        ? ({ type: "git", scope, checkpoint } satisfies CodeEngine)
        : ({ type: "unavailable", reason: SHARED_WORKSPACE_RESTORE_MESSAGE } satisfies CodeEngine);
    });

    /** Paths and line counts a restore would change. `from` holds the state to compare. */
    const diffGit = Effect.fnUntraced(function* (
      engine: Extract<CodeEngine, { readonly type: "git" }>,
      from: CheckpointRef,
    ) {
      const numstat = yield* checkpointStore.diffCheckpoints({
        cwd: engine.scope.cwd,
        fromCheckpointRef: from,
        toCheckpointRef: engine.checkpoint.ref,
        ignoreWhitespace: false,
        format: "numstat",
      });
      const files = parseTurnDiffFilesFromNumstat(numstat);
      return {
        paths: files.map((file) => file.path),
        insertions: files.reduce((sum, file) => sum + file.additions, 0),
        deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      };
    });

    const providerDryRun = Effect.fnUntraced(function* (
      loaded: LoadedRewind,
      engine: Extract<CodeEngine, { readonly type: "provider" }>,
      session: ProviderAdapter.ProviderAdapterV2SessionRuntime,
    ) {
      if (session.rewindFiles === undefined) {
        return yield* refuse(loaded.context.thread.id, NO_FILE_CHECKPOINT);
      }
      const result = yield* session.rewindFiles({
        providerThread: loaded.providerThread,
        providerTurn: engine.providerTurn,
        dryRun: true,
      });
      if (!result.canRewind) {
        return yield* refuse(loaded.context.thread.id, result.reason ?? NO_FILE_CHECKPOINT);
      }
      return result;
    });

    const relativeToScope = (loaded: LoadedRewind, filePath: string) =>
      relativeTo(loaded.context.scope?.cwd ?? loaded.context.thread.worktreePath, filePath);

    const measureCode = Effect.fnUntraced(function* (loaded: LoadedRewind, engine: CodeEngine) {
      if (engine.type === "unavailable")
        return yield* refuse(loaded.context.thread.id, engine.reason);
      if (engine.type === "provider") {
        const session = yield* rollback.openSession(loaded.rollback);
        const result = yield* providerDryRun(loaded, engine, session);
        return {
          paths: result.filesChanged.map((filePath) => relativeToScope(loaded, filePath)),
          insertions: result.insertions,
          deletions: result.deletions,
        };
      }
      const ref = CheckpointRef.make(
        `${PREVIEW_REFS_PREFIX}/${pathKey(loaded.context.thread.id)}/${NodeCrypto.randomUUID()}`,
      );
      const cwd = engine.scope.cwd;
      yield* checkpointStore.captureCheckpoint({ cwd, checkpointRef: ref });
      return yield* diffGit(engine, ref).pipe(
        Effect.ensuring(
          checkpointStore.deleteCheckpointRefs({ cwd, checkpointRefs: [ref] }).pipe(Effect.ignore),
        ),
      );
    });

    const handoffEvent = Effect.fnUntraced(function* (
      handoff: OrchestrationV2ContextHandoff,
      now: DateTime.Utc,
    ) {
      const { threadId } = handoff;
      return {
        id: yield* ids.allocate.event({ threadId }),
        type: "context-handoff.updated",
        threadId,
        runId: handoff.targetRunId,
        ...(handoff.createdByProviderInstanceId === null
          ? {}
          : { providerInstanceId: handoff.createdByProviderInstanceId }),
        occurredAt: now,
        payload: { ...handoff, updatedAt: now },
      } satisfies OrchestrationV2DomainEvent;
    });

    const handoffStatusEvents = Effect.fnUntraced(function* (
      threadId: ThreadId,
      handoffId: ContextHandoffId,
      status: "ready" | "superseded",
      now: DateTime.Utc,
    ) {
      const { contextHandoffs } = yield* projections.getThreadRecords(threadId, [
        "contextHandoffs",
      ]);
      const handoff = contextHandoffs.find((candidate) => candidate.id === handoffId);
      return handoff === undefined ? [] : [yield* handoffEvent({ ...handoff, status }, now)];
    });

    const canSummarize = Effect.fnUntraced(function* (context: ProjectionThreadRewindContext) {
      const selection = resolveProjectSettings(
        yield* serverSettings.getSettings,
        context.thread.projectId,
      ).settings.textGenerationModelSelection;
      const instance = yield* instances.getInstance(selection.instanceId);
      return (
        instance !== undefined &&
        isProviderTextGenerationCapable(yield* instance.snapshot.getSnapshot)
      );
    });

    const summarize = Effect.fnUntraced(function* (
      context: ProjectionThreadRewindContext,
      instructions: string | undefined,
    ) {
      const threadId = context.thread.id;
      const records = yield* projections.getThreadRecords(
        threadId,
        ["turnItems", "runs", "attempts"],
        { turnItemRunIds: context.runsToRollback.map((run) => run.id) },
      );
      const selected = selectHistory({
        messages: visibleConversationItems(records, records.turnItems).flatMap((item) => {
          const message = historicalMessage(item);
          return message === null ? [] : [message];
        }),
        coverage: "The turns being replaced, oldest first.",
        budget: DEFAULT_HANDOFF_TOKEN_CAP,
      });
      const project = yield* projects.get(context.thread.projectId);
      const settings = resolveProjectSettings(
        yield* serverSettings.getSettings,
        context.thread.projectId,
      ).settings;
      const worktreePath = context.thread.worktreePath;
      const cwd =
        worktreePath !== null && (yield* fileSystem.exists(worktreePath))
          ? worktreePath
          : Option.isSome(project)
            ? project.value.workspaceRoot
            : (context.scope?.cwd ?? config.stateDir);
      const { summary } = yield* textGeneration
        .generateThreadSummary({
          cwd,
          history: renderHistory(selected.messages, selected.context),
          instructions,
          modelSelection: settings.textGenerationModelSelection,
          projectId: context.thread.projectId,
        })
        .pipe(
          Effect.mapError((cause) =>
            refuse(threadId, "The summary could not be generated, so nothing was changed.", cause),
          ),
        );
      const text = summary.trim();
      if (text === "") {
        return yield* refuse(threadId, "The summary came back empty, so nothing was changed.");
      }
      return text;
    });

    const createRecord = Effect.fnUntraced(function* (
      loaded: LoadedRewind,
      input: Parameters<ThreadRewindServiceShape["rewind"]>[0],
      engine: CodeEngine | undefined,
      session: RewindSession,
    ) {
      const { context, providerThread } = loaded;
      const rollsBack = input.mode !== "code";
      const summary =
        input.mode === "summarize_from_here"
          ? {
              text: yield* summarize(context, input.summaryInstructions),
              handoffId: yield* ids.allocate.contextHandoff({
                threadId: input.threadId,
                fromProviderInstanceId: providerThread.providerInstanceId,
                toProviderInstanceId: providerThread.providerInstanceId,
              }),
            }
          : null;
      const { contextHandoffs } = yield* projections.getThreadRecords(input.threadId, [
        "contextHandoffs",
      ]);
      // A summary stands where its turns were, and the first kept run after them received it.
      const summaries = contextHandoffs.filter(
        (handoff) =>
          rollsBack && handoff.strategy === "checkpoint_summary" && handoff.status === "ready",
      );
      const cutsBefore = ({ coveredRunOrdinals }: OrchestrationV2ContextHandoff) =>
        context.targetRun.ordinal < coveredRunOrdinals.from;
      let filesChanged: ReadonlyArray<string> = [];
      if (engine?.type === "provider") {
        filesChanged = (yield* providerDryRun(loaded, engine, yield* session)).filesChanged;
      }
      return yield* writeRecord(input.threadId, input.rewindId, filesChanged, {
        filesRestored: filesChanged.length,
        restored: [],
        scope: context.scope ?? null,
        providerThread: rollsBack ? providerThread : null,
        rolledBackTo: null,
        runs: rollsBack ? context.runsToRollback : [],
        nodes: rollsBack ? context.rootNodes : [],
        checkpoints: rollsBack ? context.staleCheckpoints : [],
        summary,
        supersededSummaryIds: summaries.filter(cutsBefore).map((handoff) => handoff.id),
        redeliveredSummaries: summaries.filter(
          (handoff) =>
            !cutsBefore(handoff) &&
            handoff.delivery !== undefined &&
            context.targetOrdinal <= handoff.coveredRunOrdinals.to,
        ),
      });
    });

    const restoreCode = Effect.fnUntraced(function* (
      loaded: LoadedRewind,
      engine: Extract<CodeEngine, { readonly type: "provider" }>,
      session: RewindSession,
    ) {
      const threadId = loaded.context.thread.id;
      const { rewindFiles } = yield* session;
      if (rewindFiles === undefined) return yield* refuse(threadId, NO_FILE_CHECKPOINT);
      const result = yield* rewindFiles({
        providerThread: loaded.providerThread,
        providerTurn: engine.providerTurn,
        dryRun: false,
      });
      if (!result.canRewind) {
        return yield* refuse(threadId, result.reason ?? "The code could not be restored.");
      }
    });

    const rollbackOnce = Effect.fnUntraced(function* (
      loaded: LoadedRewind,
      input: Parameters<ThreadRewindServiceShape["rewind"]>[0],
      record: RewindUndoRecord,
      session: RewindSession,
    ) {
      if (record.rolledBackTo !== null) {
        return {
          providerThread: record.rolledBackTo,
          providerTurns: [],
          messages: [],
          runtimeRequests: [],
        } satisfies ProviderAdapter.ProviderAdapterV2ThreadSnapshot;
      }
      const snapshot = yield* rollback.rollbackConversation({
        ...loaded.rollback,
        session: yield* session,
      });
      yield* saveRecord(input.threadId, input.rewindId, {
        ...record,
        rolledBackTo: snapshot.providerThread,
      });
      return snapshot;
    });

    const applyRewind = Effect.fnUntraced(function* (
      input: Parameters<ThreadRewindServiceShape["rewind"]>[0],
    ) {
      const { threadId, rewindId } = input;
      const loaded: LoadedRewind = yield* load(threadId, input.messageId);
      const { context, providerThread, capabilities } = loaded;
      const undoable = capabilities.checkpointing.providerCanRewindFiles === true;

      const restoresCode = input.mode === "code" || input.mode === "code_and_conversation";
      const rollsBack = input.mode !== "code";
      const blocked = rollsBack ? conversationBlock(loaded) : null;
      if (blocked !== null) return yield* refuse(threadId, blocked);

      yield* rollback.ensureWorktree(context.thread);
      const engine = restoresCode ? yield* codeEngine(loaded) : undefined;
      if (engine?.type === "unavailable") return yield* refuse(threadId, engine.reason);
      const session = yield* Effect.cached(rollback.openSession(loaded.rollback));

      const existing = yield* readRecord(threadId, rewindId);
      const stashed = Option.isSome(existing)
        ? existing.value
        : yield* createRecord(loaded, input, engine, session);

      const previousRewindId = context.thread.rewindUndo?.rewindId;
      // The conversation stays untouched unless the provider's files are safely back, and a later
      // failure puts them back. A native rollback can't be taken back and git keeps no copy of the
      // files, so git restores last and its failure is reported once the rollback is on record.
      if (engine?.type === "provider") yield* restoreCode(loaded, engine, session);
      const record =
        engine?.type === "provider"
          ? yield* recordRestoredFiles(threadId, rewindId, stashed)
          : stashed;
      const snapshot = rollsBack ? yield* rollbackOnce(loaded, input, record, session) : undefined;
      const gitRestore = yield* Effect.exit(
        engine?.type === "git"
          ? checkpoints.restore({ scope: engine.scope, checkpoint: engine.checkpoint })
          : Effect.void,
      );
      if (snapshot === undefined) yield* gitRestore;
      yield* threadCommands.withLock(
        threadId,
        Effect.gen(function* () {
          const thread = yield* projections.getThread(threadId);
          const now = yield* DateTime.now;
          const events: Array<OrchestrationV2DomainEvent> = [
            {
              id: yield* ids.allocate.event({ threadId }),
              type: "thread.metadata-updated",
              threadId,
              providerInstanceId: thread.providerInstanceId,
              occurredAt: now,
              payload: {
                ...thread,
                lastRewindId: rewindId,
                rewindUndo: undoable
                  ? {
                      rewindId,
                      mode: input.mode,
                      messageId: input.messageId,
                      removedMessageCount: rollsBack ? context.removedMessageCount : 0,
                      filesRestored: record.filesRestored,
                      createdAt: now,
                    }
                  : null,
                updatedAt: now,
              },
            },
          ];
          if (snapshot !== undefined) {
            events.push(...(yield* rollback.rollbackEvents({ ...loaded.rollback, snapshot })));
          }
          if (snapshot !== undefined) {
            for (const handoffId of record.supersededSummaryIds) {
              events.push(...(yield* handoffStatusEvents(threadId, handoffId, "superseded", now)));
            }
            for (const handoff of record.redeliveredSummaries) {
              events.push(yield* handoffEvent({ ...handoff, delivery: undefined }, now));
            }
          }
          if (snapshot !== undefined && record.summary !== null) {
            const ordinals = context.runsToRollback.map((run) => run.ordinal);
            events.push({
              id: yield* ids.allocate.event({ threadId }),
              type: "context-handoff.updated",
              threadId,
              runId: context.targetRun.id,
              providerInstanceId: providerThread.providerInstanceId,
              occurredAt: now,
              payload: {
                id: record.summary.handoffId,
                transferId: null,
                threadId,
                targetRunId: context.targetRun.id,
                fromProviderThreadIds: [providerThread.id],
                toProviderThreadId: snapshot.providerThread.id,
                coveredRunOrdinals: { from: Math.min(...ordinals), to: Math.max(...ordinals) },
                strategy: "checkpoint_summary",
                status: "ready",
                summaryMessageId: null,
                summaryText: record.summary.text,
                createdByProviderInstanceId: providerThread.providerInstanceId,
                createdAt: now,
                updatedAt: now,
              },
            });
          }
          yield* eventSink.write({ events });
        }),
      );
      if (!undoable) yield* expireRecord(threadId, rewindId).pipe(Effect.ignore);
      if (previousRewindId !== undefined && previousRewindId !== rewindId) {
        yield* expireRecord(threadId, previousRewindId).pipe(Effect.ignore);
      }
      yield* gitRestore.pipe(
        Effect.mapError((cause) => refuse(threadId, CODE_NOT_RESTORED, cause)),
      );
    });

    // Runs for any failure, since an earlier attempt that crashed may have restored files.
    const putBack = (threadId: ThreadId, rewindId: CommandId) =>
      readRecord(threadId, rewindId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (record) =>
              restoreFiles(threadId, rewindId, record).pipe(
                Effect.andThen(removeRecord(threadId, rewindId)),
              ),
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to put a rewind back", { threadId, rewindId, cause }),
        ),
      );

    const applyUndo = Effect.fnUntraced(function* (input: {
      readonly threadId: ThreadId;
      readonly rewindId: CommandId;
    }) {
      const { threadId, rewindId } = input;
      const current = yield* projections.getThread(threadId);
      if (current.rewindUndo?.rewindId !== rewindId) return;
      const found = yield* readRecord(threadId, rewindId);
      if (Option.isNone(found)) return yield* refuse(threadId, UNDO_UNAVAILABLE);
      const record = found.value;

      if (record.files.length > 0) {
        yield* rollback.ensureWorktree(current);
        const { worktreePath } = current;
        if (worktreePath != null && !(yield* fileSystem.exists(worktreePath))) {
          return yield* refuse(threadId, UNDO_UNAVAILABLE);
        }
      }
      yield* refuseChangedFiles(
        threadId,
        rewindId,
        record.scope?.cwd ?? current.worktreePath,
        record,
      );
      yield* restoreFiles(threadId, rewindId, record);
      yield* threadCommands.withLock(
        threadId,
        Effect.gen(function* () {
          const thread = yield* projections.getThread(threadId);
          const now = yield* DateTime.now;
          const providerInstanceId = record.providerThread?.providerInstanceId;
          const events: Array<OrchestrationV2DomainEvent> = [
            {
              id: yield* ids.allocate.event({ threadId }),
              type: "thread.metadata-updated",
              threadId,
              providerInstanceId: thread.providerInstanceId,
              occurredAt: now,
              payload: { ...thread, rewindUndo: null, rollbackFailure: null, updatedAt: now },
            },
          ];
          // Restoring this row also makes it the active provider thread again.
          if (record.providerThread !== null && providerInstanceId !== undefined) {
            events.push({
              id: yield* ids.allocate.event({ threadId }),
              type: "provider-thread.updated",
              threadId,
              driver: record.providerThread.driver,
              providerInstanceId,
              occurredAt: now,
              payload: { ...record.providerThread, updatedAt: now },
            });
          }
          for (const checkpoint of record.checkpoints) {
            events.push({
              id: yield* ids.allocate.event({ threadId }),
              type: "checkpoint.captured",
              threadId,
              ...(checkpoint.runId === null ? {} : { runId: checkpoint.runId }),
              nodeId: checkpoint.nodeId,
              providerInstanceId: providerInstanceId ?? thread.providerInstanceId,
              occurredAt: now,
              payload: checkpoint,
            });
          }
          for (const run of record.runs) {
            const rootNode = record.nodes.find((candidate) => candidate.id === run.rootNodeId);
            events.push({
              id: yield* ids.allocate.event({ threadId }),
              type: "run.updated",
              threadId,
              runId: run.id,
              ...(rootNode === undefined ? {} : { nodeId: rootNode.id }),
              providerInstanceId: run.providerInstanceId,
              occurredAt: now,
              payload: run,
            });
            if (rootNode !== undefined) {
              events.push({
                id: yield* ids.allocate.event({ threadId }),
                type: "node.updated",
                threadId,
                runId: run.id,
                nodeId: rootNode.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: rootNode,
              });
            }
          }
          // A client that loaded the thread after the rewind never received these items.
          if (record.runs.length > 0) {
            const { turnItems } = yield* projections.getThreadRecords(threadId, ["turnItems"], {
              turnItemRunIds: record.runs.map((run) => run.id),
            });
            for (const item of turnItems) {
              events.push({
                id: yield* ids.allocate.event({ threadId }),
                type: "turn-item.updated",
                threadId,
                ...(item.runId === null ? {} : { runId: item.runId }),
                providerInstanceId: providerInstanceId ?? thread.providerInstanceId,
                occurredAt: now,
                payload: item,
              });
            }
          }
          if (record.summary !== null) {
            events.push(
              ...(yield* handoffStatusEvents(
                threadId,
                record.summary.handoffId,
                "superseded",
                now,
              )),
            );
          }
          for (const handoffId of record.supersededSummaryIds) {
            events.push(...(yield* handoffStatusEvents(threadId, handoffId, "ready", now)));
          }
          for (const handoff of record.redeliveredSummaries) {
            events.push(yield* handoffEvent(handoff, now));
          }
          yield* eventSink.write({ events });
        }),
      );
      yield* removeRecord(threadId, rewindId);
    });

    const onThreadWorkspace = <A, E, R>(
      thread: { readonly worktreePath: string | null },
      effect: Effect.Effect<A, E, R>,
    ) =>
      thread.worktreePath === null
        ? effect
        : withWorkspaceLease(path.resolve(thread.worktreePath), effect);

    const rewind = Effect.fn("ThreadRewindService.rewind")(
      function* (input: Parameters<ThreadRewindServiceShape["rewind"]>[0]) {
        const thread = yield* projections.getThread(input.threadId);
        // At-least-once delivery: the run is already rolled back, so `load` would refuse this.
        if (thread.lastRewindId === input.rewindId) {
          // A one-way rewind may have stopped before dropping its record.
          if (thread.rewindUndo?.rewindId !== input.rewindId) {
            yield* expireRecord(input.threadId, input.rewindId);
          }
          return;
        }
        yield* onThreadWorkspace(
          thread,
          applyRewind(input).pipe(Effect.tapError(() => putBack(input.threadId, input.rewindId))),
        );
      },
      (effect, input) => effect.pipe(failWith(input.threadId, REWIND_FAILED)),
    );

    const undo = Effect.fn("ThreadRewindService.undo")(
      function* (input: Parameters<ThreadRewindServiceShape["undo"]>[0]) {
        const thread = yield* projections.getThread(input.threadId);
        yield* onThreadWorkspace(thread, applyUndo(input));
      },
      (effect, input) => effect.pipe(failWith(input.threadId, "The rewind could not be undone.")),
    );

    const expireUndo = Effect.fn("ThreadRewindService.expireUndo")(
      function* (threadId: ThreadId) {
        const expired = yield* threadCommands.withLock(
          threadId,
          Effect.gen(function* () {
            const thread = yield* projections.getThread(threadId);
            if (thread.rewindUndo == null) return undefined;
            const now = yield* DateTime.now;
            yield* eventSink.write({
              events: [
                {
                  id: yield* ids.allocate.event({ threadId }),
                  type: "thread.metadata-updated",
                  threadId,
                  providerInstanceId: thread.providerInstanceId,
                  occurredAt: now,
                  payload: { ...thread, rewindUndo: null, updatedAt: now },
                },
              ],
            });
            return thread.rewindUndo.rewindId;
          }),
        );
        if (expired !== undefined) yield* expireRecord(threadId, expired);
      },
      (effect, threadId) => effect.pipe(failWith(threadId, UNDO_UNAVAILABLE)),
    );

    const previewRewind = Effect.fn("ThreadRewindService.preview")(
      function* (input: { readonly threadId: ThreadId; readonly messageId: MessageId }) {
        const loaded: LoadedRewind = yield* load(input.threadId, input.messageId);
        const { context } = loaded;
        const code: { stats: ThreadRewindCodeStats | null; reason: string | null } =
          yield* codeEngine(loaded).pipe(
            Effect.flatMap((engine) => measureCode(loaded, engine)),
            Effect.map((measured) => ({
              stats:
                measured.paths.length === 0
                  ? null
                  : {
                      filesChanged: measured.paths.length,
                      insertions: measured.insertions,
                      deletions: measured.deletions,
                      primaryPath: measured.paths.length === 1 ? (measured.paths[0] ?? null) : null,
                    },
              reason: null,
            })),
            failWith(input.threadId, "The code for this turn can't be read right now."),
            Effect.catch((cause) => Effect.succeed({ stats: null, reason: cause.detail })),
          );
        const canRollBack = conversationBlock(loaded) === null;
        const summarizable =
          canRollBack &&
          context.runsToRollback.length > 1 &&
          (yield* canSummarize(context).pipe(Effect.orElseSucceed(() => false)));
        const modes: Array<ThreadRewindMode> = [
          ...(code.stats !== null && canRollBack ? (["code_and_conversation"] as const) : []),
          ...(canRollBack ? (["conversation"] as const) : []),
          ...(code.stats !== null ? (["code"] as const) : []),
          ...(summarizable ? (["summarize_from_here"] as const) : []),
        ];
        const project = yield* projects.get(context.thread.projectId);
        const directory =
          context.thread.worktreePath ??
          (Option.isSome(project) ? project.value.workspaceRoot : context.scope?.cwd);
        return {
          messageId: input.messageId,
          modes,
          code: code.stats,
          codeUnavailableReason: code.reason,
          removedMessageCount: context.removedMessageCount,
          undoable: loaded.capabilities.checkpointing.providerCanRewindFiles === true,
          sharedWorkspaceActive:
            directory === undefined
              ? false
              : yield* hasActiveRunInDirectory(context.thread, directory, {
                  fileSystem,
                  projections,
                  projects,
                  path,
                }),
        } satisfies ThreadRewindPreview;
      },
      (effect, input) =>
        effect.pipe(failWith(input.threadId, "The rewind options could not be loaded.")),
    );

    const listTargets = Effect.fn("ThreadRewindService.listTargets")(
      function* (threadId: ThreadId) {
        const thread = yield* projections.getThread(threadId);
        const adapter = yield* adapters.get(thread.modelSelection.instanceId);
        const capabilities = yield* adapter.getCapabilities();
        const providerEngine = capabilities.checkpointing.providerCanRewindFiles === true;
        const rows = yield* projections.getRewindTargetRows(threadId);
        return {
          targets: rows.map((row) => {
            const promptTurn =
              row.promptTurn?.providerThreadId === thread.activeProviderThreadId
                ? row.promptTurn
                : undefined;
            const stats = providerEngine ? promptTurn?.codeStats : row.checkpoint;
            const code: ThreadRewindTurnCode =
              stats !== undefined
                ? stats.filesChanged === 0
                  ? { state: "unchanged" }
                  : { state: "changed", stats }
                : providerEngine && promptTurn !== undefined
                  ? { state: "pending" }
                  : { state: "unavailable" };
            return {
              messageId: row.messageId,
              runId: row.runId,
              text: singleLine(row.text),
              createdAt: DateTime.makeUnsafe(row.createdAt),
              code,
            };
          }),
        } satisfies ThreadRewindListTargetsResult;
      },
      (effect, threadId) => effect.pipe(failWith(threadId, "The rewind list could not be loaded.")),
    );

    return ThreadRewindService.of({
      listTargets,
      preview: previewRewind,
      rewind,
      undo,
      expireUndo,
    });
  }),
);
