"use client";

import { Check, CloudOff, Loader2, Lock, RefreshCw, TriangleAlert } from "lucide-react";
import { type ComponentProps, memo } from "react";
import { useSync, useSyncStatusOf } from "@/components/providers/sync-provider";
import type { SyncStatus } from "@/lib/sync/engine";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useOutboxCount } from "@/lib/hooks/data";
import { t } from "@/lib/i18n/ja";
import { cn } from "@/lib/utils";

/** Something wrong that needs attention, the most pressing first; null if nothing is. */
function wrongOf(status: SyncStatus): string | null {
  if (status.state === "error") return t.sync.error;
  if (status.quotaFull) return t.sync.quotaFull;
  if (status.stuck > 0) return t.sync.stuck;
  if (status.uploadRefused) return t.sync.uploadRefused;
  if (status.saveFailed) return t.sync.saveFailed;
  return null;
}

/**
 * What the badge makes of the status, as one value: what it shows changes
 * only as this does, not with each of the status's own changes (several
 * with every flush of a note being typed in).
 */
type Said =
  | { kind: "offline" | "vault" | "catchingUp" | "syncing" | "idle" }
  | { kind: "wrong"; wrong: string };
const SAID = {
  offline: { kind: "offline" },
  vault: { kind: "vault" },
  catchingUp: { kind: "catchingUp" },
  syncing: { kind: "syncing" },
  idle: { kind: "idle" },
} as const;
const wrongs = new Map<string, Said>();
function saidOf(status: SyncStatus): Said {
  if (status.state === "offline") return SAID.offline;
  const wrong = wrongOf(status);
  if (wrong) {
    if (!wrongs.has(wrong)) wrongs.set(wrong, { kind: "wrong", wrong });
    return wrongs.get(wrong)!;
  }
  if (status.heldForVault) return SAID.vault;
  if (status.catchingUp) return SAID.catchingUp;
  if (status.state === "syncing") return SAID.syncing;
  return SAID.idle;
}

/** The badge's words, with the edits still to send counted. */
function useBadge() {
  const said = useSyncStatusOf(saidOf);
  const pending = useOutboxCount();
  const busy = said.kind === "syncing" || said.kind === "catchingUp" || pending > 0;
  const wrong = said.kind === "wrong" ? said.wrong : null;
  const Icon =
    said.kind === "offline"
      ? CloudOff
      : wrong
        ? TriangleAlert
        : said.kind === "vault"
          ? Lock
          : busy
            ? Loader2
            : Check;
  const label =
    said.kind === "offline"
      ? t.sync.offline
      : wrong
        ? wrong
        : said.kind === "vault"
          ? t.sync.heldForVault
          : pending > 0
            ? t.sync.pending(pending)
            : said.kind === "catchingUp"
              ? t.sync.catchingUp
              : t.sync.idle;
  return { Icon, label, wrong, busy };
}

/**
 * A quiet indicator: it only asks for attention when something is wrong.
 * Its tooltip is drawn once; the face inside it alone follows the status.
 */
export const SyncBadge = memo(function SyncBadge({ className }: { className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <BadgeFace className={className} />
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <BadgeDetail />
      </TooltipContent>
    </Tooltip>
  );
});

/** The icon and the words, with what the tooltip's trigger hands its child. */
function BadgeFace({ className, ...props }: ComponentProps<"span">) {
  const { Icon, label, wrong, busy } = useBadge();
  return (
    <span
      {...props}
      role="status"
      aria-live="polite"
      aria-label={label}
      className={cn(
        "inline-flex items-center gap-1.5 text-xs text-muted-foreground",
        wrong && "text-destructive",
        className,
      )}
    >
      <Icon className={cn("size-3.5", busy && Icon === Loader2 && "animate-spin")} aria-hidden />
      <span className="hidden sm:inline">{label}</span>
    </span>
  );
}

/** What the tooltip says: drawn only while it is open. */
function BadgeDetail() {
  const { label } = useBadge();
  const lastSyncAt = useSyncStatusOf((status) => status.lastSyncAt);
  return (
    <>
      <p>{label}</p>
      {lastSyncAt ? (
        <p className="mt-0.5 text-xs text-muted-foreground">
          最終同期 {new Date(lastSyncAt).toLocaleTimeString("ja-JP")}
        </p>
      ) : null}
    </>
  );
}

export function SyncRetryButton() {
  const { engine } = useSync();
  return (
    <button
      type="button"
      onClick={() => void engine()?.retryStuck()}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
    >
      <RefreshCw className="size-3.5" aria-hidden />
      {t.action.retry}
    </button>
  );
}
