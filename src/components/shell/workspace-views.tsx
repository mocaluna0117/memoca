"use client";

import { usePathname } from "next/navigation";
import { type ComponentType, Suspense, lazy, useEffect, useLayoutEffect, useRef } from "react";
import NotesView from "@/components/views/notes-view";
import { type WorkspaceView, workspaceView } from "@/lib/workspace-route";

type Loader = () => Promise<{ default: ComponentType }>;

/** What each page's code is fetched by: on its own, as each was a route of its own. */
const LOADERS = {
  search: () => import("@/components/views/search-view"),
  trash: () => import("@/components/views/trash-view"),
  settings: () => import("@/components/views/settings-view"),
  news: () => import("@/components/views/news-view"),
  help: () => import("@/components/views/help-view"),
  admin: () => import("@/components/views/admin-view"),
} satisfies Record<Exclude<WorkspaceView, "">, Loader>;

/**
 * A page whose code is fetched on its own: drawn at once once it has been
 * (see `fetchAll` below), rather than through React.lazy, which suspends
 * for a moment even for code already here, and showed the page only some
 * 800 ms after the click, the first time.
 */
function lazyView(load: Loader): { View: ComponentType; fetch: Loader } {
  let loaded: ComponentType | null = null;
  const fetch = () =>
    load().then((module) => {
      loaded = module.default;
      return module;
    });
  const Lazy = lazy(fetch);
  const View = () => {
    const Loaded = loaded;
    return Loaded ? <Loaded /> : <Lazy />;
  };
  return { View, fetch };
}

const LAZY = Object.fromEntries(
  Object.entries(LOADERS).map(([name, load]) => [name, lazyView(load)]),
) as Record<Exclude<WorkspaceView, "">, ReturnType<typeof lazyView>>;

const VIEWS: Record<WorkspaceView, ComponentType> = {
  "": NotesView,
  search: LAZY.search.View,
  trash: LAZY.trash.View,
  settings: LAZY.settings.View,
  news: LAZY.news.View,
  help: LAZY.help.View,
  admin: LAZY.admin.View,
};

/** The page's room, empty for the moment its code is fetched (once: see below). */
const Fetching = () => <div className="flex-1" />;

/**
 * The workspace's page the address names, drawn here: moving to another
 * changes the address alone (lib/workspace-route), and this follows it.
 * Each page's code is fetched once the notes are up, while nothing else is
 * going on, so that the first move to one waits for nothing either.
 */
export function WorkspaceViews() {
  const view = workspaceView(usePathname()) ?? "";
  const View = VIEWS[view];

  useEffect(() => {
    const fetchAll = () => {
      for (const { fetch } of Object.values(LAZY)) void fetch().catch(() => {});
    };
    if (typeof requestIdleCallback === "function") {
      const handle = requestIdleCallback(fetchAll, { timeout: 5000 });
      return () => cancelIdleCallback(handle);
    }
    const timer = setTimeout(fetchAll, 2000);
    return () => clearTimeout(timer);
  }, []);

  // Another page from its top, as a link to it showed it: the page on a
  // phone, the pane it is in on a wider screen. Within the notes, they look
  // after their own (where the list was left, and a note from its top).
  const shown = useRef(view);
  useLayoutEffect(() => {
    if (shown.current === view) return;
    shown.current = view;
    document.querySelector("main")?.scrollTo(0, 0);
    window.scrollTo(0, 0);
  }, [view]);

  // One boundary whatever the page, the same shape on the server as here.
  return (
    <Suspense fallback={<Fetching />}>
      <View />
    </Suspense>
  );
}
