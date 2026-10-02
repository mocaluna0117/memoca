"use client";

import { LayoutTemplate } from "lucide-react";
import { useEffect } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useTemplates } from "@/lib/hooks/data";
import { t } from "@/lib/i18n/ja";
import { noteName } from "@/lib/note-name";
import { prepareTemplates } from "@/lib/templates";

/**
 * Picks a template to make a new note from: the notes of the folder of
 * templates, searchable by name. Opened the first time, it makes that
 * folder, with a few to start from.
 */
export function TemplatePicker({
  open,
  onOpenChange,
  onPick,
  onEdit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (templateId: string) => void;
  /** Shows the folder of templates, where they are written. */
  onEdit: () => void;
}) {
  const templates = useTemplates();

  useEffect(() => {
    if (open) void prepareTemplates();
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="px-4 pt-4">
          <DialogTitle>{t.templates.pickTitle}</DialogTitle>
          <DialogDescription>{t.templates.pickHint}</DialogDescription>
        </DialogHeader>
        <Command>
          <CommandInput placeholder={t.templates.filter} />
          <CommandList className="max-h-72">
            <CommandEmpty>{t.templates.none}</CommandEmpty>
            <CommandGroup>
              {templates.map((template) => {
                const name = noteName(template.title, template.preview);
                return (
                  <CommandItem
                    key={template.noteId}
                    value={`${template.noteId} ${name.text}`}
                    onSelect={() => {
                      onOpenChange(false);
                      onPick(template.noteId);
                    }}
                  >
                    <LayoutTemplate className="size-4 opacity-70" aria-hidden />
                    <span className="truncate">{name.text}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
        <div className="border-t px-4 py-2 text-right">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onOpenChange(false);
              onEdit();
            }}
          >
            {t.templates.edit}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
