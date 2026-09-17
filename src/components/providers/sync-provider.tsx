"use client";

import { useConvex, useQuery } from "convex/react";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { uuidv7 } from "uuidv7";
import { api } from "@convex/_generated/api";
import { vault } from "@/lib/crypto/vault";
import { deviceId } from "@/lib/db/meta";
import { SyncEngine, type SyncStatus } from "@/lib/sync/engine";
import { flushAll } from "@/lib/sync/docs";

type Me = NonNullable<ReturnType<typeof useMe>>;
function useMe() {
  return useQuery(api.users.me);
}

type SyncContextValue = {
  engine: SyncEngine | null;
  status: SyncStatus;
  me: Me | null | undefined;
  /** "provisioning" while the account row is being created on first sign-in. */
  gate: "loading" | "ready" | "provisioning" | "closed" | "badInvite";
  submitInvite: (code: string) => Promise<void>;
};

const SyncContext = createContext<SyncContextValue | null>(null);

export function useSync(): SyncContextValue {
  const value = useContext(SyncContext);
  if (!value) throw new Error("useSync must be used inside SyncProvider");
  return value;
}

const IDLE: SyncStatus = {
  state: "idle",
  pending: 0,
  lastSyncAt: null,
  catchingUp: false,
};

/**
 * Starts the background sync once an account exists, and keeps the rest of the
 * app from having to know whether it is online.
 */
export function SyncProvider({ children }: { children: ReactNode }) {
  const client = useConvex();
  const me = useMe();
  const [engine, setEngine] = useState<SyncEngine | null>(null);
  const [status, setStatus] = useState<SyncStatus>(IDLE);
  const [gate, setGate] = useState<SyncContextValue["gate"]>("loading");

  const ensure = async (inviteCode?: string) => {
    setGate("provisioning");
    const result = await client.mutation(api.users.ensure, {
      deviceId: await deviceId(),
      inboxFolderId: uuidv7(),
      ...(inviteCode ? { inviteCode } : {}),
    });
    if (result.status === "closed") setGate("closed");
    else if (result.status === "badInvite") setGate("badInvite");
    else setGate("ready");
  };

  useEffect(() => {
    if (me === undefined) return;
    if (me === null) {
      void ensure();
      return;
    }
    setGate("ready");
  }, [me === undefined ? "loading" : me === null ? "missing" : "present"]);

  useEffect(() => {
    if (!me) return;
    const next = new SyncEngine(client);
    const unsubscribe = next.subscribe(setStatus);
    void next.start(me.userKey).then(() => next.prefetchBodies());
    setEngine(next);
    return () => {
      unsubscribe();
      next.stop();
      void flushAll();
    };
  }, [client, me?.userKey]);

  // Auto-lock uses the person's own setting rather than a fixed timeout.
  useEffect(() => {
    if (me) vault.setAutoLockMinutes(me.settings.autoLockMinutes);
  }, [me?.settings.autoLockMinutes]);

  const value = useMemo<SyncContextValue>(
    () => ({ engine, status, me, gate, submitInvite: (code) => ensure(code) }),
    [engine, status, me, gate],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}
