"use client";

import { useConvex } from "convex/react";
import { useLiveQuery } from "dexie-react-hooks";
import { File, Film, Image as ImageIcon, Lock, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/bytes";
import { db } from "@/lib/db";
import { LOCKED_LABEL, useNoteTitle } from "@/lib/hooks/use-decrypted";
import { useOnline } from "@/lib/hooks/use-online";
import { t } from "@/lib/i18n/ja";
import {
  type Breakdown,
  type Figures,
  type LargeFile,
  PARTS,
  type Part,
  amounts,
  freeBytes,
  mismatch,
  placeOf,
  widths,
} from "@/lib/storage/breakdown";

const COLORS: Record<Part, string> = {
  images: "bg-sky-500",
  videos: "bg-violet-500",
  lockedFiles: "bg-indigo-300 dark:bg-indigo-400",
  otherFiles: "bg-amber-500",
  text: "bg-emerald-500",
  trash: "bg-rose-400",
  unused: "bg-zinc-400",
  uploading: "bg-teal-300 dark:bg-teal-600",
  uncounted: "bg-zinc-300 dark:bg-zinc-600",
};

/** Longest to wait for the breakdown before saying it could not be had. */
const FETCH_TIMEOUT_MS = 15_000;
/** A breakdown this recent is shown again on return to the page, rather than worked out anew. */
const REUSE_MS = 5 * 60 * 1000;

/** The last breakdown, for this account, kept while the app is open. */
let kept: { account: string; at: number; value: Breakdown } | null = null;

/** The kept breakdown for this account, if recent enough to show again. */
function keptFor(account: string): { at: number; value: Breakdown } | null {
  return kept && kept.account === account && Date.now() - kept.at < REUSE_MS ? kept : null;
}

/** Forgets the kept breakdown: for tests. */
export function forgetStorageBreakdown(): void {
  kept = null;
}

const dateOf = (at: number) =>
  new Date(at).toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" });
const timeOf = (at: number) => new Date(at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });

type Status = "idle" | "loading" | "offline" | "failed" | "signedOut";

/**
 * Where the account's storage goes, and its largest files. Worked out when
 * asked for (the page opening, unless one from the last few minutes is
 * kept, or 更新), never kept live: it reads every note and file, which would
 * otherwise happen again at every edit. `live` is the account's figures as
 * they are now, for the free space, which the page states above too.
 */
export function StorageBreakdown({ account, live, admin }: { account: string; live: Figures; admin: boolean }) {
  const client = useConvex();
  const online = useOnline();
  const [usage, setUsage] = useState(() => keptFor(account));
  const [status, setStatus] = useState<Status>(() => (keptFor(account) ? "idle" : "loading"));
  /** Asks so far, from opening, the button or the network coming back: each one fetches once. */
  const [asked, setAsked] = useState(() => (keptFor(account) ? 0 : 1));

  useEffect(() => {
    if (asked === 0 || !online) return;
    let alive = true;
    const timer = setTimeout(() => {
      if (alive) setStatus("failed");
      alive = false;
    }, FETCH_TIMEOUT_MS);
    client.query(api.usage.breakdown, {}).then(
      (value) => {
        if (!alive) return;
        clearTimeout(timer);
        const next = { at: Date.now(), value };
        kept = { account, ...next };
        setUsage(next);
        setStatus("idle");
      },
      (error: unknown) => {
        if (!alive) return;
        clearTimeout(timer);
        const code = (error as { data?: { code?: string } } | null)?.data?.code;
        setStatus(code === "UNAUTHENTICATED" ? "signedOut" : "failed");
      },
    );
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [client, account, asked, online]);

  const refresh = () => {
    if (status === "loading" || !online) return;
    setStatus("loading");
    setAsked((count) => count + 1);
  };

  const shown = usage?.value;
  const parts = shown ? amounts(shown, live) : null;
  const drawn = parts ? widths(parts, live.quotaBytes) : null;
  const free = freeBytes(live);
  const difference = shown && admin ? mismatch(shown) : null;
  const loading = status === "loading" && online;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">
          {t.storage.title}
          {usage ? (
            <span className="text-muted-foreground ml-2 text-xs font-normal">{t.storage.asOf(timeOf(usage.at))}</span>
          ) : null}
        </h3>
        <Button
          size="sm"
          variant="ghost"
          className="gap-1.5"
          aria-disabled={loading || !online}
          onClick={refresh}
        >
          <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden />
          {t.storage.refresh}
        </Button>
      </div>

      <div aria-live="polite" className="space-y-3">
        {!online ? <p className="text-muted-foreground text-xs">{t.storage.offline}</p> : null}
        {online && status === "failed" ? <p className="text-muted-foreground text-xs">{t.storage.failed}</p> : null}
        {online && status === "signedOut" ? (
          <p className="text-muted-foreground text-xs">{t.storage.signedOut}</p>
        ) : null}
        {loading && !usage ? <p className="text-muted-foreground text-xs">{t.storage.loading}</p> : null}

        {shown && parts && drawn ? (
          <>
            <div
              role="img"
              aria-label={[
                ...PARTS.filter((part) => parts[part] > 0).map((part) => `${t.storage[part]} ${formatBytes(parts[part])}`),
                `${t.storage.free} ${formatBytes(free)}`,
              ].join("、")}
              className="bg-muted flex h-3 w-full overflow-hidden rounded-full border"
            >
              {PARTS.map((part) =>
                drawn[part] > 0 ? (
                  <span key={part} className={COLORS[part]} style={{ width: `${drawn[part]}%` }} />
                ) : null,
              )}
            </div>

            <ul className="grid gap-1 text-xs sm:grid-cols-2">
              {PARTS.map((part) =>
                parts[part] > 0 ? (
                  <li key={part} className="flex items-start gap-2">
                    <span className={`mt-1 size-2.5 shrink-0 rounded-sm ${COLORS[part]}`} aria-hidden />
                    <span className="min-w-0">
                      <span>{t.storage[part]}</span>
                      <span className="text-muted-foreground ml-1.5 tabular-nums">{formatBytes(parts[part])}</span>
                      {part === "unused" && shown.unused.nextDeleteAt !== null ? (
                        <span className="text-muted-foreground block">
                          {shown.unused.nextDeleteAt > usage!.at
                            ? t.storage.unusedDetail(shown.unused.count, dateOf(shown.unused.nextDeleteAt))
                            : t.storage.unusedSoon(shown.unused.count)}
                        </span>
                      ) : null}
                    </span>
                  </li>
                ) : null,
              )}
              <li className="flex items-center gap-2">
                <span className="bg-muted size-2.5 shrink-0 rounded-sm border" aria-hidden />
                <span>{t.storage.free}</span>
                <span className="text-muted-foreground tabular-nums">{formatBytes(free)}</span>
              </li>
            </ul>

            {difference !== null ? (
              <p className="text-muted-foreground text-xs">
                {t.storage.mismatch(formatBytes(shown.usedBytes), formatBytes(shown.recomputedBytes))}
              </p>
            ) : null}
            {shown.truncated ? <p className="text-muted-foreground text-xs">{t.storage.truncated}</p> : null}

            {shown.largest.length > 0 ? (
              <div className="space-y-1">
                <h3 className="text-sm font-medium">{t.storage.largest}</h3>
                <ul className="divide-y rounded-md border">
                  {shown.largest.map((file) => (
                    <LargeFileRow key={file.attachmentId} file={file} />
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

/** One of the largest files, and where it is; opens its note, or the trash. */
function LargeFileRow({ file }: { file: LargeFile }) {
  const router = useRouter();
  const ids = [...new Set([...file.usedBy, file.noteId])];
  const notes = useLiveQuery(
    async () => new Map((await db().notes.bulkGet(ids)).map((note, index) => [ids[index]!, note])),
    [ids.join(",")],
  );
  const place = notes ? placeOf(file, notes) : null;
  const title = useNoteTitle(place?.state === "note" ? notes?.get(place.noteId) : undefined);
  const Icon = file.locked ? Lock : file.kind === "image" ? ImageIcon : file.kind === "video" ? Film : File;
  const name = file.locked ? t.storage.lockedFile : (file.name ?? t.storage.noName);
  // A title as written in 「」; a placeholder for one, as it is.
  const where =
    place?.state === "note"
      ? title && title !== LOCKED_LABEL
        ? `「${title}」`
        : title || t.storage.untitled
      : place?.state === "trash"
        ? t.storage.inTrash
        : place?.state === "unused"
          ? t.storage.notUsed
          : place?.state === "missing"
            ? t.storage.notHere
            : "";
  const target =
    place?.state === "note" ? `/app?n=${place.noteId}` : place?.state === "trash" ? "/app/trash" : null;

  const body = (
    <>
      <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{name}</span>
        <span className="text-muted-foreground block truncate">{where}</span>
      </span>
      <span className="shrink-0 text-right tabular-nums">
        <span className="block">{formatBytes(file.bytes)}</span>
        {file.width && file.height ? (
          <span className="text-muted-foreground block">
            {file.width}×{file.height}
          </span>
        ) : null}
      </span>
    </>
  );

  return (
    <li>
      {target ? (
        <button
          type="button"
          onClick={() => router.push(target)}
          className="hover:bg-accent/50 flex w-full items-center gap-3 px-3 py-2 text-left text-xs"
        >
          {body}
        </button>
      ) : (
        <div className="flex w-full items-center gap-3 px-3 py-2 text-xs">{body}</div>
      )}
    </li>
  );
}
