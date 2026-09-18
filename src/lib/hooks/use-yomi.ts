"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useState, useSyncExternalStore } from "react";
import { getMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
import {
  disableYomi,
  enableYomi,
  onYomiState,
  warmYomi,
  type YomiState,
  yomiState,
} from "@/lib/search/yomi";

export type YomiControls = {
  /** Whether the person has opted into reading search. */
  enabled: boolean | undefined;
  /** Where the dictionary is in its life cycle. */
  state: YomiState;
  progress: { done: number; total: number } | null;
  busy: boolean;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  /** Loads the dictionary now, for a screen about to need it. */
  warm: () => void;
};

export function useYomi(): YomiControls {
  const enabled = useLiveQuery(async () => getMeta<boolean>(META.yomi, false), []);
  const state = useSyncExternalStore(onYomiState, yomiState, () => "idle" as const);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const enable = useCallback(async () => {
    setBusy(true);
    setProgress({ done: 0, total: 0 });
    try {
      await enableYomi((done, total) => setProgress({ done, total }));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, []);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      await disableYomi();
    } finally {
      setBusy(false);
    }
  }, []);

  const warm = useCallback(() => {
    void warmYomi();
  }, []);

  return { enabled, state, progress, busy, enable, disable, warm };
}
