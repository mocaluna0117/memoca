"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  FileText,
  FolderPlus,
  Search,
  Settings,
  Shield,
  Trash2,
} from "lucide-react";
import { useSync } from "@/components/providers/sync-provider";
import { FolderTree } from "@/components/folders/folder-tree";
import { SyncBadge } from "@/components/shell/sync-badge";
import { QuotaBar } from "@/components/shell/quota-bar";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { createFolder } from "@/lib/sync/mutations";
import type { FolderNode } from "@/lib/types";
import { t } from "@/lib/i18n/ja";
import { cn } from "@/lib/utils";

type Props = {
  selectedFolderId: string | null;
  onSelectFolder: (folderId: string | null) => void;
  onRequestLock?: (folder: FolderNode) => void;
  onNavigate?: () => void;
  /** Portal target for row menus; set only inside the mobile drawer. */
  menuContainer?: HTMLElement | null;
};

export function Sidebar({
  selectedFolderId,
  onSelectFolder,
  onRequestLock,
  onNavigate,
  menuContainer,
}: Props) {
  const { me } = useSync();
  const pathname = usePathname();

  const links = [
    { href: "/app/search", label: t.nav.search, icon: Search },
    { href: "/app/trash", label: t.nav.trash, icon: Trash2 },
    { href: "/app/settings", label: t.nav.settings, icon: Settings },
    ...(me?.role === "admin"
      ? [{ href: "/app/admin", label: t.nav.admin, icon: Shield }]
      : []),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-3">
        <Link href="/app" className="text-sm font-semibold tracking-tight">
          {t.app.name}
        </Link>
        <SyncBadge />
      </div>

      <div className="px-2">
        <button
          type="button"
          onClick={() => {
            onSelectFolder(null);
            onNavigate?.();
          }}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm",
            selectedFolderId === null && pathname === "/app"
              ? "bg-accent text-accent-foreground"
              : "hover:bg-accent/60",
          )}
        >
          <FileText className="size-4 opacity-70" aria-hidden />
          {t.nav.allNotes}
        </button>
      </div>

      <Separator className="my-2" />

      <ScrollArea className="min-h-0 flex-1 px-2">
        <FolderTree
          selectedFolderId={selectedFolderId}
          onSelect={(id) => {
            onSelectFolder(id);
            onNavigate?.();
          }}
          onRequestLock={onRequestLock}
          menuContainer={menuContainer}
        />
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground mt-1 w-full justify-start gap-2"
          onClick={async () => {
            const id = await createFolder({ parentId: null, name: "新しいフォルダ" });
            onSelectFolder(id);
            onNavigate?.();
          }}
        >
          <FolderPlus className="size-4" aria-hidden />
          {t.action.newFolder}
        </Button>
      </ScrollArea>

      <Separator className="my-2" />

      <nav className="flex flex-col gap-0.5 px-2">
        {links.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
              pathname === href
                ? "bg-accent text-accent-foreground"
                : "hover:bg-accent/60",
            )}
          >
            <Icon className="size-4 opacity-70" aria-hidden />
            {label}
          </Link>
        ))}
      </nav>

      <div className="px-3 py-3">
        <QuotaBar />
      </div>
    </div>
  );
}
