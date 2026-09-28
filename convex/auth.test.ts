import { afterEach, describe, expect, test, vi } from "vitest";
import { createAuth } from "./auth";

/** One of better-auth's plugins as this deployment sets it up, if it does. */
const plugin = (id: string) =>
  createAuth({} as never).options.plugins?.find((found: { id: string }) => found.id === id) as
    { options?: unknown } | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("signing the desktop shell in", () => {
  test("is off unless the deployment turns it on", () => {
    vi.stubEnv("ALLOW_DESKTOP_SIGN_IN", "");
    expect(plugin("memoca-desktop-sign-in")).toBeUndefined();
    vi.stubEnv("ALLOW_DESKTOP_SIGN_IN", "1");
    expect(plugin("memoca-desktop-sign-in")).toBeUndefined();
    vi.stubEnv("ALLOW_DESKTOP_SIGN_IN", "true");
    expect(plugin("memoca-desktop-sign-in")).toBeDefined();
  });

  test("hands the browser's own session to nobody: the one-time token plugin is gone", () => {
    vi.stubEnv("ALLOW_DESKTOP_SIGN_IN", "true");
    expect(plugin("one-time-token")).toBeUndefined();
  });
});
