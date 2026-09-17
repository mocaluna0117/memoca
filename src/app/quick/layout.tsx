import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { SyncProvider } from "@/components/providers/sync-provider";
import { AccountGate } from "@/components/shell/gate";
import { isAuthenticated } from "@/lib/auth/server";
import { t } from "@/lib/i18n/ja";

export const metadata: Metadata = { title: t.nav.quick };

export default async function QuickLayout({ children }: { children: ReactNode }) {
  if (!(await isAuthenticated())) redirect("/sign-in");
  return (
    <SyncProvider>
      <AccountGate>{children}</AccountGate>
    </SyncProvider>
  );
}
