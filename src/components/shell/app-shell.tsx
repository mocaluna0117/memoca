"use client";

import { Menu } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { MobileNav } from "@/components/shell/mobile-nav";
import { Sidebar } from "@/components/shell/sidebar";
import { SyncBadge } from "@/components/shell/sync-badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useWorkspace } from "@/lib/hooks/workspace";
import { cn } from "@/lib/utils";

type ShellContextValue = { openDrawer: () => void };
const ShellContext = createContext<ShellContextValue>({ openDrawer: () => {} });

export const useShell = () => useContext(ShellContext);

export function AppShell({ children }: { children: ReactNode }) {
  const { selection, openFolder } = useWorkspace();
  const [drawer, setDrawer] = useState(false);
  const [drawerElement, setDrawerElement] = useState<HTMLDivElement | null>(null);

  const value = useMemo<ShellContextValue>(() => ({ openDrawer: () => setDrawer(true) }), []);

  const select = useCallback(
    (folderId: string | null) => {
      openFolder(folderId);
      setDrawer(false);
    },
    [openFolder],
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
          beside it. */}
      <div className="flex min-h-dvh md:h-dvh md:overflow-clip">
        <aside className="hidden w-64 shrink-0 border-r md:block">
          <div className="h-full" style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}>
            <Sidebar
              selectedFolderId={selection.folderId}
              onSelectFolder={select}
            />
          </div>
        </aside>

        <Sheet open={drawer} onOpenChange={setDrawer}>
          <SheetContent
            side="left"
            className="w-72 p-0"
            showCloseButton={false}
            onEscapeKeyDown={(event) => {
              // Escape that cancels a rename, or an IME conversion, is not a
              // request to close the whole drawer.
              const target = event.target as HTMLElement | null;
              if (event.isComposing || target?.closest("[data-inline-rename]")) {
                event.preventDefault();
              }
            }}
          >
            <SheetTitle className="sr-only">メニュー</SheetTitle>
            <div
              ref={setDrawerElement}
              style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
              className="h-full"
            >
              <Sidebar
                selectedFolderId={selection.folderId}
                onSelectFolder={select}
                onCreatedFolder={selectWithoutClosing}
                onNavigate={() => setDrawer(false)}
                onClose={() => setDrawer(false)}
                menuContainer={drawerElement}
              />
            </div>
          </SheetContent>
        </Sheet>

        {/* The bottom bar is fixed, so the page ends above it, home indicator
            included. Pages other than the workspace scroll here on wide screens. */}
        <main className="flex min-w-0 flex-1 flex-col pb-[calc(3.5rem+env(safe-area-inset-bottom,0px))] md:min-h-0 md:overflow-y-auto md:overscroll-y-contain md:pb-0">
          {children}
        </main>
      </div>
      <MobileNav />
    </ShellContext.Provider>
  );
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
  return (
    <header
      className={cn(
        "bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky top-0 z-30 flex items-center gap-2 border-b px-2 py-2 backdrop-blur md:hidden",
        className,
      )}
      style={{ top: "env(safe-area-inset-top, 0px)" }}
    >
      <Button variant="ghost" size="icon" onClick={openDrawer} aria-label="メニューを開く">
        <Menu className="size-5" aria-hidden />
      </Button>
      <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h1>
      <SyncBadge />
      {actions}
    </header>
  );
}
