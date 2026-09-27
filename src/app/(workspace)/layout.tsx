import { redirect } from "next/navigation";
import type { ReactNode } from "react";
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
  if (!(await isAuthenticated())) redirect("/sign-in");
  return (
    <SyncProvider>
      <AccountGate>{children}</AccountGate>
    </SyncProvider>
  );
}
