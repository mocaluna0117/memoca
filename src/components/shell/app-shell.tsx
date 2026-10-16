"use client";

import { Menu, PanelLeftOpen } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FolderDrawer } from "@/components/shell/folder-drawer";
import { MobileNav } from "@/components/shell/mobile-nav";
import { PANE_WIDTH_CLASS, PaneResizer, paneWidthStyle } from "@/components/shell/pane-resizer";
import { Sidebar } from "@/components/shell/sidebar";
import { SyncBadge } from "@/components/shell/sync-badge";
import { UnreadDot } from "@/components/shell/unread-dot";
import { Button } from "@/components/ui/button";
import { useDrawerSwipe } from "@/lib/hooks/use-drawer-swipe";
import { useUnreadNews } from "@/lib/hooks/use-news";
import { SIDEBAR, usePaneWidth } from "@/lib/hooks/use-pane-width";
import { isSidebarKey, useSidebarShown } from "@/lib/hooks/use-sidebar-shown";
import { useModKeyLabel } from "@/lib/platform";
import { useWorkspace } from "@/lib/hooks/workspace";
import { cn } from "@/lib/utils";

type ShellContextValue = {
  /** Opens the folder drawer; focus goes back to `opener` when it closes. */
  openDrawer: (opener?: HTMLElement | null) => void;
};
const ShellContext = createContext<ShellContextValue>({ openDrawer: () => {} });

export const useShell = () => useContext(ShellContext);

export function AppShell({ children }: { children: ReactNode }) {
  const { selection, navigate, openFolder, openPinned } = useWorkspace();
  const drawer = useDrawerSwipe();
  const unreadNews = useUnreadNews();
  const [sidebarWidth] = usePaneWidth(SIDEBAR);
  const { show: showDrawer, hide: hideDrawer, areaRef, pageRef, barRef } = drawer;
  const [drawerElement, setDrawerElement] = useState<HTMLDivElement | null>(null);
  const {
    shown: sidebarShown,
    hide: hideSidebar,
    show: showSidebar,
    shortcut: sidebarShortcut,
    asideRef,
    railRef,
  } = useSidebarShownHere();

  const value = useMemo<ShellContextValue>(() => ({ openDrawer: showDrawer }), [showDrawer]);

  const select = useCallback(
    (folderId: string | null) => {
      openFolder(folderId);
      hideDrawer();
    },
    [openFolder, hideDrawer],
  );

  const selectPinned = useCallback(() => {
    openPinned();
    hideDrawer();
  }, [openPinned, hideDrawer]);

  // A note of the tree opens in its folder: one kept in the sidebar, in no
  // folder, over every note's list. Null closes the one open.
  const openNoteHere = useCallback(
    (noteId: string | null, folderId: string | null = null) => {
      if (noteId === null) navigate({ noteId: null });
      else navigate({ folderId, pinned: false, noteId });
      hideDrawer();
    },
    [navigate, hideDrawer],
  );

  const selectWithoutClosing = useCallback(
    (folderId: string) => openFolder(folderId),
    [openFolder],
  );

  return (
    <ShellContext.Provider value={value}>
      {/* On a phone the page itself scrolls, which is what iOS expects while
          typing. On wider screens the shell is exactly one screen tall and
          each pane scrolls on its own, so a long note does not move the list
          beside it. Clipped sideways so the page moving aside for the phone's
          drawer never makes the document wider than the screen. On a phone a
          swipe right anywhere here opens the folder drawer. */}
      <div ref={areaRef} className="flex min-h-dvh overflow-x-clip md:h-dvh md:overflow-clip">
        {/* Its width as set on this device, but never so wide that a narrow
            window has no room left for the note. */}
        {/* Put away, it stays mounted (its folders open as they were), and
            leaves a rail with the one way back, on every page. */}
        <aside
          ref={asideRef}
          id={SIDEBAR.id}
          className={cn(
            "relative hidden w-64 shrink-0 border-r",
            sidebarShown && "md:block",
            PANE_WIDTH_CLASS,
          )}
          style={paneWidthStyle(SIDEBAR, sidebarWidth)}
        >
          <div className="h-full" style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}>
            <Sidebar
              selectedFolderId={selection.folderId}
              onSelectFolder={select}
              pinnedSelected={selection.pinned}
              onSelectPinned={selectPinned}
              selectedNoteId={selection.noteId}
              onOpenNote={openNoteHere}
              onHide={hideSidebar}
              hideShortcut={sidebarShortcut}
            />
          </div>
          <PaneResizer pane={SIDEBAR} label="サイドバーの幅" />
        </aside>
        {sidebarShown ? null : (
          <div className="hidden w-11 shrink-0 flex-col items-center border-r py-2 md:flex">
            <Button
              ref={railRef}
              variant="ghost"
              size="icon"
              className="relative"
              onClick={showSidebar}
              aria-label={
                unreadNews > 0
                  ? `サイドバーを開く（お知らせ 未読 ${unreadNews} 件）`
                  : "サイドバーを開く"
              }
              title={`サイドバーを開く（${sidebarShortcut}）`}
            >
              <PanelLeftOpen className="size-4" aria-hidden />
              {/* お知らせ not seen yet: in the sidebar, out of sight. */}
              {unreadNews > 0 ? (
                <UnreadDot
                  count={unreadNews}
                  className="absolute top-0.5 right-0.5 ring-2 ring-background"
                />
              ) : null}
            </Button>
          </div>
        )}

        <FolderDrawer drawer={drawer} containerRef={setDrawerElement}>
          <Sidebar
            selectedFolderId={selection.folderId}
            onSelectFolder={select}
            pinnedSelected={selection.pinned}
            onSelectPinned={selectPinned}
            onCreatedFolder={selectWithoutClosing}
            selectedNoteId={selection.noteId}
            onOpenNote={openNoteHere}
            onNavigate={hideDrawer}
            onClose={hideDrawer}
            menuContainer={drawerElement}
          />
        </FolderDrawer>

        {/* The bottom bar is fixed, so the page ends above it, home indicator
            included. Pages other than the workspace scroll here on wide screens.
            It moves aside with the phone's folder drawer, and data-drawer tells
            what is fixed inside that it may move. */}
        <main
          ref={pageRef}
          data-drawer={drawer.mounted ? "" : undefined}
          className="flex min-w-0 flex-1 flex-col pb-[calc(3.5rem+env(safe-area-inset-bottom,0px))] md:min-h-0 md:overflow-y-auto md:overscroll-y-contain md:pb-0"
        >
          {children}
        </main>
      </div>
      <MobileNav ref={barRef} />
    </ShellContext.Provider>
  );
}

/**
 * The sidebar put away and brought back, on a computer's screen: by its own
 * button and the rail's, or ⌘\ (Ctrl+\). Focus in the sidebar as it goes
 * goes to the rail's button, and from there back to the sidebar's.
 */
function useSidebarShownHere() {
  const [shown, setShown] = useSidebarShown();
  const shortcut = `${useModKeyLabel()}\\`;
  const asideRef = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLButtonElement>(null);
  const focusTo = useRef<"rail" | "sidebar" | null>(null);

  const hide = useCallback(() => {
    if (asideRef.current?.contains(document.activeElement)) focusTo.current = "rail";
    setShown(false);
  }, [setShown]);
  const show = useCallback(() => {
    if (railRef.current === document.activeElement) focusTo.current = "sidebar";
    setShown(true);
  }, [setShown]);

  useEffect(() => {
    const to = focusTo.current;
    focusTo.current = null;
    if (to === "rail") railRef.current?.focus();
    else if (to === "sidebar") {
      asideRef.current?.querySelector<HTMLElement>("[data-sidebar-hide]")?.focus();
    }
  }, [shown]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Only where there is a sidebar to put away: a phone has its drawer.
      if (!isSidebarKey(event) || !window.matchMedia("(min-width: 768px)").matches) return;
      event.preventDefault();
      if (shown) hide();
      else show();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, hide, show]);

  return { shown, hide, show, shortcut, asideRef, railRef };
}

/** Page header for phones: opens the folder drawer and shows the title. */
export function MobileHeader({
  title,
  actions,
  className,
}: {
  title: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const { openDrawer } = useShell();
  const unreadNews = useUnreadNews();
  return (
    <header
      className={cn(
        "sticky top-0 z-30 flex items-center gap-2 border-b bg-background/95 px-2 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:hidden",
        className,
      )}
      style={{ top: "env(safe-area-inset-top, 0px)" }}
    >
      <Button
        variant="ghost"
        size="icon"
        onClick={(event) => openDrawer(event.currentTarget)}
        aria-label={
          unreadNews > 0 ? `メニューを開く（お知らせ 未読 ${unreadNews} 件）` : "メニューを開く"
        }
        className="relative"
      >
        <Menu className="size-5" aria-hidden />
        {/* お知らせ not seen yet: in the menu, which is where they are on a phone. */}
        {unreadNews > 0 ? (
          <UnreadDot
            count={unreadNews}
            className="absolute top-0.5 right-0.5 ring-2 ring-background"
          />
        ) : null}
      </Button>
      <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h1>
      <SyncBadge />
      {actions}
    </header>
  );
}
