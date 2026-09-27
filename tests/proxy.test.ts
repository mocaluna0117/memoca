// @vitest-environment node
import { NextRequest } from "next/server";
import { describe, expect, test } from "vitest";
import { ASKED_FOR } from "@/lib/auth/next";
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

  test("runs for the notes, their pages, and the quick note", () => {
    expect(config.matcher).toEqual(expect.arrayContaining(["/app/:path*", "/quick"]));
  });
});
