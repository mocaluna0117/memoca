"use client";

import type { ReactElement, ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * The quick note's tooltips: shown a fifth of a second after the pointer
 * rests, and at once when it moves on to the next. A `title` was shown when
 * the system chose to, a second or two on (in the desktop app's window too).
 */
export function QuickTips({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider delayDuration={200} skipDelayDuration={400}>
      {children}
    </TooltipProvider>
  );
}

/** A tooltip on what it is put on (which keeps its own aria-label: this is what a pointer is shown). */
export function Tip({
  label,
  side = "bottom",
  children,
}: {
  label: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}
