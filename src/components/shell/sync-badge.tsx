"use client";

import { Check, CloudOff, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { useSync } from "@/components/providers/sync-provider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useOutboxCount } from "@/lib/hooks/data";
import { t } from "@/lib/i18n/ja";
import { cn } from "@/lib/utils";

/** A quiet indicator: it only asks for attention when something is wrong. */
export function SyncBadge({ className }: { className?: string }) {
  const { status } = useSync();
  const pending = useOutboxCount();

  const busy = status.state === "syncing" || status.catchingUp || pending > 0;
  const Icon =
    status.state === "offline"
      ? CloudOff
      : status.state === "error"
        ? TriangleAlert
        : busy
          ? Loader2
          : Check;

  const label =
    status.state === "offline"
      ? t.sync.offline
      : status.state === "error"
        ? t.sync.error
        : pending > 0
          ? t.sync.pending(pending)
          : status.catchingUp
            ? t.sync.catchingUp
            : t.sync.idle;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="status"
          aria-live="polite"
          aria-label={label}
          className={cn(
            "text-muted-foreground inline-flex items-center gap-1.5 text-xs",
            status.state === "error" && "text-destructive",
            className,
          )}
        >
          <Icon
            className={cn("size-3.5", busy && Icon === Loader2 && "animate-spin")}
            aria-hidden
          />
          <span className="hidden sm:inline">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p>{label}</p>
        {status.lastSyncAt ? (
          <p className="text-muted-foreground mt-0.5 text-xs">
            最終同期 {new Date(status.lastSyncAt).toLocaleTimeString("ja-JP")}
          </p>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

export function SyncRetryButton() {
  const { engine } = useSync();
  return (
    <button
      type="button"
      onClick={() => engine()?.kick(0)}
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
    >
      <RefreshCw className="size-3.5" aria-hidden />
      {t.action.retry}
    </button>
  );
}
