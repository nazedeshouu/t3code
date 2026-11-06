import { useEffect, useEffectEvent, useRef } from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isEditableFocused } from "../../lib/editableFocus";
import { isPreviewFocused } from "../../lib/previewFocus";
import { isInSideChatPane } from "../../lib/sideChatPane";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { registerCommands } from "../../shortcuts/dispatcher";
import { TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR } from "./composerFocusRedirect";
import { advanceRewindEscape, type RewindEscapeState } from "./rewindDock.logic";

/** A focused surface with its own idea of the key, or a layer open above the chat. */
export function keyBelongsElsewhere(event: KeyboardEvent, ownEditable: string): boolean {
  const target = event.target;
  return (
    event.isComposing ||
    event.keyCode === 229 ||
    isTerminalFocused() ||
    isPreviewFocused() ||
    isModelPickerOpen() ||
    isCommandPaletteOpen() ||
    isInSideChatPane(target) ||
    document.querySelector(TYPE_TO_FOCUS_FLOATING_LAYER_SELECTOR) !== null ||
    (target instanceof Element && isEditableFocused(target) && target.closest(ownEditable) === null)
  );
}

/**
 * Escape twice opens the rewind dock. It observes after every scope, so a first Escape that closed
 * a menu or cleared a selection never arms. Base UI layers `preventDefault` and usually stop the
 * key at the document (`useDismiss`), so they read as consumed or never arrive here.
 */
export function useRewindEscape(input: {
  readonly enabled: boolean;
  /** Thread find closes from a later window listener, so its Escape is not yet consumed. */
  readonly threadFindActive: boolean;
  readonly onOpen: () => void;
}) {
  const armedAtRef = useRef<RewindEscapeState>(null);
  const onKeyDown = useEffectEvent((event: KeyboardEvent, consumed: boolean) => {
    const { armedAt, open } = advanceRewindEscape(armedAtRef.current, {
      key: event.key,
      repeat: event.repeat,
      blocked:
        consumed ||
        !input.enabled ||
        input.threadFindActive ||
        (event.key === "Escape" && keyBelongsElsewhere(event, "[data-chat-composer-form]")),
      now: event.timeStamp,
    });
    armedAtRef.current = armedAt;
    if (open) input.onOpen();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the keyboard dispatcher for the life of the chat view
  useEffect(
    () =>
      registerCommands(
        {},
        { observe: (event: KeyboardEvent, consumed: boolean) => onKeyDown(event, consumed) },
      ),
    [],
  );
}
