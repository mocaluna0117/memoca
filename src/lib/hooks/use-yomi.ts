"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useState, useSyncExternalStore } from "react";
import { db, getMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
import {
  backfillReadings,
  disableYomi,
  enableYomi,
  onYomiState,
  releaseYomi,
  setYomiKept,
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
  /** Whether the dictionary is kept on this device, or downloaded for each use. */
  kept: boolean | undefined;
  setKept: (keep: boolean) => Promise<void>;
  /** Notes whose reading has not been worked out yet (written since, say). */
  unread: number;
  /** Downloads the dictionary (if not kept) and works out the readings not yet worked out. */
  use: () => Promise<void>;
  /** Lets the dictionary go from memory now. */
  release: () => void;
  /** Loads the dictionary now, for a screen about to need it. */
  warm: () => void;
};

export function useYomi(): YomiControls {
  const enabled = useLiveQuery(async () => getMeta<boolean>(META.yomi, false), []);
  const kept = useLiveQuery(async () => getMeta<boolean>(META.yomiKeep, false), []);
  const unread = useLiveQuery(
    () => db().bodies.filter((row) => row.reading === undefined || row.reading === null).count(),
    [],
    0,
  );
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

  const use = useCallback(async () => {
    setBusy(true);
    setProgress({ done: 0, total: 0 });
    try {
      if (await warmYomi()) await backfillReadings((done, total) => setProgress({ done, total }));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, []);

  const setKept = useCallback((keep: boolean) => setYomiKept(keep), []);

  return {
    enabled,
    state,
    progress,
    busy,
    enable,
    disable,
    warm,
    kept,
    setKept,
    unread,
    use,
    release: releaseYomi,
  };
}
