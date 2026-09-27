"use client";

import { RotateCw } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/**
 * On the page shown in place of one not kept for offline use: loads the
 * page asked for as soon as the network is back, since the app no longer
 * reloads by itself then; and a button for it, which a home-screen app,
 * with no browser around it, has no other way of offering.
 */
export function ReloadWhenOnline() {
  useEffect(() => {
    const reload = () => window.location.reload();
    window.addEventListener("online", reload);
    return () => window.removeEventListener("online", reload);
  }, []);
  return (
    <Button
      variant="outline"
      size="sm"
      className="gap-1.5"
      onClick={() => window.location.reload()}
    >
      <RotateCw className="size-3.5" aria-hidden />
      もう一度読み込む
    </Button>
  );
}
