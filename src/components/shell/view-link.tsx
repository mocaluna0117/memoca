"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { moveWithinWorkspace } from "@/lib/workspace-route";

/**
 * A link to a page of the workspace, followed in place (lib/workspace-route):
 * a click shows it at once, rather than once the server has answered. A
 * click that asks for a new tab or window is the browser's, as with any
 * link. Not fetched ahead: there is nothing of it to fetch.
 */
export function ViewLink({ href, onClick, ...props }: ComponentProps<typeof Link> & { href: string }) {
  return (
    <Link
      href={href}
      prefetch={false}
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (moveWithinWorkspace(href)) event.preventDefault();
      }}
    />
  );
}
