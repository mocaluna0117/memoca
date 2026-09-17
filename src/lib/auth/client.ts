"use client";

import { convexClient } from "@convex-dev/better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  plugins: [convexClient()],
});

export const { useSession, signIn, signOut } = authClient;

/** Google is the only provider: sending mail needs a domain this app lacks. */
export async function signInWithGoogle(callbackURL = "/app"): Promise<void> {
  await authClient.signIn.social({ provider: "google", callbackURL });
}
