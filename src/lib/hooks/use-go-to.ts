"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { moveWithinWorkspace } from "@/lib/workspace-route";

/**
 * Goes to an address: within the workspace, in place, by the address alone
 * (lib/workspace-route); anywhere else, by the router.
 */
export function useGoTo(): (href: string, options?: { replace?: boolean }) => void {
  const router = useRouter();
  return useCallback(
    (href, { replace = false } = {}) => {
      if (moveWithinWorkspace(href, { replace })) return;
      if (replace) router.replace(href);
      else router.push(href);
    },
    [router],
  );
}
