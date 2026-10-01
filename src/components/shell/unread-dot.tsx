import { cn } from "@/lib/utils";

/** A dot for お知らせ not seen yet, and their number said for screen readers. */
export function UnreadDot({ count, className }: { count: number; className?: string }) {
  return (
    <>
      <span className={cn("size-2 shrink-0 rounded-full bg-primary", className)} aria-hidden />
      <span className="sr-only">（未読 {count} 件）</span>
    </>
  );
}
