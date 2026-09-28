/** This page's build of the site: the commit it was made from, or "dev" (next.config.ts). */
export const PAGE_BUILD = process.env.MEMOCA_BUILD ?? "dev";

/**
 * Whether a build of the site newer than `page` is out, asked of the server
 * (/api/build) rather than the service worker, which the desktop shell's
 * window may not have. Never, for a build made here, or when the server
 * cannot be asked.
 */
export async function newBuildOut(page = PAGE_BUILD, here: Window = window): Promise<boolean> {
  if (page === "dev") return false;
  try {
    const response = await here.fetch("/api/build", { cache: "no-store" });
    if (!response.ok) return false;
    const { build } = (await response.json()) as { build?: unknown };
    return typeof build === "string" && build !== "dev" && build !== page;
  } catch {
    return false;
  }
}
