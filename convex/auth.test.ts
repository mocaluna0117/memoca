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
  test("is off unless the deployment turns it on, which production does not", () => {
    vi.stubEnv("ALLOW_DESKTOP_SIGN_IN", "");
    expect(plugin("one-time-token")).toBeUndefined();
    vi.stubEnv("ALLOW_DESKTOP_SIGN_IN", "1");
    expect(plugin("one-time-token")).toBeUndefined();
  });

  test("where it is on, a token is good for three minutes, and kept only as a hash", () => {
    vi.stubEnv("ALLOW_DESKTOP_SIGN_IN", "true");
    expect(plugin("one-time-token")?.options).toMatchObject({ expiresIn: 3, storeToken: "hashed" });
  });
});
