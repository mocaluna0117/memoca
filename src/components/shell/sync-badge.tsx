"use client";

import { Check, CloudOff, ImageUp, KeyRound, Loader2, Lock, RefreshCw, TriangleAlert } from "lucide-react";
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
  | { kind: "offline" | "signIn" | "uploads" | "vault" | "catchingUp" | "syncing" | "idle" }
  | { kind: "wrong"; wrong: string };
const SAID = {
  offline: { kind: "offline" },
  signIn: { kind: "signIn" },
  uploads: { kind: "uploads" },
  vault: { kind: "vault" },
  catchingUp: { kind: "catchingUp" },
  syncing: { kind: "syncing" },
  idle: { kind: "idle" },
} as const;
const wrongs = new Map<string, Said>();
function saidOf(status: SyncStatus): Said {
  if (status.state === "offline") return SAID.offline;
  // Edits wait for the sign-in to come back: said before they are counted,
  // or the badge said "未送信 3 件" with no word of why.
  if (status.signInWait) return SAID.signIn;
  const wrong = wrongOf(status);
  if (wrong) {
    if (!wrongs.has(wrong)) wrongs.set(wrong, { kind: "wrong", wrong });
    return wrongs.get(wrong)!;
  }
  if (status.uploadsWaiting > 0) return SAID.uploads;
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
      : said.kind === "signIn"
        ? KeyRound
        : wrong
          ? TriangleAlert
          : said.kind === "uploads"
            ? ImageUp
            : said.kind === "vault"
              ? Lock
              : busy
                ? Loader2
                : Check;
  const label =
    said.kind === "offline"
      ? t.sync.offline
      : said.kind === "signIn"
        ? t.sync.signInWait
        : wrong
          ? wrong
          : said.kind === "uploads"
            ? t.sync.uploadsWaiting
            : said.kind === "vault"
              ? t.sync.heldForVault
              : pending > 0
                ? t.sync.pending(pending)
                : said.kind === "catchingUp"
                  ? t.sync.catchingUp
                  : t.sync.idle;
  // What the tooltip says as well, where the words alone do not tell what happens next.
  const detail =
    said.kind === "signIn" ? t.sync.signInWaitDetail : said.kind === "uploads" ? t.sync.uploadsWaitingDetail : null;
  return { Icon, label, wrong, busy, detail };
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
  const { label, detail } = useBadge();
  const lastSyncAt = useSyncStatusOf((status) => status.lastSyncAt);
  return (
    <>
      <p>{label}</p>
      {detail ? <p className="mt-0.5 max-w-64 text-xs text-muted-foreground">{detail}</p> : null}
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
