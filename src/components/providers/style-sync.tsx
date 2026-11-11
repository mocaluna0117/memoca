"use client";

import { useMutation } from "convex/react";
import { useEffect } from "react";
import { api } from "@convex/_generated/api";
import { useSync } from "@/components/providers/sync-provider";
import {
  DEFAULT_STYLE,
  STYLE_KEY,
  applyStyle,
  isStyle,
  markStyleUnsent,
  paintBar,
  styleHere,
  styleUnsent,
} from "@/lib/style";

/**
 * The account's look (lib/style) on this device: taken as the account says
 * it (chosen on another device), unless one chosen here is still to reach
 * it, which is sent again instead (chosen offline, or the page closed
 * before it went). Another window of this device's choosing is taken too,
 * and the browser's bar kept in the page's colour as light and dark change.
 */
export function StyleSync() {
  const { me } = useSync();
  const updateSettings = useMutation(api.users.updateSettings);
  const account = me ? (me.settings.style ?? DEFAULT_STYLE) : null;

  useEffect(() => {
    if (account === null) return;
    const unsent = styleUnsent();
    if (unsent !== null) {
      if (unsent === account) markStyleUnsent(null);
      else
        void updateSettings({ style: unsent }).then(
          () => {
            if (styleUnsent() === unsent) markStyleUnsent(null);
          },
          () => undefined,
        );
      return;
    }
    if (styleHere() !== account) applyStyle(account);
  }, [account, updateSettings]);

  useEffect(() => {
    const elsewhere = (event: StorageEvent) => {
      if (event.key !== STYLE_KEY) return;
      const style = isStyle(event.newValue) ? event.newValue : DEFAULT_STYLE;
      if (document.documentElement.dataset.style !== (style === DEFAULT_STYLE ? undefined : style)) {
        applyStyle(style);
      }
    };
    window.addEventListener("storage", elsewhere);
    // Light and dark are a class next-themes puts on <html>: the bar after it.
    const classes = new MutationObserver(() => paintBar());
    classes.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-style"] });
    paintBar();
    return () => {
      window.removeEventListener("storage", elsewhere);
      classes.disconnect();
    };
  }, []);

  return null;
}
