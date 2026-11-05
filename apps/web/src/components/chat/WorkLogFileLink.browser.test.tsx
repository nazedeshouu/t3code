import {
  AuthFilesystemReadScope,
  EnvironmentId,
  ThreadId,
  type AuthEnvironmentScope,
  type EditorId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { useRightPanelStore } from "../../rightPanelStore";

const state = vi.hoisted(() => ({
  canRead: true,
  openEditor: vi.fn(),
  openFile: vi.fn(),
  expandMedia: vi.fn(),
}));

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.openEditor) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: (_id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
    scope !== AuthFilesystemReadScope || state.canRead,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const config = Atom.make(() => ({
    availableEditors: ["vscode"] as readonly EditorId[],
    environment: { platform: { os: "linux" }, capabilities: {} },
  }));
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => config) as never },
  };
});
vi.mock(import("../../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
vi.mock(import("../../hooks/useLocalStorage"), async (original) => ({
  ...(await original()),
  useLocalStorage: (() => ["vscode", vi.fn()]) as never,
  getLocalStorageItem: (() => "vscode") as never,
}));

import { TimelineRowCtx, type TimelineRowSharedState } from "./timelineRowContext";
import { WorkEntryFileLabelView } from "./WorkLogFileLink";

const threadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};
const label = { prefix: "Read", path: "/work/src/app.ts", displayPath: "src/app.ts", suffix: "" };

function setup() {
  using stack = new DisposableStack();
  state.canRead = true;
  state.openEditor.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.openFile.mockReset();
  state.expandMedia.mockReset();
  const { openFile } = useRightPanelStore.getState();
  useRightPanelStore.setState({ openFile: state.openFile });
  stack.defer(() => useRightPanelStore.setState({ openFile }));
  return stack.move();
}

async function renderRow(context: Partial<TimelineRowSharedState> = {}) {
  const onToggleRow = vi.fn();
  const screen = await render(
    <TimelineRowCtx
      value={
        {
          threadRef,
          markdownCwd: "/work",
          resolvedTheme: "light",
          onImageExpand: state.expandMedia,
          turnItemSource: undefined,
          ...context,
        } as TimelineRowSharedState
      }
    >
      <div role="button" tabIndex={0} onClick={onToggleRow}>
        <WorkEntryFileLabelView label={label} />
      </div>
    </TimelineRowCtx>,
  );
  return {
    onToggleRow,
    row: screen.container.querySelector<HTMLElement>("[role=button]")!,
    link: () => screen.container.querySelector("a"),
  };
}

it("opens the file without toggling the row around it", async () => {
  using _ = setup();
  const { link, onToggleRow } = await renderRow();

  await act(async () => link()!.click());

  expect(state.openFile).toHaveBeenCalledWith(threadRef, "src/app.ts", undefined);
  expect(onToggleRow).not.toHaveBeenCalled();
});

it("leaves the rest of the row toggling it", async () => {
  using _ = setup();
  const { link, onToggleRow, row } = await renderRow();

  await act(async () => row.querySelector<HTMLElement>("span span")!.click());

  expect(link()).not.toBeNull();
  expect(onToggleRow).toHaveBeenCalledOnce();
  expect(state.openFile).not.toHaveBeenCalled();
});

it("opens the file in the editor with the platform's link modifier", async () => {
  using _ = setup();
  const { link, onToggleRow } = await renderRow();
  const modifier = navigator.platform.startsWith("Mac") ? { metaKey: true } : { ctrlKey: true };

  await act(async () => {
    link()!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, ...modifier }),
    );
  });

  await vi.waitFor(() => {
    expect(state.openEditor).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ cwd: "/work/src/app.ts", editor: "vscode" }),
      }),
    );
  });
  expect(state.openFile).not.toHaveBeenCalled();
  expect(onToggleRow).not.toHaveBeenCalled();
});

it("stays plain text for a viewer without file access", async () => {
  using _ = setup();
  state.canRead = false;
  const { link, row } = await renderRow();

  expect(link()).toBeNull();
  expect(row.textContent).toContain("src/app.ts");
});

it("stays plain text on a shared guest page", async () => {
  using _ = setup();
  const { link, row } = await renderRow({
    turnItemSource: {} as TimelineRowSharedState["turnItemSource"],
  });

  expect(link()).toBeNull();
  expect(row.textContent).toContain("src/app.ts");
});

it("stays plain text outside a thread", async () => {
  using _ = setup();
  const { link, row } = await renderRow({ threadRef: null });

  expect(link()).toBeNull();
  expect(row.textContent).toContain("src/app.ts");
});
