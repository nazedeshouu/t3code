import type { MessageId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

export interface RewindPreviewTarget {
  readonly threadKey: string;
  /** Null while the dock rests on the Current row, so nothing previews. */
  readonly messageId: MessageId | null;
}

/**
 * The message the rewind dock has selected. The timeline listens to this directly: arrowing
 * through the dock must not render ChatView or the timeline.
 */
export const rewindPreviewTargetAtom = Atom.make<RewindPreviewTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("chat:rewind-preview-target"),
);

export function setRewindPreviewTarget(target: RewindPreviewTarget | null): void {
  appAtomRegistry.set(rewindPreviewTargetAtom, target);
}
