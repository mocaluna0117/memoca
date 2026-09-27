"use client";

import { useSearchParams } from "next/navigation";
import { useClientValue } from "@/lib/hooks/use-client-value";
import { inShell } from "./shell";

/**
 * How the quick note is shown: as a page of its own (a phone, the bottom
 * bar's ⚡, a share), or as a small window of its own (the desktop shell, or
 * a window the web app opens for it), which stays where it is after a save
 * and closes with Esc.
 */
export type QuickMode = "page" | "window";

export function detectQuickMode(opts: { windowParam: string | null; shell: boolean }): QuickMode {
  return opts.windowParam === "1" || opts.shell ? "window" : "page";
}

/**
 * The mode here. `?window=1` is known from the first render; the shell only
 * in the browser, so a page in the shell renders as a page for a moment.
 */
export function useQuickMode(): QuickMode {
  const windowParam = useSearchParams().get("window");
  const shell = useClientValue(inShell, false);
  return detectQuickMode({ windowParam, shell });
}
