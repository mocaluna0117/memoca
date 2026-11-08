"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useSyncEngine, useSyncStatus } from "@/components/providers/sync-provider";
import { t } from "@/lib/i18n/ja";

/**
 * Says once, as it happens, what the sync badge then keeps showing: an edit
 * the server will not take set aside, a file it refused, an edit that could
 * not be stored here. Each told again only once it has gone and come back.
 * A leaf of its own, following the status (which changes with every flush
 * of a note being typed in), so that nothing else is drawn again with it.
 */
export function SyncAlerts() {
  const status = useSyncStatus();
  const engine = useSyncEngine();
  const told = useRef({ stuck: false, uploadRefused: false, saveFailed: false });

  useEffect(() => {
    const was = told.current;
    const stuck = status.stuck > 0;
    if (stuck && !was.stuck) {
      toast.error(t.sync.stuck, {
        description: t.sync.stuckDetail,
        duration: 15_000,
        action: { label: t.sync.retryStuck, onClick: () => void engine()?.retryStuck() },
      });
    }
    if (status.uploadRefused && !was.uploadRefused) {
      toast.error(t.sync.uploadRefused, { description: t.sync.uploadRefusedDetail, duration: 10_000 });
    }
    if (status.saveFailed && !was.saveFailed) {
      toast.error(t.sync.saveFailed, { description: t.sync.saveFailedDetail, duration: 10_000 });
    }
    told.current = { stuck, uploadRefused: status.uploadRefused, saveFailed: status.saveFailed };
  }, [status.stuck, status.uploadRefused, status.saveFailed, engine]);

  return null;
}
