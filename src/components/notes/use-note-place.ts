"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { useMediaQuery } from "@/lib/hooks/use-client-value";
import { type Line, placeAt, placeOf, rememberPlace, scrollToPlace } from "@/lib/note-place";

/** How long a note is put back where it was read once its line is on the screen. */
const SETTLING_MS = 2500;
/** At most, while images above it are still loading, moving it as they do. */
const IMAGES_MS = 10_000;

/** What the note scrolls in: its own pane on a wider screen, or (null) the page, on a phone. */
function scrollerOf(body: HTMLElement | null): HTMLElement | null {
  if (!body) return null;
  const { overflowY } = getComputedStyle(body);
  return overflowY === "auto" || overflowY === "scroll" ? body : null;
}

/** The note's blocks at its top level, in its order. */
const topBlocks = (body: HTMLElement) =>
  body.querySelectorAll<HTMLElement>(
    ".memoca-editor .bn-editor > .bn-block-group > .bn-block-outer",
  );

/**
 * The note's lines on the screen from those at `viewTop` down, in its order:
 * each block's own line, not one kept at the top over what is inside it, nor
 * one out of sight in a closed toggle. Found by halves among the blocks at
 * the top level (each lower than the one before), then line by line.
 */
function* linesFrom(body: HTMLElement, viewTop: number): Generator<Line> {
  const blocks = topBlocks(body);
  let low = 0;
  let high = blocks.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (blocks[middle]!.getBoundingClientRect().bottom > viewTop) high = middle;
    else low = middle + 1;
  }
  for (let index = low; index < blocks.length; index += 1) {
    for (const content of blocks[index]!.querySelectorAll<HTMLElement>(".bn-block-content")) {
      const box = content.getBoundingClientRect();
      if (box.height === 0 || box.bottom <= viewTop) continue;
      const block = content.closest<HTMLElement>(".bn-block");
      const id = block?.dataset.id;
      if (!block || !id) continue;
      // Kept at the top over what is inside it: the reading is under it.
      if (
        getComputedStyle(content).position === "sticky" &&
        block.getBoundingClientRect().top < box.top
      ) {
        continue;
      }
      yield { id, top: box.top, bottom: box.bottom };
    }
  }
}

/**
 * The line to put back on the screen for a block: its own, or, out of sight
 * in a closed toggle, the line of the toggle it is in (from its top).
 */
function shownLineOf(
  body: HTMLElement,
  blockId: string,
): { line: HTMLElement; own: boolean } | null {
  let block = body.querySelector<HTMLElement>(`.bn-block[data-id="${CSS.escape(blockId)}"]`);
  let own = true;
  while (block) {
    const line = block.querySelector<HTMLElement>(":scope > .bn-block-content");
    if (line && line.getBoundingClientRect().height > 0) return { line, own };
    block = block.parentElement?.closest<HTMLElement>(".bn-block") ?? null;
    own = false;
  }
  return null;
}

/**
 * Keeps where a note is being read, and opens it there again, instead of at
 * its top: in its pane on a wider screen, on the page on a phone. Below the
 * note's header, which is over the top of it. Put back once its line is on
 * the screen (it loads after the note opens; a locked one only once the
 * vault is, again each time it closes and opens with the note open), and
 * as it settles, until whoever reads it scrolls it, taps or
 * types. The ref is for the note's body, which is shown with the header:
 * `header` set is the note being shown.
 */
export function useNotePlace(noteId: string, header: HTMLElement | null, hidden: boolean) {
  // The note's body, scrolled or not (on a phone, the page is): for its ref.
  const body = useRef<HTMLDivElement>(null);
  // In its own pane, or (narrower) on the page: put back again as it goes
  // from one to the other.
  const wide = useMediaQuery("(min-width: 48rem)");
  // Not kept while being put back: where it is then is not where it was read.
  const restoring = useRef(false);

  useEffect(() => {
    const viewTop = () =>
      header?.getBoundingClientRect().bottom ??
      scrollerOf(body.current)?.getBoundingClientRect().top ??
      0;
    let timer = 0;
    const keep = () => {
      window.clearTimeout(timer);
      timer = 0;
      const pane = body.current;
      if (!pane || restoring.current) return;
      const top = viewTop();
      const place = placeAt(linesFrom(pane, top), top);
      if (!place) return;
      // Its top, never read lower down here (opened, or scrolled there by
      // opening it): nothing to keep, nor room to take among those kept.
      const first = linesFrom(pane, -Infinity).next().value;
      if (place.offset <= 0 && place.block === first?.id && !placeOf(noteId)) return;
      rememberPlace(noteId, place);
    };
    const later = () => {
      if (restoring.current) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(keep, 150);
    };
    // A scroll still to be kept, kept now: before what may open another
    // note (a click, a key, going back) takes this one away, or the app is
    // put away.
    const now = () => {
      if (timer) keep();
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") now();
    };
    const pane = body.current;
    pane?.addEventListener("scroll", later, { passive: true });
    window.addEventListener("scroll", later, { passive: true });
    document.addEventListener("pointerdown", now, true);
    document.addEventListener("keydown", now, true);
    window.addEventListener("popstate", now);
    window.addEventListener("pagehide", now);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.clearTimeout(timer);
      pane?.removeEventListener("scroll", later);
      window.removeEventListener("scroll", later);
      document.removeEventListener("pointerdown", now, true);
      document.removeEventListener("keydown", now, true);
      window.removeEventListener("popstate", now);
      window.removeEventListener("pagehide", now);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [noteId, header]);

  useLayoutEffect(() => {
    // Where it starts: its top, until it is put back, or for good if it was
    // never read here.
    if (body.current) body.current.scrollTop = 0;
    const place = placeOf(noteId);
    if (!place) return;
    restoring.current = true;
    let frame = 0;
    let found = 0;
    let watching: MutationObserver | null = null;
    // The reader's own scrolling of the note, or a tap or a key anywhere.
    const byReader = (event: Event) => {
      const note = body.current?.closest(".memoca-note-pane");
      if (
        (event.type === "wheel" || event.type === "touchstart") &&
        !(event.target instanceof Node && note?.contains(event.target))
      ) {
        return;
      }
      stop();
    };
    const stop = () => {
      restoring.current = false;
      cancelAnimationFrame(frame);
      watching?.disconnect();
      for (const type of STOPPED_BY) window.removeEventListener(type, byReader, true);
    };
    const viewTop = (pane: HTMLElement) =>
      header?.getBoundingClientRect().bottom ?? scrollerOf(pane)?.getBoundingClientRect().top ?? 0;
    /** Images above the line still loading, which move it as they do. */
    const loading = (pane: HTMLElement, line: HTMLElement) =>
      [...pane.querySelectorAll("img")].some(
        (image) =>
          // Loading, or not yet given its file (one added on another
          // device, still being fetched).
          (!image.complete || image.naturalWidth === 0) &&
          image.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    const settle = () => {
      const pane = body.current;
      const shown = pane ? shownLineOf(pane, place.block) : null;
      // Gone since (deleted on another device, say): left where it is.
      if (!pane || !shown) {
        stop();
        return;
      }
      const by = scrollToPlace(
        shown.own ? place : { ...place, offset: 0 },
        shown.line.getBoundingClientRect().top,
        viewTop(pane),
      );
      if (Math.abs(by) >= 1) {
        const scroller = scrollerOf(pane);
        if (scroller) scroller.scrollTop += by;
        else window.scrollBy(0, by);
      }
      const since = performance.now() - found;
      if (since > SETTLING_MS && (since > IMAGES_MS || !loading(pane, shown.line))) {
        stop();
        return;
      }
      frame = requestAnimationFrame(settle);
    };
    /** The note's lines on the screen: put back from now, or (its line gone) left at its top. */
    const look = () => {
      const pane = body.current;
      if (!pane || !pane.querySelector(".memoca-editor .bn-block-content")) return;
      watching?.disconnect();
      if (!shownLineOf(pane, place.block)) {
        stop();
        return;
      }
      // Opened again: the one read last, for which are kept.
      rememberPlace(noteId, place);
      found = performance.now();
      for (const type of STOPPED_BY) window.addEventListener(type, byReader, true);
      frame = requestAnimationFrame(settle);
    };
    // Not yet on the screen (loading, or locked): once it is.
    watching = new MutationObserver(look);
    if (body.current) watching.observe(body.current, { childList: true, subtree: true });
    look();
    return stop;
  }, [noteId, header, hidden, wide]);

  return body;
}

/** What the one reading does that ends putting it back: their own scrolling, or a tap or a key. */
const STOPPED_BY = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
