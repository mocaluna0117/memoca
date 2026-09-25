import { describe, expect, test } from "vitest";
import { deviceLabel, unlockMethodName, withMethod } from "@/lib/crypto/platform";
import { passkeyAction, purposeCopy, type VaultPurpose } from "@/lib/vault/purpose";

const UA = {
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  android:
    "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  windowsEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
};

describe("what the device calls its passkey check", () => {
  test("by platform, with iPads that report themselves as Macs", () => {
    expect(unlockMethodName(UA.iphone, 5)).toBe("Face ID / Touch ID");
    expect(unlockMethodName(UA.macSafari, 5)).toBe("Face ID / Touch ID");
    expect(unlockMethodName(UA.macSafari, 0)).toBe("Touch ID");
    expect(unlockMethodName(UA.android, 5)).toBe("指紋・顔認証");
    expect(unlockMethodName(UA.windowsEdge, 0)).toBe("Windows Hello");
    expect(unlockMethodName("curl/8", 0)).toBe("パスキー");
  });

  test("is joined to Japanese with a space only after a Latin name", () => {
    expect(withMethod("Touch ID", "で開く")).toBe("Touch ID で開く");
    expect(withMethod("指紋・顔認証", "で開く")).toBe("指紋・顔認証で開く");
  });

  test("devices get names that tell them apart", () => {
    expect(deviceLabel(UA.iphone, 5)).toBe("iPhone（Safari）");
    expect(deviceLabel(UA.macSafari, 5)).toBe("iPad（Safari）");
    expect(deviceLabel(UA.macChrome, 0)).toBe("Mac（Chrome）");
    expect(deviceLabel(UA.android, 5)).toBe("Android（Chrome）");
    expect(deviceLabel(UA.windowsEdge, 0)).toBe("Windows（Edge）");
    expect(deviceLabel("curl/8", 0)).toBe("不明な端末");
  });
});

describe("what the prompt says", () => {
  const purposes: VaultPurpose[] = [
    { kind: "open", from: "note" },
    { kind: "open", from: "general" },
    { kind: "setup" },
    { kind: "lockNote", title: "買い物" },
    { kind: "unlockNote", title: null },
    { kind: "lockFolder", folderId: "f", name: "仕事" },
    { kind: "unlockFolder", folderId: "f", name: "仕事" },
  ];

  test("never says 「ロックを解除」, which read as the opposite of 「ロックする」", () => {
    for (const purpose of purposes) {
      const copy = purposeCopy(purpose, { method: "Touch ID", noteCount: 3 });
      const text = [copy.title, copy.verb, ...[copy.body].flat(), copy.offline ?? ""].join(" ");
      expect(text, purpose.kind).not.toContain("ロックを解除");
      expect(text, purpose.kind).not.toContain("解除");
    }
  });

  test("locking says it locks, and names what", () => {
    const copy = purposeCopy({ kind: "lockFolder", folderId: "f", name: "仕事" }, {
      method: "Touch ID",
      noteCount: 4,
    });
    expect(copy.title).toBe("フォルダ「仕事」をロックしますか？");
    expect(copy.verb).toBe("ロックする");
    expect([copy.body].flat().join()).toContain("4 件");
  });

  test("an empty folder is said to be empty, not to hold 0 notes", () => {
    const copy = purposeCopy({ kind: "lockFolder", folderId: "f", name: "仕事" }, {
      method: "Touch ID",
      noteCount: 0,
    });
    expect([copy.body].flat()[0]).toBe("いまは中にメモはありません。");
  });

  test("the passkey button opens or continues", () => {
    expect(passkeyAction({ kind: "open", from: "note" }, "Touch ID")).toBe("Touch ID で開く");
    expect(passkeyAction({ kind: "lockNote", title: null }, "Touch ID")).toBe("Touch ID で続ける");
  });
});
