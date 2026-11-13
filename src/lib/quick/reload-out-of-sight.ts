import { newBuildOut } from "@/lib/build";

/**
 * For the quick note's window as the desktop shell puts it away (it is kept
 * loaded, and nothing else would ever load its page again): a new version
 * of the site loaded, out of sight. Only while it still is out of sight
 * once the server has answered: not with the focus, not seen, and not
 * brought out at any moment since. ⌘⇧M pressed again while the server was
 * asked brought the window out before the system gave it the focus (or
 * without its giving it at all), and the page was loaded anew under the
 * person: for some seconds, on a machine short of memory, one that took no
 * click and no key. Memoca's own window has waited the same way
 * (shell-refresh). Left for the next time it is put away otherwise.
 */
export async function reloadOutOfSight(here: Window = window): Promise<boolean> {
  let out = false;
  const focused = () => {
    out = true;
  };
  const visible = () => {
    if (here.document.visibilityState === "visible") out = true;
  };
  here.addEventListener("focus", focused);
  here.document.addEventListener("visibilitychange", visible);
  try {
    if (!(await newBuildOut())) return false;
    if (out || here.document.hasFocus() || here.document.visibilityState !== "hidden") return false;
    here.location.reload();
    return true;
  } finally {
    here.removeEventListener("focus", focused);
    here.document.removeEventListener("visibilitychange", visible);
  }
}
