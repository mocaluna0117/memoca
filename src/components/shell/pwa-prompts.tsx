"use client";

import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

/**
 * Offers installation where the browser supports it, and tells people when a
 * new version is ready instead of reloading under them mid-sentence.
 *
 * iOS has no install event at all; the settings screen explains the Share
 * sheet route there.
 */
export function PwaPrompts() {
  const [installer, setInstaller] = useState<InstallPrompt | null>(null);

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstaller(event as InstallPrompt);
    };
    const onInstalled = () => setInstaller(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let notified = false;

    const announce = (registration: ServiceWorkerRegistration) => {
      if (notified || !registration.waiting) return;
      notified = true;
      toast("新しいバージョンがあります", {
        duration: Number.POSITIVE_INFINITY,
        action: {
          label: "更新",
          onClick: () => {
            registration.waiting?.postMessage({ type: "SKIP_WAITING" });
            window.location.reload();
          },
        },
      });
    };

    void navigator.serviceWorker.getRegistration().then((registration) => {
      if (!registration) return;
      announce(registration);
      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        installing?.addEventListener("statechange", () => {
          if (installing.state === "installed" && navigator.serviceWorker.controller) {
            announce(registration);
          }
        });
      });
    });
  }, []);

  if (!installer) return null;

  return (
    <div
      className="bg-card fixed inset-x-3 bottom-16 z-40 flex items-center gap-3 rounded-lg border p-3 shadow-lg md:right-4 md:bottom-4 md:left-auto md:w-80"
      style={{ marginBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <Download className="text-muted-foreground size-5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">アプリとして使う</p>
        <p className="text-muted-foreground text-xs">
          ホーム画面から開けて、オフラインでも書けます。
        </p>
      </div>
      <Button
        size="sm"
        onClick={async () => {
          await installer.prompt();
          await installer.userChoice;
          setInstaller(null);
        }}
      >
        追加
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-label="閉じる"
        onClick={() => setInstaller(null)}
      >
        ×
      </Button>
    </div>
  );
}
