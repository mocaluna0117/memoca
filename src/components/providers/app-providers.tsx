"use client";

import { ConvexReactClient } from "convex/react";
import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import { type AuthClientForConvex, ConvexWithBetterAuth } from "@/components/providers/convex-auth";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { authClient } from "@/lib/auth/client";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!, {
  // The app reads from IndexedDB, so a brief disconnect is invisible; keep the
  // socket trying rather than surfacing every blip.
  verbose: false,
  // Convex warns before unload while a mutation is unanswered, which offline
  // is every push. Here that warning is wrong: each change stays in the local
  // outbox until the server acknowledges it and is sent again after a reload,
  // so leaving the page loses nothing. It only made reloading offline ask
  // 「このサイトを離れますか？」 about changes that were already safe.
  unsavedChangesWarning: false,
});

export function AppProviders({
  children,
  initialToken,
  nonce,
}: {
  children: ReactNode;
  initialToken?: string | null;
  /** This page's script nonce (lib/csp.ts), for the theme's inline script. */
  nonce?: string;
}) {
  return (
    <ConvexWithBetterAuth
      client={convex}
      // The client's types come from its plugins; only these two calls are used.
      authClient={authClient as unknown as AuthClientForConvex}
      initialToken={initialToken}
    >
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
        nonce={nonce}
      >
        <TooltipProvider delayDuration={300}>
          {children}
          <Toaster position="top-center" richColors closeButton />
        </TooltipProvider>
      </ThemeProvider>
    </ConvexWithBetterAuth>
  );
}
