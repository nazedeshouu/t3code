// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  ContextHandoffId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  TextGenerationError,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { CheckpointStore } from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ThreadRewindService from "./ThreadRewindService.ts";

const threadId = ThreadId.make("thread:rewind");
const providerThreadId = ProviderThreadId.make("provider-thread:rewind");
const providerSessionId = ProviderSessionId.make("provider-session:rewind");
const instanceId = ProviderInstanceId.make("claude_rewind");
const driver = ProviderDriverKind.make("claudeAgent");
const scopeId = CheckpointScopeId.make("scope:rewind");
const modelSelection = { instanceId, model: "test-model" };
const undoId = CommandId.make("rewind:first");
const MESSAGE = (ordinal: number) => MessageId.make(`message:${ordinal}`);
const RUN = (ordinal: number) => RunId.make(`run:${ordinal}`);
const NODE = (ordinal: number) => NodeId.make(`node:${ordinal}`);
const ATTEMPT = (ordinal: number) => RunAttemptId.make(`attempt:${ordinal}`);
const TURN = (ordinal: number) => ProviderTurnId.make(`turn:${ordinal}`);
const CHECKPOINT = (ordinal: number) => CheckpointId.make(`checkpoint:${ordinal}`);

interface Fake {
  readonly captureCheckpoint: ReturnType<
    typeof vi.fn<CheckpointStore["Service"]["captureCheckpoint"]>
  >;
  readonly openSession: ReturnType<typeof vi.fn<() => void>>;
  readonly rewindFiles: ReturnType<typeof vi.fn<ProviderRewindFiles>>;
  readonly rollbackThread: ReturnType<typeof vi.fn<ProviderRollback>>;
  readonly restore: ReturnType<typeof vi.fn<CheckpointService.CheckpointServiceV2Shape["restore"]>>;
  readonly deleteStaleRefs: ReturnType<
    typeof vi.fn<CheckpointService.CheckpointServiceV2Shape["deleteStaleRefs"]>
  >;
  readonly generateThreadSummary: ReturnType<
    typeof vi.fn<TextGeneration.TextGeneration["Service"]["generateThreadSummary"]>
  >;
  readonly eventWrite: ReturnType<
    typeof vi.fn<() => Effect.Effect<void, EventSink.EventSinkWriteError>>
  >;
  readonly createWorktree: ReturnType<typeof vi.fn<(path: string) => void>>;
}
type ProviderRewindFiles = NonNullable<
  ProviderAdapter.ProviderAdapterV2SessionRuntime["rewindFiles"]
>;
type ProviderRollback = ProviderAdapter.ProviderAdapterV2SessionRuntime["rollbackThread"];

const makeFake = (input: { readonly file?: string; readonly restoredContent?: string }): Fake => {
  const fake: Fake = {
    captureCheckpoint: vi.fn(() => Effect.void),
    openSession: vi.fn<() => void>(),
    rewindFiles: vi.fn<ProviderRewindFiles>((request) =>
      Effect.gen(function* () {
        if (!request.dryRun && input.file !== undefined) {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.writeFileString(input.file, input.restoredContent ?? "restored");
        }
        return {
          canRewind: true,
          filesChanged: input.file === undefined ? [] : [input.file],
          insertions: 2,
          deletions: 5,
        };
      }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
    ),
    rollbackThread: vi.fn<ProviderRollback>((request) =>
      Effect.succeed({
        providerThread: {
          ...request.providerThread,
          nativeConversationHeadRef: { driver, nativeId: "kept-head", strength: "weak" },
          status: "idle",
        },
        providerTurns: [],
        messages: [],
        runtimeRequests: [],
      }),
    ),
    restore: vi.fn(() => Effect.void),
    deleteStaleRefs: vi.fn(() => Effect.void),
    generateThreadSummary: vi.fn(() => Effect.succeed({ summary: "What happened." })),
    eventWrite: vi.fn(() => Effect.void),
    createWorktree: vi.fn<(path: string) => void>(),
  };
  return fake;
};

const makeLayer = (
  fake: Fake,
  options: { readonly providerEngine?: boolean; readonly worktreePath?: string | null } = {},
) => {
  const dependencies = Layer.mergeAll(
    ThreadCommandExecutor.layer,
    IdAllocator.layer,
    Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
      open: () =>
        Effect.sync(() => {
          fake.openSession();
          return {
            rollbackThread: fake.rollbackThread,
            ...(options.providerEngine === false ? {} : { rewindFiles: fake.rewindFiles }),
          } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
        }),
    }),
    Layer.mock(RuntimePolicy.RuntimePolicyV2)({ resolve: () => Effect.succeed({} as never) }),
    Layer.mock(CheckpointService.CheckpointServiceV2)({
      restore: fake.restore,
      deleteStaleRefs: fake.deleteStaleRefs,
    }),
    Layer.mock(CheckpointStore)({
      captureCheckpoint: fake.captureCheckpoint,
      deleteCheckpointRefs: () => Effect.void,
      diffCheckpoints: () => Effect.succeed("3\t1\tsrc/a.ts\0"),
    }),
    Layer.mock(ProviderAdapterRegistryV2)({
      get: () =>
        Effect.succeed({
          getCapabilities: () =>
            Effect.succeed({
              threads: { canRollbackThread: true },
              checkpointing: {
                providerCanRollbackConversation: true,
                providerRollbackReturnsSnapshot: true,
                providerCanRewindFiles: options.providerEngine !== false,
              },
            }),
        } as never),
    }),
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      getInstance: () => Effect.succeed({ snapshot: { getSnapshot: Effect.succeed({}) } } as never),
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateThreadSummary: fake.generateThreadSummary,
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () => Effect.succeedSome({ workspaceRoot: "/nonexistent/rewind" } as never),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      pruneWorktrees: () => Effect.void,
      createWorktree: (input) =>
        Effect.sync(() => {
          fake.createWorktree(input.path ?? "");
          return {} as never;
        }),
    }),
    ServerSettings.layerTest(),
  );
  const interruptibleEventSink = Layer.effect(
    EventSink.EventSinkV2,
    Effect.map(EventSink.EventSinkV2, (sink) => ({
      ...sink,
      write: (input: Parameters<typeof sink.write>[0]) =>
        fake.eventWrite().pipe(Effect.andThen(sink.write(input))),
    })),
  );
  return ThreadRewindService.layer.pipe(
    Layer.provideMerge(CheckpointRollbackService.layer),
    Layer.provideMerge(interruptibleEventSink),
    Layer.provideMerge(RuntimeLayer.layerEventSink),
    Layer.provideMerge(ProjectionStore.layer),
    Layer.provideMerge(dependencies),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-rewind-" })),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(NodeServices.layer),
  );
};

const seed = Effect.fnUntraced(function* (input: {
  readonly runs: number;
  readonly cwd: string;
  readonly worktreePath?: string | null;
  readonly branch?: string;
  readonly checkpointStatus?: "ready" | "missing";
  readonly promptRefs?: boolean;
  /** The last run is still going: running, with a prompt but no stats yet. */
  readonly lastRunActive?: boolean;
}) {
  const eventSink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  let sequence = 0;
  const event = <Event extends Omit<OrchestrationV2DomainEvent, "id" | "threadId" | "occurredAt">>(
    value: Event,
  ) =>
    ({
      ...value,
      id: EventId.make(`seed:${sequence++}`),
      threadId,
      occurredAt: now,
    }) as OrchestrationV2DomainEvent;
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project:rewind"),
    title: "Rewind",
    providerInstanceId: instanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: input.branch ?? null,
    worktreePath: input.worktreePath === undefined ? input.cwd : input.worktreePath,
    activeProviderThreadId: providerThreadId,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const providerThread: OrchestrationV2ProviderThread = {
    id: providerThreadId,
    driver,
    providerInstanceId: instanceId,
    providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId: "native:rewind", strength: "strong" },
    nativeConversationHeadRef: null,
    status: "active",
    firstRunOrdinal: 1,
    lastRunOrdinal: input.runs,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    contextUsage: null,
    nativeMetadata: null,
    goal: null,
    createdAt: now,
    updatedAt: now,
  };
  const events: Array<OrchestrationV2DomainEvent> = [
    event({ type: "thread.created", payload: thread }),
    event({
      type: "provider-thread.updated",
      driver,
      providerInstanceId: instanceId,
      payload: providerThread,
    }),
    event({
      type: "checkpoint-scope.created",
      payload: {
        id: scopeId,
        threadId,
        runId: null,
        nodeId: NODE(1),
        parentScopeId: null,
        providerThreadId,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: input.cwd,
        createdAt: now,
      },
    }),
    event({
      type: "checkpoint.captured",
      payload: {
        id: CHECKPOINT(0),
        threadId,
        scopeId,
        runId: null,
        nodeId: NODE(1),
        parentCheckpointId: null,
        ordinalWithinScope: 0,
        appRunOrdinal: null,
        ref: CheckpointRef.make("refs/t3/test/0"),
        status: input.checkpointStatus ?? "ready",
        files: [],
        capturedAt: now,
      },
    }),
  ];
  for (let ordinal = 1; ordinal <= input.runs; ordinal++) {
    const active = input.lastRunActive === true && ordinal === input.runs;
    const run: OrchestrationV2Run = {
      id: RUN(ordinal),
      threadId,
      ordinal,
      providerInstanceId: instanceId,
      modelSelection,
      providerThreadId,
      userMessageId: MESSAGE(ordinal),
      rootNodeId: NODE(ordinal),
      activeAttemptId: ATTEMPT(ordinal),
      status: active ? "running" : "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: active ? null : now,
      checkpointId: active ? null : CHECKPOINT(ordinal),
      contextHandoffId: null,
    };
    const providerTurn: OrchestrationV2ProviderTurn = {
      id: TURN(ordinal),
      providerThreadId,
      nodeId: NODE(ordinal),
      runAttemptId: ATTEMPT(ordinal),
      nativeTurnRef: { driver, nativeId: `assistant:${ordinal}`, strength: "weak" },
      ordinal,
      status: "completed",
      startedAt: now,
      completedAt: now,
      ...(input.promptRefs === false ? {} : { nativePromptRef: `prompt:${ordinal}` }),
      ...(input.promptRefs === false || active
        ? {}
        : {
            codeStats:
              ordinal === 2
                ? { filesChanged: 0, insertions: 0, deletions: 0, primaryPath: null }
                : { filesChanged: 1, insertions: 3, deletions: 1, primaryPath: "src/a.ts" },
          }),
    };
    events.push(
      event({ type: "run.created", runId: run.id, providerInstanceId: instanceId, payload: run }),
      event({
        type: "run-attempt.created",
        runId: run.id,
        payload: {
          id: ATTEMPT(ordinal),
          runId: run.id,
          attemptOrdinal: 1,
          rootNodeId: NODE(ordinal),
          providerInstanceId: instanceId,
          providerThreadId,
          providerTurnId: TURN(ordinal),
          reason: "initial",
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      }),
      event({
        type: "node.updated",
        runId: run.id,
        nodeId: NODE(ordinal),
        payload: {
          id: NODE(ordinal),
          threadId,
          runId: run.id,
          parentNodeId: null,
          rootNodeId: NODE(ordinal),
          kind: "root_turn",
          status: "completed",
          countsForRun: true,
          providerThreadId,
          providerTurnId: TURN(ordinal),
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: scopeId,
          startedAt: now,
          completedAt: now,
        },
      }),
      event({
        type: "provider-turn.updated",
        driver,
        providerInstanceId: instanceId,
        nodeId: NODE(ordinal),
        payload: providerTurn,
      }),
      event({
        type: "message.updated",
        runId: run.id,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: MESSAGE(ordinal),
          threadId,
          runId: run.id,
          nodeId: NODE(ordinal),
          role: "user",
          text: `Prompt\n   ${ordinal}`,
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      }),
      event({
        type: "checkpoint.captured",
        runId: run.id,
        nodeId: NODE(ordinal),
        payload: {
          id: CHECKPOINT(ordinal),
          threadId,
          scopeId,
          runId: run.id,
          nodeId: NODE(ordinal),
          parentCheckpointId: CHECKPOINT(ordinal - 1),
          ordinalWithinScope: ordinal,
          appRunOrdinal: ordinal,
          ref: CheckpointRef.make(`refs/t3/test/${ordinal}`),
          status: input.checkpointStatus ?? "ready",
          files: [{ path: "src/a.ts", kind: "modified", additions: 4, deletions: 2 }],
          capturedAt: now,
        },
      }),
    );
  }
  yield* eventSink.write({ events });
});

const rewindInput = (
  mode: Parameters<ThreadRewindService.ThreadRewindServiceShape["rewind"]>[0]["mode"],
  target = 2,
) => ({ threadId, rewindId: undoId, messageId: MESSAGE(target), mode });

const runStatuses = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
  return runs.map((run) => run.status);
});

const workspace = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-rewind-workspace-" });
  const file = path.join(cwd, "a.ts");
  yield* fileSystem.writeFileString(file, "agent wrote this");
  return { cwd, file, fileSystem };
});

const scoped = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.scoped(effect);

it.effect("rewinds code and conversation, and undo restores both", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd, file, fileSystem } = yield* workspace;
    const local = makeFake({ file });
    fake.rewindFiles.mockImplementation(local.rewindFiles);
    yield* seed({ runs: 3, cwd });
    const service = yield* ThreadRewindService.ThreadRewindService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;

    yield* service.rewind(rewindInput("code_and_conversation"));

    assert.equal(yield* fileSystem.readFileString(file), "restored");
    assert.deepEqual(yield* runStatuses, ["completed", "rolled_back", "rolled_back"]);
    const shell = yield* projections.getThreadShell(threadId);
    assert.equal(shell?.rewindUndo?.rewindId, undoId);
    assert.equal(shell?.rewindUndo?.removedMessageCount, 2);
    assert.equal(shell?.rewindUndo?.filesRestored, 1);
    assert.equal(fake.deleteStaleRefs.mock.calls.length, 0);
    assert.isDefined(
      (yield* projections.getThreadRecords(threadId, ["checkpoints"])).checkpoints.find(
        (checkpoint) => checkpoint.id === CHECKPOINT(3) && checkpoint.status === "stale",
      ),
    );

    yield* service.undo({ threadId, rewindId: undoId });

    assert.equal(yield* fileSystem.readFileString(file), "agent wrote this");
    assert.deepEqual(yield* runStatuses, ["completed", "completed", "completed"]);
    const restored = yield* projections.getThreadRecords(threadId, [
      "checkpoints",
      "providerThreads",
    ]);
    assert.isNull((yield* projections.getThreadShell(threadId))?.rewindUndo ?? null);
    assert.isNull(restored.providerThreads[0]?.nativeConversationHeadRef ?? null);
    assert.equal(restored.providerThreads[0]?.status, "active");
    assert.isTrue(restored.checkpoints.every((checkpoint) => checkpoint.status === "ready"));
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});

it.effect("a retried rewind keeps the first stash instead of stashing restored content", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd, file, fileSystem } = yield* workspace;
    const local = makeFake({ file });
    fake.rewindFiles.mockImplementation(local.rewindFiles);
    yield* seed({ runs: 3, cwd });
    const service = yield* ThreadRewindService.ThreadRewindService;
    let failed = false;
    fake.rollbackThread.mockImplementationOnce(() => {
      failed = true;
      return Effect.interrupt;
    });
    const firstTry = yield* service.rewind(rewindInput("code_and_conversation")).pipe(Effect.exit);
    assert.isTrue(failed);
    assert.equal(firstTry._tag, "Failure");
    // Process loss leaves the restored file and the stash in place.
    assert.equal(yield* fileSystem.readFileString(file), "restored");

    yield* service.rewind(rewindInput("code_and_conversation"));
    yield* service.undo({ threadId, rewindId: undoId });

    assert.equal(yield* fileSystem.readFileString(file), "agent wrote this");
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});

it.effect("a replay refused after the first try restored files puts them back", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd, file, fileSystem } = yield* workspace;
    const local = makeFake({ file });
    fake.rewindFiles.mockImplementation(local.rewindFiles);
    yield* seed({ runs: 3, cwd });
    const service = yield* ThreadRewindService.ThreadRewindService;
    fake.rollbackThread.mockImplementationOnce(() => Effect.interrupt);
    yield* service.rewind(rewindInput("code_and_conversation")).pipe(Effect.exit);
    assert.equal(yield* fileSystem.readFileString(file), "restored");

    const eventSink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { providerThreads } = yield* projections.getThreadRecords(threadId, ["providerThreads"]);
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("seed:detached"),
          type: "provider-thread.updated",
          threadId,
          driver,
          providerInstanceId: instanceId,
          occurredAt: yield* DateTime.now,
          payload: { ...providerThreads[0]!, providerSessionId: null },
        },
      ],
    });

    yield* Effect.flip(service.rewind(rewindInput("code_and_conversation")));

    assert.equal(yield* fileSystem.readFileString(file), "agent wrote this");
    assert.deepEqual(yield* runStatuses, ["completed", "completed", "completed"]);
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});

const CHANGED = "a.ts changed after the rewind, so Undo would overwrite it.";
const LOCKED = new EventSink.EventSinkWriteError({ eventCount: 1, cause: "database is locked" });

it.effect("undo refuses a file edited after the rewind, then works once it is put back", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd, file, fileSystem } = yield* workspace;
    const local = makeFake({ file });
    fake.rewindFiles.mockImplementation(local.rewindFiles);
    yield* seed({ runs: 3, cwd });
    const service = yield* ThreadRewindService.ThreadRewindService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* service.rewind(rewindInput("code"));

    yield* fileSystem.writeFileString(file, "my hand edit");
    const error = yield* Effect.flip(service.undo({ threadId, rewindId: undoId }));
    assert.equal(error.detail, CHANGED);
    assert.equal(yield* fileSystem.readFileString(file), "my hand edit");
    assert.equal((yield* projections.getThreadShell(threadId))?.rewindUndo?.rewindId, undoId);

    yield* fileSystem.writeFileString(file, "restored");
    yield* service.undo({ threadId, rewindId: undoId });
    assert.equal(yield* fileSystem.readFileString(file), "agent wrote this");
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});

it.effect("an undo replayed after its files went back still finishes", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd, file, fileSystem } = yield* workspace;
    const local = makeFake({ file });
    fake.rewindFiles.mockImplementation(local.rewindFiles);
    yield* seed({ runs: 3, cwd });
    const service = yield* ThreadRewindService.ThreadRewindService;
    yield* service.rewind(rewindInput("code_and_conversation"));
    fake.eventWrite.mockImplementationOnce(() => Effect.fail(LOCKED));

    yield* Effect.flip(service.undo({ threadId, rewindId: undoId }));
    assert.equal(yield* fileSystem.readFileString(file), "agent wrote this");

    yield* service.undo({ threadId, rewindId: undoId });
    assert.deepEqual(yield* runStatuses, ["completed", "completed", "completed"]);
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});

it.effect("undo keeps a file that a rewind removed and the user then recreated", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd, file, fileSystem } = yield* workspace;
    yield* fileSystem.remove(file);
    const local = makeFake({ file });
    fake.rewindFiles.mockImplementation(local.rewindFiles);
    yield* seed({ runs: 3, cwd });
    const service = yield* ThreadRewindService.ThreadRewindService;
    yield* service.rewind(rewindInput("code"));

    yield* fileSystem.writeFileString(file, "my new file");
    const error = yield* Effect.flip(service.undo({ threadId, rewindId: undoId }));

    assert.equal(error.detail, CHANGED);
    assert.equal(yield* fileSystem.readFileString(file), "my new file");
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});

it.effect("one changed file refuses the whole undo before any other file is touched", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd, file, fileSystem } = yield* workspace;
    const second = `${cwd}/b.ts`;
    yield* fileSystem.writeFileString(second, "agent wrote b");
    fake.rewindFiles.mockImplementation((request) =>
      Effect.gen(function* () {
        if (!request.dryRun) {
          yield* fileSystem.writeFileString(file, "restored");
          yield* fileSystem.writeFileString(second, "restored b");
        }
        return { canRewind: true, filesChanged: [file, second], insertions: 2, deletions: 2 };
      }).pipe(Effect.orDie),
    );
    yield* seed({ runs: 3, cwd });
    const service = yield* ThreadRewindService.ThreadRewindService;
    yield* service.rewind(rewindInput("code"));

    yield* fileSystem.writeFileString(second, "my edit");
    const error = yield* Effect.flip(service.undo({ threadId, rewindId: undoId }));

    assert.equal(error.detail, "b.ts changed after the rewind, so Undo would overwrite it.");
    assert.equal(yield* fileSystem.readFileString(file), "restored");
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});

it.effect("undo refuses a path that became a link instead of writing through it", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd, file, fileSystem } = yield* workspace;
    const local = makeFake({ file });
    fake.rewindFiles.mockImplementation(local.rewindFiles);
    yield* seed({ runs: 3, cwd });
    const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-rewind-outside-" });
    const service = yield* ThreadRewindService.ThreadRewindService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* service.rewind(rewindInput("code"));

    yield* fileSystem.writeFileString(`${outside}/victim`, "restored");
    yield* fileSystem.remove(file);
    yield* fileSystem.symlink(`${outside}/victim`, file);
    const error = yield* Effect.flip(service.undo({ threadId, rewindId: undoId }));

    assert.equal(error.detail, CHANGED);
    assert.equal(yield* fileSystem.readFileString(`${outside}/victim`), "restored");
    assert.equal((yield* projections.getThreadShell(threadId))?.rewindUndo?.rewindId, undoId);
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});

it.effect("undo refuses a parent directory that became a link", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd, fileSystem } = yield* workspace;
    const nested = `${cwd}/src`;
    const file = `${nested}/a.ts`;
    yield* fileSystem.makeDirectory(nested);
    yield* fileSystem.writeFileString(file, "agent wrote this");
    const local = makeFake({ file });
    fake.rewindFiles.mockImplementation(local.rewindFiles);
    yield* seed({ runs: 3, cwd });
    const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-rewind-outside-" });
    const service = yield* ThreadRewindService.ThreadRewindService;
    yield* service.rewind(rewindInput("code"));

    // The link target holds the same bytes, so only the parent check can catch this.
    yield* fileSystem.writeFileString(`${outside}/a.ts`, "restored");
    yield* fileSystem.remove(nested, { recursive: true });
    yield* fileSystem.symlink(outside, nested);
    const error = yield* Effect.flip(service.undo({ threadId, rewindId: undoId }));

    assert.include(error.detail, "src/a.ts");
    assert.equal(yield* fileSystem.readFileString(`${outside}/a.ts`), "restored");
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});

it.effect("putting files back replaces a link at the path instead of following it", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd, file, fileSystem } = yield* workspace;
    const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-rewind-outside-" });
    const victim = `${outside}/victim`;
    yield* fileSystem.writeFileString(victim, "someone else's file");
    fake.rewindFiles.mockImplementation((request) =>
      Effect.gen(function* () {
        if (!request.dryRun) {
          yield* fileSystem.remove(file);
          yield* fileSystem.symlink(victim, file);
        }
        return { canRewind: true, filesChanged: [file], insertions: 1, deletions: 1 };
      }).pipe(Effect.orDie),
    );
    yield* seed({ runs: 3, cwd });
    fake.rollbackThread.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapter.ProviderAdapterRollbackThreadError({
          driver,
          providerThreadId,
          cause: "refused",
        }),
      ),
    );
    const service = yield* ThreadRewindService.ThreadRewindService;
    yield* Effect.flip(service.rewind(rewindInput("code_and_conversation")));

    assert.equal((yield* fileSystem.lstat(file)).type, "File");
    assert.equal(yield* fileSystem.readFileString(file), "agent wrote this");
    assert.equal(yield* fileSystem.readFileString(victim), "someone else's file");
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});

it.effect("a projection write that fails after the rollback replays without rolling back", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd, file, fileSystem } = yield* workspace;
    const local = makeFake({ file });
    fake.rewindFiles.mockImplementation(local.rewindFiles);
    yield* seed({ runs: 3, cwd });
    const service = yield* ThreadRewindService.ThreadRewindService;
    fake.eventWrite.mockImplementationOnce(() => Effect.fail(LOCKED));

    const error = yield* Effect.flip(service.rewind(rewindInput("code_and_conversation")));

    assert.isTrue(error.retryable);
    assert.notInclude(error.detail, "Nothing was changed");
    assert.equal(yield* fileSystem.readFileString(file), "restored");
    assert.deepEqual(yield* runStatuses, ["completed", "completed", "completed"]);

    yield* service.rewind(rewindInput("code_and_conversation"));

    assert.equal(fake.rollbackThread.mock.calls.length, 1);
    assert.deepEqual(yield* runStatuses, ["completed", "rolled_back", "rolled_back"]);
    yield* service.undo({ threadId, rewindId: undoId });
    assert.equal(yield* fileSystem.readFileString(file), "agent wrote this");
    assert.deepEqual(yield* runStatuses, ["completed", "completed", "completed"]);
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});

it.effect("undo brings back a removed managed worktree before restoring into it", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const worktree = `${config.worktreesDir}/project/thread`;
    const file = `${worktree}/a.ts`;
    yield* fileSystem.makeDirectory(worktree, { recursive: true });
    yield* fileSystem.writeFileString(file, "agent wrote this");
    const local = makeFake({ file });
    fake.rewindFiles.mockImplementation(local.rewindFiles);
    yield* seed({ runs: 3, cwd: worktree, branch: "t3/rewind" });
    const service = yield* ThreadRewindService.ThreadRewindService;
    yield* service.rewind(rewindInput("code"));
    fake.createWorktree.mockImplementation(() => {
      NodeFS.mkdirSync(`${worktree}/.git`, { recursive: true });
      NodeFS.writeFileSync(file, "restored");
    });

    yield* fileSystem.remove(worktree, { recursive: true });
    yield* service.undo({ threadId, rewindId: undoId });

    assert.deepEqual(fake.createWorktree.mock.calls, [[worktree]]);
    assert.isTrue(yield* fileSystem.exists(`${worktree}/.git`));
    assert.equal(yield* fileSystem.readFileString(file), "agent wrote this");
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});

it.effect("undo refuses to fabricate a worktree it cannot recreate", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd, file, fileSystem } = yield* workspace;
    const local = makeFake({ file });
    fake.rewindFiles.mockImplementation(local.rewindFiles);
    yield* seed({ runs: 3, cwd });
    const service = yield* ThreadRewindService.ThreadRewindService;
    yield* service.rewind(rewindInput("code"));

    yield* fileSystem.remove(cwd, { recursive: true });
    const error = yield* Effect.flip(service.undo({ threadId, rewindId: undoId }));

    assert.equal(error.detail, "This rewind can no longer be undone.");
    assert.isFalse(yield* fileSystem.exists(cwd));
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});

it.effect("code mode leaves the conversation alone and undo removes a recreated file", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd, file, fileSystem } = yield* workspace;
    yield* fileSystem.remove(file);
    const local = makeFake({ file });
    fake.rewindFiles.mockImplementation(local.rewindFiles);
    yield* seed({ runs: 2, cwd });
    const service = yield* ThreadRewindService.ThreadRewindService;
    yield* service.rewind(rewindInput("code"));
    assert.equal(fake.rollbackThread.mock.calls.length, 0);
    assert.deepEqual(yield* runStatuses, ["completed", "completed"]);
    assert.isTrue(yield* fileSystem.exists(file));
    yield* service.undo({ threadId, rewindId: undoId });
    assert.isFalse(yield* fileSystem.exists(file));
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});

it.effect("a failed code restore leaves the conversation untouched", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd, file } = yield* workspace;
    yield* seed({ runs: 2, cwd });
    fake.rewindFiles.mockImplementation((request) =>
      Effect.succeed(
        request.dryRun
          ? { canRewind: true, filesChanged: [file], insertions: 1, deletions: 1 }
          : {
              canRewind: false,
              reason: "Checkpoint is gone.",
              filesChanged: [],
              insertions: 0,
              deletions: 0,
            },
      ),
    );
    const service = yield* ThreadRewindService.ThreadRewindService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const error = yield* Effect.flip(service.rewind(rewindInput("code_and_conversation")));
    assert.equal(error.detail, "Checkpoint is gone.");
    assert.equal(fake.rollbackThread.mock.calls.length, 0);
    assert.deepEqual(yield* runStatuses, ["completed", "completed"]);
    assert.isNull((yield* projections.getThreadShell(threadId))?.rewindUndo ?? null);
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});

it.effect("a failed conversation rollback puts the restored code back", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd, file, fileSystem } = yield* workspace;
    const local = makeFake({ file });
    fake.rewindFiles.mockImplementation(local.rewindFiles);
    yield* seed({ runs: 2, cwd });
    fake.rollbackThread.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapter.ProviderAdapterRollbackThreadError({ driver, providerThreadId }),
      ),
    );
    const service = yield* ThreadRewindService.ThreadRewindService;
    const error = yield* Effect.flip(service.rewind(rewindInput("code_and_conversation")));
    assert.equal(error.detail, CheckpointRollbackService.ROLLBACK_FAILED_MESSAGE);
    assert.equal(yield* fileSystem.readFileString(file), "agent wrote this");
    assert.deepEqual(yield* runStatuses, ["completed", "completed"]);
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});

it.effect("rolls back a conversation in a project without git checkpoints", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd } = yield* workspace;
    yield* seed({ runs: 2, cwd, checkpointStatus: "missing", worktreePath: null });
    const service = yield* ThreadRewindService.ThreadRewindService;
    yield* service.rewind(rewindInput("conversation"));
    assert.deepEqual(yield* runStatuses, ["completed", "rolled_back"]);
    assert.equal(fake.restore.mock.calls.length, 0);
    assert.equal(fake.rollbackThread.mock.calls[0]?.[0].target.type, "provider_turn");
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});

it.effect("a one-way provider rewinds without undo and drops the stale refs at once", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd, fileSystem } = yield* workspace;
    yield* seed({ runs: 3, cwd, promptRefs: false });
    const service = yield* ThreadRewindService.ThreadRewindService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    assert.isFalse((yield* service.preview({ threadId, messageId: MESSAGE(2) })).undoable);

    yield* service.rewind(rewindInput("code_and_conversation"));

    assert.deepEqual(yield* runStatuses, ["completed", "rolled_back", "rolled_back"]);
    assert.equal(fake.restore.mock.calls[0]?.[0].checkpoint.id, CHECKPOINT(1));
    assert.isTrue(
      fake.rollbackThread.mock.invocationCallOrder[0]! < fake.restore.mock.invocationCallOrder[0]!,
    );
    assert.deepEqual(
      fake.deleteStaleRefs.mock.calls[0]?.[0].checkpoints.map((checkpoint) => checkpoint.id),
      [CHECKPOINT(2), CHECKPOINT(3)],
    );
    const thread = yield* projections.getThread(threadId);
    assert.equal(thread.lastRewindId, undoId);
    assert.isNull(thread.rewindUndo ?? null);
    const stashRoot = path.join(config.stateDir, "rewind-undo");
    const remaining = (yield* fileSystem.exists(stashRoot))
      ? yield* fileSystem.readDirectory(stashRoot, { recursive: true })
      : [];
    assert.isFalse(remaining.some((entry) => entry.endsWith("record.json")));
  }).pipe(scoped, Effect.provide(makeLayer(fake, { providerEngine: false })));
});

it.effect("a git code rewind opens no session, with or without one to open", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd } = yield* workspace;
    yield* seed({ runs: 2, cwd, promptRefs: false });
    const eventSink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { providerThreads } = yield* projections.getThreadRecords(threadId, ["providerThreads"]);
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("seed:detached"),
          type: "provider-thread.updated",
          threadId,
          driver,
          providerInstanceId: instanceId,
          occurredAt: yield* DateTime.now,
          payload: { ...providerThreads[0]!, providerSessionId: null },
        },
      ],
    });
    const service = yield* ThreadRewindService.ThreadRewindService;

    yield* service.rewind(rewindInput("code"));

    assert.equal(fake.restore.mock.calls.length, 1);
    assert.equal(fake.openSession.mock.calls.length, 0);
  }).pipe(scoped, Effect.provide(makeLayer(fake, { providerEngine: false })));
});

it.effect("a file engine picked in the composer leaves another instance's session alone", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd } = yield* workspace;
    yield* seed({ runs: 2, cwd });
    const eventSink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const thread = yield* projections.getThread(threadId);
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("seed:picker"),
          type: "thread.metadata-updated",
          threadId,
          occurredAt: yield* DateTime.now,
          payload: {
            ...thread,
            modelSelection: {
              ...modelSelection,
              instanceId: ProviderInstanceId.make("claude_other"),
            },
          },
        },
      ],
    });
    const service = yield* ThreadRewindService.ThreadRewindService;

    const preview = yield* service.preview({ threadId, messageId: MESSAGE(2) });
    assert.deepEqual(preview.modes, []);
    assert.equal(fake.openSession.mock.calls.length, 0);
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});

it.effect("a failed one-way rollback leaves the code alone", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd } = yield* workspace;
    yield* seed({ runs: 2, cwd, promptRefs: false });
    fake.rollbackThread.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapter.ProviderAdapterRollbackThreadError({ driver, providerThreadId }),
      ),
    );
    const service = yield* ThreadRewindService.ThreadRewindService;
    yield* Effect.flip(service.rewind(rewindInput("code_and_conversation")));
    assert.equal(fake.restore.mock.calls.length, 0);
    assert.deepEqual(yield* runStatuses, ["completed", "completed"]);
  }).pipe(scoped, Effect.provide(makeLayer(fake, { providerEngine: false })));
});

it.effect("a replay after a crash never rolls a provider's conversation back twice", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd } = yield* workspace;
    yield* seed({ runs: 3, cwd, promptRefs: false });
    const restoring = yield* Deferred.make<void>();
    fake.restore.mockImplementationOnce(() =>
      Deferred.succeed(restoring, undefined).pipe(Effect.andThen(Effect.never)),
    );
    const service = yield* ThreadRewindService.ThreadRewindService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;

    const crashed = yield* service
      .rewind(rewindInput("code_and_conversation"))
      .pipe(Effect.forkChild);
    yield* Deferred.await(restoring);
    yield* Fiber.interrupt(crashed);
    assert.deepEqual(yield* runStatuses, ["completed", "completed", "completed"]);

    yield* service.rewind(rewindInput("code_and_conversation"));

    assert.equal(fake.rollbackThread.mock.calls.length, 1);
    assert.deepEqual(yield* runStatuses, ["completed", "rolled_back", "rolled_back"]);
    const { providerThreads } = yield* projections.getThreadRecords(threadId, ["providerThreads"]);
    assert.equal(providerThreads[0]?.nativeConversationHeadRef?.nativeId, "kept-head");
  }).pipe(scoped, Effect.provide(makeLayer(fake, { providerEngine: false })));
});

it.effect("a git restore that fails after the rollback keeps the rollback on record", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd } = yield* workspace;
    yield* seed({ runs: 2, cwd, promptRefs: false });
    fake.restore.mockImplementationOnce(() =>
      Effect.fail(
        new CheckpointService.CheckpointRestoreError({
          scopeId,
          checkpointId: CHECKPOINT(1),
          cause: "locked",
        }),
      ),
    );
    const service = yield* ThreadRewindService.ThreadRewindService;
    const error = yield* Effect.flip(service.rewind(rewindInput("code_and_conversation")));
    assert.equal(error.detail, "The conversation was rewound, but the code could not be restored.");
    assert.deepEqual(yield* runStatuses, ["completed", "rolled_back"]);
  }).pipe(scoped, Effect.provide(makeLayer(fake, { providerEngine: false })));
});

it.effect("restores code in a local thread through the provider", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd, file, fileSystem } = yield* workspace;
    const local = makeFake({ file });
    fake.rewindFiles.mockImplementation(local.rewindFiles);
    yield* seed({ runs: 2, cwd, worktreePath: null });
    const service = yield* ThreadRewindService.ThreadRewindService;
    yield* service.rewind(rewindInput("code"));
    assert.equal(yield* fileSystem.readFileString(file), "restored");
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});

it.effect("still refuses a git restore in a shared local workspace", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd } = yield* workspace;
    yield* seed({ runs: 2, cwd, worktreePath: null });
    const service = yield* ThreadRewindService.ThreadRewindService;
    const error = yield* Effect.flip(service.rewind(rewindInput("code")));
    assert.include(error.detail, "File restore requires an isolated worktree");
    assert.equal(fake.restore.mock.calls.length, 0);
  }).pipe(scoped, Effect.provide(makeLayer(fake, { providerEngine: false })));
});

it.effect("undoes a rewind to the thread start back onto the old provider thread", () => {
  const fake = makeFake({});
  fake.rollbackThread.mockImplementation((request) =>
    Effect.succeed({
      providerThread: {
        ...request.providerThread,
        id: ProviderThreadId.make("provider-thread:fresh"),
        nativeThreadRef: { driver, nativeId: "native:fresh", strength: "strong" },
      },
      providerTurns: [],
      messages: [],
      runtimeRequests: [],
    }),
  );
  return Effect.gen(function* () {
    const { cwd } = yield* workspace;
    yield* seed({ runs: 2, cwd });
    const service = yield* ThreadRewindService.ThreadRewindService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;

    yield* service.rewind(rewindInput("conversation", 1));
    assert.equal(fake.rollbackThread.mock.calls[0]?.[0].target.type, "thread_start");
    assert.equal(
      (yield* projections.getThread(threadId)).activeProviderThreadId,
      "provider-thread:fresh",
    );

    yield* service.undo({ threadId, rewindId: undoId });
    assert.equal((yield* projections.getThread(threadId)).activeProviderThreadId, providerThreadId);
    assert.deepEqual(yield* runStatuses, ["completed", "completed"]);
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});

it.effect("hands the summary to the next run, and a failed summary changes nothing", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd } = yield* workspace;
    yield* seed({ runs: 3, cwd });
    const service = yield* ThreadRewindService.ThreadRewindService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;

    fake.generateThreadSummary.mockImplementationOnce(() =>
      Effect.fail(new TextGenerationError({ operation: "generateThreadSummary", detail: "down" })),
    );
    const error = yield* Effect.flip(
      service.rewind({
        ...rewindInput("summarize_from_here"),
        summaryInstructions: "Keep the plan.",
      }),
    );
    assert.equal(error.detail, "The summary could not be generated, so nothing was changed.");
    assert.equal(fake.generateThreadSummary.mock.calls[0]?.[0].instructions, "Keep the plan.");
    assert.equal(fake.rollbackThread.mock.calls.length, 0);
    assert.deepEqual(yield* runStatuses, ["completed", "completed", "completed"]);

    yield* service.rewind(rewindInput("summarize_from_here"));
    assert.deepEqual(yield* runStatuses, ["completed", "rolled_back", "rolled_back"]);
    const [handoff] = (yield* projections.getThreadRecords(threadId, ["contextHandoffs"]))
      .contextHandoffs;
    assert.equal(handoff?.summaryText, "What happened.");
    assert.equal(handoff?.status, "ready");
    assert.deepEqual(handoff?.coveredRunOrdinals, { from: 2, to: 3 });

    yield* service.undo({ threadId, rewindId: undoId });
    const [dropped] = (yield* projections.getThreadRecords(threadId, ["contextHandoffs"]))
      .contextHandoffs;
    assert.equal(dropped?.status, "superseded");
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});

it.effect("undo resends the restored items, which a client that loaded later never had", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd } = yield* workspace;
    yield* seed({ runs: 3, cwd });
    const eventSink = yield* EventSink.EventSinkV2;
    const service = yield* ThreadRewindService.ThreadRewindService;
    const now = yield* DateTime.now;
    const item: OrchestrationV2TurnItem = {
      id: TurnItemId.make("item:restored"),
      threadId,
      runId: RUN(3),
      nodeId: NODE(3),
      providerThreadId,
      providerTurnId: TURN(3),
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 3_000_001,
      status: "completed",
      title: null,
      updatedAt: now,
      startedAt: now,
      completedAt: now,
      type: "assistant_message",
      messageId: MessageId.make("message:reply"),
      text: "Reply",
      streaming: false,
    };
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("seed:item"),
          type: "turn-item.updated",
          threadId,
          runId: RUN(3),
          occurredAt: now,
          payload: item,
        },
      ],
    });
    yield* service.rewind(rewindInput("conversation"));
    const afterSequence = yield* eventSink.latestSequence({ threadId });

    yield* service.undo({ threadId, rewindId: undoId });

    const resent = yield* eventSink
      .stream({ threadId, afterSequence, eventType: "turn-item.updated" })
      .pipe(Stream.take(1), Stream.runCollect);
    assert.equal(Array.from(resent)[0]?.event.type, "turn-item.updated");
    assert.deepEqual(
      Array.from(resent).flatMap(({ event }) =>
        event.type === "turn-item.updated" ? [event.payload.id] : [],
      ),
      [item.id],
    );
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});

it.effect("a later conversation rewind replaces an undelivered summary until it is undone", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd } = yield* workspace;
    yield* seed({ runs: 3, cwd });
    const service = yield* ThreadRewindService.ThreadRewindService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const handoffStatus = projections
      .getThreadRecords(threadId, ["contextHandoffs"])
      .pipe(Effect.map(({ contextHandoffs }) => contextHandoffs[0]?.status));
    const codeRewind = CommandId.make("rewind:code");
    const conversationRewind = CommandId.make("rewind:conversation");

    yield* service.rewind(rewindInput("summarize_from_here", 3));
    assert.equal(yield* handoffStatus, "ready");

    yield* service.rewind({ ...rewindInput("code", 2), rewindId: codeRewind });
    assert.equal(yield* handoffStatus, "ready");

    yield* service.rewind({ ...rewindInput("conversation", 2), rewindId: conversationRewind });
    assert.equal(yield* handoffStatus, "superseded");

    yield* service.undo({ threadId, rewindId: conversationRewind });
    assert.equal(yield* handoffStatus, "ready");
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});

const seedDeliveredSummary = Effect.gen(function* () {
  const eventSink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
  yield* eventSink.write({
    events: [
      {
        id: EventId.make("seed:summarized-run"),
        type: "run.updated",
        threadId,
        runId: RUN(2),
        occurredAt: now,
        payload: { ...runs[1]!, status: "rolled_back" },
      },
      {
        id: EventId.make("seed:summary"),
        type: "context-handoff.updated",
        threadId,
        runId: RUN(2),
        occurredAt: now,
        payload: {
          id: ContextHandoffId.make("handoff:delivered"),
          threadId,
          targetRunId: RUN(2),
          fromProviderThreadIds: [providerThreadId],
          toProviderThreadId: providerThreadId,
          coveredRunOrdinals: { from: 2, to: 2 },
          strategy: "checkpoint_summary",
          status: "ready",
          summaryMessageId: null,
          summaryText: "Earlier work.",
          delivery: { nativeThreadId: "native:rewind", status: "inline", itemIds: [] },
          createdByProviderInstanceId: instanceId,
          createdAt: now,
          updatedAt: now,
        },
      },
    ],
  });
});

const deliveredHandoff = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const { contextHandoffs } = yield* projections.getThreadRecords(threadId, ["contextHandoffs"]);
  return contextHandoffs.find((handoff) => handoff.id === "handoff:delivered");
});

it.effect("rewinding past the run that received a summary delivers it again", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd } = yield* workspace;
    yield* seed({ runs: 3, cwd });
    yield* seedDeliveredSummary;
    const service = yield* ThreadRewindService.ThreadRewindService;

    yield* service.rewind(rewindInput("conversation", 3));
    const pending = yield* deliveredHandoff;
    assert.equal(pending?.status, "ready");
    assert.isUndefined(pending?.delivery);

    yield* service.undo({ threadId, rewindId: undoId });
    assert.equal((yield* deliveredHandoff)?.delivery?.status, "inline");
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});

it.effect("a rewind to before a delivered summary's turns drops the summary", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd } = yield* workspace;
    yield* seed({ runs: 3, cwd });
    yield* seedDeliveredSummary;
    const service = yield* ThreadRewindService.ThreadRewindService;

    yield* service.rewind(rewindInput("conversation", 1));
    assert.equal((yield* deliveredHandoff)?.status, "superseded");

    yield* service.undo({ threadId, rewindId: undoId });
    assert.equal((yield* deliveredHandoff)?.status, "ready");
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});

it.effect("a rewind that keeps the run which received a summary leaves it delivered", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd } = yield* workspace;
    yield* seed({ runs: 4, cwd });
    yield* seedDeliveredSummary;
    const service = yield* ThreadRewindService.ThreadRewindService;

    yield* service.rewind(rewindInput("conversation", 4));
    assert.equal((yield* deliveredHandoff)?.delivery?.status, "inline");
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});

it.effect("offers no conversation rewind on a provider thread without a session", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd } = yield* workspace;
    yield* seed({ runs: 2, cwd });
    const eventSink = yield* EventSink.EventSinkV2;
    const service = yield* ThreadRewindService.ThreadRewindService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { providerThreads } = yield* projections.getThreadRecords(threadId, ["providerThreads"]);
    const [providerThread] = providerThreads;
    assert.isDefined(providerThread);
    if (providerThread === undefined) return;
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("seed:detached"),
          type: "provider-thread.updated",
          threadId,
          driver,
          providerInstanceId: instanceId,
          occurredAt: yield* DateTime.now,
          payload: { ...providerThread, providerSessionId: null },
        },
      ],
    });

    const preview = yield* service.preview({ threadId, messageId: MESSAGE(1) });
    assert.notInclude(preview.modes, "conversation");
    const error = yield* Effect.flip(service.rewind(rewindInput("conversation", 1)));
    assert.equal(error.detail, "This thread has no provider conversation to rewind.");
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});

it.effect("expiring the undo drops the stash and the stale refs it kept", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd, file, fileSystem } = yield* workspace;
    const local = makeFake({ file });
    fake.rewindFiles.mockImplementation(local.rewindFiles);
    yield* seed({ runs: 3, cwd });
    const service = yield* ThreadRewindService.ThreadRewindService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    yield* service.rewind(rewindInput("code_and_conversation"));
    const stashRoot = path.join(config.stateDir, "rewind-undo");
    assert.equal(
      (yield* fileSystem.readDirectory(stashRoot, { recursive: true })).length > 0,
      true,
    );

    yield* service.expireUndo(threadId);

    assert.isNull((yield* projections.getThreadShell(threadId))?.rewindUndo ?? null);
    assert.deepEqual(
      fake.deleteStaleRefs.mock.calls[0]?.[0].checkpoints.map((checkpoint) => checkpoint.id),
      [CHECKPOINT(2), CHECKPOINT(3)],
    );
    const remaining = yield* fileSystem.readDirectory(stashRoot, { recursive: true });
    assert.isFalse(remaining.some((entry) => entry.endsWith("record.json")));
    // A stale id is a no-op here; the orchestrator rejects it at dispatch.
    yield* service.undo({ threadId, rewindId: undoId });
    assert.deepEqual(yield* runStatuses, ["completed", "rolled_back", "rolled_back"]);
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});

it.effect("lists every visible prompt oldest first with what each turn did", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd } = yield* workspace;
    yield* seed({ runs: 3, cwd });
    const service = yield* ThreadRewindService.ThreadRewindService;
    yield* service.rewind(rewindInput("conversation", 3));
    const { targets } = yield* service.listTargets(threadId);
    assert.deepEqual(
      targets.map((target) => [target.runId, target.text, target.code.state]),
      [
        [RUN(1), "Prompt 1", "changed"],
        [RUN(2), "Prompt 2", "unchanged"],
      ],
    );
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});

it.effect("lists a running prompt, with stats pending", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd } = yield* workspace;
    yield* seed({ runs: 2, cwd, lastRunActive: true });
    const service = yield* ThreadRewindService.ThreadRewindService;
    const { targets } = yield* service.listTargets(threadId);
    assert.deepEqual(
      targets.map((target) => [target.runId, target.code.state]),
      [
        [RUN(1), "changed"],
        [RUN(2), "pending"],
      ],
    );
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});

it.effect("derives list stats from checkpoints for the git engine", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd } = yield* workspace;
    yield* seed({ runs: 1, cwd, promptRefs: false });
    const service = yield* ThreadRewindService.ThreadRewindService;
    const { targets } = yield* service.listTargets(threadId);
    assert.deepEqual(targets[0]?.code, {
      state: "changed",
      stats: { filesChanged: 1, insertions: 4, deletions: 2, primaryPath: "src/a.ts" },
    });
  }).pipe(scoped, Effect.provide(makeLayer(fake, { providerEngine: false })));
});

it.effect("concurrent previews each capture to a ref of their own", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd } = yield* workspace;
    yield* seed({ runs: 2, cwd, promptRefs: false });
    const service = yield* ThreadRewindService.ThreadRewindService;
    const preview = service.preview({ threadId, messageId: MESSAGE(2) });
    yield* Effect.all([preview, preview], { concurrency: "unbounded" });
    const [first, second] = fake.captureCheckpoint.mock.calls.map(([input]) => input.checkpointRef);
    assert.isDefined(first);
    assert.notEqual(first, second);
  }).pipe(scoped, Effect.provide(makeLayer(fake, { providerEngine: false })));
});

it.effect("previews the modes a target allows", () => {
  const fake = makeFake({});
  return Effect.gen(function* () {
    const { cwd, file } = yield* workspace;
    const local = makeFake({ file });
    fake.rewindFiles.mockImplementation(local.rewindFiles);
    yield* seed({ runs: 3, cwd });
    const service = yield* ThreadRewindService.ThreadRewindService;

    const middle = yield* service.preview({ threadId, messageId: MESSAGE(2) });
    assert.deepEqual(middle.modes, [
      "code_and_conversation",
      "conversation",
      "code",
      "summarize_from_here",
    ]);
    assert.deepEqual(middle.code, {
      filesChanged: 1,
      insertions: 2,
      deletions: 5,
      primaryPath: "a.ts",
    });
    assert.equal(middle.removedMessageCount, 2);
    assert.isFalse(middle.sharedWorkspaceActive);

    const latest = yield* service.preview({ threadId, messageId: MESSAGE(3) });
    assert.notInclude(latest.modes, "summarize_from_here");

    fake.rewindFiles.mockImplementation(() =>
      Effect.succeed({ canRewind: true, filesChanged: [], insertions: 0, deletions: 0 }),
    );
    const clean = yield* service.preview({ threadId, messageId: MESSAGE(2) });
    assert.deepEqual(clean.modes, ["conversation", "summarize_from_here"]);
    assert.isNull(clean.code);
    assert.isNull(clean.codeUnavailableReason);
  }).pipe(scoped, Effect.provide(makeLayer(fake)));
});
