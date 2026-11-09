"use client";

import { ListChecks, Plus, X } from "lucide-react";
import { useEffect, useRef } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tip } from "@/components/notes/quick-tip";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n/ja";
import { quickLines } from "@/lib/quick/text";
import { cn } from "@/lib/utils";

/** A tab as the strip shows it: what is in it, as far as it is known, and whether all of it is saved. */
export type QuickTab = {
  id: string;
  text: string;
  images: number;
  unsaved: boolean;
  /** The Todo's tab (lib/quick/todo): its own kind, always saved. */
  todo?: boolean;
};

/** A tab's name: its first line, or what it holds, or that it is new. */
export function tabName(tab: Pick<QuickTab, "text" | "images">): string {
  const first = quickLines(tab.text)[0]?.trim();
  if (first) return first;
  return tab.images > 0 ? t.quick.tabImages(tab.images) : t.quick.newTab;
}

/** Whether a tab holds anything to lose: written since it was last saved. */
export const holds = (tab: Pick<QuickTab, "unsaved">) => tab.unsaved;

/**
 * The quick note's tabs, as a text editor's are: each a draft of its own,
 * one shown. A tab is closed by its ×, there only while there are two or
 * more; + opens a new one, after the others. Scrolled sideways where they
 * do not fit (the window is as narrow as 320 pixels).
 */
export function QuickTabs({
  tabs,
  active,
  canOpen,
  onShow,
  onOpen,
  onClose,
  onOpenTodo,
}: {
  tabs: QuickTab[];
  active: string;
  /** Fewer than the most there may be. */
  canOpen: boolean;
  onShow: (id: string) => void;
  onOpen: () => void;
  onClose: (id: string) => void;
  /** The Todo's tab opened, or shown if it is open. */
  onOpenTodo: () => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  // A mouse's wheel turned over the tabs, more than fit, scrolls them
  // sideways: only a trackpad (or Shift and the wheel) could, and with a
  // mouse alone the tabs out of sight were out of reach. A sideways swipe,
  // and Shift with the wheel, are left to the browser, which scrolls them
  // already. Not passive, to keep the turn from going on to the page.
  useEffect(() => {
    const element = strip.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.shiftKey) return;
      if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      if (element.scrollWidth <= element.clientWidth) return;
      // In lines (Firefox's mouse) or pages, made pixels.
      const by =
        event.deltaMode === 1
          ? event.deltaY * 16
          : event.deltaMode === 2
            ? event.deltaY * element.clientWidth
            : event.deltaY;
      const before = element.scrollLeft;
      element.scrollLeft = before + by;
      if (element.scrollLeft !== before) event.preventDefault();
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);
  // The tab shown is in sight, one opened at the end included.
  useEffect(() => {
    strip.current
      ?.querySelector<HTMLElement>(`[data-quick-tab="${active}"]`)
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active, tabs.length]);

  return (
    <div className="flex items-end gap-1 bg-muted/40 px-2 pt-1.5">
      <div
        ref={strip}
        role="tablist"
        aria-label={t.quick.tabs}
        className="flex min-w-0 flex-1 [scrollbar-width:none] items-end gap-0.5 overflow-x-auto"
      >
        {tabs.map((tab) => {
          const selected = tab.id === active;
          const name = tabName(tab);
          return (
            <div
              key={tab.id}
              data-quick-tab={tab.id}
              className={cn(
                "group flex max-w-40 min-w-0 shrink-0 items-center rounded-t-md border border-b-0 text-xs",
                selected
                  ? "bg-background text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-background/60",
              )}
            >
              <Tip label={name}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => onShow(tab.id)}
                  className="min-w-0 truncate py-1.5 pr-1 pl-2.5 text-left outline-none focus-visible:underline"
                >
                  {tab.todo ? (
                    <ListChecks className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />
                  ) : null}
                  {name}
                </button>
              </Tip>
              {tabs.length > 1 ? (
                <Tip label={t.quick.closeTabTip}>
                  <button
                    type="button"
                    aria-label={t.quick.closeTab(name)}
                    onClick={() => onClose(tab.id)}
                    className={cn(
                      "mr-1 flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-muted",
                      selected
                        ? "opacity-70"
                        : "opacity-0 group-hover:opacity-70 focus-visible:opacity-70 pointer-coarse:opacity-70",
                    )}
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </Tip>
              ) : (
                <span className="w-1.5" aria-hidden />
              )}
            </div>
          );
        })}
      </div>
      <Tip label={t.quick.openTab}>
        <Button
          variant="ghost"
          size="icon"
          className="mb-0.5 size-7 shrink-0"
          aria-label={t.quick.openTab}
          disabled={!canOpen}
          onClick={onOpen}
        >
          <Plus className="size-4" aria-hidden />
        </Button>
      </Tip>
      <Tip label={t.quick.openTodo}>
        <Button
          variant="ghost"
          size="icon"
          className="mb-0.5 size-7 shrink-0"
          aria-label={t.quick.openTodo}
          aria-pressed={tabs.some((tab) => tab.todo && tab.id === active)}
          onClick={onOpenTodo}
        >
          <ListChecks className="size-4" aria-hidden />
        </Button>
      </Tip>
    </div>
  );
}

/**
 * Asked before a tab with something in it is closed, as a text editor asks:
 * saved first (as a quick note is, into Inbox), or let go of, or kept.
 */
export function CloseTabDialog({
  name,
  open,
  onSave,
  onDiscard,
  onCancel,
}: {
  name: string;
  open: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t.quick.closeTitle}</AlertDialogTitle>
          <AlertDialogDescription>{t.quick.closeBody(name)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t.action.cancel}</AlertDialogCancel>
          <Button variant="outline" onClick={onDiscard}>
            {t.quick.closeDiscard}
          </Button>
          <Button onClick={onSave}>{t.quick.closeSave}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
