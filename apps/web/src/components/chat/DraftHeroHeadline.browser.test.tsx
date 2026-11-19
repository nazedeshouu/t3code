import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { ProjectId, WS_METHODS } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The draft route loads ChatView lazily; importing it here keeps its first transform out of the test's timeout.
import "~/components/ChatView";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { useUiStateStore } from "~/uiStateStore";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  answerRpc,
  installFakeEnvironment,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

// One shell subscription serves the whole file, so every test names the same projects.
const EXTRA_PROJECTS = [
  { id: ProjectId.make("project-alpha"), title: "alpha" },
  { id: ProjectId.make("project-beta"), title: "beta" },
];

it("the new-thread project picker follows the manual sidebar project order", async () => {
  using _environment = installFakeEnvironment([], { extraProjects: EXTRA_PROJECTS });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    sidebarProjectSortOrder: "manual",
  });
  useUiStateStore.setState({
    projectOrder: [
      `${ENVIRONMENT_ID}:/workspace/beta`,
      `${ENVIRONMENT_ID}:/workspace/render`,
      `${ENVIRONMENT_ID}:/workspace/alpha`,
    ],
  });
  using _order = { [Symbol.dispose]: () => useUiStateStore.setState({ projectOrder: [] }) };
  const draftId = DraftId.make("draft-manual-order");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId);

  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  // The shell snapshot has arrived once the sidebar lists the project.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();
  const trigger = document.querySelector<HTMLElement>("[data-draft-project-trigger]");
  if (!trigger) throw new Error("The draft project picker did not render.");
  await userEvent.click(page.elementLocator(trigger));
  await expect.element(page.getByRole("option", { name: "beta" })).toBeVisible();

  // The draft's own project leads; the rest keep the sidebar's order.
  await vi.waitFor(() => {
    expect(
      page
        .getByRole("option")
        .elements()
        .map((option) => option.textContent),
    ).toEqual([
      expect.stringMatching(/render$/),
      expect.stringMatching(/beta$/),
      expect.stringMatching(/alpha$/),
      "Add project",
    ]);
  });
});

it("moving a draft to another project takes the old project's @ rows off offer", async () => {
  using _environment = installFakeEnvironment([], { extraProjects: EXTRA_PROJECTS });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  let releaseAlpha = () => {};
  const alphaListed = new Promise<void>((resolve) => {
    releaseAlpha = resolve;
  });
  const listing = (cwd: string, name: string) => ({
    parentPath: cwd,
    entries: [{ name, fullPath: `${cwd}/${name}`, kind: "file" as const }],
  });
  using _browse = answerRpc(WS_METHODS.filesystemBrowse, ({ cwd }: { readonly cwd: string }) =>
    cwd === "/workspace/alpha"
      ? Effect.promise(() => alphaListed).pipe(Effect.as(listing(cwd, "theirs.md")))
      : Effect.succeed(listing(cwd, "ours.md")),
  );
  const draftId = DraftId.make("draft-moved-project");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId);
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const editor = page.getByTestId("composer-editor");
  const row = (name: string) => page.getByRole("option", { name, exact: true });
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();
  await userEvent.click(editor);
  await userEvent.keyboard("@");
  await expect.element(row("ours.md")).toHaveAttribute("aria-selected", "true");

  // The same composer now asks the same text of another project, whose listing is slow.
  const projectPicker = document.querySelector<HTMLElement>("[data-draft-project-trigger]");
  if (!projectPicker) throw new Error("The draft project picker did not render.");
  await userEvent.click(page.elementLocator(projectPicker));
  await userEvent.click(page.getByRole("option", { name: "alpha" }));
  await userEvent.click(editor);
  await expect.element(row("ours.md")).toHaveAttribute("aria-disabled", "true");
  await userEvent.keyboard("{Enter}");
  expect(editor.element().textContent).toBe("@");

  releaseAlpha();
  // The waiting Enter takes the new project's file, by the new project's path.
  await expect.element(page.getByRole("button", { name: "Preview theirs.md" })).toBeVisible();
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
    "[theirs.md](theirs.md) ",
  );
});
