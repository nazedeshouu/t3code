import type { CommandId, MessageId, ThreadRewindMode } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  advanceRewindEscape,
  assumedRewindModes,
  formatRewindStat,
  rewindChoices,
  rewindConsequence,
  rewindRowCode,
  rewindUnavailableReason,
  rewindUndoDescription,
  type RewindEscapePress,
  type RewindEscapeState,
} from "./rewindDock.logic";

const press = (now: number, overrides: Partial<RewindEscapePress> = {}): RewindEscapePress => ({
  key: "Escape",
  repeat: false,
  blocked: false,
  now,
  ...overrides,
});

function replay(presses: ReadonlyArray<RewindEscapePress>) {
  let armedAt: RewindEscapeState = null;
  const opened: number[] = [];
  for (const next of presses) {
    const result = advanceRewindEscape(armedAt, next);
    armedAt = result.armedAt;
    if (result.open) opened.push(next.now);
  }
  return opened;
}

describe("advanceRewindEscape", () => {
  it.each([
    ["two presses inside the window", [press(0), press(500)], [500]],
    ["two presses outside the window", [press(0), press(501)], []],
    ["a third press re-arms rather than reopening", [press(0), press(100), press(200)], [100]],
    ["a slow press becomes the new first press", [press(0), press(900), press(1000)], [1000]],
    ["held Escape is one press", [press(0), press(30, { repeat: true })], []],
    [
      "a repeat keeps the first press armed",
      [press(0, {}), press(30, { repeat: true }), press(90)],
      [90],
    ],
    ["a consumed first press does not arm", [press(0, { blocked: true }), press(100)], []],
    ["a consumed second press disarms", [press(0), press(100, { blocked: true }), press(200)], []],
    ["any other key disarms", [press(0), press(100, { key: "a" }), press(200)], []],
  ])("%s", (_name, presses, opened) => {
    expect(replay(presses)).toEqual(opened);
  });
});

describe("rewind row stats", () => {
  it("names the only file and counts several", () => {
    expect(
      formatRewindStat({
        filesChanged: 1,
        insertions: 12,
        deletions: 4,
        primaryPath: "src/auth/auth.ts" as never,
      }),
    ).toEqual({ label: "auth.ts", insertions: "+12", deletions: "−4" });
    expect(
      formatRewindStat({ filesChanged: 3, insertions: 1500, deletions: 18, primaryPath: null }),
    ).toEqual({ label: "3 files", insertions: "+1.5k", deletions: "−18" });
    expect(
      formatRewindStat({ filesChanged: 2, insertions: 0, deletions: 3, primaryPath: null }),
    ).toEqual({ label: "2 files", insertions: null, deletions: "−3" });
  });

  it("leaves a turn with unknown stats blank", () => {
    expect(rewindRowCode({ state: "pending" })).toEqual({
      kind: "text",
      text: "",
      warning: false,
    });
  });

  it("warns only for turns without a snapshot", () => {
    expect(rewindRowCode({ state: "unchanged" })).toEqual({
      kind: "text",
      text: "No code changes",
      warning: false,
    });
    expect(rewindRowCode({ state: "unavailable" })).toEqual({
      kind: "text",
      text: "No code restore",
      warning: true,
    });
  });
});

describe("rewind options", () => {
  it("keeps server order and ends with Never mind", () => {
    expect(rewindChoices(["conversation", "summarize_from_here"])).toEqual([
      "conversation",
      "summarize_from_here",
      "cancel",
    ]);
    expect(rewindChoices([])).toEqual(["cancel"]);
  });

  it.each<[string, Parameters<typeof assumedRewindModes>, ThreadRewindMode[]]>([
    [
      "every option",
      [{ state: "unchanged" }, true],
      ["code_and_conversation", "conversation", "code", "summarize_from_here"],
    ],
    ["no snapshot", [{ state: "unavailable" }, true], ["conversation", "summarize_from_here"]],
    ["no provider rollback", [{ state: "unchanged" }, false], ["code"]],
  ])("assumes %s while the preview loads", (_name, input, modes) => {
    expect(assumedRewindModes(...input)).toEqual(modes);
  });

  it("describes what each option does", () => {
    const preview = {
      code: { filesChanged: 1, insertions: 12, deletions: 4, primaryPath: "auth.ts" as never },
      removedMessageCount: 3,
    };
    expect(rewindConsequence("code_and_conversation", preview)).toEqual({
      stat: { label: "auth.ts", insertions: "+12", deletions: "−4" },
      text: "reverted, 3 messages removed",
    });
    expect(
      rewindConsequence("code_and_conversation", {
        code: { filesChanged: 0, insertions: 0, deletions: 0, primaryPath: null },
        removedMessageCount: 1,
      }).text,
    ).toBe("No file changes, 1 message removed");
  });
});

describe("rewindUnavailableReason", () => {
  it("explains only when neither conversation nor code can move", () => {
    const code = [{ code: { state: "unavailable" } as const }];
    expect(rewindUnavailableReason(code, true)).toBeNull();
    expect(rewindUnavailableReason([{ code: { state: "unchanged" } }], false)).toBeNull();
    expect(rewindUnavailableReason([], false)).toBeNull();
    expect(rewindUnavailableReason(code, false)).not.toBeNull();
  });
});

describe("rewindUndoDescription", () => {
  const undo = (mode: ThreadRewindMode, removedMessageCount: number, filesRestored: number) => ({
    rewindId: "rewind" as CommandId,
    mode,
    messageId: "message" as MessageId,
    removedMessageCount,
    filesRestored,
    createdAt: DateTime.makeUnsafe(0),
  });

  it.each<[ThreadRewindMode, number, number, string]>([
    ["code_and_conversation", 4, 3, "4 messages removed · 3 files restored"],
    ["conversation", 1, 0, "1 message removed"],
    ["code", 0, 1, "1 file restored"],
    ["summarize_from_here", 6, 0, "6 messages summarized"],
    ["conversation", 0, 0, ""],
  ])("%s", (mode, removed, restored, description) => {
    expect(rewindUndoDescription(undo(mode, removed, restored))).toBe(description);
  });
});
