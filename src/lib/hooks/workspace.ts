"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo } from "react";
import { useSelectionStore } from "@/lib/store/selection";

export type Selection = {
  /** null = all notes (or, `pinned`, the pinned ones), otherwise a folder id. */
  folderId: string | null;
  noteId: string | null;
  /** The pinned notes, of every folder: the list shown, with no folder. */
  pinned: boolean;
};

function hrefFor(selection: Selection): string {
  const search = new URLSearchParams();
  if (selection.folderId) search.set("f", selection.folderId);
  else if (selection.pinned) search.set("v", "pinned");
  if (selection.noteId) search.set("n", selection.noteId);
  const query = search.toString();
  return query ? `/app?${query}` : "/app";
}

/**
 * What is currently selected, and how to change it.
 *
 * Selection lives in a store so a change takes effect in the same commit as
 * the click, and the URL is updated alongside it so every view stays linkable
 * and the back button still works.
 */
export function useWorkspace() {
  const params = useSearchParams();
  const router = useRouter();
  const folderId = useSelectionStore((s) => s.folderId);
  const noteId = useSelectionStore((s) => s.noteId);
  const pinned = useSelectionStore((s) => s.pinned);
  const apply = useSelectionStore((s) => s.apply);

  const urlFolder = params.get("f");
  const urlNote = params.get("n");
  const urlPinned = !urlFolder && params.get("v") === "pinned";

  // Follow the URL when it changes from outside this hook: a first load, the
  // back button, or a link from another screen.
  useEffect(() => {
    apply({ folderId: urlFolder, noteId: urlNote, pinned: urlPinned });
  }, [urlFolder, urlNote, urlPinned, apply]);

  const selection = useMemo<Selection>(
    () => ({ folderId, noteId, pinned }),
    [folderId, noteId, pinned],
  );

  const navigate = useCallback(
    (next: Partial<Selection>, options: { replace?: boolean } = {}) => {
      const merged = { ...useSelectionStore.getState(), ...next };
      const target = {
        folderId: merged.folderId,
        noteId: merged.noteId,
        // A folder is not the pinned notes.
        pinned: merged.folderId === null && merged.pinned,
      };
      // State first, so the interface has already switched by the time the
      // next keystroke arrives.
      apply(target);

      const href = hrefFor(target);
      // The whole workspace is one route, so this is a URL change and nothing
      // more. Going through the router would make Next fetch the route
      // payload, which fails with no network and throws away the editor.
      if (typeof window !== "undefined" && window.location.pathname === "/app") {
        if (options.replace) window.history.replaceState(null, "", href);
        else window.history.pushState(null, "", href);
        return;
      }
      if (options.replace) router.replace(href);
      else router.push(href);
    },
    [apply, router],
  );

  const openFolder = useCallback(
    (folder: string | null) => navigate({ folderId: folder, noteId: null, pinned: false }),
    [navigate],
  );
  /** The pinned notes, of every folder. */
  const openPinned = useCallback(
    () => navigate({ folderId: null, noteId: null, pinned: true }),
    [navigate],
  );
  const openNote = useCallback((note: string | null) => navigate({ noteId: note }), [navigate]);
  const closeNote = useCallback(() => navigate({ noteId: null }), [navigate]);

  return { selection, navigate, openFolder, openPinned, openNote, closeNote };
}
