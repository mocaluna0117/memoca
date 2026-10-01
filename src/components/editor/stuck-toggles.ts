import { createExtension } from "@blocknote/core";
import { Plugin } from "prosemirror-state";

/**
 * An open toggle's line stays at the top of the note while what is inside it
 * is scrolled past (globals.css). Here, what CSS cannot do alone:
 *
 * - One open inside another stays just below the other's line, not over it,
 *   both ▼ in reach: moved down by the lines of those it is inside, as they
 *   are on the screen (a line can wrap, or be a heading).
 * - The caret is kept out from under them. Moved up by the keys into a line
 *   they cover, it would be out of sight: the note scrolls to show it.
 */

/** An open toggle with something inside it: its block, as the CSS has it. */
const HAS_OPEN_TOGGLE =
  ':has(> .bn-block-group):has(> .bn-block-content .bn-toggle-wrapper[data-show-children="true"])';
export const OPEN_TOGGLE = `.bn-block${HAS_OPEN_TOGGLE}`;

/**
 * The z-index of a line kept at the top, as globals.css has it; one inside
 * another a step lower, to go up under the other's line past its end. Below
 * BlockNote's menus and toolbars (10 and up).
 */
const Z = 8;

/** How far one line kept at the top goes over the line above it: no gap to show through. */
const OVERLAP = 1;

/** An open toggle, as on the screen: its line's height and the open toggle it is in. */
export type OpenToggle = { id: string; height: number; within: string | null };

/**
 * The CSS for open toggles inside others: each line kept below the lines of
 * those it is in, and under them as it goes up past its end. Toggles in the
 * note's order, those it is in before it.
 */
export function stackRules(toggles: readonly OpenToggle[]): string {
  // Each one's place: how far below the top its line is, and how deep it is.
  const placed = new Map<string, { offset: number; depth: number; height: number }>();
  const rules: string[] = [];
  for (const toggle of toggles) {
    const outer = toggle.within === null ? undefined : placed.get(toggle.within);
    const at = outer
      ? { offset: outer.offset + outer.height - OVERLAP, depth: outer.depth + 1 }
      : { offset: 0, depth: 0 };
    placed.set(toggle.id, { ...at, height: toggle.height });
    // Block ids are BlockNote's own (letters, digits, dashes); anything else
    // is left at the top, as the CSS has it, rather than put in a selector.
    if (at.depth === 0 || !/^[\w-]+$/.test(toggle.id)) continue;
    rules.push(
      // The selector of the CSS that keeps it at the top, narrowed to this
      // block: the more specific, so this wins.
      `.memoca-editor .bn-block[data-id="${toggle.id}"]${HAS_OPEN_TOGGLE} > .bn-block-content {` +
        ` top: calc(var(--memoca-sticky-top, 0px) + ${at.offset}px);` +
        ` z-index: ${Math.max(1, Z - at.depth)}; }`,
    );
  }
  return rules.join("\n");
}

/** The open toggles in the note, as on the screen. */
function openToggles(dom: HTMLElement): OpenToggle[] {
  return [...dom.querySelectorAll<HTMLElement>(OPEN_TOGGLE)].map((block) => ({
    id: block.dataset.id ?? "",
    // Not offsetHeight, rounded: what shows through a gap of half a pixel.
    height: block.querySelector(":scope > .bn-block-content")?.getBoundingClientRect().height ?? 0,
    within: block.parentElement?.closest<HTMLElement>(OPEN_TOGGLE)?.dataset.id ?? null,
  }));
}

/** What a line kept at the top is kept at the top of: the note's pane, or (null) the screen. */
function scrollerOf(line: Element): Element | null {
  for (let at = line.parentElement; at; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if (overflowY !== "visible" && overflowY !== "clip") return at;
  }
  return null;
}

/**
 * How far down the screen the lines over an element reach once kept at the
 * top: those of the open toggles it is inside (not its own line), where they
 * are kept, wherever they are now (past the end of a toggle scrolled up out
 * of sight, its line is up there with it). Null if none is kept there.
 */
function coveredTo(element: Element): { bottom: number; scroller: Element | null } | null {
  let covered: { bottom: number; scroller: Element | null } | null = null;
  for (
    let block = element.closest(OPEN_TOGGLE);
    block;
    block = block.parentElement?.closest(OPEN_TOGGLE) ?? null
  ) {
    const line = block.querySelector(":scope > .bn-block-content");
    if (!line || line.contains(element)) continue;
    const style = getComputedStyle(line);
    if (style.position !== "sticky") continue;
    const scroller = scrollerOf(line);
    const top = scroller ? scroller.getBoundingClientRect().top + scroller.clientTop : 0;
    const bottom = top + parseFloat(style.top) + line.getBoundingClientRect().height;
    if (!covered || bottom > covered.bottom) covered = { bottom, scroller };
  }
  return covered;
}

/** Room left between the lines kept at the top and what is brought out from under them. */
const MARGIN = 4;

/**
 * Brings what is at `top` on the screen inside an element (by default, its
 * top) out from under the lines kept at the top over it, if they would cover
 * it (or it is out of sight above them). Whether it did.
 */
export function uncover(element: Element, top = element.getBoundingClientRect().top): boolean {
  const covered = coveredTo(element);
  if (!covered || top >= covered.bottom + MARGIN) return false;
  const by = covered.bottom + MARGIN - top;
  if (covered.scroller) covered.scroller.scrollTop -= by;
  else window.scrollBy(0, -by);
  return true;
}

/** How long a drag over the note may go without a dragover before it is taken to be gone. */
const DRAG_GONE_MS = 1000;

export const stuckToggles = createExtension({
  key: "memocaStuckToggles",
  mount({ dom, root, signal }) {
    // While something is dragged over the note, the lines are let go
    // (globals.css): dropped on one kept at the top, it would go where its
    // toggle starts, out of sight above; and the note scrolls as it is
    // dragged up as it does with none there. Back once it is dropped, or
    // gone (no dragover for a while: dragleave says nothing of where to).
    const container = dom.closest(".bn-container") ?? dom;
    let gone = 0;
    const dragging = (on: boolean) => {
      window.clearTimeout(gone);
      if (on) {
        container.setAttribute("data-memoca-dragging", "");
        gone = window.setTimeout(() => dragging(false), DRAG_GONE_MS);
      } else {
        container.removeAttribute("data-memoca-dragging");
      }
    };
    root.addEventListener(
      "dragover",
      (event) => {
        if (event.target instanceof Node && container.contains(event.target)) dragging(true);
      },
      // Before what is over: it may take the event as its own.
      { signal, capture: true },
    );
    for (const type of ["drop", "dragend"]) {
      root.addEventListener(type, () => dragging(false), { signal, capture: true });
    }

    const sheet = document.createElement("style");
    sheet.dataset.memoca = "stuck-toggles";
    document.head.append(sheet);
    let frame = 0;
    const update = () => {
      frame = 0;
      const css = stackRules(openToggles(dom));
      if (sheet.textContent !== css) sheet.textContent = css;
    };
    const later = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    // Opened or closed (by its ▼, the keys, or BlockNote's opening one given
    // its first line), lines changed, or the note's width.
    const changes = new MutationObserver(later);
    changes.observe(dom, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-show-children"],
    });
    const sizes = new ResizeObserver(later);
    sizes.observe(dom);
    later();
    signal.addEventListener("abort", () => {
      dragging(false);
      cancelAnimationFrame(frame);
      changes.disconnect();
      sizes.disconnect();
      sheet.remove();
    });
  },
  prosemirrorPlugins: [
    new Plugin({
      props: {
        // Out of sight below, or not covered, ProseMirror's own scrolling.
        handleScrollToSelection(view) {
          const head = view.state.selection.head;
          let found: Node;
          try {
            found = view.domAtPos(head).node;
          } catch {
            return false;
          }
          const element = found instanceof Element ? found : found.parentElement;
          if (!element || !view.dom.contains(element)) return false;
          return uncover(element, view.coordsAtPos(head).top);
        },
      },
    }),
  ],
});
