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
  X,
} from "lucide-react";
import { useSync } from "@/components/providers/sync-provider";
import { FolderTree } from "@/components/folders/folder-tree";
import { SyncBadge } from "@/components/shell/sync-badge";
import { QuotaBar } from "@/components/shell/quota-bar";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { createFolder } from "@/lib/sync/mutations";
import type { FolderNode } from "@/lib/types";
import { t } from "@/lib/i18n/ja";
import { cn } from "@/lib/utils";

type Props = {
  selectedFolderId: string | null;
  onSelectFolder: (folderId: string | null) => void;
  /** Selects a freshly created folder without dismissing the panel. */
  onCreatedFolder?: (folderId: string) => void;
  onRequestLock?: (folder: FolderNode) => void;
  onNavigate?: () => void;
  /** Shows a close control in the header; set only inside the mobile drawer. */
  onClose?: () => void;
  /** Portal target for row menus; set only inside the mobile drawer. */
  menuContainer?: HTMLElement | null;
};

export function Sidebar({
  selectedFolderId,
  onSelectFolder,
  onCreatedFolder,
  onRequestLock,
  onNavigate,
  onClose,
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
        {/* The close control shares the header row so it can never sit on top
            of the sync badge, and it moves down with the safe-area padding. */}
        <div className="flex items-center gap-1">
          <SyncBadge />
          {onClose ? (
            <Button
              variant="ghost"
              size="icon-sm"
              className="-mr-1"
              aria-label={t.action.close}
              onClick={onClose}
            >
              <X aria-hidden />
            </Button>
          ) : null}
        </div>
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

      {/* A labelled section with its add button beside the label, where people
          look first, rather than trailing after however many folders exist. */}
      <div className="flex items-center justify-between gap-2 pr-2 pl-4">
        <h2 className="text-muted-foreground text-xs font-medium">{t.nav.folders}</h2>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground size-7"
              aria-label={t.action.addFolder}
              onClick={async () => {
                const id = await createFolder({ parentId: null, name: "新しいフォルダ" });
                // Stay put: the next thing anyone does with a new folder is
                // rename it, and that control is right here.
                (onCreatedFolder ?? onSelectFolder)(id);
              }}
            >
              <FolderPlus className="size-4" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{t.action.addFolder}</TooltipContent>
        </Tooltip>
      </div>

      <ScrollArea className="min-h-0 flex-1 px-2 pt-1">
        <FolderTree
          selectedFolderId={selectedFolderId}
          onSelect={(id) => {
            onSelectFolder(id);
            onNavigate?.();
          }}
          onRequestLock={onRequestLock}
          onCreated={onCreatedFolder}
          menuContainer={menuContainer}
        />
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
