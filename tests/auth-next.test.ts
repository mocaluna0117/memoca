import { describe, expect, test } from "vitest";
import { safeNext, signInReturningTo } from "@/lib/auth/next";

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
    ]) {
      expect(safeNext(value), value).toBeNull();
    }
  });

  test("not the sign-in page itself, which would come back to itself", () => {
    expect(safeNext("/sign-in?next=/app")).toBeNull();
    expect(safeNext("/./sign-in")).toBeNull();
  });

  test("the sign-in page is told the way back in its own address", () => {
    const href = signInReturningTo("/quick?text=あとで 読む");
    expect(new URL(href, "https://memoca.test").searchParams.get("next")).toBe(
      "/quick?text=あとで 読む",
    );
  });
});
