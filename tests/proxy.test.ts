// @vitest-environment node
import { NextRequest } from "next/server";
import { describe, expect, test } from "vitest";
import { ASKED_FOR } from "@/lib/auth/next";
import { NONCE_HEADER, contentSecurityPolicy } from "@/lib/csp";
import { config, proxy } from "@/proxy";

/** What the workspace layout will read under ASKED_FOR, as Next hands it over. */
function askedFor(url: string, headers: Record<string, string> = {}) {
  const response = proxy(new NextRequest(url, { headers }));
  return response.headers.get(`x-middleware-request-${ASKED_FOR}`);
}

describe("the address the proxy tells the workspace layout", () => {
  test("replaces whatever the browser sent under the same name", () => {
    // A claim that would pass as a way back, so only the replacement can win.
    expect(askedFor("http://localhost/app", { [ASKED_FOR]: "/quick?text=planted" })).toBe("/app");
  });

  test("keeps the query a share put there, and drops Next's own _rsc", () => {
    expect(askedFor("http://localhost/quick?text=abc&_rsc=1x2y")).toBe("/quick?text=abc");
  });

  test("is told only for the notes, their pages, and the quick note", () => {
    expect(askedFor("http://localhost/app/settings")).toBe("/app/settings");
    expect(askedFor("http://localhost/sign-in")).toBeNull();
  });
});

/** Whether the proxy runs for a path, by its matcher as Next reads it. */
const matched = (path: string) =>
  config.matcher.some((pattern) => new RegExp(`^${pattern.replace("/(", "/(?:")}$`).test(path));

describe("the policy every page is served with", () => {
  test("runs for every page, and for no file", () => {
    for (const page of [
      "/",
      "/app",
      "/app/settings",
      "/quick",
      "/sign-in",
      "/desktop/handoff",
      "/offline",
    ]) {
      expect(matched(page), page).toBe(true);
    }
    for (const file of [
      "/api/auth/session",
      "/_next/static/chunks/a.js",
      "/serwist/sw.js",
      "/yomi-worker.js",
      "/icon.png",
    ]) {
      expect(matched(file), file).toBe(false);
    }
  });

  test("lets only scripts with this request's nonce run, and tells the page the nonce", () => {
    const response = proxy(new NextRequest("http://localhost/app"));
    const policy = response.headers.get("Content-Security-Policy")!;
    const nonce = response.headers.get(`x-middleware-request-${NONCE_HEADER}`)!;
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(policy).toContain(`'nonce-${nonce}'`);
    expect(policy).toContain("'strict-dynamic'");
    expect(policy).toContain("object-src 'none'");
    // Next reads the policy from the request to put the nonce on its scripts.
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(policy);
  });

  test("a new nonce each time", () => {
    const nonce = () =>
      proxy(new NextRequest("http://localhost/app")).headers.get(
        `x-middleware-request-${NONCE_HEADER}`,
      );
    expect(nonce()).not.toBe(nonce());
  });

  test("leaves where a page connects to alone, the desktop app's channel included", () => {
    const policy = contentSecurityPolicy("n");
    expect(policy).not.toMatch(/default-src|connect-src/);
    expect(policy).not.toContain(" 'unsafe-eval'");
    expect(contentSecurityPolicy("n", true)).toContain("'unsafe-eval'");
  });
});
