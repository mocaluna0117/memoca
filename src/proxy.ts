import { type NextRequest, NextResponse } from "next/server";
import { ASKED_FOR } from "@/lib/auth/next";

/**
 * Tells the workspace layout which address was asked for, so that someone
 * not signed in can be sent to sign in and back to exactly that address,
 * with a redirect the service worker does not keep as the page. Whatever a
 * browser sent under the same name is replaced.
 */
export function proxy(request: NextRequest) {
  const asked = request.nextUrl.clone();
  // Next's own, on a navigation within the app: nothing to come back to.
  asked.searchParams.delete("_rsc");
  const headers = new Headers(request.headers);
  headers.set(ASKED_FOR, asked.pathname + asked.search);
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ["/app/:path*", "/quick"] };
