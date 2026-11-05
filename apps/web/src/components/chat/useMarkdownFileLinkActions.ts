import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthPreviewOperateScope,
  AssetWorkspaceAssetNotFoundError,
  type EditorId,
  type EnvironmentId,
  type ScopedThreadRef,
  type ServerConfig,
} from "@t3tools/contracts";
import { isHostPath, resolveWorkspaceFilePath } from "@t3tools/shared/path";
import { mediaMimeTypeFromExtension } from "@t3tools/shared/mediaPreview";
import {
  claimWorkspaceBasenameLookup,
  findAgentDirectoryMatch,
  needsWorkspaceBasenameLookup,
  pickProjectLinkMatch,
  pickWorkspaceLinkMatch,
  WORKSPACE_BASENAME_LOOKUP_LIMIT,
  workspaceLinkLookupQuery,
} from "@t3tools/client-runtime/workspace-basename-lookup";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { type RefObject, useLayoutEffect, useRef } from "react";

import { isPreviewAvailableFor } from "../../browser/previewRuntime";
import {
  BrowserPreviewUnavailableError,
  isBrowserPreviewFile,
  openFileInPreview,
} from "../../browser/openFileInPreview";
import { openInEditorMenuLabel } from "../../editorLabels";
import {
  PreferredEditorEnvironmentRequiredError,
  useOpenInPreferredEditor,
  usePreferredEditor,
} from "../../editorPreferences";
import type { MarkdownFileLinkMeta } from "../../markdown-links";
import {
  markdownFileCopyPaths,
  markdownFileEditorTarget,
  resolveMarkdownFileHostPath,
} from "../../markdownFileHostPath";
import { resolveRemoteOpenState, useRemoteOpenResolution } from "../../remoteOpen";
import { useRightPanelStore } from "../../rightPanelStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { assetEnvironment } from "../../state/assets";
import { clientHostEnvironmentAtom } from "../../state/clientHostEnvironment";
import { readThreadShell, useProjects } from "../../state/entities";
import { filesystemEnvironment } from "../../state/filesystem";
import { previewEnvironment } from "../../state/preview";
import { hostEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { projectEnvironment } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import {
  readEnvironmentScope,
  readPreparedConnection,
  useEnvironmentScope,
} from "../../state/session";
import { shellEnvironment } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import {
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "../preview/fileExplorerLabel";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { resolveMarkdownMediaPreview, type ExpandedImagePreview } from "./ExpandedImagePreview";
import { markdownImageGallery } from "./markdownImageGallery";
import type { MarkdownFileLinkProps } from "./MarkdownFileLink";
import { canUseMarkdownFileShellActions } from "./MarkdownFileLink.logic";

const isAssetNotFoundError = Schema.is(AssetWorkspaceAssetNotFoundError);

const NO_MARKDOWN_EDITORS: ReadonlyArray<EditorId> = [];

type MarkdownServerConfigFields = ReturnType<typeof markdownServerConfigFields>;

function markdownServerConfigFields(config: ServerConfig | null) {
  return {
    pullRequestsEnabled: config !== null,
    isMacOS: config?.environment.platform.os === "darwin",
    availableEditors: config?.availableEditors ?? NO_MARKDOWN_EDITORS,
    revealInFileManagerLabel:
      config?.shellRevealInFileManager === true && config.availableEditors.includes("file-manager")
        ? config.shellRevealInFileManagerKind === undefined
          ? revealInFileExplorerLabelForOs(config.environment.platform.os)
          : revealInFileExplorerLabelForKind(config.shellRevealInFileManagerKind)
        : undefined,
  };
}

function markdownServerConfigFieldsEqual(
  previous: MarkdownServerConfigFields,
  next: MarkdownServerConfigFields,
): boolean {
  return (
    previous.pullRequestsEnabled === next.pullRequestsEnabled &&
    previous.isMacOS === next.isMacOS &&
    previous.revealInFileManagerLabel === next.revealInFileManagerLabel &&
    previous.availableEditors.length === next.availableEditors.length &&
    previous.availableEditors.every((editor, index) => editor === next.availableEditors[index])
  );
}

// Compare only markdown config fields to avoid rerendering replies on every provider status push.
export const markdownServerConfigFieldsAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make((get) => {
    const next = markdownServerConfigFields(get(serverEnvironment.configValueAtom(environmentId)));
    const previous = Option.getOrNull(get.self<MarkdownServerConfigFields>());
    return previous !== null && markdownServerConfigFieldsEqual(previous, next) ? previous : next;
  }).pipe(Atom.withLabel("markdown-server-config-fields")),
);

type MarkdownFileLinkActionProps = Omit<
  MarkdownFileLinkProps,
  "label" | "copyMarkdown" | "theme" | "pathLabel"
>;

/** What a file link does when opened, shared by markdown chips and tool activity paths. */
export function useMarkdownFileLinkActions({
  threadRef,
  environmentId,
  cwd,
  agentDirectories,
  expandMedia,
  mediaScopeKey,
  mediaGalleryRootRef,
}: {
  threadRef: ScopedThreadRef | undefined;
  environmentId: EnvironmentId | null;
  cwd: string | undefined;
  /** Folders the agent worked in, the latest first; read when a link opens. */
  agentDirectories?: (() => ReadonlyArray<string>) | undefined;
  expandMedia: (preview: ExpandedImagePreview) => void;
  /** Media still loading when this changes never opens. */
  mediaScopeKey: string;
  mediaGalleryRootRef?: RefObject<HTMLElement | null>;
}) {
  const mediaRequestId = useRef(0);
  // Layout cleanup blocks stale requests from reaching onImageExpand before paint.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- layout cleanup invalidates media requests still loading for the old scope before paint
  useLayoutEffect(
    () => () => {
      mediaRequestId.current += 1;
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Leaving the scope invalidates media requests still loading for it.
    [mediaScopeKey],
  );
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  const searchProjectEntries = useAtomQueryRunner(projectEnvironment.searchEntries, {
    reportFailure: false,
  });
  const getFilesystemMetadata = useAtomQueryRunner(filesystemEnvironment.getMetadata, {
    reportFailure: false,
    refresh: true,
  });
  const canOperateHost = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const canOperatePreview = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  const isClientHost = useAtomValue(clientHostEnvironmentAtom(environmentId));
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const remoteOpen = useRemoteOpenResolution(environmentId);
  const canUseShellActions =
    canOperateHost &&
    canUseMarkdownFileShellActions(environmentId, remoteOpen.state.mode, remoteOpen.isResolved);
  const openMarkdownMedia = (
    source: string,
    resolvedFilePath?: string,
    clickedImage?: HTMLImageElement | null,
  ) => {
    const requestId = ++mediaRequestId.current;
    void resolveMarkdownMediaPreview({
      source,
      resolvedFilePath,
      cwd,
      threadRef,
      // Read the connection on click; reconnect replaces it, and subscriptions would refresh every markdown
      // context.
      httpBaseUrl:
        environmentId === null ? undefined : readPreparedConnection(environmentId)?.httpBaseUrl,
      createAssetUrl,
      onOpenFile: threadRef
        ? (path) => useRightPanelStore.getState().openFile(threadRef, path)
        : undefined,
    }).then(
      (preview) => {
        if (preview && mediaRequestId.current === requestId) {
          const selected = preview.images[preview.index];
          expandMedia(
            selected && selected.type !== "video" && mediaGalleryRootRef?.current
              ? markdownImageGallery(clickedImage ?? mediaGalleryRootRef.current, selected)
              : preview,
          );
        }
      },
      (error: unknown) => {
        if (mediaRequestId.current !== requestId) return;
        let description =
          error instanceof Error
            ? error.message
            : "The file could not be loaded. It may have been moved or deleted.";
        if (
          isAssetNotFoundError(error) &&
          error.resource._tag === "media-file" &&
          environmentId !== null
        ) {
          // The connection may resolve while the media lookup is pending.
          const target = readPreparedConnection(environmentId)?.target ?? null;
          if (
            target !== null &&
            resolveRemoteOpenState({
              target,
              sshTarget: null,
              remoteOpenTargets: undefined,
              isDesktopRenderer: window.desktopBridge !== undefined,
              hostEnvironmentId: appAtomRegistry.get(hostEnvironmentIdAtom),
            }).mode !== "local-exec"
          ) {
            description = `The file was not found on ${target.label} at ${error.checkedPath ?? error.resource.path}.`;
          }
        }
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Media unavailable",
            description,
          }),
        );
      },
    );
  };
  const { availableEditors, revealInFileManagerLabel, isMacOS } = useAtomValue(
    markdownServerConfigFieldsAtom(environmentId),
  );
  const projects = useProjects();
  const [preferredEditor] = usePreferredEditor(availableEditors);
  const preferredEditorMenuLabel = openInEditorMenuLabel(preferredEditor);
  const openInPreferredEditor = useOpenInPreferredEditor(environmentId, availableEditors, cwd);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });
  const revealFileInFileManager = (filePath: string) => {
    if (environmentId === null) {
      return Promise.resolve(
        AsyncResult.failure<void, PreferredEditorEnvironmentRequiredError>(
          Cause.fail(new PreferredEditorEnvironmentRequiredError({ targetPath: filePath })),
        ),
      );
    }
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
      return Promise.resolve(
        AsyncResult.failure<void, Error>(
          Cause.fail(new Error("This connection cannot reveal files on this environment.")),
        ),
      );
    }
    return openInEditor({
      environmentId,
      input: { cwd: filePath, editor: "file-manager", reveal: true },
    });
  };
  const openMarkdownFileInPreview = (path: string) => {
    const preparedConnection = threadRef ? readPreparedConnection(threadRef.environmentId) : null;
    if (!threadRef || !canOperatePreview || preparedConnection === null) {
      return Promise.resolve(
        AsyncResult.failure<void, BrowserPreviewUnavailableError>(
          Cause.fail(
            new BrowserPreviewUnavailableError({
              message: "Environment is not connected.",
            }),
          ),
        ),
      );
    }
    return openFileInPreview({
      threadRef,
      filePath: path,
      workspaceRoot: cwd,
      httpBaseUrl: preparedConnection.httpBaseUrl,
      createAssetUrl,
      openPreview,
    });
  };
  const findWorkspaceFileMatch = async (fileLinkMeta: MarkdownFileLinkMeta) => {
    const workspaceRelativePath = fileLinkMeta.workspaceLookupPath;
    if (
      !workspaceRelativePath ||
      !cwd ||
      environmentId === null ||
      !readEnvironmentScope(environmentId, AuthFilesystemReadScope)
    ) {
      return null;
    }
    const query = workspaceLinkLookupQuery(workspaceRelativePath, cwd);
    if (query === null) return null;
    // Search can be truncated or still scanning, so it cannot rule out the literal
    // path. A path with a folder opens as written whenever it exists.
    if (!needsWorkspaceBasenameLookup(workspaceRelativePath)) {
      const metadata = await getFilesystemMetadata({
        environmentId,
        input: { paths: [resolveWorkspaceFilePath(workspaceRelativePath, cwd)] },
      });
      if (metadata._tag !== "Success" || metadata.value.entries[0] !== null) return null;
    }
    const searchRoot = async (root: string) => {
      const rootQuery = workspaceLinkLookupQuery(workspaceRelativePath, root);
      if (rootQuery === null) return { root, entries: [] };
      const result = await searchProjectEntries({
        environmentId,
        input: {
          cwd: root,
          query: rootQuery,
          limit: WORKSPACE_BASENAME_LOOKUP_LIMIT,
          kind: "file",
        },
      });
      return { root, entries: result._tag === "Success" ? result.value.entries : [] };
    };
    const own = await searchRoot(cwd);
    const ownMatch = pickWorkspaceLinkMatch(workspaceRelativePath, cwd, own.entries);
    if (ownMatch !== null) return ownMatch;
    const threadProjectId = threadRef ? readThreadShell(threadRef)?.projectId : undefined;
    const otherRoots = projects.flatMap((project) =>
      project.environmentId === environmentId &&
      project.id !== threadProjectId &&
      project.workspaceRoot !== cwd
        ? [project.workspaceRoot]
        : [],
    );
    const agentRoots = (agentDirectories?.() ?? []).filter((root) => root !== cwd);
    if (otherRoots.length === 0 && agentRoots.length === 0) return null;
    // Another project's file never replaces a thread-local file the search missed.
    if (needsWorkspaceBasenameLookup(workspaceRelativePath)) {
      const metadata = await getFilesystemMetadata({
        environmentId,
        input: { paths: [resolveWorkspaceFilePath(workspaceRelativePath, cwd)] },
      });
      if (metadata._tag !== "Success" || metadata.value.entries[0] !== null) return null;
    }
    const projectMatch = pickProjectLinkMatch(
      workspaceRelativePath,
      await Promise.all(otherRoots.map(searchRoot)),
    );
    if (projectMatch !== null || agentRoots.length === 0) return projectMatch;
    // No project has the file, so it opens where the agent last worked, as written.
    const agentPaths = agentRoots.map((root) =>
      resolveWorkspaceFilePath(workspaceRelativePath, root),
    );
    const metadata = await getFilesystemMetadata({ environmentId, input: { paths: agentPaths } });
    if (metadata._tag !== "Success") return null;
    const literal = agentPaths.find((_, index) => metadata.value.entries[index]?.kind === "file");
    if (literal !== undefined || !needsWorkspaceBasenameLookup(workspaceRelativePath)) {
      return literal ?? null;
    }
    return findAgentDirectoryMatch(workspaceRelativePath, agentRoots, searchRoot);
  };
  const openFileInPanel = (fileLinkMeta: MarkdownFileLinkMeta, panelPath: string) => {
    if (!threadRef) return;
    // Every open supersedes pending lookups, including synchronous opens.
    const isLatestLookup = claimWorkspaceBasenameLookup();
    const openAt = (path: string) =>
      useRightPanelStore.getState().openFile(threadRef, path, fileLinkMeta.line);
    if (
      fileLinkMeta.workspaceLookupPath === null ||
      !cwd ||
      workspaceLinkLookupQuery(panelPath, cwd) === null
    ) {
      openAt(panelPath);
      return;
    }
    void (async () => {
      const match = await findWorkspaceFileMatch(fileLinkMeta);
      if (!isLatestLookup()) return;
      openAt(match ?? panelPath);
    })();
  };
  const fileLinkProps = (
    fileLinkMeta: MarkdownFileLinkMeta,
    mediaSource?: string,
  ): MarkdownFileLinkActionProps => {
    const resolveHostPath = () =>
      resolveMarkdownFileHostPath({
        meta: fileLinkMeta,
        cwd,
        findWorkspaceMatch: () => findWorkspaceFileMatch(fileLinkMeta),
      });
    const isAppBundle = isMacOS && fileLinkMeta.filePath.endsWith(".app");
    const canOpenApp =
      environmentId !== null &&
      isAppBundle &&
      isClientHost &&
      canOperateHost &&
      availableEditors.includes("file-manager");
    const mediaPath = mediaSource ?? fileLinkMeta.filePath;
    const canPreviewMedia =
      mediaMimeTypeFromExtension(
        fileLinkMeta.basename.slice(fileLinkMeta.basename.lastIndexOf(".")),
      ) !== null;
    const panelPath =
      fileLinkMeta.workspaceRelativePath ??
      (!canPreviewMedia && isHostPath(fileLinkMeta.filePath) ? fileLinkMeta.filePath : null);

    return {
      environmentId,
      href: fileLinkMeta.targetPath,
      targetPath: fileLinkMeta.targetPath,
      iconPath:
        isAppBundle && cwd
          ? resolveWorkspaceFilePath(fileLinkMeta.filePath, cwd)
          : fileLinkMeta.filePath,
      isAppBundle,
      workspaceRelativePath: fileLinkMeta.workspaceRelativePath,
      panelPath: isAppBundle ? null : panelPath,
      line: fileLinkMeta.line,
      threadRef,
      onOpen: canOpenApp
        ? async () =>
            openInEditor({
              environmentId,
              input: { cwd: (await resolveHostPath()).absolutePath, editor: "file-manager" },
            })
        : canUseShellActions
          ? async () =>
              openInPreferredEditor(markdownFileEditorTarget(fileLinkMeta, await resolveHostPath()))
          : undefined,
      resolveCopyPaths: async () =>
        markdownFileCopyPaths(fileLinkMeta, await resolveHostPath(), cwd),
      onOpenInPanel: (path) => openFileInPanel(fileLinkMeta, path),
      onOpenMedia:
        threadRef && canPreviewMedia
          ? () => openMarkdownMedia(mediaPath, fileLinkMeta.filePath)
          : undefined,
      openInEditorMenuLabel: canOpenApp ? "Open app" : preferredEditorMenuLabel,
      onReveal:
        canUseShellActions && revealInFileManagerLabel !== undefined
          ? async () => revealFileInFileManager((await resolveHostPath()).absolutePath)
          : undefined,
      revealLabel: revealInFileManagerLabel,
      onOpenInBrowser:
        threadRef &&
        canOperatePreview &&
        isPreviewAvailableFor(threadRef.environmentId) &&
        isBrowserPreviewFile(fileLinkMeta.filePath)
          ? () => openMarkdownFileInPreview(fileLinkMeta.filePath)
          : undefined,
    };
  };

  return { openMarkdownMedia, fileLinkProps };
}
