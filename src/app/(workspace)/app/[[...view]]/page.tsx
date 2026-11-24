import { notFound } from "next/navigation";
import { WorkspaceViews } from "@/components/shell/workspace-views";
import { isWorkspaceSegments } from "@/lib/workspace-route";

/**
 * Every page of the workspace, as one route: the notes (/app), search,
 * trash, settings, news, help and admin. Which is drawn is read from the
 * address on this device (WorkspaceViews), so that moving from one to
 * another waits for nothing from the server (lib/workspace-route).
 */
export default async function WorkspacePage({ params }: { params: Promise<{ view?: string[] }> }) {
  const { view } = await params;
  if (!isWorkspaceSegments(view)) notFound();
  return <WorkspaceViews />;
}
