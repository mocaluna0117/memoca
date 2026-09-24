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
import type { FolderNode } from "@/lib/types";
import { cn } from "@/lib/utils";

type ShellContextValue = { openDrawer: () => void; requestLock: (f: FolderNode) => void };
const ShellContext = createContext<ShellContextValue>({
  openDrawer: () => {},
  requestLock: () => {},
});

export const useShell = () => useContext(ShellContext);

export function AppShell({
  children,
  onRequestFolderLock,
}: {
  children: ReactNode;
  onRequestFolderLock?: (folder: FolderNode) => void;
}) {
  const { selection, openFolder } = useWorkspace();
  const [drawer, setDrawer] = useState(false);
  const [drawerElement, setDrawerElement] = useState<HTMLDivElement | null>(null);

  const value = useMemo<ShellContextValue>(
    () => ({
      openDrawer: () => setDrawer(true),
      requestLock: (folder) => onRequestFolderLock?.(folder),
    }),
    [onRequestFolderLock],
  );

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
      <div className="flex min-h-dvh">
        <aside className="hidden w-64 shrink-0 border-r md:block">
          <div
            className="sticky top-0"
            style={{
              paddingTop: "env(safe-area-inset-top, 0px)",
              height: "calc(100dvh - env(safe-area-inset-top, 0px))",
            }}
          >
            <Sidebar
              selectedFolderId={selection.folderId}
              onSelectFolder={select}
              onRequestLock={onRequestFolderLock}
            />
          </div>
        </aside>

        <Sheet open={drawer} onOpenChange={setDrawer}>
          <SheetContent side="left" className="w-72 p-0" showCloseButton={false}>
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
                onRequestLock={onRequestFolderLock}
                onNavigate={() => setDrawer(false)}
                onClose={() => setDrawer(false)}
                menuContainer={drawerElement}
              />
            </div>
          </SheetContent>
        </Sheet>

        <main className="flex min-w-0 flex-1 flex-col pb-14 md:pb-0">{children}</main>
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
