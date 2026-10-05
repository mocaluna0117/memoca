"use client";

import { useConvex, useQuery } from "convex/react";
import { useLiveQuery } from "dexie-react-hooks";
import { usePathname } from "next/navigation";
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
  quotaFull: false,
};

/**
 * Starts the background sync once an account exists, and keeps the rest of the
 * app from having to know whether it is online.
 *
 * The account snapshot is cached on the device, because otherwise a reload with
 * no network would hang on the server query and the app would show a spinner
 * over data it already has.
 */
export function SyncProvider({
  signedInAs = null,
  children,
}: {
  /** The account signed in, as the page's token says (see tokenSubject). */
  signedInAs?: string | null;
  children: ReactNode;
}) {
  const client = useConvex();
  const remote = useQuery(api.users.me);
  const [status, setStatus] = useState<SyncStatus>(IDLE);
  const [provision, setProvision] = useState<Provision>("pending");
  const engineRef = useRef<SyncEngine | null>(null);
  /** The running engine, once it has started. */
  const startedRef = useRef<Promise<SyncEngine> | null>(null);
  /** The engine whose bodies have been fetched ahead, so they are fetched once. */
  const prefetchedRef = useRef<SyncEngine | null>(null);

  // What the device holds of an account: its profile, and whose data it is.
  const local = useLiveQuery(
    async () => ({
      profile: (await getMeta<ServerProfile | null>(META.profile, null)) ?? null,
      owner: await getMeta<string | null>(META.userKey, null),
    }),
    [],
    undefined,
  );

  // The profile kept here is that of the last account to sync on this
  // device. Someone else signing in on the same browser (the last one's
  // session having run out, rather than been signed out of) is neither shown
  // it nor has sync started on that account's data while the server has yet
  // to answer: only the account signed in has its own profile read from here.
  const cached =
    local === undefined
      ? undefined
      : local.profile && (!signedInAs || local.profile.userKey === signedInAs)
        ? local.profile
        : null;

  // Keep the on-device copy in step whenever the server answers, once the
  // data here is that account's: the engine wipes another's first, profile
  // and all, and a copy written before would go with it.
  const owner = local?.owner;
  useEffect(() => {
    if (remote && (owner === null || owner === remote.userKey)) void setMeta(META.profile, remote);
  }, [remote, owner]);

  const me = remote ?? cached ?? null;
  /** The device's data is this account's (or there is none): it may be shown. */
  const ours = me !== null && owner !== undefined && (owner === null || owner === me.userKey);

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
    startedRef.current = next.start(userKey).then(() => next);
    return () => {
      unsubscribe();
      next.stop();
      engineRef.current = null;
      void flushAll();
      // Another account's vault must not stay open for whoever signs in next.
      vault.lock();
    };
  }, [client, userKey]);

  // Bodies are fetched ahead only where they are read: the quick note,
  // opened to jot one line down, has no use for them.
  const inNotes = usePathname().startsWith("/app");
  useEffect(() => {
    const started = startedRef.current;
    if (!inNotes || !started) return;
    let current = true;
    void started.then((engine) => {
      if (!current || engine !== engineRef.current || prefetchedRef.current === engine) return;
      prefetchedRef.current = engine;
      void engine.prefetchBodies();
    });
    return () => {
      current = false;
    };
  }, [inNotes, userKey]);

  const autoLockMinutes = me?.settings.autoLockMinutes;
  useEffect(() => {
    if (autoLockMinutes) vault.setAutoLockMinutes(autoLockMinutes);
  }, [autoLockMinutes]);

  const gate: SyncContextValue["gate"] = ours
    ? "ready"
    : me
      ? "loading"
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
