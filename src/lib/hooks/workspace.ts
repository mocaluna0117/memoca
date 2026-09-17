"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";

export type Selection = {
  /** null = all notes, otherwise a folder id. */
  folderId: string | null;
  noteId: string | null;
};

/**
 * Selection lives in the URL so every view is linkable and the browser's back
 * button does the obvious thing, on desktop and on a phone alike.
 */
export function useWorkspace() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const selection = useMemo<Selection>(
    () => ({ folderId: params.get("f"), noteId: params.get("n") }),
    [params],
  );

  const navigate = useCallback(
    (next: Partial<Selection>, options: { replace?: boolean } = {}) => {
      const merged = { ...selection, ...next };
      const search = new URLSearchParams();
      if (merged.folderId) search.set("f", merged.folderId);
      if (merged.noteId) search.set("n", merged.noteId);
      const query = search.toString();
      const href = query ? `/app?${query}` : "/app";

      // The whole workspace is one route, so selecting a note is a URL change
      // and nothing more. Going through the router would make Next fetch the
      // route payload, which fails with no network and throws away the editor;
      // the History API keeps the link shareable and the back button working
      // while staying entirely offline-safe.
      if (typeof window !== "undefined" && window.location.pathname === "/app") {
        if (options.replace) window.history.replaceState(null, "", href);
        else window.history.pushState(null, "", href);
        return;
      }
      if (options.replace) router.replace(href);
      else router.push(href);
    },
    [router, selection],
  );

  const openFolder = useCallback(
    (folderId: string | null) => navigate({ folderId, noteId: null }),
    [navigate],
  );
  const openNote = useCallback((noteId: string | null) => navigate({ noteId }), [navigate]);
  const closeNote = useCallback(() => navigate({ noteId: null }), [navigate]);

  return { selection, navigate, openFolder, openNote, closeNote, pathname };
}
