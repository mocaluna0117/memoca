"use client";

import { buttonVariants } from "@/components/ui/button";
import { t } from "@/lib/i18n/ja";

/**
 * How long a PDF is under way before how far it has come is shown, with
 * the button to cancel it: one made sooner shows only what is happening,
 * not a number and a bar there and gone at once.
 */
export const DETAILS_AFTER_MS = 400;

/** The percents read out to a screen reader, rather than every one. */
const READ_OUT_AT = [25, 50, 75] as const;

export type ExportCover = {
  /** How far it has come, as a whole percent. */
  set(percent: number): void;
  /** Takes the cover away. */
  remove(): void;
};

/**
 * The white cover a note is made into a PDF under, while it is laid out
 * at the width of a sheet and in the light theme: 「PDF を書き出しています…
 * 42%」 over a bar, and a button to cancel. The number, the bar and the
 * button are shown once it has gone on for {@link DETAILS_AFTER_MS}.
 *
 * Built as it is put up, in the same task as the note is laid out again,
 * so the note is never seen half done. A screen reader is told it has
 * begun, then every quarter of the way, rather than at each percent.
 */
export function showExportCover({ onCancel }: { onCancel: () => void }): ExportCover {
  const cover = document.createElement("div");
  // Over everything, and holding the focus once it has the button.
  cover.setAttribute("role", "dialog");
  cover.setAttribute("aria-modal", "true");
  cover.setAttribute("aria-label", t.exportPdf.progressLabel);
  cover.className =
    "memoca-export-cover fixed inset-0 z-[1000] flex items-center justify-center bg-white px-4 text-sm text-neutral-600";

  // What it is doing, and how far, as seen; read out by the bar and the status below.
  const line = document.createElement("p");
  line.setAttribute("aria-hidden", "true");
  const number = document.createElement("span");
  // As wide as "100%" from the start, so the line does not move as it counts.
  number.className = "invisible inline-block w-[4ch] text-left tabular-nums";
  number.textContent = t.exportPdf.percent(0);
  line.append(`${t.exportPdf.progress} `, number);

  // Below the line, which stays where it is when they come. Not drawn at
  // all until then, rather than drawn invisible: the button's transitions
  // would take its visibility along, and it could not be given the focus.
  const details = document.createElement("div");
  details.className =
    "absolute top-full left-1/2 mt-3 flex -translate-x-1/2 flex-col items-center gap-3";
  details.hidden = true;
  const bar = document.createElement("div");
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-label", t.exportPdf.progressLabel);
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  bar.className = "h-1.5 w-48 overflow-hidden rounded-full bg-muted";
  const fill = document.createElement("div");
  fill.className = "h-full bg-primary transition-[width] duration-150 ease-out";
  bar.append(fill);
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = buttonVariants({ variant: "outline", size: "sm" });
  cancel.textContent = t.action.cancel;
  details.append(bar, cancel);

  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.className = "sr-only";

  const middle = document.createElement("div");
  middle.className = "relative";
  middle.append(line, details);
  cover.append(middle, status);
  document.body.append(cover);
  status.textContent = t.exportPdf.progress;

  let shown = -1;
  let readOut = 0;
  let cancelling = false;
  const set = (percent: number) => {
    const value = Math.max(0, Math.min(100, Math.round(percent)));
    if (value === shown) return;
    shown = value;
    number.textContent = t.exportPdf.percent(value);
    bar.setAttribute("aria-valuenow", String(value));
    bar.setAttribute("aria-valuetext", t.exportPdf.percent(value));
    fill.style.width = `${value}%`;
    const passed = READ_OUT_AT.filter((at) => at <= value).at(-1);
    if (passed !== undefined && passed > readOut && !cancelling) {
      readOut = passed;
      status.textContent = `${t.exportPdf.progress} ${t.exportPdf.percent(passed)}`;
    }
  };
  set(0);

  const cancelNow = () => {
    if (cancelling) return;
    cancelling = true;
    // What is being drawn is finished first: said so meanwhile.
    cancel.disabled = true;
    cancel.textContent = t.exportPdf.cancelling;
    status.textContent = t.exportPdf.cancelling;
    onCancel();
  };
  cancel.addEventListener("click", cancelNow);
  cover.addEventListener("keydown", (event) => {
    // The button is all there is to go to: not the note beneath.
    if (event.key === "Tab") event.preventDefault();
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    cancelNow();
  });

  const reveal = setTimeout(() => {
    number.classList.remove("invisible");
    details.hidden = false;
    // So the keyboard can cancel at once. Whatever had the focus is under
    // the cover (the note's was let go; the menu the export was chosen from
    // may still be on its way out, and takes it as the pointer leaves it).
    if (!cancelling) cancel.focus({ preventScroll: true });
  }, DETAILS_AFTER_MS);

  return {
    set,
    remove: () => {
      clearTimeout(reveal);
      cover.remove();
    },
  };
}
