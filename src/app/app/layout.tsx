import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { SyncProvider } from "@/components/providers/sync-provider";
import { AccountGate } from "@/components/shell/gate";
import { WorkspaceShell } from "@/components/shell/workspace-shell";
import { isAuthenticated } from "@/lib/auth/server";

export const metadata: Metadata = { title: "メモ" };

export default async function AppLayout({ children }: { children: ReactNode }) {
  if (!(await isAuthenticated())) redirect("/sign-in");
  return (
    <SyncProvider>
      <AccountGate>
        <WorkspaceShell>{children}</WorkspaceShell>
      </AccountGate>
    </SyncProvider>
  );
}
