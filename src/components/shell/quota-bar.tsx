"use client";

import { useStorageUsage } from "@/components/providers/sync-provider";
import { Progress } from "@/components/ui/progress";
import { formatBytes } from "@/lib/bytes";
import { t } from "@/lib/i18n/ja";

export function QuotaBar() {
  const me = useStorageUsage();
  if (!me) return null;

  const used = me.usedBytes + me.reservedBytes;
  const ratio = me.quotaBytes > 0 ? Math.min(100, (used / me.quotaBytes) * 100) : 0;

  return (
    // One line, the bar beside its figures (the sidebar's height is the
    // folders'): the figures below it in a sidebar too narrow for both.
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Progress value={ratio} className="h-1 min-w-12 flex-1" />
      <p className="text-muted-foreground shrink-0 text-xs">
        {t.quota.used(formatBytes(used), formatBytes(me.quotaBytes))}
      </p>
    </div>
  );
}
