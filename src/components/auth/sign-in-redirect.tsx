"use client";

import { useEffect } from "react";
import { signInReturningTo } from "@/lib/auth/next";

/**
 * Sends someone who is not signed in to sign in, to come back to this very
 * address afterwards: the page that was opened, and what a share put in it.
 * Only the browser knows the address, which a layout on the server does not.
 */
export function SignInRedirect() {
  useEffect(() => {
    window.location.replace(signInReturningTo(window.location.pathname + window.location.search));
  }, []);
  return null;
}
