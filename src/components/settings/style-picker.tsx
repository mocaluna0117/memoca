"use client";

import { useMutation } from "convex/react";
import { Check } from "lucide-react";
import { useSyncExternalStore } from "react";
import { api } from "@convex/_generated/api";
import {
  DEFAULT_STYLE,
  STYLES,
  STYLE_CHANGED,
  type StyleId,
  applyStyle,
  markStyleUnsent,
  styleHere,
  styleUnsent,
} from "@/lib/style";
import { cn } from "@/lib/utils";

function subscribe(onChange: () => void): () => void {
  window.addEventListener(STYLE_CHANGED, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(STYLE_CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** A small page in a look, drawn in its own colours, corners and letters, light or dark as the page is. */
function Preview({ style }: { style: StyleId }) {
  return (
    <div
      data-style={style}
      aria-hidden
      className="bg-background text-foreground flex h-24 overflow-hidden rounded-lg border font-sans"
    >
      <div className="bg-sidebar border-sidebar-border flex w-[34%] flex-col gap-1.5 border-r p-2">
        <span className="text-sidebar-foreground truncate text-[10px] font-semibold">Memoca</span>
        <span className="bg-sidebar-accent h-2.5 w-full rounded-sm" />
        <span className="bg-sidebar-foreground/15 h-1.5 w-3/4 rounded-sm" />
        <span className="bg-sidebar-foreground/15 h-1.5 w-2/3 rounded-sm" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 p-2">
        <span className="truncate text-xs font-bold">あいう Aa</span>
        <span className="text-muted-foreground truncate text-[10px]">きょうのメモ</span>
        <span className="bg-foreground/10 h-1.5 w-full rounded-sm" />
        <span className="bg-primary text-primary-foreground mt-auto self-end rounded-md px-2 py-0.5 text-[10px]">
          保存
        </span>
      </div>
    </div>
  );
}

/**
 * The app's looks to choose from (lib/style), each shown as a small page
 * of it: chosen, the page in it at once, here, and the account told, for
 * its other devices (sent again later if it cannot be now: StyleSync).
 */
export function StylePicker() {
  const current = useSyncExternalStore(subscribe, styleHere, () => DEFAULT_STYLE);
  const updateSettings = useMutation(api.users.updateSettings);

  const choose = (style: StyleId) => {
    applyStyle(style);
    markStyleUnsent(style);
    void updateSettings({ style }).then(
      () => {
        if (styleUnsent() === style) markStyleUnsent(null);
      },
      () => undefined,
    );
  };

  return (
    <div role="radiogroup" aria-label="デザイン" className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {STYLES.map((style) => {
        const chosen = current === style.id;
        return (
          <button
            key={style.id}
            type="button"
            role="radio"
            aria-checked={chosen}
            onClick={() => choose(style.id)}
            className={cn(
              "hover:bg-accent/50 flex flex-col gap-2 rounded-xl border p-2 text-left transition-colors",
              chosen && "border-primary ring-primary/30 ring-2",
            )}
          >
            <Preview style={style.id} />
            <span className="flex items-center gap-1.5 px-0.5 text-sm font-medium">
              {chosen ? <Check className="text-primary size-4 shrink-0" aria-hidden /> : null}
              {style.label}
            </span>
            <span className="text-muted-foreground px-0.5 text-xs leading-snug">{style.description}</span>
          </button>
        );
      })}
    </div>
  );
}
