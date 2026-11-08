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
  useSyncExternalStore,
} from "react";
import { uuidv7 } from "uuidv7";
import { api } from "@convex/_generated/api";
import { vault } from "@/lib/crypto/vault";
import { db, getMeta, setMeta } from "@/lib/db";
import type { Allowance } from "@/lib/media/attachments";
import { META, deviceId } from "@/lib/db/meta";
import { flushAll } from "@/lib/sync/docs";
import { SyncEngine, type SyncStatus } from "@/lib/sync/engine";
import { type StatusStore, createStatusStore } from "@/lib/sync/status-store";

type ServerProfile = NonNullable<
  Exclude<ReturnType<typeof useQuery<typeof api.users.me>>, undefined>
>;

/**
 * The account, without its storage figures: those change with every push
 * (each edit sent is counted), and through `me` every reader of the account
 * (the shell, the sidebar and every folder row, the editor) was drawn again
 * with every flush of a note being typed in. They are read apart, by
 * {@link useStorageUsage} where they are shown and {@link useAllowance}
 * where a file is checked against them.
 */
export type Profile = Omit<ServerProfile, "usedBytes" | "reservedBytes">;
/** The account's storage figures, as the quota bar shows them. */
export type StorageUsage = Pick<ServerProfile, "quotaBytes" | "usedBytes" | "reservedBytes"> & {
  /** As Allowance has them: a profile kept from before the video limit was reported has none. */
  limits?: { maxImageBytes: number; maxVideoBytes?: number };
};

/** Result of provisioning, which only matters before an account row exists. */
type Provision = "pending" | "created" | "closed" | "badInvite";

type SyncContextValue = {
  engine: () => SyncEngine | null;
  /** The account, from the server when reachable and from disk when not. */
  me: Profile | null;
  gate: "loading" | "ready" | "closed" | "badInvite";
  submitInvite: (code: string) => Promise<void>;
};

const SyncContext = createContext<SyncContextValue | null>(null);
/** The storage figures apart (see Profile): only what shows them follows them. */
const UsageContext = createContext<StorageUsage | null | undefined>(undefined);
/**
 * The storage figures as they are at the moment asked, by one function for
 * the app's whole life: for a file checked as it arrives, with nothing
 * drawn again as the figures move.
 */
const AllowanceContext = createContext<(() => Allowance | null) | null>(null);
/**
 * The status apart from the rest: it changes with every flush of a note being
 * typed in, and only the badge and the lock repairs follow it. Through the
 * context, each change would draw everything that reads anything of sync.
 */
const SyncStatusContext = createContext<StatusStore | null>(null);
/**
 * The engine alone, by one function for the app's whole life, for those who
 * need nothing else of sync. The value of SyncContext is made again whenever
 * the account's row does, which every push does (the room it uses), and each
 * of them would be drawn again with every flush of a note being typed in:
 * the note list and the folder tree among them (useLockActions).
 */
const SyncEngineContext = createContext<(() => SyncEngine | null) | null>(null);

/** How often making the account is asked again when the server could not answer, and after how long (times the try). */
const PROVISION_TRIES = 6;
const PROVISION_RETRY_MS = 2_000;

const IDLE: SyncStatus = {
  state: "idle",
  pending: 0,
  lastSyncAt: null,
  catchingUp: false,
  quotaFull: false,
  heldForVault: false,
  stuck: 0,
  uploadRefused: false,
  saveFailed: false,
};

export function useSync(): SyncContextValue {
  const value = useContext(SyncContext);
  if (!value) throw new Error("useSync must be used inside SyncProvider");
  return value;
}

/** The account's storage figures, drawn again as they move; null before the account is known. */
export function useStorageUsage(): StorageUsage | null {
  const usage = useContext(UsageContext);
  if (usage === undefined) throw new Error("useStorageUsage must be used inside SyncProvider");
  return usage;
}

/** The storage figures at the moment asked (see AllowanceContext). */
export function useAllowance(): () => Allowance | null {
  const allowance = useContext(AllowanceContext);
  if (!allowance) throw new Error("useAllowance must be used inside SyncProvider");
  return allowance;
}

const serverStatus = () => IDLE;

/** The running engine, if there is one, without what else sync holds (see SyncEngineContext). */
export function useSyncEngine(): () => SyncEngine | null {
  const engine = useContext(SyncEngineContext);
  if (!engine) throw new Error("useSyncEngine must be used inside SyncProvider");
  return engine;
}

/** Where syncing stands, drawn again only when it changes. */
export function useSyncStatus(): SyncStatus {
  const store = useContext(SyncStatusContext);
  if (!store) throw new Error("useSyncStatus must be used inside SyncProvider");
  return useSyncExternalStore(store.subscribe, store.get, serverStatus);
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
  const [store] = useState(() => createStatusStore(IDLE));
  const [provision, setProvision] = useState<Provision>("pending");
  const engineRef = useRef<SyncEngine | null>(null);
  /** The engine of the moment, by one function for the app's whole life. */
  const engine = useCallback(() => engineRef.current, []);
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

  // The account apart from its storage figures, the same object for as long
  // as it says the same (see Profile): by its text, as the server's answer is
  // a new object with every push.
  const profileKey = me === null ? null : JSON.stringify(withoutUsage(me));
  const profile = useMemo<Profile | null>(
    () => (profileKey === null ? null : (JSON.parse(profileKey) as Profile)),
    [profileKey],
  );
  const quotaBytes = me?.quotaBytes;
  const usedBytes = me?.usedBytes;
  const reservedBytes = me?.reservedBytes;
  const maxImageBytes = me?.limits?.maxImageBytes;
  const maxVideoBytes = me?.limits?.maxVideoBytes;
  const usage = useMemo<StorageUsage | null>(
    () =>
      quotaBytes === undefined || usedBytes === undefined || reservedBytes === undefined
        ? null
        : {
            quotaBytes,
            usedBytes,
            reservedBytes,
            ...(maxImageBytes === undefined
              ? {}
              : { limits: { maxImageBytes, ...(maxVideoBytes === undefined ? {} : { maxVideoBytes }) } }),
          },
    [quotaBytes, usedBytes, reservedBytes, maxImageBytes, maxVideoBytes],
  );
  const usageRef = useRef<StorageUsage | null>(usage);
  useEffect(() => {
    usageRef.current = usage;
  }, [usage]);
  const allowance = useCallback(() => usageRef.current, []);

  const missing = remote === null && cached === null;
  useEffect(() => {
    if (!missing) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Asked again a little later, a few times, when the server could not
    // answer (busy, the connection dropped): failed once, the account was
    // never made, and the app stayed on its loading screen until reloaded.
    const ask = async (tries: number) => {
      try {
        const result = await provisionAccount(client);
        if (!cancelled) setProvision(result);
      } catch {
        if (cancelled || tries >= PROVISION_TRIES) return;
        timer = setTimeout(() => void ask(tries + 1), PROVISION_RETRY_MS * tries);
      }
    };
    void ask(1);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
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
    const unsubscribe = next.subscribe(store.set);
    startedRef.current = next.start(userKey).then(() => next);
    return () => {
      unsubscribe();
      next.stop();
      engineRef.current = null;
      store.set(IDLE);
      void flushAll();
      // Another account's vault must not stay open for whoever signs in next.
      vault.lock();
    };
  }, [client, userKey, store]);

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
    () => ({ engine, me: profile, gate, submitInvite }),
    [engine, profile, gate, submitInvite],
  );

  return (
    <SyncContext.Provider value={value}>
      <UsageContext.Provider value={usage}>
        <AllowanceContext.Provider value={allowance}>
          <SyncEngineContext.Provider value={engine}>
            <SyncStatusContext.Provider value={store}>{children}</SyncStatusContext.Provider>
          </SyncEngineContext.Provider>
        </AllowanceContext.Provider>
      </UsageContext.Provider>
    </SyncContext.Provider>
  );
}

/** The account as the server reports it, less the storage figures (see Profile). */
function withoutUsage(me: ServerProfile): Profile {
  const { usedBytes: _used, reservedBytes: _reserved, ...rest } = me;
  void _used;
  void _reserved;
  return rest;
}

/** Wipes the cached profile along with the rest of the device's data. */
export async function clearCachedProfile(): Promise<void> {
  await db().meta.delete(META.profile);
}
