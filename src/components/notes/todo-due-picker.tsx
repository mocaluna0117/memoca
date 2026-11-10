"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { NEEDS_TIME, NONE, TIMINGS, TIMING_CHIP, type Timing } from "@/lib/notify/reminders";
import { dayOf, dueOf, formatDue, readDue } from "@/lib/quick/todo-due";
import { cn } from "@/lib/utils";

const WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"];
const NAMES = ["日", "月", "火", "水", "木", "金", "土"];

/** The times a due is most often given, a touch each: 正午, and the end of a day among them. */
const TIMES = [
  { label: "9:00", time: "09:00" },
  { label: "12:00", time: "12:00" },
  { label: "18:00", time: "18:00" },
  { label: "23:59", time: "23:59" },
];

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
 * An item's due picked: a day (今日, 明日 and a week on at a touch, or from
 * the month shown), and a time if wanted (a touch for the usual ones, or
 * written), or none. Each is set as it is picked, and the picker stays
 * open for the other, saying what the due is now, until 完了 (or Enter, Esc,
 * a click beside it). Beside `at`, the item's button.
 *
 * What it shows is its own, from the due it opened with and what is picked
 * since: the item's due, as the editor has it, is not read again while it is
 * open, and a time written in, shown from that, went back to what it was as
 * each was set (a wheel's, on a phone, at every turn).
 */
export function TodoDuePicker({
  due,
  at,
  onPick,
  onClose,
  notify,
  defaults,
  onNotify,
}: {
  due: string | null;
  at: DOMRect;
  /** The due picked: null for none. */
  onPick: (due: string | null) => void;
  onClose: () => void;
  /** The item's own reminders: none at all, its own times, or (null) the account's. */
  notify: Timing[] | typeof NONE | null;
  /** The account's times, as the item has them unless it has its own. */
  defaults: Timing[];
  /** Its own chosen: null for the account's again. */
  onNotify: (own: Timing[] | typeof NONE | null) => void;
}) {
  const [now] = useState(() => new Date());
  const today = daysAfter(now, 0);
  const [current, setCurrent] = useState<string | null>(() => (readDue(due) ? due : null));
  const read = readDue(current);
  const [month, setMonth] = useState(() => {
    const shown = read?.day ?? today;
    return new Date(shown.getFullYear(), shown.getMonth(), 1);
  });
  const time = read?.time ?? null;
  /** Sets the due, here and on the item. */
  const pick = (next: string | null) => {
    setCurrent(next);
    onPick(next);
  };
  const pickDay = (day: Date) => {
    pick(dueOf(day, time));
    if (day.getMonth() !== month.getMonth() || day.getFullYear() !== month.getFullYear()) {
      setMonth(new Date(day.getFullYear(), day.getMonth(), 1));
    }
  };
  /** A time, on the day picked (today, if none is yet); none, the day alone. */
  const pickTime = (next: string | null) => {
    if (!next && !read) return;
    pick(dueOf(read?.day ?? today, next));
  };
  const quick = [
    { label: "今日", day: today },
    { label: "明日", day: daysAfter(today, 1) },
    { label: "1 週間後", day: daysAfter(today, 7) },
  ];
  // Larger to touch on a phone, and 16 pixels of text in its field, or iOS
  // zooms the page in as it is touched.
  const chip =
    "h-7 flex-1 px-2 text-xs pointer-coarse:h-9 pointer-coarse:text-sm aria-pressed:border-primary aria-pressed:bg-primary/10";

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
        className="max-h-(--radix-popover-content-available-height) w-72 gap-2 overflow-y-auto"
        aria-label="期日"
        // Back to the editor, by whoever opened it: not to the anchor.
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <p className="text-sm font-medium" aria-live="polite" data-todo-due-now="">
          {current ? formatDue(current, now) : <span className="text-muted-foreground">期日なし</span>}
        </p>

        <div className="flex gap-1.5">
          {quick.map((each) => (
            <Button
              key={each.label}
              variant="outline"
              size="sm"
              className={chip}
              aria-pressed={read !== null && dayOf(read.day) === dayOf(each.day)}
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
          <p className="text-sm font-medium">
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

        <div className="flex flex-col gap-1.5 border-t pt-2">
          <div className="flex items-center gap-2">
            <label htmlFor="todo-due-time" className="text-xs text-muted-foreground">
              時刻
            </label>
            <input
              id="todo-due-time"
              type="time"
              value={time ?? ""}
              className="h-7 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-sm text-foreground pointer-coarse:h-9 pointer-coarse:text-base"
              onChange={(event) => pickTime(event.target.value || null)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  onClose();
                }
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 px-2 text-xs pointer-coarse:h-9"
              disabled={!time}
              onClick={() => pickTime(null)}
            >
              時刻なし
            </Button>
          </div>
          <div className="flex gap-1.5">
            {TIMES.map((each) => (
              <Button
                key={each.time}
                variant="outline"
                size="sm"
                className={cn(chip, "tabular-nums")}
                aria-pressed={time === each.time}
                onClick={() => pickTime(each.time)}
              >
                {each.label}
              </Button>
            ))}
          </div>
        </div>

        {current ? (
          <NotifyRow own={notify} defaults={defaults} timed={time !== null} chip={chip} onChange={onNotify} />
        ) : null}

        <div className="flex items-center justify-between border-t pt-2">
          {current ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-destructive hover:text-destructive pointer-coarse:h-9"
              onClick={() => {
                pick(null);
                onClose();
              }}
            >
              期日を消す
            </Button>
          ) : (
            <span />
          )}
          <Button size="sm" className="h-7 px-3 text-xs pointer-coarse:h-9" onClick={onClose}>
            完了
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * When the item is told of its due: as every item is (the account's times,
 * chosen at the Todo's bell), never, or at times of its own. What it shows
 * is its own, as the picker's due is.
 */
function NotifyRow({
  own: first,
  defaults,
  timed,
  chip,
  onChange,
}: {
  own: Timing[] | typeof NONE | null;
  defaults: Timing[];
  timed: boolean;
  chip: string;
  onChange: (own: Timing[] | typeof NONE | null) => void;
}) {
  const [own, setOwn] = useState(first);
  // Its own times shown, even with every one of them taken off (kept as none).
  const [choosing, setChoosing] = useState(Array.isArray(first));
  const mode = choosing ? "own" : own === NONE ? "none" : "default";
  const chosen = Array.isArray(own) ? own : [];
  const set = (next: Timing[] | typeof NONE | null) => {
    setOwn(next);
    onChange(next);
  };
  const modes = [
    { key: "default", label: "いつもどおり", pick: () => (setChoosing(false), set(null)) },
    { key: "none", label: "通知しない", pick: () => (setChoosing(false), set(NONE)) },
    {
      key: "own",
      label: "時刻を選ぶ",
      pick: () => {
        setChoosing(true);
        // From the account's, as the item had them.
        if (!Array.isArray(own)) set(defaults.filter((each) => timed || !NEEDS_TIME.has(each)));
      },
    },
  ] as const;
  const toggle = (timing: Timing) => {
    const next = chosen.includes(timing) ? chosen.filter((each) => each !== timing) : [...chosen, timing];
    set(TIMINGS.filter((each) => next.includes(each)));
  };
  return (
    <div className="flex flex-col gap-1.5 border-t pt-2" role="group" aria-label="通知">
      <p className="text-xs text-muted-foreground">通知</p>
      <div className="flex gap-1.5">
        {modes.map((each) => (
          <Button
            key={each.key}
            variant="outline"
            size="sm"
            className={chip}
            aria-pressed={mode === each.key}
            onClick={each.pick}
          >
            {each.label}
          </Button>
        ))}
      </div>
      {choosing ? (
        <div className="grid grid-cols-2 gap-1.5">
          {TIMINGS.map((timing) => (
            <Button
              key={timing}
              variant="outline"
              size="sm"
              className={chip}
              aria-pressed={chosen.includes(timing)}
              disabled={NEEDS_TIME.has(timing) && !timed}
              onClick={() => toggle(timing)}
            >
              {TIMING_CHIP[timing]}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
