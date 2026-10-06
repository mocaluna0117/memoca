"use client";

import { useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** How long the pointer rests on a name before the whole of it is shown. */
const DELAY_MS = 1_000;

/** The gap between the pane the name is in and the tooltip beside it. */
const GAP_PX = 8;

/**
 * A name cut short with … where its row is too narrow (a narrow window, a
 * long name), shown whole in a tooltip once the pointer has rested on it a
 * moment. Only when it is cut short: one shown whole already has nothing to
 * add. Not on a phone, where there is no pointer to rest (globals.css).
 *
 * To the right, past the pane the name is in (the sidebar, the list), where
 * it covers neither the rows below nor the row's own buttons beside it.
 */
export function TruncatedName({ text, className }: { text: string; className?: string }) {
  const name = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(GAP_PX);
  return (
    <Tooltip
      delayDuration={DELAY_MS}
      // Only read, never pointed at: closed as the pointer leaves the name,
      // not kept open on its way across the row's buttons towards it.
      disableHoverableContent
      open={open}
      onOpenChange={(next) => {
        const element = name.current;
        const cut = next && element !== null && element.scrollWidth > element.clientWidth;
        if (cut) {
          const pane = element.closest("aside, section") ?? element;
          setOffset(pane.getBoundingClientRect().right - element.getBoundingClientRect().right + GAP_PX);
        }
        setOpen(cut);
      }}
    >
      <TooltipTrigger asChild>
        <span ref={name} className={cn("truncate", className)}>
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={offset}>
        {text}
      </TooltipContent>
    </Tooltip>
  );
}
