"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/bytes";
import { type WriteTrace, prepareImage } from "@/lib/media/compress";
import { WEBP_ASSET_VERSION, canvasWritesWebp, webpWorkerState } from "@/lib/media/webp-encoder";

const BY = { canvas: "canvas", worker: "WebAssembly", fallback: "予備の形式" } as const;
const ms = (value: number | undefined) => (value === undefined ? "―" : `${Math.round(value)} ms`);

/** One write, as a line: what wrote it, and where the time went. */
function describeWrite(write: WriteTrace): string {
  const parts = [
    `${write.width}×${write.height}`,
    BY[write.by],
    write.type,
    formatBytes(write.bytes),
    `計 ${ms(write.ms)}`,
  ];
  if (write.pixelsMs !== undefined) parts.push(`画素の読み出し ${ms(write.pixelsMs)}`);
  if (write.worker) {
    const worker = write.worker;
    parts.push(`待ち ${ms(worker.waitedMs)}`);
    if (worker.loadMs !== undefined) parts.push(`読み込み ${ms(worker.loadMs)}`);
    if (worker.encodeMs !== undefined) parts.push(`エンコード ${ms(worker.encodeMs)}`);
    if (worker.heapBytes !== undefined) parts.push(`メモリ ${formatBytes(worker.heapBytes)}`);
    if (worker.issue) parts.push(`WebAssembly を使わなかった理由: ${worker.issue}`);
  }
  if (write.issue) parts.push(`失敗: ${write.issue}`);
  return `書き出し: ${parts.join("、")}`;
}

/** Whether the service worker holds both of the encoder's files, for use offline. */
async function encoderCached(): Promise<string> {
  if (typeof caches === "undefined") return "確認できない";
  const keys = await (await caches.open("memoca-webp")).keys();
  const current = keys.filter((request) => new URL(request.url).pathname.startsWith(`/webp/${WEBP_ASSET_VERSION}/`));
  return current.length >= 2 ? "端末に保存済み（オフラインでも使える）" : `未保存（${current.length} / 2）`;
}

/**
 * For the admin: runs one image through what adding it to a note does, and
 * shows every step (what wrote it, as what, how large, where the time went),
 * to measure on each phone and computer what the numbers should be. Nothing
 * is uploaded, and a failure here does not count against the encoder.
 */
export function ImageDiagnostics({ maxImageBytes }: { maxImageBytes: number | undefined }) {
  const input = useRef<HTMLInputElement>(null);
  const [report, setReport] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (file: File) => {
    setBusy(true);
    let hidden = false;
    const onChange = () => {
      if (document.visibilityState === "hidden") hidden = true;
    };
    document.addEventListener("visibilitychange", onChange);
    const state = webpWorkerState();
    const lines = [
      `ブラウザ: ${navigator.userAgent}`,
      `画面: ${screen.width}×${screen.height}、倍率 ${window.devicePixelRatio}`,
      `canvas で WebP: ${(await canvasWritesWebp()) ? "書ける" : "書けない"}`,
      `WebAssembly のエンコーダー: ${state.available ? "使える" : "使えない"}（失敗 ${state.failures} 回${state.loadBlocked ? "、読み込み待ち" : ""}）、${await encoderCached()}`,
      `元の画像: ${file.name}（${file.type || "種類なし"}、${formatBytes(file.size)}）`,
    ];
    const started = performance.now();
    try {
      const result = await prepareImage(file, {
        maxBytes: maxImageBytes,
        trial: true,
        onRead: (read) => lines.push(`読み込み: ${read.width}×${read.height}、${ms(read.ms)}`),
        onWrite: (write) => lines.push(describeWrite(write)),
      });
      lines.push(
        `結果: ${result.mime}、${formatBytes(result.blob.size)}${result.width ? `、${result.width}×${result.height}` : ""}${result.blob === file ? "（元のまま）" : ""}`,
      );
    } catch (error) {
      lines.push(`失敗: ${error instanceof Error ? error.message : String(error)}`);
    }
    document.removeEventListener("visibilitychange", onChange);
    lines.push(`合計: ${ms(performance.now() - started)}${hidden ? "（途中で画面を離れたため、時間は参考）" : ""}`);
    setReport(lines.join("\n"));
    setBusy(false);
  };

  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="text-sm font-medium">画像の診断（管理者だけに表示）</p>
      <p className="text-muted-foreground text-xs leading-relaxed">
        画像を 1 枚選ぶと、メモに追加するときと同じ処理を試し、各段階の形式・大きさ・時間を表示します。アップロードはしません。
      </p>
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="hidden"
        aria-label="診断する画像"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void run(file);
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? "処理しています…" : "画像を選んで試す"}
        </Button>
        {report ? (
          <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(report)}>
            結果をコピー
          </Button>
        ) : null}
      </div>
      {report ? (
        <pre className="bg-muted overflow-x-auto rounded p-2 text-xs leading-relaxed whitespace-pre-wrap">
          {report}
        </pre>
      ) : null}
    </div>
  );
}
