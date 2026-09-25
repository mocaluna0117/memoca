/**
 * The decisions behind the phone's folder-drawer swipe, kept free of React
 * and of any live gesture so they can be tested on their own: which way a
 * finger is going, how fast it let go, where the drawer comes to rest, and
 * which touches belong to something else. `useDrawerSwipe` wires them to the
 * DOM.
 *
 * Positions are the drawer's offset in CSS pixels: `-width` is shut, 0 is
 * fully open.
 */

/** Movement before the direction is decided. */
export const SLOP_PX = 10;
/** How much more sideways than vertical a move has to be to be a swipe. */
export const AXIS_RATIO = 1.2;
/**
 * A finger that rests this long before moving is selecting text, moving the
 * caret or asking for a context menu, not swiping.
 */
export const HOLD_MS = 400;
/** A release at least this fast decides by itself, wherever the drawer is. */
export const FLICK_PX_PER_MS = 0.4;
/** The release speed is taken from this last stretch of the movement. */
export const VELOCITY_WINDOW_MS = 100;
/** Above this pinch-zoom the finger is panning the page, not the drawer. */
export const MAX_SCALE = 1.01;
export const SETTLE_MS = 280;
export const REDUCED_SETTLE_MS = 120;
export const SETTLE_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
/** Matches Tailwind's `md`: from there on the folders are always on screen. */
export const PHONE_QUERY = "(max-width: 767px)";

/** 1 moves right, which opens; -1 moves left, which closes. */
export type Direction = 1 | -1;
/** Still deciding, moving the drawer, or none of the drawer's business. */
export type Lock = "pending" | "drag" | "ignore";
export type Rest = "open" | "closed";
export type Sample = { t: number; x: number };

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Decides what a touch is from how far it has moved and for how long. Once it
 * is past the slop the answer is final, and only a sideways move in the
 * drawer's own direction takes it.
 */
export function lockAxis(dx: number, dy: number, elapsedMs: number, direction: Direction): Lock {
  if (elapsedMs >= HOLD_MS) return "ignore";
  if (Math.hypot(dx, dy) < SLOP_PX) return "pending";
  const sideways = Math.abs(dx) >= AXIS_RATIO * Math.abs(dy);
  return sideways && Math.sign(dx) === direction ? "drag" : "ignore";
}

/**
 * Where the drawer is while a finger holds it: where it started plus how far
 * the finger has gone since the direction was decided, so it does not jump
 * by the slop. It never goes past shut or past fully open.
 */
export function dragOffset(dx: number, width: number, direction: Direction, start: number): number {
  return clamp(start + dx - direction * SLOP_PX, -width, 0);
}

/** 0 shut, 1 fully open: the overlay's opacity and how far the page moves. */
export function openness(offset: number, width: number): number {
  return width > 0 ? clamp(1 + offset / width, 0, 1) : 0;
}

/** Adds a sample and forgets the ones too old to count for the release speed. */
export function addSample(samples: readonly Sample[], sample: Sample): Sample[] {
  return [...samples.filter((s) => sample.t - s.t <= VELOCITY_WINDOW_MS), sample];
}

/**
 * Horizontal speed in px/ms over the last stretch before `now`. A finger
 * that stopped before letting go has no speed left.
 */
export function releaseVelocity(samples: readonly Sample[], now: number): number {
  const recent = samples.filter((s) => now - s.t <= VELOCITY_WINDOW_MS);
  if (recent.length < 2) return 0;
  const first = recent[0];
  const last = recent[recent.length - 1];
  const dt = last.t - first.t;
  return dt > 0 ? (last.x - first.x) / dt : 0;
}

/** A flick decides by its direction; otherwise more than half open stays open. */
export function restingPlace({
  offset,
  width,
  velocity,
}: {
  offset: number;
  width: number;
  velocity: number;
}): Rest {
  if (velocity >= FLICK_PX_PER_MS) return "open";
  if (velocity <= -FLICK_PX_PER_MS) return "closed";
  return offset > -width / 2 ? "open" : "closed";
}

/** For a gesture cut short, such as the system taking the touch: the nearer one. */
export function nearestPlace(offset: number, width: number): Rest {
  return restingPlace({ offset, width, velocity: 0 });
}

/**
 * Whether a swipe may start at all: on a phone, with one finger, on a page
 * that is not zoomed, and with nothing else modal on screen.
 */
export function swipeAllowed(env: {
  phone: boolean;
  touches: number;
  scale: number;
  modalOpen: boolean;
}): boolean {
  return env.phone && env.touches === 1 && env.scale <= MAX_SCALE && !env.modalOpen;
}

/** Things that take a sideways drag, or a touch, for themselves. */
const ANYWHERE = [
  "input",
  "textarea",
  "select",
  '[role="slider"]',
  // A player's own controls are out of reach, so the touch lands on the
  // player: dragging its timeline right would open the drawer instead.
  "video[controls]",
  "audio[controls]",
  // The block toolbar above the keyboard scrolls sideways.
  '[role="toolbar"]',
  ".bn-resize-handle",
  ".bn-toolbar",
  ".bn-suggestion-menu",
  ".bn-side-menu",
  ".bn-drag-handle",
  '[draggable="true"]',
  // For anything else that needs the finger, such as cropping an image.
  "[data-no-drawer-swipe]",
].join(", ");

/** Inside the open drawer: its row menus, rename fields and scrollbar. */
const IN_DRAWER = [
  ANYWHERE,
  "[data-inline-rename]",
  '[role="menu"]',
  '[data-slot="popover-content"]',
  '[data-slot="scroll-area-scrollbar"]',
].join(", ");

const EDITABLE = '[contenteditable]:not([contenteditable="false"])';

/** An element that scrolls sideways and has something to scroll to. */
function scrollsSideways(element: Element, view: Window): boolean {
  const { overflowX } = view.getComputedStyle(element);
  return (
    (overflowX === "auto" || overflowX === "scroll") &&
    element.scrollWidth > element.clientWidth + 1
  );
}

/** A drag inside selected text moves the selection's handles. */
function withinSelection(element: Element): boolean {
  const host = element.closest(EDITABLE);
  const selection = element.ownerDocument.getSelection();
  return (
    host !== null &&
    selection !== null &&
    selection.rangeCount > 0 &&
    !selection.isCollapsed &&
    host.contains(selection.anchorNode)
  );
}

/**
 * Whether a touch that lands on `target` must be left alone: it is on a
 * control, inside something that scrolls sideways, or inside selected text,
 * anywhere between the target and `root`.
 */
export function touchBelongsElsewhere(
  target: EventTarget | null,
  root: Element,
  where: "page" | "drawer",
): boolean {
  const node = target as Node | null;
  // Older WebKit can report the text node under the finger.
  const element = node?.nodeType === 3 ? node.parentElement : (node as Element | null);
  const view = root.ownerDocument.defaultView;
  if (!element || typeof element.matches !== "function" || !view || !root.contains(element)) {
    return true;
  }
  const selector = where === "drawer" ? IN_DRAWER : ANYWHERE;
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.matches(selector) || scrollsSideways(current, view)) return true;
    if (current === root) break;
  }
  return withinSelection(element);
}
