import type { ReactNode } from "react";
import { SignInRedirect } from "@/components/auth/sign-in-redirect";
import { SyncProvider } from "@/components/providers/sync-provider";
import { AccountGate } from "@/components/shell/gate";
import { isAuthenticated } from "@/lib/auth/server";

/**
 * Everything that needs the account: the notes (/app) and the quick note
 * (/quick). One layout for both, so going from one to the other keeps the
 * sync engine running and the vault as it was, instead of starting the one
 * again and closing the other.
 */
export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  // Not signed in: off to sign in, and back here after, with nothing else
  // started on the way (the account gate would wait for an account forever).
  if (!(await isAuthenticated())) return <SignInRedirect />;
  return (
    <SyncProvider>
      <AccountGate>{children}</AccountGate>
    </SyncProvider>
  );
}
