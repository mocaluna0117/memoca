"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  CalendarDays,
  FileText,
  FilePlus,
  FolderPlus,
  Megaphone,
  Pin,
  Search,
  Settings,
  Shield,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { useOpenQuickNote } from "@/components/notes/quick-entry";
import { useSync } from "@/components/providers/sync-provider";
import { FolderTree } from "@/components/folders/folder-tree";
import { SyncBadge } from "@/components/shell/sync-badge";
import { VaultBadge } from "@/components/vault/vault-badge";
import { QuotaBar } from "@/components/shell/quota-bar";
import { UnreadDot } from "@/components/shell/unread-dot";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useUnreadNews } from "@/lib/hooks/use-news";
import { useSidebarMode } from "@/lib/hooks/use-sidebar-mode";
import { JOURNAL_FOLDER_ID, createFolder, createNote } from "@/lib/sync/mutations";
import { dayOf, journalDay, openToday } from "@/lib/journal";
import { useWorkspace } from "@/lib/hooks/workspace";
import { t } from "@/lib/i18n/ja";
import { cn } from "@/lib/utils";

type Props = {
  selectedFolderId: string | null;
  onSelectFolder: (folderId: string | null) => void;
  /** The pinned notes, of every folder, are the list shown. */
  pinnedSelected: boolean;
  onSelectPinned: () => void;
  /** Selects a freshly created folder without dismissing the panel. */
  onCreatedFolder?: (folderId: string) => void;
  /** The note open, and how one of the tree is opened, in its folder (null: closed). */
  selectedNoteId?: string | null;
  onOpenNote?: (noteId: string | null, folderId?: string | null) => void;
  onNavigate?: () => void;
  /** Shows a close control in the header; set only inside the mobile drawer. */
  onClose?: () => void;
  /** Portal target for row menus; set only inside the mobile drawer. */
  menuContainer?: HTMLElement | null;
};

export function Sidebar({
  selectedFolderId,
  onSelectFolder,
  pinnedSelected,
  onSelectPinned,
  onCreatedFolder,
  selectedNoteId = null,
  onOpenNote,
  onNavigate,
  onClose,
  menuContainer,
}: Props) {
  const { me } = useSync();
  const pathname = usePathname();
  const openQuickNote = useOpenQuickNote();
  const { navigate } = useWorkspace();
  const [mode] = useSidebarMode();
  const todayOpen = selectedNoteId !== null && journalDay(selectedNoteId) === dayOf(new Date());

  const unreadNews = useUnreadNews();
  const links = [
    { href: "/app/search", label: t.nav.search, icon: Search },
    { href: "/app/trash", label: t.nav.trash, icon: Trash2 },
    { href: "/app/news", label: t.nav.news, icon: Megaphone },
    { href: "/app/settings", label: t.nav.settings, icon: Settings },
    ...(me?.role === "admin" ? [{ href: "/app/admin", label: t.nav.admin, icon: Shield }] : []),
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
          <VaultBadge compact container={menuContainer} />
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
        {/* On a phone the bottom bar has its own. */}
        <button
          type="button"
          onClick={openQuickNote}
          className="hidden w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/60 md:flex"
        >
          <Zap className="size-4 text-primary" aria-hidden />
          {t.nav.quick}
        </button>
        {/* Today's note, made the first time it is asked for each day (lib/journal). */}
        <button
          type="button"
          onClick={async () => {
            const noteId = await openToday();
            navigate({ folderId: JOURNAL_FOLDER_ID, pinned: false, noteId });
            onNavigate?.();
          }}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm",
            todayOpen && pathname === "/app"
              ? "bg-accent text-accent-foreground"
              : "hover:bg-accent/60",
          )}
        >
          <CalendarDays className="size-4 opacity-70" aria-hidden />
          今日のメモ
        </button>
        <button
          type="button"
          onClick={() => {
            onSelectFolder(null);
            onNavigate?.();
          }}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm",
            selectedFolderId === null && !pinnedSelected && pathname === "/app"
              ? "bg-accent text-accent-foreground"
              : "hover:bg-accent/60",
          )}
        >
          <FileText className="size-4 opacity-70" aria-hidden />
          {t.nav.allNotes}
        </button>
        <button
          type="button"
          onClick={() => {
            onSelectPinned();
            onNavigate?.();
          }}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm",
            pinnedSelected && pathname === "/app"
              ? "bg-accent text-accent-foreground"
              : "hover:bg-accent/60",
          )}
        >
          <Pin className="size-4 opacity-70" aria-hidden />
          {t.nav.pinned}
        </button>
      </div>

      <Separator className="my-2" />

      {/* A labelled section with its add button beside the label, where people
          look first, rather than trailing after however many folders exist. */}
      <div className="flex items-center justify-between gap-2 pr-2 pl-4">
        <h2 className="text-xs font-medium text-muted-foreground">{t.nav.folders}</h2>
        <div className="flex items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-foreground"
                aria-label={t.action.addNote}
                onClick={async () => {
                  // Kept in the sidebar, in no folder, after what is there,
                  // and opened to be written in.
                  const id = await createNote({ folderId: null, topLevel: true });
                  onOpenNote?.(id);
                }}
              >
                <FilePlus className="size-4" aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">{t.action.addNote}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground hover:text-foreground"
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
      </div>

      {/* Radix lays the tree out in a table, as wide as its widest row: made a
          block, a long name is cut short with … rather than running past the
          edge, however narrow the sidebar is set. */}
      <ScrollArea className="min-h-0 flex-1 px-2 pt-1 [&_[data-slot=scroll-area-viewport]>div]:!block">
        <FolderTree
          explorer={mode === "explorer"}
          selectedFolderId={selectedFolderId}
          onSelect={(id) => {
            onSelectFolder(id);
            onNavigate?.();
          }}
          onCreated={onCreatedFolder}
          selectedNoteId={selectedNoteId}
          onOpenNote={onOpenNote}
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
              pathname === href ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
            )}
          >
            <Icon className="size-4 opacity-70" aria-hidden />
            {label}
            {href === "/app/news" && unreadNews > 0 ? (
              <UnreadDot count={unreadNews} className="ml-auto" />
            ) : null}
          </Link>
        ))}
      </nav>

      <div className="px-3 py-3">
        <QuotaBar />
      </div>
    </div>
  );
}
