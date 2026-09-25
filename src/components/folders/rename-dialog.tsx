"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n/ja";

export function RenameDialog({
  open,
  title,
  initialValue,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  title: string;
  initialValue: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (value: string) => Promise<void> | void;
}) {
  const [value, setValue] = useState(initialValue);
  const field = useRef<HTMLInputElement>(null);
  // Re-seed when the dialog opens. Adjusting state during render is the
  // documented way to derive from props without an extra render pass.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setValue(initialValue);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-sm"
        // Start in the field with the old name selected, so typing replaces it
        // and Enter saves without reaching for the mouse.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          field.current?.focus();
          field.current?.select();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = value.trim();
            if (trimmed.length === 0) return;
            // A failure must say so, not leave the dialog sitting there.
            void Promise.resolve(onSubmit(trimmed)).catch(() =>
              toast.error("名前を変更できませんでした。もう一度お試しください。"),
            );
          }}
          className="space-y-4"
        >
          <Input
            ref={field}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            enterKeyHint="done"
            maxLength={120}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t.action.cancel}
            </Button>
            <Button type="submit" disabled={value.trim().length === 0}>
              {t.action.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
