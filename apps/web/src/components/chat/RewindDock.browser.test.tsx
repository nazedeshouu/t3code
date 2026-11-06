import { EnvironmentId, MessageId, ThreadId, type ThreadRewindPreview } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  queries: new Map<string, { data: unknown; error: string | null }>(),
}));

vi.mock(import("../../state/orchestration"), () => ({
  orchestrationEnvironment: {
    rewindTargets: (() => "targets") as never,
    rewindPreview: ((target: { input: { messageId: string } }) =>
      `preview:${target.input.messageId}`) as never,
  } as never,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((key: string) =>
    state.queries.get(key) ?? { data: null, error: null }) as never,
}));

import { RegistryContext } from "@effect/atom-react";

import { render } from "../../../test/render";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { openRewindDock, useRewindDockRequest } from "./ChatOverlayHosts";
import { RewindDock } from "./RewindDock";
import { rewindPreviewTargetAtom } from "./rewindPreviewTarget";

const threadKey = "environment:thread";
const first = MessageId.make("message-first");
const second = MessageId.make("message-second");
const createdAt = DateTime.makeUnsafe("2026-11-06T00:00:00.000Z");

const preview: ThreadRewindPreview = {
  messageId: second,
  modes: ["code_and_conversation", "conversation", "code", "summarize_from_here"],
  code: { filesChanged: 1, insertions: 12, deletions: 4, primaryPath: "src/auth.ts" as never },
  codeUnavailableReason: null,
  removedMessageCount: 3,
  undoable: true,
  sharedWorkspaceActive: true,
};

function setup(overrides: Partial<ThreadRewindPreview> = {}) {
  state.queries = new Map<string, { data: unknown; error: string | null }>([
    [
      "targets",
      {
        error: null,
        data: {
          targets: [
            {
              messageId: first,
              runId: "run-1",
              text: "First prompt",
              createdAt,
              code: { state: "unavailable" },
            },
            {
              messageId: second,
              runId: "run-2",
              text: "Second prompt",
              createdAt,
              code: { state: "changed", stats: preview.code },
            },
          ],
        },
      },
    ],
    [`preview:${second}`, { error: null, data: { ...preview, ...overrides } }],
  ]);
  const onRewind = vi.fn(async (): Promise<string | null> => null);
  openRewindDock(threadKey);
  return onRewind;
}

function Dock({ onRewind }: { onRewind: () => Promise<string | null> }) {
  return (
    <RegistryContext value={appAtomRegistry}>
      <DockHost onRewind={onRewind} />
    </RegistryContext>
  );
}

function DockHost({ onRewind }: { onRewind: () => Promise<string | null> }) {
  const request = useRewindDockRequest(threadKey);
  if (request === null) return <p>Closed</p>;
  return (
    <RewindDock
      request={request}
      environmentId={EnvironmentId.make("environment")}
      threadId={ThreadId.make("thread")}
      threadKey={threadKey}
      supportsConversationRollback
      composerRef={{ current: null }}
      holdTimeline={() => () => false}
      onRewind={onRewind}
    />
  );
}

const previewedMessage = () => appAtomRegistry.get(rewindPreviewTargetAtom)?.messageId;

it("walks from the list to a restore and back out with Escape", async () => {
  const onRewind = setup();
  await using screen = await render(<Dock onRewind={onRewind} />);
  await expect.element(page.getByRole("option", { name: "Current" })).toBeInTheDocument();
  await expect.element(screen.getByText("No code restore")).toBeInTheDocument();
  await vi.waitFor(() => expect(previewedMessage()).toBeNull());

  await userEvent.keyboard("{ArrowUp}");
  expect(previewedMessage()).toBe(second);
  await expect
    .element(page.getByRole("option", { name: /Second prompt/ }))
    .toHaveAttribute("aria-selected", "true");

  await userEvent.keyboard("{Enter}");
  await expect
    .element(screen.getByText("auth.ts +12 −4 reverted, 3 messages removed"))
    .toBeInTheDocument();
  await expect
    .element(screen.getByText("Another thread is working in this folder."))
    .toBeInTheDocument();
  await expect.element(screen.getByText("This can't be undone.")).not.toBeInTheDocument();

  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("option", { name: "Current" })).toBeInTheDocument();
  expect(previewedMessage()).toBe(second);

  await userEvent.keyboard("{Escape}");
  await expect.element(screen.getByText("Closed")).toBeInTheDocument();
  expect(appAtomRegistry.get(rewindPreviewTargetAtom)).toBeNull();
  expect(onRewind).not.toHaveBeenCalled();
});

it("takes a number key as the choice and keeps a failure on the options step", async () => {
  const onRewind = setup();
  onRewind.mockResolvedValueOnce("Claude could not restore auth.ts.");
  await using screen = await render(<Dock onRewind={onRewind} />);
  await userEvent.keyboard("{ArrowUp}{Enter}");
  await expect.element(screen.getByText("Restore conversation")).toBeInTheDocument();

  await userEvent.keyboard("2");
  await expect.element(screen.getByText("Claude could not restore auth.ts.")).toBeInTheDocument();
  expect(onRewind).toHaveBeenCalledWith(
    expect.objectContaining({ messageId: second, mode: "conversation" }),
  );

  await userEvent.keyboard("1");
  await expect.element(screen.getByText("Closed")).toBeInTheDocument();
  expect(onRewind).toHaveBeenLastCalledWith(
    expect.objectContaining({ messageId: second, mode: "code_and_conversation" }),
  );
});

it("opens the summary field from typing and sends it as guidance", async () => {
  const onRewind = setup();
  await using screen = await render(<Dock onRewind={onRewind} />);
  await userEvent.keyboard("{ArrowUp}{Enter}");
  await expect.element(screen.getByText("Summarize from here")).toBeInTheDocument();
  await userEvent.keyboard("{ArrowUp}{ArrowUp}k");
  const field = screen.getByRole("textbox", { name: "Add context (optional)" });
  await expect.element(field).toHaveValue("k");

  await userEvent.keyboard("eep the plan{Enter}");
  await expect.element(screen.getByText("Closed")).toBeInTheDocument();
  expect(onRewind).toHaveBeenCalledWith(
    expect.objectContaining({
      mode: "summarize_from_here",
      summaryInstructions: "keep the plan",
    }),
  );
});

it("renumbers around the server's modes and returns to the list on Never mind", async () => {
  const onRewind = setup({
    modes: ["conversation"],
    code: null,
    codeUnavailableReason: "No file snapshot exists for this turn." as never,
    undoable: false,
    sharedWorkspaceActive: false,
  });
  await using screen = await render(<Dock onRewind={onRewind} />);
  await userEvent.keyboard("{ArrowUp}{Enter}");
  await expect.element(screen.getByText("This can't be undone.")).toBeInTheDocument();
  await expect
    .element(screen.getByText("No file snapshot exists for this turn."))
    .toBeInTheDocument();
  await expect
    .element(screen.getByText("Restored files go back whole", { exact: false }))
    .not.toBeInTheDocument();

  await userEvent.keyboard("2");
  await expect.element(page.getByRole("option", { name: "Current" })).toBeInTheDocument();
  expect(onRewind).not.toHaveBeenCalled();
});

it("leaves keys alone while another surface owns them", async () => {
  const onRewind = setup();
  await using screen = await render(
    <>
      <input aria-label="Find in thread" />
      <Dock onRewind={onRewind} />
    </>,
  );
  await userEvent.click(screen.getByRole("textbox", { name: "Find in thread" }));
  await userEvent.keyboard("{ArrowUp}a");
  await expect.element(screen.getByRole("textbox", { name: "Find in thread" })).toHaveValue("a");
  expect(previewedMessage()).toBeNull();
});
