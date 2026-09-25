"use client";

import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import {
  type Direction,
  type Lock,
  PHONE_QUERY,
  REDUCED_SETTLE_MS,
  type Rest,
  SETTLE_EASING,
  SETTLE_MS,
  type Sample,
  addSample,
  dragOffset,
  lockAxis,
  nearestPlace,
  openness,
  releaseVelocity,
  restingPlace,
  swipeAllowed,
  touchBelongsElsewhere,
} from "@/lib/gesture/drawer-swipe";
import { useVaultGate } from "@/lib/store/vault-gate";

type Gesture = {
  id: number;
  direction: Direction;
  x0: number;
  y0: number;
  t0: number;
  lock: Lock;
  /** Where the drawer was when the finger took it. */
  start: number;
  dx: number;
  samples: Sample[];
};

type Parts = {
  /**
   * Takes the swipe that opens. It holds the page, and also the strip the
   * page leaves bare while it is moved aside.
   */
  area: HTMLElement | null;
  /** Moves aside as the drawer comes in. */
  page: HTMLElement | null;
  /** Fixed at the bottom of the screen, so it has to be moved on its own. */
  bar: HTMLElement | null;
  content: HTMLElement | null;
  /** The dimming beside the drawer, which fades with it. */
  shade: HTMLElement | null;
  /** What takes a touch beside the drawer. Only there while it is open. */
  overlay: HTMLElement | null;
};

const translate = (x: number) => `translate3d(${x}px, 0, 0)`;

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Another dialog or prompt owns the screen. The drawer sets the same body style, so it asks first. */
const vaultPromptOpen = () => useVaultGate.getState().request !== null;
const modalOpen = () => vaultPromptOpen() || document.body.style.pointerEvents === "none";

/** Where focus can go back to without bringing up the keyboard. */
function restorable(element: Element | null): HTMLElement | null {
  if (!(element instanceof HTMLElement) || element === document.body) return null;
  if (element.isContentEditable || element.matches("input, textarea, select")) return null;
  return element;
}

function touchById(list: TouchList, id: number): Touch | null {
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].identifier === id) return list[i];
  }
  return null;
}

/**
 * Everything the drawer does between React renders. A finger moves it dozens
 * of times a second, so positions are written straight to the DOM once per
 * frame and React only hears about opening and closing.
 */
function createDrawer(render: {
  setMounted: (mounted: boolean) => void;
  setOpen: (open: boolean) => void;
}) {
  const parts: Parts = {
    area: null,
    page: null,
    bar: null,
    content: null,
    shade: null,
    overlay: null,
  };
  let open = false;
  let mounted = false;
  let width = 0;
  let offset = 0;
  let push = true;
  let gesture: Gesture | null = null;
  let frame = 0;
  let animations: Animation[] = [];
  let returnFocus: HTMLElement | null = null;
  /** Opened by a finger: focus moves in once it is really open, not on the way. */
  let byFinger = false;
  /** Mounting: the drawer is measured and placed as soon as its parts are in the DOM. */
  let entering = false;

  const moved = () => [parts.page, parts.bar].filter((el): el is HTMLElement => el !== null);

  const paint = () => {
    frame = 0;
    const { content, shade } = parts;
    if (content) content.style.transform = translate(offset);
    if (shade) shade.style.opacity = String(openness(offset, width));
    for (const el of moved()) el.style.transform = push ? translate(offset + width) : "";
  };

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(paint);
  };

  /** Where the drawer is on screen right now, animation included. */
  const liveOffset = () => {
    if (!parts.content || animations.length === 0) return offset;
    const transform = getComputedStyle(parts.content).transform;
    return transform && transform !== "none" ? new DOMMatrixReadOnly(transform).m41 : 0;
  };

  /** Stops any animation where it is, so a finger can take over from there. */
  const hold = () => {
    offset = liveOffset();
    for (const animation of animations) animation.cancel();
    animations = [];
    paint();
  };

  const unmount = () => {
    mounted = false;
    // A swipe that began on the page while the drawer was leaving goes on:
    // it opens a new one.
    if (gesture?.direction === -1) gesture = null;
    for (const el of moved()) el.style.transform = "";
    render.setMounted(false);
  };

  /**
   * Animates from wherever the drawer is to one of its resting places. The
   * resting state is written first and the animation only covers the way
   * there, so once it ends nothing is left behind: in particular no transform
   * on the page, which would make it the reference for everything fixed in it.
   */
  const settle = (rest: Rest) => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    const from = liveOffset();
    for (const animation of animations) animation.cancel();
    const to = rest === "open" ? 0 : -width;
    offset = to;
    const timing = {
      duration: reducedMotion() ? REDUCED_SETTLE_MS : SETTLE_MS,
      easing: SETTLE_EASING,
    };
    const run: Animation[] = [];
    const { content, shade } = parts;
    if (content) {
      content.style.transform = rest === "open" ? "" : translate(to);
      run.push(
        content.animate([{ transform: translate(from) }, { transform: translate(to) }], timing),
      );
    }
    if (shade) {
      shade.style.opacity = rest === "open" ? "" : "0";
      run.push(
        shade.animate(
          [{ opacity: openness(from, width) }, { opacity: openness(to, width) }],
          timing,
        ),
      );
    }
    const pushFrom = push ? from + width : 0;
    const pushTo = push ? to + width : 0;
    for (const el of moved()) {
      el.style.transform = pushTo ? translate(pushTo) : "";
      if (pushFrom !== pushTo) {
        run.push(
          el.animate(
            [{ transform: translate(pushFrom) }, { transform: translate(pushTo) }],
            timing,
          ),
        );
      }
    }
    animations = run;
    const done = () => {
      if (animations !== run) return;
      animations = [];
      if (rest === "closed") unmount();
    };
    Promise.all(run.map((animation) => animation.finished)).then(done, () => undefined);
    // A hidden tab may never finish an animation; the drawer still has to go.
    window.setTimeout(done, timing.duration + 200);
  };

  const show = (opener?: HTMLElement | null) => {
    if (open) return;
    open = true;
    byFinger = false;
    returnFocus = opener ?? null;
    push = !reducedMotion();
    render.setOpen(true);
    if (mounted) {
      // Caught on its way out.
      settle("open");
      return;
    }
    mounted = true;
    entering = true;
    render.setMounted(true);
  };

  const hide = () => {
    if (!open) return;
    open = false;
    entering = false;
    gesture = null;
    render.setOpen(false);
    settle("closed");
  };

  /** Runs once the drawer is in the DOM, before it is painted. */
  const entered = () => {
    const { content } = parts;
    if (!content || !open) return;
    entering = false;
    width = content.offsetWidth;
    offset = -width;
    if (gesture?.lock === "drag") {
      gesture.start = -width;
      offset = dragOffset(gesture.dx, width, 1, gesture.start);
      paint();
      return;
    }
    settle("open");
  };

  const release = (rest: Rest) => {
    if (rest === "closed") {
      hide();
      return;
    }
    settle("open");
    if (byFinger) {
      byFinger = false;
      parts.content?.focus({ preventScroll: true });
    }
  };

  /** A second finger, or the system taking the touch: the nearer place wins. */
  const abandon = () => {
    const current = gesture;
    gesture = null;
    if (current?.lock === "drag") release(nearestPlace(offset, width));
  };

  const begin = (event: TouchEvent, direction: Direction) => {
    const touch = event.touches[0];
    gesture = {
      id: touch.identifier,
      direction,
      x0: touch.clientX,
      y0: touch.clientY,
      t0: event.timeStamp,
      lock: "pending",
      start: 0,
      dx: 0,
      // From where the finger came down: a quick flick may send a single move
      // before it lets go, and that alone would read as standing still.
      samples: [{ t: event.timeStamp, x: touch.clientX }],
    };
  };

  const environment = (event: TouchEvent, modal: boolean) => ({
    phone: window.matchMedia(PHONE_QUERY).matches,
    touches: event.touches.length,
    scale: window.visualViewport?.scale ?? 1,
    modalOpen: modal,
  });

  const onPageTouchStart = (event: TouchEvent) => {
    // A second finger ends a swipe. A lone new one means the last touch ended
    // where this element could not hear it, such as on a node since removed.
    if (gesture) abandon();
    // While it is on its way out the page is already under the finger, and a
    // swipe catches the drawer where it is.
    if (open || !parts.area) return;
    if (!swipeAllowed(environment(event, modalOpen()))) return;
    if (touchBelongsElsewhere(event.target, parts.area, "page")) return;
    begin(event, 1);
  };

  const onDrawerTouchStart = (event: TouchEvent) => {
    if (gesture) abandon();
    const root = event.currentTarget as HTMLElement;
    if (!open || !swipeAllowed(environment(event, vaultPromptOpen()))) return;
    if (touchBelongsElsewhere(event.target, root, "drawer")) return;
    begin(event, -1);
  };

  /** The moment a touch becomes a swipe. False when it should not be one after all. */
  const take = (current: Gesture): boolean => {
    if (current.direction === -1) {
      if (!open) return false;
      hold();
      current.start = offset;
      return true;
    }
    // The prompt or a dialog may have come up while the finger was deciding.
    if (open || modalOpen()) return false;
    open = true;
    byFinger = true;
    if (mounted) {
      // Caught on its way out. Focus still goes back where it was before.
      hold();
      current.start = offset;
      render.setOpen(true);
      return true;
    }
    mounted = true;
    entering = true;
    returnFocus = restorable(document.activeElement);
    push = !reducedMotion();
    // Rendered now, portal included, so the drawer is under the finger on the
    // very next frame.
    flushSync(() => {
      render.setMounted(true);
      render.setOpen(true);
    });
    return true;
  };

  const onTouchMove = (event: TouchEvent) => {
    const current = gesture;
    if (!current) return;
    if (event.touches.length !== 1) {
      abandon();
      return;
    }
    const touch = touchById(event.touches, current.id);
    if (!touch) return;
    current.dx = touch.clientX - current.x0;
    current.samples = addSample(current.samples, { t: event.timeStamp, x: touch.clientX });
    if (current.lock === "pending") {
      current.lock = lockAxis(
        current.dx,
        touch.clientY - current.y0,
        event.timeStamp - current.t0,
        current.direction,
      );
      if (current.lock === "pending") return;
      if (current.lock === "ignore" || !take(current)) {
        gesture = null;
        return;
      }
    }
    // Neither the page nor the folder list scrolls under a swipe.
    if (event.cancelable) event.preventDefault();
    if (width > 0) {
      offset = dragOffset(current.dx, width, current.direction, current.start);
      schedule();
    }
  };

  const onTouchEnd = (event: TouchEvent) => {
    const current = gesture;
    if (!current) return;
    const touch = touchById(event.changedTouches, current.id);
    if (!touch) return;
    gesture = null;
    if (current.lock !== "drag") return;
    // The finger that swiped does not also tap whatever it let go over.
    if (event.cancelable) event.preventDefault();
    const samples = addSample(current.samples, { t: event.timeStamp, x: touch.clientX });
    release(restingPlace({ offset, width, velocity: releaseVelocity(samples, event.timeStamp) }));
  };

  const listen = (el: HTMLElement, onTouchStart: (event: TouchEvent) => void) => {
    // Native listeners: React's touch handlers are passive, so they cannot stop
    // the page scrolling, and they bubble through portals, so the drawer's
    // would also hear dialogs opened from inside it.
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: false });
    el.addEventListener("touchcancel", abandon, { passive: false });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", abandon);
    };
  };

  const part =
    (key: keyof Parts, onTouchStart?: (event: TouchEvent) => void) => (el: HTMLElement | null) => {
      parts[key] = el;
      if (!el) return;
      const stop = onTouchStart ? listen(el, onTouchStart) : undefined;
      // The dialog's portal renders a pass after the drawer is asked for, so it
      // is placed when its parts arrive, not when it is mounted.
      if (entering && parts.content && parts.shade) entered();
      return () => {
        stop?.();
        if (parts[key] === el) parts[key] = null;
      };
    };

  /**
   * The area listens only while the screen is a phone's: a blocking touchmove
   * listener makes the browser wait on every scroll inside it, and from md up
   * the swipe can never start. Growing past a phone, say by turning it on its
   * side, also closes the drawer, since the folders are then beside the page
   * and the page must not stay moved aside.
   */
  const areaRef = (el: HTMLElement | null) => {
    parts.area = el;
    if (!el) return;
    const phone = window.matchMedia(PHONE_QUERY);
    let stop = phone.matches ? listen(el, onPageTouchStart) : undefined;
    const onChange = () => {
      stop?.();
      stop = undefined;
      if (phone.matches) {
        stop = listen(el, onPageTouchStart);
      } else {
        gesture = null;
        hide();
      }
    };
    phone.addEventListener("change", onChange);
    return () => {
      phone.removeEventListener("change", onChange);
      stop?.();
      if (parts.area === el) parts.area = null;
    };
  };

  return {
    show,
    hide,
    areaRef,
    pageRef: part("page"),
    barRef: part("bar"),
    contentRef: part("content", onDrawerTouchStart),
    shadeRef: part("shade"),
    overlayRef: part("overlay", onDrawerTouchStart),
    /** A finger-opened drawer takes focus when it settles open, not while it is still being dragged. */
    onOpenAutoFocus: (event: Event) => {
      if (byFinger) event.preventDefault();
    },
    /**
     * Focus goes back where it was, typically to 「メニューを開く」. Only when it
     * was lost with the drawer: a swipe that never opened left it in place.
     */
    onCloseAutoFocus: (event: Event) => {
      event.preventDefault();
      const target = returnFocus;
      returnFocus = null;
      const active = document.activeElement;
      if (target?.isConnected && (!active || active === document.body)) {
        target.focus({ preventScroll: true });
      }
    },
    dispose: () => {
      if (frame) cancelAnimationFrame(frame);
      for (const animation of animations) animation.cancel();
      animations = [];
      gesture = null;
    },
  };
}

export type DrawerSwipe = ReturnType<typeof useDrawerSwipe>;

/**
 * The phone's folder drawer, opened by a button or by swiping right anywhere
 * on the page, and closed by swiping left on it or on the dimmed page beside
 * it. The drawer follows the finger and the page moves aside with it.
 *
 * `areaRef` goes on the element that takes the opening swipe, `pageRef` on
 * the page inside it that moves with the drawer, `barRef` on the bottom bar,
 * and the rest on the drawer's parts.
 */
export function useDrawerSwipe() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [drawer] = useState(() => createDrawer({ setMounted, setOpen }));

  useEffect(() => drawer.dispose, [drawer]);

  return {
    open,
    mounted,
    show: drawer.show,
    hide: drawer.hide,
    areaRef: drawer.areaRef,
    pageRef: drawer.pageRef,
    barRef: drawer.barRef,
    contentRef: drawer.contentRef,
    shadeRef: drawer.shadeRef,
    overlayRef: drawer.overlayRef,
    onOpenAutoFocus: drawer.onOpenAutoFocus,
    onCloseAutoFocus: drawer.onCloseAutoFocus,
  };
}
