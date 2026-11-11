"use client";

import { useMutation } from "convex/react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "@convex/_generated/api";
import { useSync } from "@/components/providers/sync-provider";
import {
  type GuideFlow,
  type GuideState,
  type GuideWindow,
  SHOW_WELCOME,
  clearStaleGuide,
  guideFrom,
  rememberDesktopGuideDone,
  setGuide,
  storedGuide,
  subscribeGuide,
} from "@/lib/guide";
import { useClientValue } from "@/lib/hooks/use-client-value";
import { inShell } from "@/lib/quick/shell";
import { rememberWelcomeSeen, welcomeOff, welcomeSeenHere } from "@/lib/welcome";

/** The cards, loaded only once there is a guide to show. */
const GuideCard = dynamic(() => import("./guide-card").then((m) => m.GuideCard), { ssr: false });

const shellOf = () => window.memocaShell ?? null;

/**
 * The hands-on welcome (lib/guide), in every page of the account's, /app
 * and /quick alike, so it goes on from one to the other, and from one of
 * the desktop app's windows to the other.
 *
 * - The web's: once an account, on its first /app (not a /quick a share
 *   opened), in a browser or on a phone. Not in the desktop app.
 * - The desktop app's: about its hotkeys and its two windows, from
 *   「はじめの案内をもう一度見る」 (once a computer, of itself, to come).
 *
 * Neither on a device the tests turn it off on (lib/welcome).
 */
export function Guide() {
  const { me } = useSync();
  const pathname = usePathname();
  const markWelcomed = useMutation(api.users.markWelcomed);
  const shell = useClientValue(shellOf, null);
  // The desktop app's window, by its bridge or by its name (a page of it
  // that has no bridge yet): never the web's guide there.
  const desktop = useClientValue(inShell, false);
  const raw = useSyncExternalStore(subscribeGuide, storedGuide, () => null);
  const [declinedBy, setDeclinedBy] = useState<string | null>(null);
  const here: GuideWindow = pathname.startsWith("/quick") ? "quick" : "app";
  const flowHere: GuideFlow = shell ? "desktop" : "web";
  const userKey = me?.userKey ?? null;
  const off = useClientValue(welcomeOff, true);

  // As stored, for this kind of device: the desktop app's never in a
  // browser, the web's never in the desktop app.
  const stored = guideFrom(raw);
  const kept = stored && stored.flow === flowHere ? stored : null;

  // Left at a step for long: over.
  useEffect(() => clearStaleGuide(), [raw]);

  // Asked for again: from its start, in this window.
  useEffect(() => {
    const show = () => setGuide({ flow: flowHere, step: "intro", at: Date.now(), startedIn: here, asked: true });
    window.addEventListener(SHOW_WELCOME, show);
    return () => window.removeEventListener(SHOW_WELCOME, show);
  }, [flowHere, here]);

  // The quick note opened, for the web's guide waiting on it: in this tab
  // (a phone), or in a window of its own (a computer), whose guide is this.
  const step = kept?.step;
  useEffect(() => {
    if (kept?.flow === "web" && step === "open-quick" && here === "quick") {
      setGuide({ flow: "web", step: "save-quick", at: Date.now(), done: true, asked: kept.asked });
    }
  }, [kept?.flow, kept?.asked, step, here]);

  // The desktop app's window out, however it was (the quick note's button,
  // the menu bar's menu): the guide goes on in it.
  useEffect(() => {
    if (kept?.flow !== "desktop" || step !== "open-app" || here !== "app") return;
    const out = () => {
      if (document.visibilityState === "visible" && document.hasFocus()) {
        setGuide({ flow: "desktop", step: "app-here", at: Date.now(), done: true, asked: kept.asked });
      }
    };
    window.addEventListener("focus", out);
    return () => window.removeEventListener("focus", out);
  }, [kept?.flow, kept?.asked, step, here]);

  // A new account's first /app, in a browser or on a phone: its first card,
  // until it is taken up or turned down.
  const due =
    !desktop &&
    here === "app" &&
    userKey !== null &&
    me?.welcomed === false &&
    declinedBy !== userKey &&
    !welcomeSeenHere(userKey);
  const shown: GuideState | null = off ? null : (kept ?? (due ? { flow: "web", step: "intro", at: 0, startedIn: "app" } : null));
  if (!shown) return null;
  // The first card only where it was started; the others say where to go on.
  if (shown.step === "intro" && shown.startedIn && shown.startedIn !== here) return null;

  /**
   * Taken up or turned down: the web's not offered this account again, nor
   * the desktop app's this computer (one asked for leaves that as it was).
   */
  const settle = (flow: GuideFlow) => {
    if (flow === "web") {
      if (userKey) {
        setDeclinedBy(userKey);
        rememberWelcomeSeen(userKey);
        void markWelcomed({}).catch(() => undefined);
      }
    } else if (!shown.asked) {
      rememberDesktopGuideDone();
    }
  };

  return (
    <GuideCard
      state={shown}
      here={here}
      shell={shell}
      onStart={() => {
        settle(shown.flow);
        if (shown.flow === "desktop" && here === "app") {
          // On in the quick note's window, brought out for it.
          setGuide({ flow: "desktop", step: "write", at: Date.now(), asked: shown.asked });
          window.memocaShell?.showQuick?.();
          return;
        }
        setGuide({
          flow: shown.flow,
          step: shown.flow === "web" ? "open-quick" : "write",
          at: Date.now(),
          asked: shown.asked,
        });
      }}
      onEnd={() => {
        settle(shown.flow);
        setGuide(null);
      }}
    />
  );
}
