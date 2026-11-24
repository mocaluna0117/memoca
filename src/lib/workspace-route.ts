/**
 * The workspace's pages: the notes (/app) and the others under it, which
 * are one route (app/(workspace)/app/[[...view]]) drawn by the page itself
 * from its address (components/shell/workspace-views). Moving between them
 * changes the address and nothing more: no request to the server, which
 * is far (the server answers from the US), and every one of them is drawn
 * from this device's data anyway.
 */
export const WORKSPACE_VIEWS = ["search", "trash", "settings", "news", "help", "admin"] as const;
export type WorkspaceView = "" | (typeof WORKSPACE_VIEWS)[number];

/** Which of the workspace's pages an address is: "" the notes, null none of them. */
export function workspaceView(pathname: string): WorkspaceView | null {
  if (pathname === "/app" || pathname === "/app/") return "";
  const match = /^\/app\/([^/]+)\/?$/.exec(pathname);
  const name = match?.[1];
  return name && (WORKSPACE_VIEWS as readonly string[]).includes(name) ? (name as WorkspaceView) : null;
}

/** Whether the route's segments (after /app) are one of its pages. */
export function isWorkspaceSegments(segments: readonly string[] | undefined): boolean {
  return workspaceView(`/app${segments?.length ? `/${segments.join("/")}` : ""}`) !== null;
}

/**
 * Goes to `href` in place, by the address alone, when both here and there
 * are pages of the workspace, and says whether it did. Else the router has
 * to: another route (the quick note, sign-in), or from one.
 */
export function moveWithinWorkspace(href: string, { replace = false } = {}): boolean {
  if (typeof window === "undefined") return false;
  const here = window.location;
  const target = new URL(href, here.href);
  if (target.origin !== here.origin) return false;
  if (workspaceView(here.pathname) === null || workspaceView(target.pathname) === null) return false;
  const path = target.pathname + target.search + target.hash;
  if (replace) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  return true;
}
