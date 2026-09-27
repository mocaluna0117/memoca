"use client";

import { RotateCw } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useClientValue } from "@/lib/hooks/use-client-value";

/**
 * On the page shown in place of one not kept for offline use: loads the
 * page asked for as soon as the network is back, since the app no longer
 * reloads by itself then; and a button for it, which a home-screen app,
 * with no browser around it, has no other way of offering.
 *
 * The button is offered once the page has started: before, a press would
 * do nothing, and the network coming back would go unnoticed.
 */
export function ReloadWhenOnline() {
  const started = useClientValue(() => true, false);
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
      disabled={!started}
      onClick={() => window.location.reload()}
    >
      <RotateCw className="size-3.5" aria-hidden />
      もう一度読み込む
    </Button>
  );
}
