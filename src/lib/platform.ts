"use client";

import { useClientValue } from "@/lib/hooks/use-client-value";

/**
 * Whether the keyboard's command key is ⌘: an Apple computer, phone or
 * tablet (iPadOS says it is a Mac), told from the user agent as the rest of
 * the app tells devices apart (src/lib/crypto/platform.ts).
 */
export const isApple = (userAgent: string) => /Macintosh|iPhone|iPad|iPod/.test(userAgent);

/** The key held with Enter to save, as it is marked on this keyboard. */
export const modKeyLabel = (userAgent: string) => (isApple(userAgent) ? "⌘" : "Ctrl");

/** {@link modKeyLabel} here: ⌘ until the browser says otherwise. */
export function useModKeyLabel(): string {
  return useClientValue(() => modKeyLabel(navigator.userAgent), "⌘");
}
