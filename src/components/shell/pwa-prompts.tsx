"use client";

import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { flushAll } from "@/lib/sync/docs";

/** How often a page left open looks for a new version of the app. */
export const UPDATE_CHECK_MS = 30 * 60 * 1000;

/** This page's build, written into its scripts as they were built (next.config.ts). */
const PAGE_BUILD = process.env.MEMOCA_BUILD ?? "dev";

/** The offer's toast: one at a time, put away when the workspace is left. */
const OFFER = "new-version";

/** A worker of another build has taken this page over: out of date until it is loaded again. */
let outdated = false;

/** Which build a worker is of (sw.ts answers); null if it does not say. */
function buildOf(worker: ServiceWorker, ms = 3_000): Promise<string | null> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const done = (build: string | null) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(build);
    };
    const timer = setTimeout(() => done(null), ms);
    channel.port1.onmessage = (event) => done(typeof event.data === "string" ? event.data : null);
    worker.postMessage({ type: "BUILD" }, [channel.port2]);
  });
}

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
    const workers = navigator.serviceWorker;
    let current = true;
    const show = () =>
      toast("新しいバージョンがあります", {
        id: OFFER,
        duration: Number.POSITIVE_INFINITY,
        action: {
          label: "更新",
          // What was typed in the last moment is stored before the page goes.
          onClick: () => void flushAll().finally(() => window.location.reload()),
        },
      });
    // Back from the quick note, say: offered again.
    if (outdated) show();

    // The worker starts as soon as it is installed and takes the page over
    // (skipWaiting, clientsClaim), so none ever waits: what tells is its
    // taking over. It is news only if it is of another build than this
    // page's scripts: not a first visit's, not one claiming a page loaded
    // past it (a hard reload), and not one found as this page came, new,
    // from the network (the shells are fetched from it first).
    const onTakeover = () => {
      const worker = workers.controller;
      if (!worker) return;
      void buildOf(worker).then((theirs) => {
        if (theirs === PAGE_BUILD) return;
        outdated = true;
        if (current) show();
      });
    };
    workers.addEventListener("controllerchange", onTakeover);

    // A page left open, as a computer's is, would not look for a new
    // version on its own: every so often while it is in sight, then, and
    // at once when the network comes back.
    let checked = Date.now();
    const check = () => {
      if (document.visibilityState !== "visible" || Date.now() - checked < UPDATE_CHECK_MS) return;
      checked = Date.now();
      void workers
        .getRegistration()
        .then((registration) => registration?.update())
        .catch(() => undefined);
    };
    const onOnline = () => {
      checked = 0;
      check();
    };
    const timer = setInterval(check, UPDATE_CHECK_MS);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("online", onOnline);

    return () => {
      current = false;
      workers.removeEventListener("controllerchange", onTakeover);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("online", onOnline);
      clearInterval(timer);
      // Not carried over to the quick note, where it would sit on 保存.
      toast.dismiss(OFFER);
    };
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
