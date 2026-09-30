"use client";

import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { type Pane, clampWidth, usePaneWidth, widestIn } from "@/lib/hooks/use-pane-width";

/**
 * A pane's width on a computer's screen: the one set, but no more than its
 * share of the window allows (never less than its initial width, which is
 * what it had before it could be set). Given with {@link paneWidthStyle}.
 */
export const PANE_WIDTH_CLASS =
  "md:w-[min(var(--pane-width),max(var(--pane-floor),var(--pane-share)))]";

/** The style {@link PANE_WIDTH_CLASS} reads: as {@link widestIn} has it. */
export const paneWidthStyle = (pane: Pane, width: number) =>
  ({
    "--pane-width": `${width}px`,
    "--pane-floor": `${pane.initial}px`,
    "--pane-share": `${pane.share * 100}vw`,
  }) as CSSProperties;

/** How far an arrow key moves the edge, and with Shift held. */
const STEP = 16;
const BIG_STEP = 64;
/** How far a press has to move before it is a drag, not a click. */
const SLOP = 3;

/**
 * The right edge of a pane, dragged to set its width: on a computer's
 * screen only (a phone shows one pane at a time). Arrow keys move it too,
 * Home and End to its narrowest and widest, and Enter or a double click
 * puts it back as it started. It sits on the pane's border, in a pane that
 * is `relative` and has the id {@link Pane.id}, and reaches out over the
 * next pane rather than into this one, where its scroll bar is.
 *
 * Moves are counted from the width shown, which in a narrow window may be
 * less than the one set. A move wider then keeps the one set, so a window
 * made narrow for a while does not undo it.
 */
export function PaneResizer({ pane, label }: { pane: Pane; label: string }) {
  const [width, setWidth] = usePaneWidth(pane);
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; x: number; from: number; to: number | null } | null>(null);
  // What the pane has on the screen, and the most it could: for the keys and
  // for what a screen reader says.
  const [shown, setShown] = useState<{ width: number; widest: number } | null>(null);

  useEffect(() => {
    const element = ref.current?.parentElement;
    if (!element) return;
    const measure = () =>
      setShown({
        width: Math.round(element.getBoundingClientRect().width),
        widest: Math.round(widestIn(pane, window.innerWidth)),
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [pane]);

  const now = () => Math.round(ref.current?.parentElement?.getBoundingClientRect().width ?? width);
  const widest = () => Math.round(widestIn(pane, window.innerWidth));

  /** Sets a width moved to from `from`: moved wider, never less than the one set. */
  const settle = (from: number, next: number) =>
    setWidth(next > from ? Math.max(width, Math.min(next, widest())) : next);

  const start = (event: PointerEvent<HTMLDivElement>) => {
    // The main button only, and not Control-click, which is a right click on a Mac.
    if (event.button !== 0 || event.ctrlKey || drag.current) return;
    // No text selected on the way, and the editor keeps its caret.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, x: event.clientX, from: now(), to: null };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointer) return;
    // Let go where it was not heard.
    if (!(event.buttons & 1)) return end(event);
    const dx = event.clientX - current.x;
    if (current.to === null && Math.abs(dx) < SLOP) return;
    current.to = clampWidth(pane, current.from + dx);
    // Shown as it goes, and kept when let go: not a write to storage, and a
    // render of the whole workspace, each time the pointer moves.
    ref.current?.parentElement?.style.setProperty("--pane-width", `${current.to}px`);
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointer) return;
    drag.current = null;
    if (current.to === null) return;
    // Back to the width rendered, for a width kept as it was (moved wider
    // than a narrow window shows) to be shown as it is; one that changed is
    // rendered before the screen is next drawn.
    ref.current?.parentElement?.style.setProperty("--pane-width", `${width}px`);
    settle(current.from, current.to);
  };

  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      setWidth(null);
      return;
    }
    const step = event.shiftKey ? BIG_STEP : STEP;
    const from = now();
    const next = {
      ArrowLeft: from - step,
      ArrowRight: from + step,
      Home: pane.min,
      End: pane.max,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    settle(from, next);
  };

  const value = shown?.width ?? width;
  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation="vertical"
      aria-controls={pane.id}
      aria-label={label}
      aria-valuemin={pane.min}
      aria-valuemax={shown?.widest ?? pane.max}
      aria-valuenow={value}
      aria-valuetext={`${value}ピクセル`}
      title="ドラッグで幅を変える。ダブルクリックで元の幅に戻す"
      tabIndex={0}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={key}
      onDoubleClick={() => setWidth(null)}
      // From the border (just past the padding box `right` counts from) out
      // over the next pane; wider for a finger, where the scroll bar is not
      // dragged.
      className="group absolute inset-y-0 -right-2 z-20 hidden w-2 cursor-col-resize touch-none outline-none md:block pointer-coarse:-right-3 pointer-coarse:w-6"
    >
      <div className="h-full w-0.5 bg-transparent transition-colors group-hover:bg-ring group-focus-visible:w-1 group-focus-visible:bg-primary group-active:bg-ring pointer-coarse:mx-auto" />
    </div>
  );
}
