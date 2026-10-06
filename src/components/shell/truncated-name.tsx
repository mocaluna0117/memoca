"use client";

import { useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** How long the pointer rests on a name before the whole of it is shown. */
const DELAY_MS = 1_000;

/**
 * A name cut short with … where its row is too narrow (a narrow window, a
 * long name), shown whole in a tooltip once the pointer has rested on it a
 * moment. Only when it is cut short: one shown whole already has nothing to
 * add. Not on a phone, where there is no pointer to rest (globals.css).
 */
export function TruncatedName({ text, className }: { text: string; className?: string }) {
  const name = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <Tooltip
      delayDuration={DELAY_MS}
      open={open}
      onOpenChange={(next) => {
        const element = name.current;
        setOpen(next && element !== null && element.scrollWidth > element.clientWidth);
      }}
    >
      <TooltipTrigger asChild>
        <span ref={name} className={cn("truncate", className)}>
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}
