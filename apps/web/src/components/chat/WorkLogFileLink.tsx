import { AuthFilesystemReadScope, type ScopedThreadRef } from "@t3tools/contracts";
import { use } from "react";

import { resolveToolFileLinkMeta, type MarkdownFileLinkMeta } from "../../markdown-links";
import { useEnvironmentScope } from "../../state/session";
import { MiddleTruncate } from "../ui/middle-truncate";
import { MarkdownFileLink } from "./MarkdownFileLink";
import { TimelineRowCtx } from "./timelineRowContext";
import { useMarkdownFileLinkActions } from "./useMarkdownFileLinkActions";
import type { WorkEntryFileLabel } from "./MessagesTimeline.logic";

/** A path a tool named. Where the viewer cannot open it, it stays the text it always was. */
export function WorkLogFileLink({
  path,
  label,
  layout = "truncate",
}: {
  path: string;
  label: string;
  layout?: "truncate" | "wrap";
}) {
  const { threadRef, markdownCwd, turnItemSource } = use(TimelineRowCtx);
  const canReadFiles = useEnvironmentScope(
    threadRef?.environmentId ?? null,
    AuthFilesystemReadScope,
  );
  const meta = canReadFiles ? resolveToolFileLinkMeta(path, markdownCwd) : null;
  if (threadRef && meta && !turnItemSource) {
    return <OpenableFileLink threadRef={threadRef} meta={meta} label={label} layout={layout} />;
  }
  return layout === "truncate" ? <MiddleTruncate value={label} showTitle={false} /> : label;
}

function OpenableFileLink({
  threadRef,
  meta,
  label,
  layout,
}: {
  threadRef: ScopedThreadRef;
  meta: MarkdownFileLinkMeta;
  label: string;
  layout: "truncate" | "wrap";
}) {
  const { markdownCwd, onImageExpand, resolvedTheme } = use(TimelineRowCtx);
  const { fileLinkProps } = useMarkdownFileLinkActions({
    threadRef,
    environmentId: threadRef.environmentId,
    cwd: markdownCwd,
    expandMedia: onImageExpand,
    mediaScopeKey: `${threadRef.environmentId}:${threadRef.threadId}`,
  });
  return (
    <MarkdownFileLink
      {...fileLinkProps(meta)}
      label={meta.basename}
      copyMarkdown={meta.targetPath}
      theme={resolvedTheme}
      pathLabel={label}
      pathLayout={layout}
    />
  );
}

/** A row label with its path as a link. Everything around the path still toggles the row. */
export function WorkEntryFileLabelView({ label }: { label: WorkEntryFileLabel }) {
  return (
    <span className="flex min-w-0 items-baseline gap-1">
      {label.prefix ? <span className="shrink-0">{label.prefix}</span> : null}
      <WorkLogFileLink path={label.path} label={label.displayPath} />
      {label.suffix ? <span className="shrink-0">{label.suffix}</span> : null}
    </span>
  );
}
