import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthFilesystemReadScope,
  AuthStandardClientScopes,
  EnvironmentId,
  FilesystemBrowseError,
  ProjectSearchEntriesError,
  ORCHESTRATION_V2_WS_METHODS,
  RunId,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import {
  compileResolvedKeybindingsConfig,
  mergeWithDefaultKeybindings,
} from "@t3tools/shared/keybindings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { selectThreadDiffPanelSelection, useDiffPanelStore } from "~/diffPanelStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { environmentContextRecord } from "~/lib/composerContextRecords";
import { startWorkspaceFocus } from "~/lib/workspaceFocus";
import { usePromptStashStore } from "~/promptStashStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { getRouter } from "~/router";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentSession } from "~/state/session";
import { environmentThreadDetails } from "~/state/threads";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  answerAssetUrls,
  answerRpc,
  assistantItem,
  dispatchedCommands,
  emitThreadEvent,
  hasPendingAssetUrl,
  installFakeEnvironment,
  limitSessionPermissions,
  rejectPendingCommand,
  threadWithHistory,
  threadWithQuestion,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, fakeTimers, render } from "../../test/render";

const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  ),
  (char) => char.charCodeAt(0),
);

/** Accepts every attachment upload without sending its bytes, until disposed. */
function acceptAttachmentUploads(): Disposable {
  const mint = answerRpc(WS_METHODS.attachmentsCreateUploadUrl, () =>
    Effect.succeed({ attachmentId: "upload-1", relativeUrl: "/upload", expiresAt: 0 }),
  );
  // Sending verifies each ready upload still exists on the server.
  const verify = answerRpc(WS_METHODS.assetsCreateUrl, () =>
    Effect.succeed({ relativeUrl: "/upload-1", expiresAt: 0 }),
  );
  const status = vi.spyOn(XMLHttpRequest.prototype, "status", "get").mockReturnValue(200);
  const send = vi.spyOn(XMLHttpRequest.prototype, "send").mockImplementation(function (
    this: XMLHttpRequest,
  ) {
    queueMicrotask(() => this.dispatchEvent(new ProgressEvent("load")));
  });
  return {
    [Symbol.dispose]: () => {
      send.mockRestore();
      status.mockRestore();
      mint[Symbol.dispose]();
      verify[Symbol.dispose]();
    },
  };
}

/** Holds every call to `method` until `release`, then ends it with `end`, until disposed. */
function holdRpc<Input>(method: string, end: Effect.Effect<never, Error>) {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: Input[] = [];
  const answer = answerRpc(method, (input: Input) => {
    calls.push(input);
    return Effect.promise(() => held).pipe(Effect.andThen(end));
  });
  return { calls, release, [Symbol.dispose]: () => answer[Symbol.dispose]() };
}

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("a machine chip stashed in one thread restores with its machine in another", async () => {
  const other = threadWithHistory("thread-stash-restore", 1);
  const asking = threadWithQuestion("thread-stash-question", "Which file should change?");
  using _environment = installFakeEnvironment([other, asking]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-stash-machine");
  const machine = environmentContextRecord(EnvironmentId.make("environment-build"), "Build box");
  const drafts = useComposerDraftStore.getState();
  drafts.setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
    threadId: ThreadId.make("thread-stash-machine"),
  });
  drafts.setPrompt(draftId, "Deploy on ");
  drafts.addEnvironmentContexts(draftId, [machine]);
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const editor = page.getByTestId("composer-editor");
  const pressStashShortcut = async () => {
    await userEvent.click(editor);
    await userEvent.keyboard("{ControlOrMeta>}s{/ControlOrMeta}");
  };
  await vi.waitFor(() => expect(editor.element().textContent).toContain("Deploy on"));
  // A draft can't stash until the shell snapshot lists its project.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();
  await pressStashShortcut();
  await vi.waitFor(() => expect(usePromptStashStore.getState().entries).toHaveLength(1));

  // An answer carries no machines, so an open question refuses the restore and keeps the entry.
  await router.navigate({ to: `/${ENVIRONMENT_ID}/${asking.id}` });
  await expect.element(page.getByText("Which file should change?")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: /^Stashed prompts/ }));
  await userEvent.click(page.getByRole("button", { name: /^Restore stashed prompt/ }));
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("Stashed machines can't go in an answer"),
  );
  expect(usePromptStashStore.getState().entries).toHaveLength(1);

  await router.navigate({ to: `/${ENVIRONMENT_ID}/${other.id}` });
  await expect.element(page.getByText("Answer 0 for thread-stash-restore.")).toBeVisible();
  await pressStashShortcut();

  await vi.waitFor(() => expect(editor.element().textContent).toContain("Deploy on"));
  expect(
    useComposerDraftStore.getState().getComposerDraft(scopeThreadRef(ENVIRONMENT_ID, other.id))
      ?.environmentContexts,
  ).toEqual([machine]);
  expect(
    useComposerDraftStore.getState().getComposerDraft(draftId)?.environmentContexts ?? [],
  ).toEqual([]);
});

it("a question that opens while a stashed file is checked keeps a machine stash", async () => {
  const thread = threadWithHistory("thread-stash-late-question", 1);
  const asking = threadWithQuestion("thread-stash-late-question", "Which file should change?");
  const [request] = asking.runtimeRequests ?? [];
  const question = asking.items.at(-1);
  if (!request || !question) throw new Error("threadWithQuestion has no question");
  using _environment = installFakeEnvironment([thread]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  usePromptStashStore.getState().stashEntry({
    id: "stash-late-question",
    createdAt: "2026-01-01T00:00:00.000Z",
    prompt: "Deploy on ",
    attachments: [],
    files: [
      {
        id: "file-notes",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        attachmentId: "attachment-notes",
        environmentId: ENVIRONMENT_ID,
      },
    ],
    droppedImageNames: [],
    records: [environmentContextRecord(EnvironmentId.make("environment-build"), "Build box")],
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText("Answer 0 for thread-stash-late-question.")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: /^Stashed prompts/ }));
  await userEvent.click(page.getByRole("button", { name: /^Restore stashed prompt/ }));

  // The question opens while the restore still waits on the server's file check.
  await vi.waitFor(() => expect(hasPendingAssetUrl()).toBe(true));
  await emitThreadEvent(thread.id, { type: "turn-item.updated", payload: question });
  await emitThreadEvent(thread.id, { type: "runtime-request.updated", payload: request });
  await expect.element(page.getByText("Which file should change?")).toBeVisible();
  await answerAssetUrls();

  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("Stashed machines can't go in an answer"),
  );
  expect(usePromptStashStore.getState().entries).toHaveLength(1);
  usePromptStashStore.getState().takeEntry("stash-late-question");
});

it("a new draft does not load its reserved thread before the server lists it", async () => {
  using _environment = installFakeEnvironment([]);
  using fetchSpy = vi.spyOn(globalThis, "fetch");
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-27443");
  const threadId = ThreadId.make("thread-27443");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, { threadId });

  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  // The shell snapshot has arrived once the sidebar lists the project, so the connection is up.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  const threadRequests = fetchSpy.mock.calls
    .map(([input]) => String(input instanceof Request ? input.url : input))
    .filter((url) => url.includes(`/api/orchestration/threads/${threadId}/`));
  // A 404 here marks the thread deleted, and the view never loads it once the send creates it.
  expect(threadRequests).toEqual([]);
});

it("an interrupted image-only first send of a new thread says it may not have been sent", async () => {
  using _environment = installFakeEnvironment([]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-image-only-interrupted");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
      threadId: ThreadId.make("thread-image-only-interrupted"),
    });
  // A dropped connection interrupts a new thread's launch, which is not resent.
  using launch = holdRpc(ORCHESTRATION_V2_WS_METHODS.launchThread, Effect.interrupt);
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  using _uploads = acceptAttachmentUploads();
  const editor = page.getByTestId("composer-editor");
  await expect.element(editor).toBeVisible();
  // The send needs the project, which arrives with the shell snapshot.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  await userEvent.click(editor);
  const clipboardData = new DataTransfer();
  clipboardData.items.add(new File([PNG], "shot.png", { type: "image/png" }));
  editor
    .element()
    .dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  await expect.element(page.getByRole("img", { name: "shot.png" })).toBeVisible();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(launch.calls).toHaveLength(1));
  await userEvent.keyboard("next draft");
  await expect.element(editor).toHaveTextContent("next draft");
  launch.release();

  await expect.element(page.getByText("Message may not have been sent")).toBeVisible();
  await expect.element(editor).toHaveTextContent("next draft");
  // With no text there is nothing to copy.
  expect(page.getByText("Copy message", { exact: true }).query()).toBeNull();
});

it("opens the thread actions menu for an older settled thread the shell leaves out", async () => {
  const thread = { ...threadWithHistory("older-settled", 1), olderSettled: true as const };
  using _environment = installFakeEnvironment([thread]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });

  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText("older-settled: question 0")).toBeVisible();

  await page.getByRole("button", { name: `Thread actions for ${thread.title}` }).click();
  // Without a bound the poll runs to the test deadline and reports a bare timeout.
  await expect
    .element(page.getByRole("menuitem", { name: "Rename thread" }), { timeout: 5_000 })
    .toBeVisible();
});

it("retains each thread's diff selection when returning from another thread or Settings", async () => {
  const a = threadWithHistory("diff-selection-a", 1);
  const b = threadWithHistory("diff-selection-b", 1);
  using _environment = installFakeEnvironment([a, b]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const aRef = scopeThreadRef(ENVIRONMENT_ID, a.id);
  const bRef = scopeThreadRef(ENVIRONMENT_ID, b.id);
  useRightPanelStore.getState().open(aRef, "diff");
  useRightPanelStore.getState().open(bRef, "diff");
  useDiffPanelStore.getState().selectBranchBaseRef(bRef, "origin/release");
  const router = getRouter(createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${a.id}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText(`Answer 0 for ${a.id}.`)).toBeVisible();
  await act(() => useDiffPanelStore.getState().selectGitScope(aRef, "unstaged"));

  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: b.id },
    }),
  );
  await expect.element(page.getByText(`Answer 0 for ${b.id}.`)).toBeVisible();
  expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, bRef)).toEqual({
    kind: "branch",
    baseRef: "origin/release",
  });
  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: a.id },
    }),
  );
  await expect.element(page.getByText(`Answer 0 for ${a.id}.`)).toBeVisible();
  expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, aRef)).toEqual({
    kind: "unstaged",
  });

  await act(() => useDiffPanelStore.getState().selectTurn(aRef, a.runs[0]!.id));
  await act(() => router.navigate({ to: "/settings/general" }));
  await expect
    .element(page.getByRole("heading", { name: "Time format", exact: true }))
    .toBeVisible();
  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: a.id },
    }),
  );
  await expect.element(page.getByText(`Answer 0 for ${a.id}.`)).toBeVisible();
  expect(
    selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, aRef),
  ).toMatchObject({
    kind: "turn",
    turnId: a.runs[0]!.id,
  });
});

it("a stashed prompt ending in a file chip restores with the chip", async () => {
  using _environment = installFakeEnvironment([]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-28338");
  const drafts = useComposerDraftStore.getState();
  drafts.setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
    threadId: ThreadId.make("thread-28338"),
  });
  drafts.setPrompt(draftId, "Check [package.json](package.json) ");
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const chip = page.getByRole("button", { name: "Preview package.json" });
  await expect.element(chip).toBeVisible();
  // The stash shortcut is a no-op until the shell snapshot lists the project.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  const editor = page.getByTestId("composer-editor");
  await userEvent.click(editor);
  await userEvent.keyboard("{ControlOrMeta>}s{/ControlOrMeta}");
  await expect.element(chip).not.toBeInTheDocument();
  await userEvent.keyboard("{ControlOrMeta>}s{/ControlOrMeta}");

  await vi.waitFor(() => expect(editor.element().textContent).toContain("Check"));
  expect(editor.element().textContent).not.toContain("[package.json](package.json)");
  await expect.element(chip).toBeVisible();
});

it("a rejected send leaves the timeline when a new draft was typed meanwhile", async () => {
  const thread = threadWithHistory("rejected-send", 1);
  using _environment = installFakeEnvironment([thread], {
    acceptCommands: true,
    holdCommand: (command) => command.type === "message.dispatch",
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();

  const editor = page.getByTestId("composer-editor");
  await userEvent.click(editor);
  await userEvent.keyboard("Failed prompt{Enter}");
  await vi.waitFor(() =>
    expect(dispatchedCommands().map((command) => command.type)).toContain("message.dispatch"),
  );
  await expect.element(page.getByText("Failed prompt")).toBeVisible();
  await userEvent.keyboard("Next draft");

  await rejectPendingCommand("Attachment 'sample.png' cannot be sent.");

  await expect.element(page.getByText("Attachment 'sample.png' cannot be sent.")).toBeVisible();
  await expect.element(page.getByText("Failed prompt")).not.toBeInTheDocument();
  expect(editor.element().textContent).toContain("Next draft");
});

it("Enter on an empty prompt resumes an interrupted thread", async () => {
  const history = threadWithHistory("interrupted", 1);
  const interruptedRun = { ...history.runs[0]!, status: "interrupted" as const };
  const thread = { ...history, runs: [interruptedRun] };
  using _environment = installFakeEnvironment([thread], { acceptCommands: true });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByRole("button", { name: "Resume thread" })).toBeVisible();

  await userEvent.click(page.getByTestId("composer-editor"));
  await userEvent.keyboard("{Enter}");

  await vi.waitFor(() =>
    expect(dispatchedCommands()).toContainEqual(
      expect.objectContaining({ manualContinuationOfRunId: interruptedRun.id }),
    ),
  );
});

it("opening a thread or returning to the window on a touch tablet does not focus the composer", async () => {
  const realMatchMedia = window.matchMedia.bind(window);
  using _touch = vi
    .spyOn(window, "matchMedia")
    .mockImplementation((query) => realMatchMedia(query === "(pointer: coarse)" ? "all" : query));
  const first = threadWithHistory("thread-29469-a", 1);
  const second = threadWithHistory("thread-29469-b", 1);
  using _environment = installFakeEnvironment([first, second]);
  // iPad Pro 11 in landscape: the desktop layout, above max-sm.
  await page.viewport(1194, 834);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${first.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const composer = page.getByTestId("composer-editor");
  await expect.element(page.getByText(`Answer 0 for ${first.id}.`)).toBeVisible();

  // Fake frames hold the next thread entry's focus frame until the test advances it.
  using _timers = fakeTimers();
  await act(() =>
    router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENVIRONMENT_ID, threadId: second.id },
    }),
  );
  await expect.element(page.getByText(`Answer 0 for ${second.id}.`)).toBeVisible();
  vi.advanceTimersToNextFrame();
  // Focusing the editor raises the on-screen keyboard, which shrinks the page on iPadOS.
  expect(document.activeElement).not.toBe(composer.element());

  // ChatView waits two frames after window focus before refocusing the composer.
  window.dispatchEvent(new FocusEvent("focus"));
  vi.advanceTimersToNextFrame();
  vi.advanceTimersToNextFrame();
  expect(document.activeElement).not.toBe(composer.element());
});

it("a mounted thread view lets go of the thread structures it has replaced", async () => {
  // Items are shared with the fixture, so a reopen's snapshot also carries the earlier updates.
  const history = threadWithHistory("updated", 3);
  const items = [...history.items];
  const updated = { ...history, items };
  const other = threadWithHistory("other", 3);
  using _environment = installFakeEnvironment([updated, other]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(createMemoryHistory({ initialEntries: ["/"] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  const open = async (threadId: ThreadId, text: string) => {
    await act(() =>
      router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: ENVIRONMENT_ID, threadId },
      }),
    );
    await expect.element(page.getByText(text).first()).toBeVisible();
  };
  const structureAtom = environmentThreadDetails.quietThreadAtom(
    scopeThreadRef(ENVIRONMENT_ID, updated.id),
  );

  // Each round, a new answer arrives while the thread is shown, then the user switches away.
  const shown: Array<WeakRef<object>> = [];
  await open(other.id, "Answer 2 for other.");
  for (let round = 0; round < 6; round++) {
    await open(updated.id, round === 0 ? "Answer 2 for updated." : `Update ${round - 1}.`);
    const update = assistantItem(
      updated.id,
      RunId.make("updated-run-2"),
      `updated-update-${round}`,
      6 + round,
      `Update ${round}.`,
    );
    items.push(update);
    await act(() => emitThreadEvent(updated.id, { type: "turn-item.updated", payload: update }));
    await expect.element(page.getByText(`Update ${round}.`)).toBeVisible();
    shown.push(new WeakRef(appAtomRegistry.get(structureAtom)!.projection));
    await open(other.id, "Answer 2 for other.");
  }
  await cdp().send("HeapProfiler.collectGarbage");

  // The thread keeps its latest structure, and the timeline may remember the one before it.
  const kept = shown.slice(0, -2).flatMap((structure, round) => (structure.deref() ? [round] : []));
  expect(kept).toEqual([]);
});

it("a shortcut conditioned on rightPanelOpen sees the thread's open right panel", async () => {
  await page.viewport(1280, 800);
  const thread = threadWithHistory("thread-panel-shortcut", 1);
  using _environment = installFakeEnvironment([thread], {
    keybindings: mergeWithDefaultKeybindings(
      compileResolvedKeybindingsConfig([
        { key: "ctrl+t", command: "rightPanel.new", when: "rightPanelOpen && !terminalFocus" },
        { key: "ctrl+t", command: "rightPanel.toggle", when: "!rightPanelOpen" },
      ]),
    ),
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const composer = page.getByTestId("composer-editor");
  const toggle = page.getByRole("button", { name: "Toggle right panel", exact: true });
  await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await page.getByRole("button", { name: /^Files/ }).click();
  await composer.click();
  await userEvent.keyboard("{Control>}t{/Control}");
  await expect.element(page.getByRole("menuitem", { name: /Files/ })).toBeVisible();
  await expect.element(toggle).toHaveAttribute("aria-pressed", "true");
});

it("selecting a side-chat tab focuses that side chat's composer", async () => {
  const parent = threadWithHistory("focus-parent", 1);
  // The shell loaded by the file's first test stays; a family read serves side chats added later.
  const sideChat = (name: string) => ({
    ...threadWithHistory(name, 1),
    sideChatOf: parent.id,
    olderSettled: true as const,
  });
  const side = sideChat("focus-side");
  const otherSide = sideChat("focus-other-side");
  await page.viewport(1400, 900);
  using _environment = installFakeEnvironment([parent, side, otherSide]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const parentRef = scopeThreadRef(ENVIRONMENT_ID, parent.id);
  useRightPanelStore.getState().openSideChat(parentRef, otherSide.id);
  useRightPanelStore.getState().openSideChat(parentRef, side.id);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${parent.id}`] }),
  );
  await router.load();
  await using screen = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  using _focus = { [Symbol.dispose]: startWorkspaceFocus(router) };
  const mainEditor = screen.getByRole("textbox", { name: `Message ${parent.title}`, exact: true });
  const sideEditor = screen.getByRole("textbox", { name: `Message ${side.title}`, exact: true });
  await expect.element(sideEditor).toBeVisible();
  await userEvent.click(mainEditor);
  await userEvent.keyboard("main draft");

  await userEvent.click(screen.getByRole("button", { name: otherSide.title, exact: true }));
  const otherEditor = screen.getByRole("textbox", {
    name: `Message ${otherSide.title}`,
    exact: true,
  });
  await expect.element(otherEditor).toHaveFocus();
  await userEvent.keyboard("other draft");
  await expect.element(otherEditor).toHaveTextContent("other draft");

  await userEvent.click(screen.getByRole("button", { name: side.title, exact: true }));
  await expect.element(sideEditor).toHaveFocus();
  await expect.element(mainEditor).toHaveTextContent("main draft");
});

type BrowseInput = { readonly partialPath: string; readonly cwd: string };
type BrowseListing = ReadonlyArray<readonly [name: string, kind: "file" | "directory"]>;

/** What `filesystem.browse` returns for a project-relative directory holding `entries`. */
function browseResult({ partialPath, cwd }: BrowseInput, entries: BrowseListing) {
  const parentPath = `${cwd}/${partialPath.slice(2)}`.replace(/\/$/, "");
  return {
    parentPath,
    entries: entries.map(([name, kind]) => ({ name, fullPath: `${parentPath}/${name}`, kind })),
  };
}

/** A router on a new draft thread, ready to render. */
async function draftRouter(name: string, settings: Partial<typeof DEFAULT_CLIENT_SETTINGS> = {}) {
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    ...settings,
  });
  const draftId = DraftId.make(`draft-${name}`);
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
      threadId: ThreadId.make(`thread-${name}`),
    });
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  return { router, draftId };
}

it("@ browses folders from the keyboard: Enter opens one, Enter on a file mentions it", async () => {
  using _environment = installFakeEnvironment([]);
  const listings: Record<string, BrowseListing> = {
    "./": [
      ["src", "directory"],
      ["README.md", "file"],
    ],
    "./src/": Array.from({ length: 30 }, (_, index) => [`module${index}.ts`, "file"] as const),
  };
  using _browse = answerRpc(WS_METHODS.filesystemBrowse, (input: BrowseInput) =>
    Effect.succeed(browseResult(input, listings[input.partialPath] ?? [])),
  );
  const { router, draftId } = await draftRouter("path-mention");
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const editor = page.getByTestId("composer-editor");
  const option = (name: string) => page.getByRole("option", { name, exact: true });
  const menu = page.getByRole("listbox", { name: "Files and folders" });
  // A relative path resolves against the project, which the shell snapshot brings.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  await userEvent.click(editor);
  await userEvent.keyboard("@");
  await expect.element(option("src/")).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(option("README.md")).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{ArrowUp}");

  // Enter on a folder opens it in place and keeps the menu up.
  await userEvent.keyboard("{Enter}");
  await expect.element(option("module0.ts")).toHaveAttribute("aria-selected", "true");
  expect(editor.element().textContent).toBe("@src/");

  // Escape closes the menu and leaves the typed path alone.
  await userEvent.keyboard("{Escape}");
  await expect.element(menu).not.toBeInTheDocument();
  expect(editor.element().textContent).toBe("@src/");
  // The dismissal lasts for that token; a retyped one opens the menu again.
  await userEvent.keyboard("{Backspace>5/}@src/");
  await expect.element(option("module0.ts")).toBeVisible();

  // The highlight wraps to the last row, and the list scrolls to show it.
  await userEvent.keyboard("{ArrowUp}");
  await expect.element(option("module29.ts")).toHaveAttribute("aria-selected", "true");
  await expect.element(option("module29.ts")).toBeInViewport();
  await expect.element(option("module0.ts")).not.toBeInViewport();

  // Enter on a file inserts the mention and a space, then closes the menu.
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("button", { name: "Preview src/module29.ts" })).toBeVisible();
  await expect.element(menu).not.toBeInTheDocument();
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
    "[module29.ts](src/module29.ts) ",
  );

  // Space right after a folder's slash mentions the folder itself.
  await userEvent.keyboard("@src/");
  await expect.element(option("module0.ts")).toBeVisible();
  await userEvent.keyboard(" ");
  await expect.element(page.getByRole("button", { name: "Preview src" })).toBeVisible();
});

it("a key pressed before the @ rows land runs when they do, and a folder being browsed never sends", async () => {
  using _environment = installFakeEnvironment([]);
  // Listings stay cached between this file's tests, so these folders are this test's own.
  let releaseLib = () => {};
  const libListed = new Promise<void>((resolve) => {
    releaseLib = resolve;
  });
  const listings: Record<string, BrowseListing> = {
    "./": [
      ["lib", "directory"],
      ["vacant", "directory"],
      ["vacant lot", "directory"],
    ],
    "./lib/": [
      ["components", "directory"],
      ["index.ts", "file"],
    ],
    "./lib/components/": [["Button.tsx", "file"]],
    "./vacant/": [],
    "./vacant lot/": [],
  };
  using _browse = answerRpc(WS_METHODS.filesystemBrowse, (input: BrowseInput) => {
    const listing = listings[input.partialPath];
    if (listing === undefined) {
      return Effect.fail(
        new FilesystemBrowseError({
          partialPath: input.partialPath,
          failure: "read_directory_failed",
          pathMissing: true,
        }),
      );
    }
    const result = Effect.succeed(browseResult(input, listing));
    return input.partialPath === "./lib/"
      ? Effect.promise(() => libListed).pipe(Effect.andThen(result))
      : result;
  });
  const { router, draftId } = await draftRouter("path-keys");
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const editor = page.getByTestId("composer-editor");
  const option = (name: string) => page.getByRole("option", { name, exact: true });
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  await userEvent.click(editor);
  await userEvent.keyboard("@");
  await expect.element(option("lib/")).toHaveAttribute("aria-selected", "true");
  // The first Enter opens lib/. Its listing is held, so the second meets last query's rows,
  // which are shown but not on offer.
  await userEvent.keyboard("{Enter}");
  await expect.element(option("lib/")).toHaveAttribute("aria-disabled", "true");
  await userEvent.keyboard("{Enter}");
  expect(editor.element().textContent).toBe("@lib/");
  releaseLib();
  // Once lib/ lists, the waiting Enter opens its first folder.
  await expect.element(option("Button.tsx")).toHaveAttribute("aria-selected", "true");
  expect(editor.element().textContent).toBe("@lib/components/");

  // A path that says where it starts stays a path when its folder is missing: Enter and Tab
  // belong to the menu, which says so, rather than sending half a path.
  await userEvent.keyboard("{Backspace>16/}@./missing/");
  await expect.element(page.getByText("No folder at ./missing/").first()).toBeVisible();
  await userEvent.keyboard("{Enter}{Tab}");
  expect(editor.element().textContent).toBe("@./missing/");

  // An empty folder has one thing to choose, the folder itself, and Enter takes it.
  await userEvent.keyboard("{Backspace>11/}@vacant/");
  await expect.element(page.getByText("This folder is empty.").first()).toBeVisible();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("button", { name: "Preview vacant" })).toBeVisible();

  // The same holds for a folder the menu had to quote: it stays a path, not quoted prose.
  await userEvent.keyboard("@");
  await expect.element(option("vacant lot/")).toBeVisible();
  await userEvent.keyboard("{ArrowUp}{Enter}");
  expect(editor.element().textContent).toContain('@"vacant lot/');
  await expect.element(page.getByText("This folder is empty.").first()).toBeVisible();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("button", { name: "Preview vacant lot" })).toBeVisible();
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
    "[vacant](vacant) [vacant lot](vacant%20lot) ",
  );
  expect(dispatchedCommands()).toEqual([]);
});

it("an Enter pressed ahead of the @ search sends once the word turns out to be prose", async () => {
  using _environment = installFakeEnvironment([]);
  let releaseSearch = () => {};
  const searched = new Promise<void>((resolve) => {
    releaseSearch = resolve;
  });
  // The project search is loose: it answers `sam` with a file that only has those letters along its path.
  using _search = answerRpc(WS_METHODS.projectsSearchEntries, () =>
    Effect.promise(() => searched).pipe(
      Effect.as({ entries: [{ path: "scripts/a/main.ts", kind: "file" }], truncated: false }),
    ),
  );
  const { router } = await draftRouter("path-prose-word");
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const editor = page.getByTestId("composer-editor");
  const menu = page.getByRole("listbox", { name: "Files and folders" });
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  // Enter lands before the search answers. It waits, then sends: nothing is named `sam`.
  await userEvent.click(editor);
  await userEvent.keyboard("thanks @sam{Enter}");
  expect(editor.element().textContent).toBe("thanks @sam");
  releaseSearch();
  await expect.element(editor).toHaveTextContent("");
  await expect.element(menu).not.toBeInTheDocument();
});

it("a scoped package name after @ is prose: no menu, and Enter sends", async () => {
  using _environment = installFakeEnvironment([]);
  using _search = answerRpc(WS_METHODS.projectsSearchEntries, () =>
    Effect.succeed({ entries: [], truncated: false }),
  );
  using _browse = answerRpc(WS_METHODS.filesystemBrowse, ({ partialPath }: BrowseInput) =>
    Effect.fail(
      new FilesystemBrowseError({
        partialPath,
        failure: "read_directory_failed",
        pathMissing: true,
      }),
    ),
  );
  const { router } = await draftRouter("path-prose-package");
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const editor = page.getByTestId("composer-editor");
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  // It is shaped like a path, but the project has no `types` folder.
  await userEvent.click(editor);
  await userEvent.keyboard("upgrade @types/node");
  await expect.element(editor).toHaveTextContent("upgrade @types/node");
  expect(document.querySelector("[data-composer-command-drawer]")).toBeNull();

  // With no menu on screen, Escape is not the composer's to take.
  const heardOutside = vi.fn();
  window.addEventListener("keydown", heardOutside);
  using _listener = {
    [Symbol.dispose]: () => window.removeEventListener("keydown", heardOutside),
  };
  await userEvent.keyboard("{Escape}");
  expect(heardOutside).toHaveBeenCalledWith(expect.objectContaining({ key: "Escape" }));

  await userEvent.keyboard("{Enter}");
  await expect.element(editor).toHaveTextContent("");
});

it("a bare name whose search failed keeps Enter until the menu is dismissed", async () => {
  using _environment = installFakeEnvironment([]);
  let releaseSearch = () => {};
  const searched = new Promise<void>((resolve) => {
    releaseSearch = resolve;
  });
  using _search = answerRpc(WS_METHODS.projectsSearchEntries, () =>
    Effect.promise(() => searched).pipe(
      Effect.andThen(
        Effect.fail(
          new ProjectSearchEntriesError({
            cwd: "/work",
            queryLength: 3,
            limit: 1,
            failure: "search_index_search_failed",
          }),
        ),
      ),
    ),
  );
  const { router } = await draftRouter("path-search-failed");
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const editor = page.getByTestId("composer-editor");
  const failure = page.getByText("Couldn't search this project's files.");
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  // An Enter already waiting when the search fails does not send: `zed` may well be a file.
  await userEvent.click(editor);
  await userEvent.keyboard("ask @zed{Enter}");
  releaseSearch();
  await expect.element(failure.first()).toBeVisible();
  expect(editor.element().textContent).toBe("ask @zed");

  // Nor does one pressed with the failure on screen.
  await userEvent.keyboard("{Enter}");
  expect(editor.element().textContent).toBe("ask @zed");
  expect(dispatchedCommands()).toEqual([]);

  // Escape puts the menu away, and the text is the user's to send as it stands.
  await userEvent.keyboard("{Escape}");
  await expect.element(failure).not.toBeInTheDocument();
  await userEvent.keyboard("{Enter}");
  await expect.element(editor).toHaveTextContent("");
});

it("without file access an @ word is prose, while a path says files can't be read", async () => {
  using _environment = installFakeEnvironment([]);
  using _permissions = limitSessionPermissions(
    AuthStandardClientScopes.filter((scope) => scope !== AuthFilesystemReadScope),
    () => appAtomRegistry.refresh(environmentSession.sessionStateAtom(ENVIRONMENT_ID)),
  );
  const { router } = await draftRouter("path-no-access");
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const editor = page.getByTestId("composer-editor");
  const noAccess = page.getByText("This connection can't read files on this machine.");
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  await userEvent.click(editor);
  await userEvent.keyboard("see @docs/");
  await expect.element(noAccess.first()).toBeVisible();
  await userEvent.keyboard("{Enter}");
  expect(editor.element().textContent).toBe("see @docs/");

  // There is nothing to look a bare word up in, so it gets no menu and Enter sends.
  await userEvent.keyboard("{Backspace>5/}kim");
  await expect.element(noAccess).not.toBeInTheDocument();
  expect(document.querySelector("[data-composer-command-drawer]")).toBeNull();
  await userEvent.keyboard("{Enter}");
  await expect.element(editor).toHaveTextContent("");
});

it("a folder that could not be read keeps Enter, pressed after the failure or ahead of it", async () => {
  using _environment = installFakeEnvironment([]);
  using _search = answerRpc(WS_METHODS.projectsSearchEntries, () =>
    Effect.succeed({ entries: [], truncated: false }),
  );
  let releaseLocked = () => {};
  const lockedRead = new Promise<void>((resolve) => {
    releaseLocked = resolve;
  });
  using _browse = answerRpc(WS_METHODS.filesystemBrowse, (input: BrowseInput) => {
    if (input.partialPath === "./") return Effect.succeed(browseResult(input, []));
    const denied = Effect.fail(
      new FilesystemBrowseError({
        partialPath: input.partialPath,
        failure: "read_directory_failed",
        permissionDenied: true,
      }),
    );
    return input.partialPath === "./locked/"
      ? Effect.promise(() => lockedRead).pipe(Effect.andThen(denied))
      : denied;
  });
  const { router } = await draftRouter("path-unreadable");
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const editor = page.getByTestId("composer-editor");
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  // The folder may well exist, so this is not prose like `@types/node`: the menu says what went
  // wrong and Enter stays with it instead of sending the draft.
  await userEvent.click(editor);
  await userEvent.keyboard("review @private/");
  await expect.element(page.getByText("No permission to read private/.").first()).toBeVisible();
  await userEvent.keyboard("{Enter}");
  expect(editor.element().textContent).toBe("review @private/");

  // An Enter that was already waiting when the failure landed is no more a send than that one.
  await userEvent.keyboard("{Backspace>9/}@locked/{Enter}");
  releaseLocked();
  await expect.element(page.getByText("No permission to read locked/.").first()).toBeVisible();
  expect(editor.element().textContent).toBe("review @locked/");
  expect(dispatchedCommands()).toEqual([]);
});

it("Enter on a folder found by search opens it without the menu closing in between", async () => {
  using _environment = installFakeEnvironment([]);
  using _search = answerRpc(WS_METHODS.projectsSearchEntries, () =>
    Effect.succeed({
      entries: [
        { path: "depot", kind: "directory" },
        { path: "depot/deploy.ts", kind: "file" },
      ],
      truncated: false,
    }),
  );
  let releaseDepot = () => {};
  const depotListed = new Promise<void>((resolve) => {
    releaseDepot = resolve;
  });
  using _browse = answerRpc(WS_METHODS.filesystemBrowse, (input: BrowseInput) =>
    input.partialPath === "./depot/"
      ? Effect.promise(() => depotListed).pipe(
          Effect.as(browseResult(input, [["deploy.ts", "file"]])),
        )
      : Effect.succeed(browseResult(input, [])),
  );
  const { router } = await draftRouter("path-search-to-folder");
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const editor = page.getByTestId("composer-editor");
  const option = (name: string) => page.getByRole("option", { name, exact: true });
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  await userEvent.click(editor);
  await userEvent.keyboard("@dep");
  await expect.element(option("depot/")).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{Enter}");
  expect(editor.element().textContent).toBe("@depot/");

  // The folder's listing is a different lookup from the search. Until it answers, the search's
  // rows hold the menu open, dimmed and off offer.
  await expect.element(option("depot/")).toHaveAttribute("aria-disabled", "true");
  releaseDepot();
  await expect.element(option("deploy.ts")).toHaveAttribute("aria-selected", "true");
  await expect.element(option("depot/")).not.toBeInTheDocument();
});

it("a held Enter that the @ menu has no use for breaks the line when Mod+Enter sends", async () => {
  using _environment = installFakeEnvironment([]);
  let releaseSearch = () => {};
  const searched = new Promise<void>((resolve) => {
    releaseSearch = resolve;
  });
  using _search = answerRpc(WS_METHODS.projectsSearchEntries, () =>
    Effect.promise(() => searched).pipe(Effect.as({ entries: [], truncated: false })),
  );
  const { router, draftId } = await draftRouter("path-held-newline", { sendShortcut: "mod-enter" });
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const editor = page.getByTestId("composer-editor");
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  // Enter waits on the search. `quinn` names nothing, so the key was the editor's all along.
  await userEvent.click(editor);
  await userEvent.keyboard("thanks @quinn{Enter}");
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe("thanks @quinn");
  releaseSearch();
  await vi.waitFor(() =>
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toMatch(
      /^thanks @quinn\n+$/,
    ),
  );
  expect(dispatchedCommands()).toEqual([]);
});

it("a Space held for a folder listing is typed where it was pressed, if typing goes on or the menu closes", async () => {
  using _environment = installFakeEnvironment([]);
  let releaseAtlas = () => {};
  const atlasListed = new Promise<void>((resolve) => {
    releaseAtlas = resolve;
  });
  using _browse = answerRpc(WS_METHODS.filesystemBrowse, (input: BrowseInput) =>
    input.partialPath === "./atlas/"
      ? Effect.promise(() => atlasListed).pipe(Effect.as(browseResult(input, [["and.ts", "file"]])))
      : input.partialPath === "./books/"
        ? Effect.never
        : Effect.succeed(browseResult(input, [])),
  );
  const { router, draftId } = await draftRouter("path-held-space");
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const editor = page.getByTestId("composer-editor");
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  // Space waits to learn whether atlas/ can be mentioned; the user does not wait for it.
  await userEvent.click(editor);
  await userEvent.keyboard("@atlas/ and more");
  releaseAtlas();
  await vi.waitFor(() =>
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
      "@atlas/ and more",
    ),
  );

  // Escape closes a menu whose listing never came. The Space pressed for it is typed all the same.
  await userEvent.keyboard(" @./books/ {Escape}");
  await vi.waitFor(() =>
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
      "@atlas/ and more @./books/ ",
    ),
  );
});

it("a folder too large for one listing narrows on the server as its name is typed", async () => {
  using _environment = installFakeEnvironment([]);
  const requested: Array<string> = [];
  using _browse = answerRpc(WS_METHODS.filesystemBrowse, (input: BrowseInput) => {
    requested.push(input.partialPath);
    // The capped listing misses `zebra.ts`; only asking for the typed name reaches it.
    const folder = { ...input, partialPath: "./big/" };
    return Effect.succeed(
      input.partialPath === "./big/zeb"
        ? browseResult(folder, [["zebra.ts", "file"]])
        : { ...browseResult(folder, [["alpha.ts", "file"]]), truncated: true },
    );
  });
  const { router, draftId } = await draftRouter("path-truncated");
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const editor = page.getByTestId("composer-editor");
  const option = (name: string) => page.getByRole("option", { name, exact: true });
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  await userEvent.click(editor);
  await userEvent.keyboard("@big/");
  await expect.element(option("alpha.ts")).toHaveAttribute("aria-selected", "true");

  // After a pause in typing the server is asked for the name, and its rows replace the capped ones.
  await userEvent.keyboard("zeb");
  await expect.element(option("zebra.ts")).toHaveAttribute("aria-selected", "true");
  await expect.element(option("alpha.ts")).not.toBeInTheDocument();
  expect(requested).toContain("./big/zeb");
  await userEvent.keyboard("{Enter}");
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
    "[zebra.ts](big/zebra.ts) ",
  );
});
