import { describe, expect, test } from "vitest";
import {
  desktopHandoff,
  desktopSignIn,
  handoffCheck,
  handoffLink,
  isHandoffChallenge,
  isHandoffCode,
  isHandoffState,
  pastedCode,
  shellAgent,
} from "@/lib/auth/handoff";

const state = "a".repeat(40) + "_-9";
const challenge = "c".repeat(40) + "-_0";
const code = "Ab3".repeat(10) + "Zz";

describe("signing the desktop shell in", () => {
  test("a state, a challenge and a verifier are the shell's own: 32 bytes as base64url, and nothing else", () => {
    for (const check of [isHandoffState, isHandoffChallenge]) {
      expect(check(state)).toBe(true);
      for (const value of [
        undefined,
        "",
        "a".repeat(42),
        "a".repeat(44),
        `${"a".repeat(42)}=`,
        `${"a".repeat(42)}/`,
      ]) {
        expect(check(value), String(value)).toBe(false);
      }
      expect(check(["a".repeat(43)])).toBe(false);
    }
  });

  test("a code is one as the server makes them: 32 letters and digits", () => {
    expect(isHandoffCode(code)).toBe(true);
    for (const value of [
      undefined,
      "short",
      "a".repeat(31),
      "a".repeat(33),
      `${"a".repeat(31)}-`,
      `${"a".repeat(31)}_`,
      `${"a".repeat(31)}=`,
    ]) {
      expect(isHandoffCode(value), String(value)).toBe(false);
    }
  });

  test("a pasted code loses the spaces and line breaks a copy picks up", () => {
    expect(pastedCode("  abcd\nefgh \t")).toBe("abcdefgh");
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
    const back = new URL(handoffLink(code, state));
    expect(back.protocol).toBe("memoca:");
    expect(back.searchParams.get("code")).toBe(code);
    expect(back.searchParams.get("state")).toBe(state);
    // The browser is given the challenge, never the verifier.
    for (const path of [
      desktopSignIn({ state, challenge }),
      desktopHandoff({ state, challenge }),
    ]) {
      const url = new URL(path, "https://x.test");
      expect(url.searchParams.get("state")).toBe(state);
      expect(url.searchParams.get("challenge")).toBe(challenge);
    }
  });

  test("the few letters both pages show are the first of the challenge's SHA-256", async () => {
    // SHA-256("abc") = ba7816bf…, as desktop/src-tauri/src/sign_in.rs has it too.
    expect(await handoffCheck("abc")).toBe("BA78-16BF");
    expect(await handoffCheck(challenge)).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(await handoffCheck(challenge)).not.toBe(await handoffCheck(state));
  });
});
