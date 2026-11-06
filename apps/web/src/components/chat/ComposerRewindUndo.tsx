import type { ThreadRewindUndo } from "@t3tools/contracts";
import { Undo2Icon } from "lucide-react";

import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { rewindUndoDescription } from "./rewindDock.logic";

/** Lives on the thread until its next run, so every client sees it and a reload keeps it. */
export function rewindUndoBannerItem(input: {
  readonly undo: ThreadRewindUndo;
  readonly onUndo: () => void;
}): ComposerBannerStackItem {
  const description = rewindUndoDescription(input.undo);
  return {
    id: "rewind-undo",
    variant: "info",
    icon: <Undo2Icon />,
    title: "Rewound",
    ...(description === "" ? {} : { description }),
    actions: (
      <Button size="xs" variant="ghost" onClick={input.onUndo}>
        Undo
      </Button>
    ),
  };
}
