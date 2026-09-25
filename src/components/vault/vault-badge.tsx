"use client";

import { LockOpen } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { vault } from "@/lib/crypto/vault";
import { useVaultUnlocked } from "@/lib/hooks/use-decrypted";
import { t } from "@/lib/i18n/ja";
import { cn } from "@/lib/utils";

/** Closes the vault by hand, saying so when work in progress delays it. */
export async function closeVaultNow(): Promise<void> {
  if ((await vault.close("manual")) === "deferred") toast("処理が終わったら金庫を閉じます");
}

/**
 * Shown only while the vault is open: it is the state that lasts for a while
 * and that someone handing their phone over would want to end. A closed
 * vault is already obvious from every locked note.
 */
export function VaultBadge({
  compact = false,
  className,
  container,
}: {
  compact?: boolean;
  className?: string;
  /** Set inside the phone's folder drawer, whose focus trap would close it. */
  container?: HTMLElement | null;
}) {
  const unlocked = useVaultUnlocked();
  if (!unlocked) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size={compact ? "icon-sm" : "sm"}
          className={cn("text-muted-foreground gap-1.5 text-xs", className)}
          aria-label={t.vault.isOpen}
        >
          <LockOpen className="size-3.5" aria-hidden />
          {compact ? null : <span className="hidden sm:inline">{t.vault.isOpen}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3" portalContainer={container}>
        <div className="space-y-1">
          <p className="text-sm font-medium">金庫は開いています</p>
          <p className="text-muted-foreground text-xs">
            ロックしたメモを読んだり編集したりできます。{vault.autoLockMinutes}{" "}
            分間操作がないと自動で閉じます。
          </p>
        </div>
        <Button size="sm" className="w-full" onClick={() => void closeVaultNow()}>
          {t.vault.closeNow}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
