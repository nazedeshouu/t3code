import type { LegendListRef } from "@legendapp/list/react";
import type { MessageId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, type RefObject } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import type { MessagesTimelineHistoryControls } from "./MessagesTimeline";
import { rewindPreviewTargetAtom, type RewindPreviewTarget } from "./rewindPreviewTarget";

/** Long enough that holding an arrow key scrolls only where it stops. */
const REVEAL_DEBOUNCE_MS = 110;
const REVEAL_MARGIN_PX = 96;

const rowShowsMessage = (row: MessagesTimelineRow, messageId: MessageId) =>
  row.kind === "message" && row.message.id === messageId;

function paintRewindBoundary(
  viewport: HTMLElement,
  rows: ReadonlyArray<MessagesTimelineRow>,
  target: MessageId | null,
) {
  if (target === null) {
    delete viewport.dataset.rewindPreview;
    viewport.style.removeProperty("--rewind-boundary");
    return;
  }
  const boundary = rows.findIndex((row) => rowShowsMessage(row, target));
  viewport.style.setProperty("--rewind-boundary", String(boundary));
  viewport.dataset.rewindPreview = "true";
}

/**
 * Shows on the real thread what the rewind dock's selection would do. Selection writes one CSS
 * variable on the viewport (see `[data-rewind-preview]` in index.css), so moving it renders no
 * rows and restyles only the mounted ones. Everything before the selection is untouched; a target
 * not paged in yet leaves every loaded row dimmed until its page arrives.
 */
export function useRewindTimelinePreview(input: {
  readonly threadKey: string;
  readonly viewport: HTMLElement | null;
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly historyControls: MessagesTimelineHistoryControls | undefined;
  readonly contentInsetEndAdjustment: number;
}) {
  const { threadKey, viewport, rows, listRef, historyControls } = input;
  const targetRef = useRef<MessageId | null>(null);
  const revealedRef = useRef<MessageId | null>(null);
  const requestedPageRef = useRef<string | null>(null);

  const reveal = useEffectEvent(
    (
      currentRows: ReadonlyArray<MessagesTimelineRow>,
      history: MessagesTimelineHistoryControls | undefined,
    ) => {
      const target = targetRef.current;
      if (target === null || revealedRef.current === target) return;
      const index = currentRows.findIndex((row) => rowShowsMessage(row, target));
      if (index < 0) {
        const page = `${target}:${currentRows[0]?.id ?? ""}`;
        if (history?.hasMoreHistory && !history.loading && requestedPageRef.current !== page) {
          requestedPageRef.current = page;
          history.onLoadEarlier(target);
        }
        return;
      }
      revealedRef.current = target;
      const list = listRef.current;
      const scrollNode = list?.getScrollableNode();
      if (!list || !scrollNode) return;
      const rowElement: HTMLElement | undefined = list.getState().elementAtIndex(index);
      const view = scrollNode.getBoundingClientRect();
      const top = rowElement?.getBoundingClientRect().top;
      if (
        top !== undefined &&
        top >= view.top + REVEAL_MARGIN_PX / 2 &&
        top <= view.bottom - input.contentInsetEndAdjustment - REVEAL_MARGIN_PX
      ) {
        return;
      }
      void list.scrollToIndex({
        index,
        animated: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        viewOffset: REVEAL_MARGIN_PX,
      });
    },
  );
  const paintCurrentRows = useEffectEvent((element: HTMLElement) =>
    paintRewindBoundary(element, rows, targetRef.current),
  );
  const revealCurrentRows = useEffectEvent(() => reveal(rows, historyControls));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the dock's selection outside React so arrowing through it renders nothing here
  useEffect(() => {
    if (!viewport) return;
    let revealTimer: ReturnType<typeof setTimeout> | undefined;
    const onTarget = (preview: RewindPreviewTarget | null) => {
      const target = preview?.threadKey === threadKey ? preview.messageId : null;
      if (target === targetRef.current) return;
      targetRef.current = target;
      revealedRef.current = null;
      paintCurrentRows(viewport);
      clearTimeout(revealTimer);
      if (target !== null) revealTimer = setTimeout(revealCurrentRows, REVEAL_DEBOUNCE_MS);
    };
    onTarget(appAtomRegistry.get(rewindPreviewTargetAtom));
    const unsubscribe = appAtomRegistry.subscribe(rewindPreviewTargetAtom, onTarget);
    return () => {
      unsubscribe();
      clearTimeout(revealTimer);
      targetRef.current = null;
      paintRewindBoundary(viewport, [], null);
    };
  }, [threadKey, viewport]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the boundary on its row, and finishes a reveal, as rows stream in or a page loads
  useEffect(() => {
    if (!viewport || targetRef.current === null) return;
    paintRewindBoundary(viewport, rows, targetRef.current);
    reveal(rows, historyControls);
  }, [historyControls, rows, viewport]);
}
