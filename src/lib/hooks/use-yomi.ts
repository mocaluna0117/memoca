"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { isYomiOn, onYomiOn, turnYomiOff, turnYomiOn } from "@/lib/search/yomi";

export type YomiControls = {
  /** Whether reading search is turned on, for as long as this page is open. */
  on: boolean;
  /** Turning on: the dictionary being downloaded, or readings worked out. */
  busy: boolean;
  progress: { done: number; total: number } | null;
  /** Turns it on; throws the reason it could not be. */
  turnOn: () => Promise<void>;
  turnOff: () => void;
};

/** Reading search's switch, and what turning it on is doing. */
export function useYomi(): YomiControls {
  const on = useSyncExternalStore(onYomiOn, isYomiOn, () => false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const turnOn = useCallback(async () => {
    setBusy(true);
    setProgress({ done: 0, total: 0 });
    try {
      await turnYomiOn((done, total) => setProgress({ done, total }));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, []);

  return { on, busy, progress, turnOn, turnOff: turnYomiOff };
}
