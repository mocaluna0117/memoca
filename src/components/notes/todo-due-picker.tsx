"use client";

import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { dayOf, dueOf, readDue } from "@/lib/quick/todo-due";
import { cn } from "@/lib/utils";

const WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"];
const NAMES = ["日", "月", "火", "水", "木", "金", "土"];

/** Midnight of a day, so many days after `date`'s. */
const daysAfter = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

/** The days a month is shown with: from the Monday of its first week to the Sunday of its last, whole weeks. */
function monthDays(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = daysAfter(first, -((first.getDay() + 6) % 7));
  const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const end = daysAfter(last, (7 - last.getDay()) % 7);
  const days: Date[] = [];
  for (let day = start; day <= end; day = daysAfter(day, 1)) days.push(day);
  return days;
}

/**
 * An item's due picked: a day from the month shown (今日, 明日 and a week on
 * at a touch), a time if wanted, or none. A day picked puts it away; a time
 * keeps it open. Beside `at`, the item's button.
 */
export function TodoDuePicker({
  due,
  at,
  onPick,
  onClose,
}: {
  due: string | null;
  at: DOMRect;
  /** The due picked: null for none. */
  onPick: (due: string | null) => void;
  onClose: () => void;
}) {
  const read = readDue(due);
  const today = daysAfter(new Date(), 0);
  const [month, setMonth] = useState(() => {
    const shown = read?.day ?? today;
    return new Date(shown.getFullYear(), shown.getMonth(), 1);
  });
  const time = read?.time ?? null;
  const pickDay = (day: Date) => {
    onPick(dueOf(day, time));
    onClose();
  };
  const quick = [
    { label: "今日", day: today },
    { label: "明日", day: daysAfter(today, 1) },
    { label: "1 週間後", day: daysAfter(today, 7) },
  ];

  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <PopoverAnchor asChild>
        <span
          aria-hidden
          style={{ position: "fixed", left: at.left, top: at.top, width: at.width, height: at.height, pointerEvents: "none" }}
        />
      </PopoverAnchor>
      <PopoverContent
        align="end"
        collisionPadding={8}
        className="w-72 gap-2"
        aria-label="期日"
        // Back to the editor, by whoever opened it: not to the anchor.
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <div className="flex gap-1.5">
          {quick.map((each) => (
            <Button
              key={each.label}
              variant="outline"
              size="sm"
              className="h-7 flex-1 px-2 text-xs"
              onClick={() => pickDay(each.day)}
            >
              {each.label}
            </Button>
          ))}
        </div>

        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="前の月"
            onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
          >
            <ChevronLeft aria-hidden />
          </Button>
          <p className="text-sm font-medium" aria-live="polite">
            {month.getFullYear()}年{month.getMonth() + 1}月
          </p>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="次の月"
            onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
          >
            <ChevronRight aria-hidden />
          </Button>
        </div>

        <div className="grid grid-cols-7 gap-0.5 text-center text-xs">
          {WEEKDAYS.map((name) => (
            <span key={name} className="py-1 text-muted-foreground" aria-hidden>
              {name}
            </span>
          ))}
          {monthDays(month).map((day) => {
            const key = dayOf(day);
            const picked = read !== null && key === dayOf(read.day);
            const isToday = key === dayOf(today);
            const inMonth = day.getMonth() === month.getMonth();
            return (
              <button
                key={key}
                type="button"
                aria-label={`${day.getMonth() + 1}月${day.getDate()}日（${NAMES[day.getDay()]}）`}
                aria-pressed={picked}
                onClick={() => pickDay(day)}
                className={cn(
                  "h-8 rounded-md text-sm tabular-nums hover:bg-accent",
                  !inMonth && "text-muted-foreground/50",
                  isToday && !picked && "ring-1 ring-primary/60",
                  picked && "bg-primary text-primary-foreground hover:bg-primary/90",
                )}
              >
                {day.getDate()}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 border-t pt-2">
          <label className="flex flex-1 items-center gap-2 text-xs text-muted-foreground">
            時刻
            <input
              type="time"
              value={time ?? ""}
              aria-label="時刻"
              className="h-7 flex-1 rounded-md border bg-transparent px-2 text-sm text-foreground"
              onChange={(event) => {
                const value = event.target.value;
                onPick(dueOf(read?.day ?? today, value || null));
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") onClose();
              }}
            />
          </label>
          {time ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="時刻をなしにする"
              onClick={() => read && onPick(dueOf(read.day, null))}
            >
              <X aria-hidden />
            </Button>
          ) : null}
        </div>

        <div className="flex items-center justify-between">
          {read ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-destructive hover:text-destructive"
              onClick={() => {
                onPick(null);
                onClose();
              }}
            >
              期日を消す
            </Button>
          ) : (
            <span />
          )}
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onClose}>
            閉じる
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
