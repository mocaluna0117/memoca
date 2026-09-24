"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A name edited in place, the way a file explorer does it.
 *
 * Enter saves and Escape cancels, and both hand focus back to the row so the
 * next key works on it again. Clicking away saves too, but leaves focus where
 * the click put it. An empty or unchanged name saves nothing.
 */
export function InlineRename({
  initialValue,
  label,
  placeholder,
  onSubmit,
  onDone,
  className,
}: {
  initialValue: string;
  label: string;
  placeholder?: string;
  onSubmit: (value: string) => Promise<void> | void;
  /** Runs once editing ends; `byKeyboard` is true for Enter and Escape. */
  onDone: (byKeyboard: boolean) => void;
  className?: string;
}) {
  const [value, setValue] = useState(initialValue);
  const field = useRef<HTMLInputElement>(null);
  // Enter unmounts the field, and unmounting can blur it: without this the
  // same edit would be saved twice.
  const finished = useRef(false);

  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  const finish = (save: boolean, byKeyboard: boolean) => {
    if (finished.current) return;
    finished.current = true;
    const next = value.trim();
    if (save && next.length > 0 && next !== initialValue) void onSubmit(next);
    onDone(byKeyboard);
  };

  return (
    <input
      ref={field}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        // The Enter that confirms a kana-to-kanji conversion belongs to the
        // IME. Safari reports it with isComposing already false but as 229.
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        // Keys typed into a name are not commands for the row underneath.
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true, true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(false, true);
        }
      }}
      onBlur={() => finish(true, false)}
      // Lets a surrounding dialog tell that Escape here means "stop renaming",
      // not "close". Dialogs see the key before this field does.
      data-inline-rename=""
      aria-label={label}
      placeholder={placeholder}
      maxLength={120}
      enterKeyHint="done"
      autoComplete="off"
      spellCheck={false}
      className={cn(
        "bg-background ring-ring min-w-0 flex-1 rounded-sm px-1 text-sm outline-none ring-1",
        className,
      )}
    />
  );
}
