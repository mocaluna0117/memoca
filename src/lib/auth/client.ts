"use client";

import { convexClient } from "@convex-dev/better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  plugins: [convexClient()],
});

export const { useSession, signIn, signOut } = authClient;

/**
 * Google is the only provider: sending mail needs a domain this app lacks.
 * Throws when the sign-in cannot start, which the client otherwise reports
 * only in what it returns.
 */
export async function signInWithGoogle(callbackURL = "/app"): Promise<void> {
  const { error } = await authClient.signIn.social({ provider: "google", callbackURL });
  if (error) throw new Error(error.message ?? `sign-in refused (${error.status})`);
}
