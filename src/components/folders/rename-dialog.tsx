"use client";

import { useEffect, useState } from "react";
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
  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = value.trim();
            if (trimmed.length > 0) void onSubmit(trimmed);
          }}
          className="space-y-4"
        >
          <Input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoFocus
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
