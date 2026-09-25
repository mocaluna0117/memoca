import { withMethod } from "@/lib/crypto/platform";

/**
 * Why the vault prompt opened. The prompt used to say 「ロックを解除」 whatever
 * the reason, so choosing 「ロックする」 opened a screen that read like the
 * opposite. Every caller now says what it is about to do.
 */
export type VaultPurpose =
  | { kind: "open"; from: "note" | "general" }
  | { kind: "setup" }
  | { kind: "lockNote"; title: string | null }
  | { kind: "unlockNote"; title: string | null }
  | { kind: "lockFolder"; folderId: string; name: string }
  | { kind: "unlockFolder"; folderId: string; name: string };

export type PurposeCopy = {
  title: string;
  /** One paragraph, or points shown as a list. */
  body: string | string[];
  /** The primary button on the password screen, and on the confirmation. */
  verb: string;
  /** Shown instead of the controls when the purpose needs the server. */
  offline: string | null;
};

/**
 * Whether the purpose asks for a yes even with the vault already open. Taking
 * a lock off stores the contents unencrypted, and locking a folder changes
 * every note in it, so neither should happen on a single mis-tap.
 */
export function needsConfirmation(purpose: VaultPurpose): boolean {
  return (
    purpose.kind === "unlockNote" ||
    purpose.kind === "lockFolder" ||
    purpose.kind === "unlockFolder"
  );
}

/** Whether the purpose changes data on the server, so cannot happen offline. */
export function needsServer(purpose: VaultPurpose): boolean {
  return purpose.kind !== "open";
}

const quoted = (title: string | null) => (title ? `「${title}」` : "このメモ");

export function purposeCopy(
  purpose: VaultPurpose,
  opts: { method: string; noteCount?: number | null } = { method: "パスキー" },
): PurposeCopy {
  const count = opts.noteCount ?? null;
  switch (purpose.kind) {
    case "open":
      return purpose.from === "note"
        ? {
            title: "ロックされたメモを開く",
            body: "このメモを読むには、金庫を開きます。",
            verb: "開く",
            offline: null,
          }
        : {
            title: "金庫を開く",
            body: "金庫を開くと、ロックしたメモを読んだり編集したりできます。",
            verb: "開く",
            offline: null,
          };
    case "setup":
      return {
        title: "金庫を作成",
        body: "ロックしたメモの本文・タイトル・添付ファイルは、この金庫の鍵で暗号化されます。鍵はこの端末の中だけで使われ、Memoca のサーバーでも読めません。",
        verb: "作成する",
        offline: "金庫の作成にはインターネット接続が必要です。",
      };
    case "lockNote":
      return {
        title: "メモをロック",
        body: `${quoted(purpose.title)}の本文・タイトル・添付ファイルを暗号化します。続けるには本人確認をしてください。`,
        verb: "ロックする",
        offline: "ロックするにはインターネット接続が必要です。",
      };
    case "unlockNote":
      return {
        title: "メモのロックを外しますか？",
        body: `${quoted(purpose.title)}を通常のメモに戻します。本文・タイトル・添付ファイルは、暗号化されない状態でサーバーに保存されます。`,
        verb: "ロックを外す",
        offline: "ロックを外すにはインターネット接続が必要です。",
      };
    case "lockFolder":
      return {
        title: `フォルダ「${purpose.name}」をロックしますか？`,
        body: [
          count === 0
            ? "いまは中にメモはありません。"
            : count === null
              ? "中にあるメモ（サブフォルダを含む）の本文・タイトル・添付ファイルを暗号化します。"
              : `中にあるメモ ${count} 件（サブフォルダを含む）の本文・タイトル・添付ファイルを暗号化します。`,
          "あとから追加・移動したメモも自動でロックされます。",
          "インターネット接続が必要です。終わるまでこの画面を開いたままにしてください。",
        ],
        verb: "ロックする",
        offline: "ロックするにはインターネット接続が必要です。",
      };
    case "unlockFolder":
      return {
        title: `フォルダ「${purpose.name}」のロックを外しますか？`,
        body: [
          count === 0
            ? "いまは中にロックされたメモはありません。"
            : count === null
              ? "このフォルダのロックされたメモを通常のメモに戻します。"
              : `このフォルダのロックされたメモ ${count} 件を通常のメモに戻します。`,
          "本文・タイトル・添付ファイルは、暗号化されない状態でサーバーに保存されます。",
        ],
        verb: "ロックを外す",
        offline: "ロックを外すにはインターネット接続が必要です。",
      };
  }
}

/** The passkey button: 「{m}で開く」 when opening, 「{m}で続ける」 otherwise. */
export function passkeyAction(purpose: VaultPurpose, method: string): string {
  return withMethod(method, purpose.kind === "open" ? "で開く" : "で続ける");
}
