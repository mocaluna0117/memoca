/**
 * Where to scroll the sidebar's tree to for a folder just opened in it: as
 * much of what is inside it in sight as fits, from its first note, and no
 * further than that takes, as VS Code shows a folder opened in its explorer.
 * Its row is never scrolled past: at most, it is in its place at the top
 * (`stickyTop` down, under the rows of the folders it is in, kept there),
 * with its first note right under it. Where it all is already in sight, the
 * tree stays where it is.
 *
 * Every value in pixels, down from the top of what the tree scrolls:
 * `current` its scroll now, `groupTop` and `groupBottom` where the folder's
 * row and what is inside it begin and end, `viewHeight` how tall the part
 * in sight is.
 */
export function folderRevealTop({
  current,
  groupTop,
  groupBottom,
  stickyTop,
  viewHeight,
}: {
  current: number;
  groupTop: number;
  groupBottom: number;
  stickyTop: number;
  viewHeight: number;
}): number {
  // Its row in its place at the top: what it is inside of shown from its start.
  const top = groupTop - stickyTop;
  // Its last row at the bottom of what is in sight.
  const end = groupBottom - viewHeight;
  return Math.max(0, Math.min(top, Math.max(current, end)));
}
