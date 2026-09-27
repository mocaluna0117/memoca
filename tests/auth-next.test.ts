import { describe, expect, test } from "vitest";
// better-auth's own check of a callback URL on this site, as the server runs
// it. Internal to better-auth, and shipped without types.
// @ts-expect-error -- no declaration file for this module
import { matchesOriginPattern as check } from "../node_modules/better-auth/dist/auth/trusted-origins.mjs";
import { HOME, forCallback, safeNext, signInReturningTo } from "@/lib/auth/next";

describe("where sign-in comes back to", () => {
  test("a path on this site, its query included", () => {
    expect(safeNext("/quick?text=%E3%81%82")).toBe("/quick?text=%E3%81%82");
    expect(safeNext("/app/settings")).toBe("/app/settings");
  });

  test("nothing, or anything but one path, is no answer", () => {
    for (const value of [undefined, "", ["/app", "/quick"]]) expect(safeNext(value)).toBeNull();
  });

  test("never another site, however the address is dressed up", () => {
    for (const value of [
      "https://evil.example/",
      "//evil.example/steal",
      "/\\evil.example",
      "\\/evil.example",
      "/app\n//evil.example",
      "javascript:alert(1)",
      // Other sites once the dot segments are read.
      "/.//evil.example",
      "/..//evil.example",
      "/%2e//evil.example",
      "/app/..//evil.example/x",
    ]) {
      expect(safeNext(value), value).toBeNull();
    }
  });

  test("not the sign-in page itself, which would come back to itself", () => {
    expect(safeNext("/sign-in?next=/app")).toBeNull();
    expect(safeNext("/./sign-in")).toBeNull();
    expect(safeNext("/sign-in/")).toBeNull();
  });

  test("the sign-in page is told the way back in its own address", () => {
    const href = signInReturningTo("/quick?text=あとで 読む");
    expect(new URL(href, "https://memoca.test").searchParams.get("next")).toBe(
      "/quick?text=あとで 読む",
    );
  });
});

describe("the way back, as the sign-in hands it to better-auth", () => {
  const matchesOriginPattern = check as (
    url: string,
    pattern: string,
    settings: { allowRelativePaths: boolean },
  ) => boolean;
  const accepted = (url: string) => matchesOriginPattern(url, "", { allowRelativePaths: true });

  test("whatever was shared, better-auth accepts it, and it reads back the same", () => {
    for (const text of [
      "**大事**",
      "a*b",
      "括弧(かっこ)と!と'と~",
      "コロン: セミコロン; カンマ, [角] {波} $^|`",
      "スペース と+プラス と%パーセント",
      "絵文字👨‍👩‍👧",
      "https://example.com/a?b=c&d=e#f",
    ]) {
      const next = safeNext(`/quick?${new URLSearchParams({ window: "1", text })}`)!;
      const callback = forCallback(next);
      expect(accepted(callback), text).toBe(true);
      const read = new URL(callback, "https://memoca.test");
      expect(read.pathname).toBe("/quick");
      expect(read.searchParams.get("text"), text).toBe(text);
      expect(read.searchParams.get("window")).toBe("1");
    }
  });

  test("a path already fit to hand over is handed over as it is", () => {
    for (const path of [HOME, "/app/settings", "/app?n=0193f0a2-7c1e-7d4b-9a8e-3f2b1c0d9e8f"]) {
      expect(forCallback(path)).toBe(path);
      expect(accepted(path)).toBe(true);
    }
  });

  test("a path better-auth would turn away however written leads home instead", () => {
    expect(forCallback("/app/設定")).toBe(HOME);
    expect(forCallback("/app/a*b")).toBe(HOME);
  });
});
