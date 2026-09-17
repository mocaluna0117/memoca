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
