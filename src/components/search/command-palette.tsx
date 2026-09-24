"use client";

import { FilePlus2, FolderPlus, Lock, Search, Settings, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSearch } from "@/lib/hooks/use-search";
import { useWorkspace } from "@/lib/hooks/workspace";
import { createFolder, createNote } from "@/lib/sync/mutations";
import { t } from "@/lib/i18n/ja";

/**
 * Search and the common actions behind one shortcut.
 *
 * Everything it searches is already on the device, so it answers instantly and
 * works with no network.
 */
export function CommandPalette() {
  const router = useRouter();
  const { selection, navigate } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { hits } = useSearch(query);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const run = (action: () => void | Promise<void>) => {
    setOpen(false);
    void action();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className="top-1/4 translate-y-0 overflow-hidden rounded-xl! p-0 sm:max-w-lg"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{t.nav.search}</DialogTitle>
          <DialogDescription>メモを探す、または操作を選ぶ</DialogDescription>
        </DialogHeader>
        {/* Results already come from the local index, ranked; cmdk must not
            re-rank or hide them. */}
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="メモを検索、または操作を入力"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>{t.empty.noResults}</CommandEmpty>

            {hits.length > 0 ? (
              <CommandGroup heading="メモ">
                {hits.slice(0, 8).map((hit) => (
                  <CommandItem
                    key={hit.noteId}
                    value={hit.noteId}
                    onSelect={() => run(() => navigate({ noteId: hit.noteId }))}
                  >
                    {hit.locked ? <Lock className="size-4 opacity-70" aria-hidden /> : null}
                    <span className="truncate">{hit.title || "無題のメモ"}</span>
                    {hit.folderName ? (
                      <span className="ml-auto truncate text-xs text-muted-foreground">
                        {hit.folderName}
                      </span>
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}

            <CommandSeparator />

            <CommandGroup heading="操作">
              <CommandItem
                value="new-note"
                onSelect={() =>
                  run(async () =>
                    navigate({ noteId: await createNote({ folderId: selection.folderId }) }),
                  )
                }
              >
                <FilePlus2 className="size-4 opacity-70" aria-hidden />
                {t.action.newNote}
              </CommandItem>
              <CommandItem
                value="new-folder"
                onSelect={() =>
                  run(async () => {
                    const id = await createFolder({ parentId: null, name: "新しいフォルダ" });
                    navigate({ folderId: id, noteId: null });
                  })
                }
              >
                <FolderPlus className="size-4 opacity-70" aria-hidden />
                {t.action.addFolder}
              </CommandItem>
              <CommandItem value="search" onSelect={() => run(() => router.push("/app/search"))}>
                <Search className="size-4 opacity-70" aria-hidden />
                {t.nav.search}
              </CommandItem>
              <CommandItem value="trash" onSelect={() => run(() => router.push("/app/trash"))}>
                <Trash2 className="size-4 opacity-70" aria-hidden />
                {t.nav.trash}
              </CommandItem>
              <CommandItem
                value="settings"
                onSelect={() => run(() => router.push("/app/settings"))}
              >
                <Settings className="size-4 opacity-70" aria-hidden />
                {t.nav.settings}
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
