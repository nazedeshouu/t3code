import type {
  EnvironmentId,
  MessageId,
  ThreadId,
  ThreadRewindMode,
  ThreadRewindPreview,
  ThreadRewindTarget,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  memo,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { registerCommands } from "../../shortcuts/dispatcher";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { cn } from "~/lib/utils";
import type { ComposerHandleRef } from "../../composerHandleContext";
import { Kbd } from "../ui/kbd";
import { ScrollArea } from "../ui/scroll-area";
import { closeRewindDock, type RewindDockRequest } from "./ChatOverlayHosts";
import { ComposerSurface } from "./ComposerSurface";
import {
  assumedRewindModes,
  REWIND_MODE_LABELS,
  restoresCode,
  rewindChoices,
  rewindConsequence,
  rewindRowCode,
  rewindUnavailableReason,
  type RewindChoice,
  type RewindStat,
} from "./rewindDock.logic";
import { setRewindPreviewTarget } from "./rewindPreviewTarget";
import { keyBelongsElsewhere } from "./useRewindEscape";
import type { RewindRequest } from "./useTimelineRewind";

const DOCK_SELECTOR = "[data-rewind-dock]";
const STEP_ENTER =
  "transition-[opacity,translate] duration-150 ease-out starting:translate-y-1 starting:opacity-0 motion-reduce:transition-none";
const ROW =
  "flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg px-2.5 text-start transition-colors duration-100 pointer-coarse:min-h-11 aria-selected:bg-foreground/[0.07] motion-reduce:transition-none";

/** While a step is open it owns the keyboard, wherever focus went after a click on the thread. */
function useDockKeys(onKeyDown: (event: KeyboardEvent) => boolean) {
  const handle = useEffectEvent(onKeyDown);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes this step to the keyboard dispatcher for as long as it is on screen
  useEffect(
    () =>
      registerCommands(
        {},
        {
          capture: true,
          when: (event) => !keyBelongsElsewhere(event, DOCK_SELECTOR),
          onKeyDown: (event) => handle(event),
        },
      ),
    [],
  );
}

const isPlainKey = (event: KeyboardEvent) => !event.metaKey && !event.ctrlKey && !event.altKey;
const isPrintable = (event: KeyboardEvent) => event.key.length === 1 && isPlainKey(event);

function consume(event: KeyboardEvent, run?: () => void): true {
  event.preventDefault();
  if (!event.repeat) run?.();
  return true;
}

function Hints({ children }: { readonly children: ReactNode }) {
  return (
    <span className="flex flex-none items-center gap-2.5 text-secondary-label text-xs pointer-coarse:hidden">
      {children}
    </span>
  );
}

function Header({ title, hints }: { readonly title: ReactNode; readonly hints: ReactNode }) {
  return (
    <header className="flex min-h-7 items-center justify-between gap-4 px-2.5 pb-1">
      <div className="flex min-w-0 items-baseline gap-2 text-sm">{title}</div>
      <Hints>{hints}</Hints>
    </header>
  );
}

function StatNumbers({ stat }: { readonly stat: RewindStat }) {
  return (
    <span className="font-mono text-xs tabular-nums">
      <span className="text-muted-foreground">{stat.label}</span>
      {stat.insertions === null ? null : (
        <span className="text-diff-addition-foreground"> {stat.insertions}</span>
      )}
      {stat.deletions === null ? null : (
        <span className="text-diff-deletion-foreground"> {stat.deletions}</span>
      )}
    </span>
  );
}

function TargetCode({ target }: { readonly target: ThreadRewindTarget }) {
  const code = rewindRowCode(target.code);
  if (code.kind === "stat") return <StatNumbers stat={code.stat} />;
  return (
    <span
      className={cn(
        "font-mono text-xs tabular-nums",
        code.warning ? "text-warning-foreground" : "text-muted-foreground",
      )}
    >
      {code.text}
    </span>
  );
}

const TargetRow = memo(function TargetRow(props: {
  readonly target: ThreadRewindTarget;
  readonly index: number;
  readonly selected: boolean;
  readonly onSelect: (messageId: MessageId) => void;
  readonly onChoose: (messageId: MessageId) => void;
}) {
  const { target, index, selected, onSelect, onChoose } = props;
  return (
    <div
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      data-rewind-row={index}
      className={cn(ROW, "min-h-8 py-1")}
      onPointerMove={() => onSelect(target.messageId)}
      onClick={() => onChoose(target.messageId)}
    >
      <span className="min-w-0 flex-1 truncate text-sm">{target.text || "Attachments only"}</span>
      <span className="flex-none">
        <TargetCode target={target} />
      </span>
    </div>
  );
});

function TargetList(props: {
  readonly targets: ReadonlyArray<ThreadRewindTarget> | null;
  readonly error: string | null;
  readonly supportsConversationRollback: boolean;
  readonly selected: MessageId | null;
  readonly onSelect: (messageId: MessageId | null) => void;
  readonly onChoose: (messageId: MessageId) => void;
  readonly onClose: () => void;
}) {
  const { targets, error, selected, onSelect, onChoose, onClose } = props;
  const listRef = useRef<HTMLDivElement>(null);
  const unavailable =
    targets === null ? null : rewindUnavailableReason(targets, props.supportsConversationRollback);
  const rows = unavailable === null ? (targets ?? []) : [];
  const rowIds = [...rows.map((target) => target.messageId), null];
  const selectedIndex = rowIds.indexOf(selected);
  const position = selectedIndex === -1 ? rows.length : selectedIndex;
  const revealRow = (index: number) =>
    listRef.current
      ?.querySelector(`[data-rewind-row="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  const rowsReady = targets !== null;
  const revealSelectedRow = useEffectEvent(() => revealRow(position));
  // Only on arrival: later moves reveal from the keyboard handler, never from a hover.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the list's DOM to the selected row when its rows arrive
  useLayoutEffect(() => {
    if (rowsReady) revealSelectedRow();
  }, [rowsReady]);

  useDockKeys((event) => {
    const move = (delta: number) => {
      const next = Math.min(Math.max(position + delta, 0), rows.length);
      onSelect(rowIds[next] ?? null);
      revealRow(next);
    };
    if (event.key === "Escape") return consume(event, onClose);
    if (!isPlainKey(event)) return false;
    if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) {
      event.preventDefault();
      move(-1);
      return true;
    }
    if (event.key === "ArrowDown" || event.key === "Tab") {
      event.preventDefault();
      move(1);
      return true;
    }
    if (event.key === "Enter") {
      return consume(event, () => {
        if (selected === null) onClose();
        else onChoose(selected);
      });
    }
    return isPrintable(event) ? consume(event) : false;
  });

  return (
    <div className={STEP_ENTER}>
      <Header
        title={<h2 className="font-medium">Rewind</h2>}
        hints={
          <>
            <span className="flex items-center gap-1">
              <Kbd>↑↓</Kbd> move
            </span>
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd> choose
            </span>
            <Kbd>esc</Kbd>
          </>
        }
      />
      {error !== null ? <Note tone="error">{error}</Note> : null}
      {unavailable !== null ? <Note>{unavailable}</Note> : null}
      {targets === null && error === null ? <TargetListSkeleton /> : null}
      {targets?.length === 0 ? <Note>Nothing to rewind to yet.</Note> : null}
      <ScrollArea scrollFade radius="none" className="h-auto max-h-72">
        <div ref={listRef} role="listbox" aria-label="Messages to rewind to" className="grid">
          {rows.map((target, index) => (
            <TargetRow
              key={target.messageId}
              target={target}
              index={index}
              selected={selected === target.messageId}
              onSelect={onSelect}
              onChoose={onChoose}
            />
          ))}
          <div
            role="option"
            tabIndex={-1}
            aria-selected={position === rows.length}
            data-rewind-row={rows.length}
            className={cn(ROW, "min-h-8 py-1 text-muted-foreground text-sm")}
            onPointerMove={() => onSelect(null)}
            onClick={onClose}
          >
            Current
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

function TargetListSkeleton() {
  return (
    <div aria-hidden className="grid">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex min-h-8 items-center px-2.5">
          <span className="h-3 w-3/5 rounded-sm bg-foreground/[0.07]" />
        </div>
      ))}
    </div>
  );
}

function Note({
  tone = "muted",
  children,
  className,
}: {
  readonly tone?: "muted" | "warning" | "error";
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <p
      {...(tone === "error" ? { role: "alert" } : {})}
      className={cn(
        "px-2.5 py-1 text-xs",
        tone === "muted" && "text-muted-foreground",
        tone === "warning" && "text-warning-foreground",
        tone === "error" && "text-destructive-foreground",
        className,
      )}
    >
      {children}
    </p>
  );
}

function ConsequenceLine(props: {
  readonly choice: ThreadRewindMode;
  readonly preview: ThreadRewindPreview | null;
  readonly failed: boolean;
}) {
  if (props.preview === null) {
    return props.failed ? null : (
      <span aria-hidden className="flex h-4 items-center">
        <span className="h-2.5 w-40 max-w-full rounded-sm bg-foreground/[0.07]" />
      </span>
    );
  }
  const { stat, text } = rewindConsequence(props.choice, props.preview);
  return (
    <span className="block truncate text-muted-foreground text-xs">
      {stat === null ? null : (
        <>
          <StatNumbers stat={stat} />{" "}
        </>
      )}
      {text}
    </span>
  );
}

type Busy = "rewinding" | "stopping" | null;

function Options(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly target: ThreadRewindTarget;
  readonly supportsConversationRollback: boolean;
  readonly onBack: () => void;
  readonly onRewind: (request: RewindRequest) => Promise<string | null>;
  readonly onRewound: (mode: ThreadRewindMode) => void;
}) {
  const { environmentId, threadId, target, onBack } = props;
  const query = useEnvironmentQuery(
    orchestrationEnvironment.rewindPreview({
      environmentId,
      input: { threadId, messageId: target.messageId },
    }),
  );
  const preview = query.data;
  const modes =
    preview?.modes ??
    (query.error === null
      ? assumedRewindModes(target.code, props.supportsConversationRollback)
      : []);
  const choices = rewindChoices(modes);
  const [picked, setPicked] = useState<RewindChoice | null>(null);
  const active = picked !== null && choices.includes(picked) ? picked : (choices[0] ?? "cancel");
  const [summary, setSummary] = useState<string | null>(null);
  const summaryRef = useRef<HTMLInputElement>(null);
  const summaryOpen = summary !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves DOM focus into the summary field when it opens
  useLayoutEffect(() => {
    if (summaryOpen) summaryRef.current?.focus();
  }, [summaryOpen]);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const ready = preview !== null && busy === null;

  const choose = async (choice: RewindChoice) => {
    if (choice === "cancel") {
      if (busy === null) onBack();
      return;
    }
    if (!ready) return;
    setPicked(choice);
    setError(null);
    setBusy("rewinding");
    const failure = await props.onRewind({
      messageId: target.messageId,
      mode: choice,
      ...(choice === "summarize_from_here" && summary !== null
        ? { summaryInstructions: summary }
        : {}),
      onStopping: () => setBusy("stopping"),
    });
    if (failure === null) {
      props.onRewound(choice);
      return;
    }
    setBusy(null);
    setError(failure);
  };

  useDockKeys((event) => {
    if (event.target === summaryRef.current && summary !== null) {
      if (event.key === "Escape") return consume(event, () => setSummary(null));
      if (event.key === "Enter") return consume(event, () => void choose(active));
      return false;
    }
    if (event.key === "Escape") {
      return consume(event, () => {
        if (summary !== null) setSummary(null);
        else if (busy === null) onBack();
      });
    }
    if (!isPlainKey(event)) return false;
    const index = choices.indexOf(active);
    const move = (delta: number) => {
      event.preventDefault();
      setPicked(choices[(index + delta + choices.length) % choices.length] ?? null);
      setSummary(null);
      return true;
    };
    if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) return move(-1);
    if (event.key === "Tab" && active === "summarize_from_here" && summary === null) {
      return consume(event, () => setSummary(""));
    }
    if (event.key === "ArrowDown" || event.key === "Tab") return move(1);
    if (event.key === "Enter") return consume(event, () => void choose(active));
    if (isPrintable(event)) {
      const numbered = choices[Number(event.key) - 1];
      if (numbered !== undefined) return consume(event, () => void choose(numbered));
      if (active === "summarize_from_here" && busy === null) {
        return consume(event, () => setSummary(event.key));
      }
      return consume(event);
    }
    return false;
  });

  const busyLabel = busy === "stopping" ? "Stopping the current turn…" : "Rewinding…";
  const warnsAboutCode = modes.some(restoresCode);
  const codeFocused = restoresCode(active);
  return (
    <div className={STEP_ENTER} aria-busy={busy !== null}>
      <Header
        title={
          <>
            <span className="min-w-0 truncate font-medium">
              {target.text || "Attachments only"}
            </span>
            <span className="flex-none text-muted-foreground text-xs">
              {formatRelativeTimeLabel(DateTime.formatIso(target.createdAt))}
            </span>
          </>
        }
        hints={<Kbd>{`1–${choices.length}`}</Kbd>}
      />
      <div role="listbox" aria-label="Rewind options" className="grid">
        {choices.map((choice, index) => {
          const isActive = choice === active;
          return (
            <div
              key={choice}
              role="option"
              tabIndex={-1}
              aria-selected={isActive}
              className={cn(
                ROW,
                "min-h-11 py-1",
                busy !== null && !isActive && "opacity-50",
                !ready && choice !== "cancel" && "cursor-default",
              )}
              onPointerMove={() => {
                if (busy === null) setPicked(choice);
              }}
              onClick={() => void choose(choice)}
            >
              <span className="w-3 flex-none font-mono text-secondary-label text-xs tabular-nums">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{REWIND_MODE_LABELS[choice]}</span>
                {choice === "cancel" ? null : isActive && busy !== null ? (
                  <span className="block truncate text-muted-foreground text-xs">{busyLabel}</span>
                ) : isActive && summary !== null ? (
                  <input
                    ref={summaryRef}
                    value={summary}
                    placeholder="Add context (optional)"
                    aria-label="Add context (optional)"
                    className="block h-4 w-full bg-transparent text-xs outline-none placeholder:text-placeholder"
                    onChange={(event) => setSummary(event.target.value)}
                    onClick={(event) => event.stopPropagation()}
                  />
                ) : (
                  <ConsequenceLine
                    choice={choice}
                    preview={preview}
                    failed={query.error !== null}
                  />
                )}
              </span>
            </div>
          );
        })}
      </div>
      {preview?.codeUnavailableReason ? <Note>{preview.codeUnavailableReason}</Note> : null}
      {query.error !== null ? <Note tone="error">{query.error}</Note> : null}
      {error !== null ? <Note tone="error">{error}</Note> : null}
      {warnsAboutCode ? (
        <div
          aria-hidden={!codeFocused}
          className={cn(
            "transition-opacity duration-100 motion-reduce:transition-none",
            !codeFocused && "opacity-0",
          )}
        >
          <Note className="pb-0">
            Restored files go back whole, losing later changes by anyone. Bash changes to other
            files aren't undone.
          </Note>
          {preview?.sharedWorkspaceActive ? (
            <Note tone="warning" className="pt-0">
              Another thread is working in this folder.
            </Note>
          ) : null}
        </div>
      ) : null}
      <span role="status" className="sr-only">
        {busy === null ? "" : busyLabel}
      </span>
    </div>
  );
}

function RewindSteps(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadKey: string;
  readonly initialMessageId: MessageId | null;
  readonly supportsConversationRollback: boolean;
  readonly onRewind: (request: RewindRequest) => Promise<string | null>;
  readonly onRewound: (mode: ThreadRewindMode) => void;
}) {
  const { environmentId, threadId, threadKey, initialMessageId } = props;
  const query = useEnvironmentQuery(
    orchestrationEnvironment.rewindTargets({ environmentId, input: { threadId } }),
  );
  const targets = query.data?.targets ?? null;
  const [view, setView] = useState({
    options: initialMessageId !== null,
    messageId: initialMessageId,
  });
  const target = targets?.find((candidate) => candidate.messageId === view.messageId);
  const select = useStableCallback((messageId: MessageId | null) => {
    if (messageId === view.messageId && !view.options) return;
    setView({ options: false, messageId });
    setRewindPreviewTarget({ threadKey, messageId });
  });
  const enterOptions = useStableCallback((messageId: MessageId) => {
    setView({ options: true, messageId });
    setRewindPreviewTarget({ threadKey, messageId });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- points the timeline preview at the message the dock opened on
  useEffect(() => {
    setRewindPreviewTarget({ threadKey, messageId: initialMessageId });
  }, [initialMessageId, threadKey]);
  const orphaned = targets !== null && view.messageId !== null && target === undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the timeline preview of a message the server does not offer as a target
  useEffect(() => {
    if (orphaned) setRewindPreviewTarget({ threadKey, messageId: null });
  }, [orphaned, threadKey]);

  if (view.options && target !== undefined) {
    return (
      <Options
        key={target.messageId}
        environmentId={environmentId}
        threadId={threadId}
        target={target}
        supportsConversationRollback={props.supportsConversationRollback}
        onBack={() => setView({ options: false, messageId: target.messageId })}
        onRewind={props.onRewind}
        onRewound={props.onRewound}
      />
    );
  }
  return (
    <TargetList
      targets={targets}
      error={query.error}
      supportsConversationRollback={props.supportsConversationRollback}
      selected={target?.messageId ?? null}
      onSelect={select}
      onChoose={enterOptions}
      onClose={closeRewindDock}
    />
  );
}

/**
 * The composer's slot while rewinding. The composer stays mounted and hidden underneath, so the
 * draft comes back exactly as it was, and the thread itself shows what the selection would do.
 */
export function RewindDock(props: {
  readonly request: RewindDockRequest;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadKey: string;
  readonly supportsConversationRollback: boolean;
  readonly composerRef: ComposerHandleRef;
  /** Lets go of the timeline; the release puts it back, or at its end after a rewind. */
  readonly holdTimeline: () => (returnToEnd: boolean) => boolean;
  readonly onRewind: (request: RewindRequest) => Promise<string | null>;
}) {
  const { composerRef, holdTimeline } = props;
  const dockRef = useRef<HTMLElement>(null);
  const conversationChangedRef = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- borrows the timeline and keyboard focus from the composer for as long as the dock is open
  useLayoutEffect(() => {
    const cursor = composerRef.current?.readSnapshot().cursor;
    const releaseTimeline = holdTimeline();
    dockRef.current?.focus({ preventScroll: true });
    return () => {
      setRewindPreviewTarget(null);
      const conversationChanged = conversationChangedRef.current;
      if (!releaseTimeline(conversationChanged)) return;
      if (window.matchMedia("(pointer: coarse)").matches) return;
      requestAnimationFrame(() => {
        if (conversationChanged || cursor === undefined) composerRef.current?.focusAtEnd();
        else composerRef.current?.focusAt(cursor);
      });
    };
  }, [composerRef, holdTimeline]);
  const onRewound = (mode: ThreadRewindMode) => {
    conversationChangedRef.current = mode !== "code";
    closeRewindDock();
  };
  return (
    <ComposerSurface.Main>
      <section
        ref={dockRef}
        tabIndex={-1}
        aria-label="Rewind"
        data-rewind-dock="true"
        className="p-1.5 pt-2 outline-none"
      >
        <RewindSteps
          key={props.request.key}
          environmentId={props.environmentId}
          threadId={props.threadId}
          threadKey={props.threadKey}
          initialMessageId={props.request.messageId}
          supportsConversationRollback={props.supportsConversationRollback}
          onRewind={props.onRewind}
          onRewound={onRewound}
        />
      </section>
    </ComposerSurface.Main>
  );
}
