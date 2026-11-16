import type { ClientSettings } from "@t3tools/contracts/settings";

/** One row here is one toggle in Labs > Naze's stuff, searchable in settings and on by default. */
export const NAZE_LABS = [
  {
    id: "naze-rewind",
    title: "Rewind",
    description:
      "Double Esc, /rewind, the Rewind command, and its shortcut open the rewind dock. Off leaves the message action, and file checkpoints keep running either way.",
    searchTerms: "rewind esc escape undo checkpoint dock",
  },
  {
    id: "naze-tool-file-links",
    title: "Tool activity file links",
    description: "File paths in tool activity open the file. Off shows them as plain text.",
    searchTerms: "tool activity work log file path link open",
  },
  {
    id: "naze-file-mentions",
    title: "Better @ file mentions",
    description:
      "Typing a path after @ browses that folder, including ~/ and absolute paths on the thread's machine. Enter opens a folder, Space mentions it. Off searches project file names only.",
    searchTerms: "mention file folder path at browse home absolute composer",
  },
] as const;

export type NazeLabId = (typeof NAZE_LABS)[number]["id"];

export function nazeLabEnabled(settings: Pick<ClientSettings, "nazeLabs">, id: NazeLabId): boolean {
  return settings.nazeLabs[id] ?? true;
}
