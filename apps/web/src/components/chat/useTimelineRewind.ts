import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ComposerThreadTarget } from "../../composerDraftStore";
import type { ComposerHandleRef } from "../../composerHandleContext";
import type { SessionPhase } from "../../types";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  CommandId,
  type EnvironmentId,
  type MessageId,
  type ScopedThreadRef,
  type ThreadId,
  type RunId,
  type ThreadRewindMode,
  type ThreadRewindUndo,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useRef } from "react";
import { type ChatMessage } from "../../types";
import { newThreadId, randomUUID } from "~/lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useComposerDraftStore } from "../../composerDraftStore";
import { threadEnvironment } from "../../state/threads";
import { waitForThreadShell } from "../../state/entities";
import { assetEnvironment } from "../../state/assets";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { rewindToMessage, type RewindPrefill } from "./chatViewSend";
import {
  makeThreadErrorSetter,
  stopThreadBeforeRewind,
  waitForThreadRewind,
} from "../ChatView.logic";

interface TimelineRewindInput {
  readonly environmentId: EnvironmentId;
  readonly routeThreadRef: ScopedThreadRef;
  readonly routeThreadKey: string;
  readonly currentRouteThreadKeyRef: { readonly current: string | null };
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly timelineMessages: ReadonlyArray<ChatMessage>;
  readonly phase: SessionPhase;
  readonly isSendBusy: boolean;
  readonly canInterrupt: boolean;
  readonly activeEnvironmentUnavailable: boolean;
  readonly activeEnvironmentUnavailableLabel: string | null;
  readonly promptRef: { current: string };
  readonly composerRef: ComposerHandleRef;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly setThreadError: ReturnType<typeof makeThreadErrorSetter>;
}

export interface RewindRequest {
  readonly messageId: MessageId;
  readonly mode: ThreadRewindMode;
  readonly summaryInstructions?: string;
  /** Called once the rewind has to wait for a running turn to stop. */
  readonly onStopping?: () => void;
}

/**
 * Going back in a thread's timeline: rewinding to an earlier message, undoing that rewind, and
 * forking a new thread from a run.
 */
export function useTimelineRewind(input: TimelineRewindInput) {
  const {
    environmentId,
    routeThreadRef,
    routeThreadKey,
    currentRouteThreadKeyRef,
    activeThread,
    timelineMessages,
    phase,
    isSendBusy,
    canInterrupt,
    activeEnvironmentUnavailable,
    activeEnvironmentUnavailableLabel,
    promptRef,
    composerRef,
    composerDraftTarget,
    setThreadError,
  } = input;
  const navigate = useNavigate();
  const createAttachmentAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });

  const rewindThread = useOrchestrationCommand(threadEnvironment.rewind, { reportFailure: false });
  const undoThreadRewind = useOrchestrationCommand(threadEnvironment.undoRewind, {
    reportFailure: false,
  });
  const interruptThreadTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    reportFailure: false,
  });
  const forkThreadFromRun = useAtomCommand(threadEnvironment.forkFromRun, {
    reportFailure: false,
  });
  const prefillRef = useRef<{
    readonly threadKey: string;
    readonly messageId: MessageId;
    readonly prefill: RewindPrefill;
  } | null>(null);

  /** Resolves to null once rewound, or to the reason it did not. */
  const onRewind = async (request: RewindRequest): Promise<string | null> => {
    if (!activeThread) return "This thread is not available.";
    if (activeEnvironmentUnavailable && activeEnvironmentUnavailableLabel) {
      return `Reconnect ${activeEnvironmentUnavailableLabel} before rewinding.`;
    }
    const { messageId, mode, summaryInstructions } = request;
    const message =
      mode === "code"
        ? null
        : (timelineMessages.find((candidate) => candidate.id === messageId) ?? null);
    if (mode !== "code" && message === null) {
      return "This message is still loading. Try again in a moment.";
    }
    const threadId = activeThread.id;
    const running = phase === "running" || isSendBusy || canInterrupt;
    useComposerDraftStore.setState((store) => ({
      rewindingThreadKeys: new Set(store.rewindingThreadKeys).add(routeThreadKey),
    }));
    setThreadError(threadId, null);
    const rewind = await rewindToMessage({
      message,
      environmentId,
      draftTarget: composerDraftTarget,
      composerHasPendingAttachments: composerRef.current?.hasPendingAttachments() === true,
      createAssetUrl: createAttachmentAssetUrl,
      rewind: async () => {
        if (running) {
          request.onStopping?.();
          await stopThreadBeforeRewind(routeThreadRef, async () => {
            const stopped = await interruptThreadTurn({ environmentId, input: { threadId } });
            if (stopped._tag === "Failure") throw squashAtomCommandFailure(stopped);
          });
        }
        const commandId = CommandId.make(randomUUID());
        await waitForThreadRewind(
          routeThreadRef,
          commandId,
          (thread) => thread.lastRewindId === commandId,
          async () => {
            const result = await rewindThread({
              environmentId,
              input: {
                commandId,
                threadId,
                messageId,
                mode,
                ...(summaryInstructions === undefined ? {} : { summaryInstructions }),
              },
            });
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          },
        );
      },
    });
    useComposerDraftStore.setState((store) => {
      const remaining = new Set(store.rewindingThreadKeys);
      remaining.delete(routeThreadKey);
      return { rewindingThreadKeys: remaining };
    });
    if (rewind.error !== null) return rewind.error;
    if (rewind.prefill !== null) {
      prefillRef.current = { threadKey: routeThreadKey, messageId, prefill: rewind.prefill };
      if (currentRouteThreadKeyRef.current === routeThreadKey) {
        const nextPrompt = rewind.prefill.prompt;
        promptRef.current = nextPrompt;
        composerRef.current?.resetCursorState({ prompt: nextPrompt, cursor: nextPrompt.length });
      }
    }
    return null;
  };
  const onRewindStable = useStableCallback(onRewind);

  /** Takes back what the rewind wrote into the composer, unless the user has since edited it. */
  const clearRewindPrefill = (messageId: MessageId) => {
    const held = prefillRef.current;
    prefillRef.current = null;
    if (held === null || held.threadKey !== routeThreadKey || held.messageId !== messageId) return;
    const store = useComposerDraftStore.getState();
    if (store.getComposerDraft(composerDraftTarget)?.prompt !== held.prefill.prompt) return;
    const { previousPrompt, imageIds, fileIds } = held.prefill;
    store.setPrompt(composerDraftTarget, previousPrompt);
    for (const id of imageIds) store.removeImage(composerDraftTarget, id);
    for (const id of fileIds) store.removeFile(composerDraftTarget, id);
    promptRef.current = previousPrompt;
    composerRef.current?.resetCursorState({
      prompt: previousPrompt,
      cursor: previousPrompt.length,
    });
  };

  const undoingRef = useRef(false);
  const onUndoRewind = async (undo: ThreadRewindUndo) => {
    if (!activeThread || undoingRef.current) return;
    const threadId = activeThread.id;
    const commandId = CommandId.make(randomUUID());
    undoingRef.current = true;
    try {
      await waitForThreadRewind(
        routeThreadRef,
        commandId,
        (thread) => thread.rewindUndo?.rewindId !== undo.rewindId,
        async () => {
          const result = await undoThreadRewind({
            environmentId,
            input: { commandId, threadId, rewindId: undo.rewindId },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        },
      );
      clearRewindPrefill(undo.messageId);
    } catch (error) {
      setThreadError(
        threadId,
        error instanceof Error ? error.message : "The rewind could not be undone.",
      );
    } finally {
      undoingRef.current = false;
    }
  };
  const onUndoRewindStable = useStableCallback(onUndoRewind);

  const onForkFromRun = async (input: {
    readonly sourceThreadId: ThreadId;
    readonly runId: RunId;
  }) => {
    if (!activeThread || activeEnvironmentUnavailable) return;
    const targetThreadId = newThreadId();
    const targetThreadRef = scopeThreadRef(environmentId, targetThreadId);
    const result = await forkThreadFromRun({
      environmentId,
      input: {
        sourceThreadId: input.sourceThreadId,
        targetThreadId,
        runId: input.runId,
        title: `${activeThread.title} fork`,
      },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThread.id,
          error instanceof Error ? error.message : "Failed to fork this response.",
        );
      }
      return;
    }
    const targetThreadReady = await waitForThreadShell(targetThreadRef);
    if (!targetThreadReady) {
      setThreadError(
        activeThread.id,
        "The fork was created, but its thread data did not reach this client. Reconnect and try opening it from the sidebar.",
      );
      return;
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(targetThreadRef),
    });
  };
  const onForkFromRunStable = useStableCallback(onForkFromRun);
  return {
    onForkFromRunStable,
    onRewindStable,
    onUndoRewindStable,
  };
}
