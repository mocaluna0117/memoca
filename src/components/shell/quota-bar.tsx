"use client";

import { useSync } from "@/components/providers/sync-provider";
import { Progress } from "@/components/ui/progress";
import { formatBytes } from "@/lib/bytes";
import { t } from "@/lib/i18n/ja";

export function QuotaBar() {
  const { me } = useSync();
  if (!me) return null;

  const used = me.usedBytes + me.reservedBytes;
  const ratio = me.quotaBytes > 0 ? Math.min(100, (used / me.quotaBytes) * 100) : 0;

  return (
    <div className="space-y-1.5">
      <Progress value={ratio} className="h-1" />
      <p className="text-muted-foreground text-xs">
        {t.quota.used(formatBytes(used), formatBytes(me.quotaBytes))}
      </p>
    </div>
  );
}
