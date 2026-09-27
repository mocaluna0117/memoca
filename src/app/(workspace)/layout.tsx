import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { SyncProvider } from "@/components/providers/sync-provider";
import { AccountGate } from "@/components/shell/gate";
import { ASKED_FOR, HOME, safeNext, signInReturningTo } from "@/lib/auth/next";
import { getToken, isAuthenticated } from "@/lib/auth/server";
import { tokenSubject } from "@/lib/auth/subject";

/**
 * Everything that needs the account: the notes (/app) and the quick note
 * (/quick). One layout for both, so going from one to the other keeps the
 * sync engine running and the vault as it was, instead of starting the one
 * again and closing the other.
 */
export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  if (!(await isAuthenticated())) {
    // Off to sign in, and back to the address asked for, what a share put in
    // it included, after.
    const asked = (await headers()).get(ASKED_FOR) ?? undefined;
    redirect(signInReturningTo(safeNext(asked) ?? HOME));
  }
  return (
    // Who is signed in, for the device's data to be shown only to its owner.
    <SyncProvider signedInAs={tokenSubject(await getToken())}>
      <AccountGate>{children}</AccountGate>
    </SyncProvider>
  );
}
