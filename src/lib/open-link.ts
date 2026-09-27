/** The kinds of link a note's link may open: pages, mail and calls. */
const OPENED = new Set(["http:", "https:", "mailto:", "tel:"]);

/**
 * Opens a link clicked in a note, in a window with no hold on this one.
 * BlockNote's own opening hands the page opened a way back to the app's
 * window (`window.opener`), through which it could send it elsewhere: to a
 * page made up to look like Memoca asking to sign in again, say. For the
 * editor's `links.onClick`: true once the click is dealt with.
 */
export function openLinkApart(event: MouseEvent, here: Window = window): boolean {
  const target = event.target;
  const link =
    target instanceof Element
      ? target.closest<HTMLAnchorElement>('a[data-inline-content-type="link"]')
      : null;
  if (!link) return false;
  let url: URL;
  try {
    url = new URL(link.getAttribute("href") ?? "", here.location.href);
  } catch {
    return true;
  }
  if (OPENED.has(url.protocol)) here.open(url.href, "_blank", "noopener,noreferrer");
  return true;
}
