import { type NextRequest, NextResponse } from "next/server";
import { ASKED_FOR } from "@/lib/auth/next";
import { NONCE_HEADER, contentSecurityPolicy, newNonce } from "@/lib/csp";

/**
 * Serves every page with its Content-Security-Policy (lib/csp.ts), handing
 * the page the nonce its scripts carry.
 *
 * It also tells the workspace layout which address was asked for, so that
 * someone not signed in can be sent to sign in and back to exactly that
 * address, with a redirect the service worker does not keep as the page.
 * Whatever a browser sent under the same name is replaced.
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  const { pathname } = request.nextUrl;
  if (pathname === "/quick" || pathname === "/app" || pathname.startsWith("/app/")) {
    const asked = request.nextUrl.clone();
    // Next's own, on a navigation within the app: nothing to come back to.
    asked.searchParams.delete("_rsc");
    headers.set(ASKED_FOR, asked.pathname + asked.search);
  }

  const nonce = newNonce();
  const policy = contentSecurityPolicy(nonce, process.env.NODE_ENV === "development");
  // Next puts the nonce on its own scripts from the policy in the request.
  headers.set(NONCE_HEADER, nonce);
  headers.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  // Pages: not the API, Next's and the service worker's files, or any other
  // file (a name with a dot in it).
  matcher: ["/((?!api/|_next/|serwist/|.*\\..*).*)"],
};
