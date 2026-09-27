import { describe, expect, test } from "vitest";
import {
  desktopComplete,
  desktopHandoff,
  handoffLink,
  isHandoffState,
  isHandoffToken,
  pastedToken,
  shellAgent,
  tokenFromFragment,
} from "@/lib/auth/handoff";

const state = "a".repeat(40) + "_-9";

describe("signing the desktop shell in", () => {
  test("a state is the shell's own: 32 random bytes as base64url, and nothing else", () => {
    expect(isHandoffState(state)).toBe(true);
    for (const value of [
      undefined,
      "",
      "a".repeat(42),
      "a".repeat(44),
      `${"a".repeat(42)}=`,
      `${"a".repeat(42)}/`,
    ]) {
      expect(isHandoffState(value), String(value)).toBe(false);
    }
    expect(isHandoffState(["a".repeat(43)])).toBe(false);
  });

  test("a token is one as the server makes them: 32 of letters, digits, - and _", () => {
    expect(isHandoffToken("Ab3".repeat(10) + "Zz")).toBe(true);
    expect(isHandoffToken("dOY0FgSpRq8UDAvWHElvd6tPX1RK_LR-")).toBe(true);
    for (const value of [
      undefined,
      "short",
      "a".repeat(31),
      "a".repeat(33),
      `${"a".repeat(31)}=`,
      `${"a".repeat(31)}.`,
    ]) {
      expect(isHandoffToken(value), String(value)).toBe(false);
    }
  });

  test("a pasted code loses the spaces and line breaks a copy picks up", () => {
    expect(pastedToken("  abcd\nefgh \t")).toBe("abcdefgh");
  });

  test("the shell is told by its user agent", () => {
    expect(
      shellAgent("Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 MemocaShell/0.1.0 (macos)"),
    ).toBe(true);
    expect(shellAgent("Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605.1.15")).toBe(false);
    expect(shellAgent("NotMemocaShell/1.0")).toBe(false);
    expect(shellAgent(null)).toBe(false);
  });

  test("the addresses carry what they carry, and nothing is lost on the way", () => {
    const back = new URL(handoffLink("tok", state));
    expect(back.protocol).toBe("memoca:");
    expect(back.searchParams.get("token")).toBe("tok");
    expect(back.searchParams.get("state")).toBe(state);
    expect(new URL(desktopHandoff(state), "https://x.test").searchParams.get("state")).toBe(state);
    // The token goes in the fragment, which reaches no server and no Referer.
    const complete = new URL(desktopComplete("tok"), "https://x.test");
    expect(complete.search).toBe("");
    expect(complete.hash).toBe("#token=tok");
  });

  test("the token is read from the fragment, only in the shape the server makes it", () => {
    const token = "dOY0FgSpRq8UDAvWHElvd6tPX1RK_LR-";
    expect(tokenFromFragment(`#token=${token}`)).toBe(token);
    expect(tokenFromFragment(`token=${token}`)).toBe(token);
    for (const hash of ["", "#", "#token=", "#token=short", `#other=${token}`]) {
      expect(tokenFromFragment(hash), hash).toBeNull();
    }
  });
});
