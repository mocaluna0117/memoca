"use client";

import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import { ConvexReactClient } from "convex/react";
import { ThemeProvider } from "next-themes";
import type { ComponentProps, ReactNode } from "react";
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
}: {
  children: ReactNode;
  initialToken?: string | null;
}) {
  return (
    <ConvexBetterAuthProvider
      client={convex}
      // The adapter types its prop against its own inferred client shape;
      // ours differs only in plugin generics, so the cast is at the boundary.
      authClient={
        authClient as unknown as ComponentProps<
          typeof ConvexBetterAuthProvider
        >["authClient"]
      }
      initialToken={initialToken}
    >
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <TooltipProvider delayDuration={300}>
          {children}
          <Toaster position="top-center" richColors closeButton />
        </TooltipProvider>
      </ThemeProvider>
    </ConvexBetterAuthProvider>
  );
}
