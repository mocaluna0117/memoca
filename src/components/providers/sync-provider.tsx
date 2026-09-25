"use client";

import { useConvex, useQuery } from "convex/react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { uuidv7 } from "uuidv7";
import { api } from "@convex/_generated/api";
import { vault } from "@/lib/crypto/vault";
import { db, getMeta, setMeta } from "@/lib/db";
import { META, deviceId } from "@/lib/db/meta";
import { flushAll } from "@/lib/sync/docs";
import { SyncEngine, type SyncStatus } from "@/lib/sync/engine";

type ServerProfile = NonNullable<
  Exclude<ReturnType<typeof useQuery<typeof api.users.me>>, undefined>
>;

/** Result of provisioning, which only matters before an account row exists. */
type Provision = "pending" | "created" | "closed" | "badInvite";

type SyncContextValue = {
  engine: () => SyncEngine | null;
  status: SyncStatus;
  /** The account, from the server when reachable and from disk when not. */
  me: ServerProfile | null;
  gate: "loading" | "ready" | "closed" | "badInvite";
  submitInvite: (code: string) => Promise<void>;
};

const SyncContext = createContext<SyncContextValue | null>(null);

export function useSync(): SyncContextValue {
  const value = useContext(SyncContext);
  if (!value) throw new Error("useSync must be used inside SyncProvider");
  return value;
}

/**
 * Creates the app-side account row for a freshly signed-in person. Kept outside
 * the component so the only state change happens at the call site, after the
 * network round trip.
 */
async function provisionAccount(
  client: ReturnType<typeof useConvex>,
  inviteCode?: string,
): Promise<Provision> {
  const result = await client.mutation(api.users.ensure, {
    deviceId: await deviceId(),
    inboxFolderId: uuidv7(),
    ...(inviteCode ? { inviteCode } : {}),
  });
  if (result.status === "closed") return "closed";
  if (result.status === "badInvite") return "badInvite";
  return "created";
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
 *
 * The account snapshot is cached on the device, because otherwise a reload with
 * no network would hang on the server query and the app would show a spinner
 * over data it already has.
 */
export function SyncProvider({ children }: { children: ReactNode }) {
  const client = useConvex();
  const remote = useQuery(api.users.me);
  const [status, setStatus] = useState<SyncStatus>(IDLE);
  const [provision, setProvision] = useState<Provision>("pending");
  const engineRef = useRef<SyncEngine | null>(null);

  const cached = useLiveQuery(
    async () => (await getMeta<ServerProfile | null>(META.profile, null)) ?? null,
    [],
    undefined,
  );

  // Keep the on-device copy in step whenever the server answers.
  useEffect(() => {
    if (remote) void setMeta(META.profile, remote);
  }, [remote]);

  const me = remote ?? cached ?? null;

  const missing = remote === null && cached === null;
  useEffect(() => {
    if (!missing) return;
    let cancelled = false;
    void (async () => {
      const result = await provisionAccount(client);
      if (!cancelled) setProvision(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [missing, client]);

  const submitInvite = useCallback(
    async (inviteCode: string) => {
      setProvision(await provisionAccount(client, inviteCode));
    },
    [client],
  );

  const userKey = me?.userKey ?? null;
  useEffect(() => {
    if (!userKey) return;
    const next = new SyncEngine(client);
    engineRef.current = next;
    const unsubscribe = next.subscribe(setStatus);
    void next.start(userKey).then(() => next.prefetchBodies());
    return () => {
      unsubscribe();
      next.stop();
      engineRef.current = null;
      void flushAll();
      // Another account's vault must not stay open for whoever signs in next.
      vault.lock();
    };
  }, [client, userKey]);

  const autoLockMinutes = me?.settings.autoLockMinutes;
  useEffect(() => {
    if (autoLockMinutes) vault.setAutoLockMinutes(autoLockMinutes);
  }, [autoLockMinutes]);

  const gate: SyncContextValue["gate"] = me
    ? "ready"
    : provision === "closed"
      ? "closed"
      : provision === "badInvite"
        ? "badInvite"
        : "loading";

  const value = useMemo<SyncContextValue>(
    () => ({
      engine: () => engineRef.current,
      status,
      me,
      gate,
      submitInvite,
    }),
    [status, me, gate, submitInvite],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

/** Wipes the cached profile along with the rest of the device's data. */
export async function clearCachedProfile(): Promise<void> {
  await db().meta.delete(META.profile);
}
