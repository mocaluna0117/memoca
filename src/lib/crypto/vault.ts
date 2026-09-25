"use client";

import { toArrayBuffer, toBytes } from "@/lib/bytes";
import type { Sealed } from "@/lib/types";
import { ctx, HKDF_INFO } from "./context";
import {
  type ArgonParams,
  DEFAULT_ARGON,
  KEY_BYTES,
  argonKey,
  hkdfKey,
  importAesKey,
  open,
  randomBytes,
  seal,
  wipe,
} from "./primitives";

export type VaultRecord = {
  argon: ArgonParams;
  saltPw: ArrayBuffer;
  pwWrap: Sealed;
  recWrap: { hkdfSalt: ArrayBuffer; ct: ArrayBuffer; iv: ArrayBuffer } | null;
  passkeys: {
    credentialId: string;
    prfInput: ArrayBuffer;
    hkdfSalt: ArrayBuffer;
    ct: ArrayBuffer;
    iv: ArrayBuffer;
    label: string;
    createdAt: number;
  }[];
  version: number;
};

/**
 * Holds the unwrapped vault key for as long as the app is unlocked.
 *
 * The key is a non-extractable CryptoKey, so even code running on the page
 * cannot read its bytes back out. It lives only in memory: an iOS process kill,
 * a tab close or the auto-lock timer all drop it, and the next unlock is one
 * Face ID prompt away.
 */
class VaultSession {
  private key: CryptoKey | null = null;
  private noteKeys = new Map<string, CryptoKey>();
  private listeners = new Set<(unlocked: boolean) => void>();
  private lockTimer: ReturnType<typeof setTimeout> | null = null;
  private autoLockMs = 5 * 60_000;

  get isUnlocked(): boolean {
    return this.key !== null;
  }

  subscribe(listener: (unlocked: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of this.listeners) listener(this.isUnlocked);
  }

  setAutoLockMinutes(minutes: number) {
    this.autoLockMs = Math.max(1, minutes) * 60_000;
    if (this.key) this.touch();
  }

  /** Restarts the inactivity countdown. Called on any meaningful interaction. */
  touch() {
    if (!this.key) return;
    if (this.lockTimer) clearTimeout(this.lockTimer);
    this.lockTimer = setTimeout(() => this.lock(), this.autoLockMs);
  }

  adopt(key: CryptoKey) {
    this.key = key;
    this.noteKeys.clear();
    this.touch();
    this.emit();
  }

  lock() {
    if (this.lockTimer) clearTimeout(this.lockTimer);
    this.lockTimer = null;
    this.key = null;
    this.noteKeys.clear();
    this.emit();
  }

  private require(): CryptoKey {
    if (!this.key) throw new VaultLockedError();
    return this.key;
  }

  /* ---------------------------------------------------------------- notes */

  /** A fresh data key for a note that is about to be locked. */
  async createNoteKey(noteId: string, epoch: number): Promise<{ key: CryptoKey; wrapped: Sealed }> {
    const raw = randomBytes(KEY_BYTES);
    const key = await importAesKey(raw);
    const wrapped = await seal(this.require(), raw, ctx.noteKeyWrap(noteId, epoch));
    wipe(raw);
    this.noteKeys.set(`${noteId}:${epoch}`, key);
    return {
      key,
      wrapped: { ct: toArrayBuffer(wrapped.ct), iv: toArrayBuffer(wrapped.iv) },
    };
  }

  async noteKey(noteId: string, epoch: number, wrapped: Sealed): Promise<CryptoKey> {
    const cacheKey = `${noteId}:${epoch}`;
    const cached = this.noteKeys.get(cacheKey);
    if (cached) return cached;
    const raw = await open(
      this.require(),
      toBytes(wrapped.ct),
      toBytes(wrapped.iv),
      ctx.noteKeyWrap(noteId, epoch),
    );
    const key = await importAesKey(raw);
    wipe(raw);
    this.noteKeys.set(cacheKey, key);
    return key;
  }

  async createAttachmentKey(
    attachmentId: string,
  ): Promise<{ key: CryptoKey; wrapped: Sealed }> {
    const raw = randomBytes(KEY_BYTES);
    const key = await importAesKey(raw);
    const wrapped = await seal(this.require(), raw, ctx.attachmentKeyWrap(attachmentId));
    wipe(raw);
    return {
      key,
      wrapped: { ct: toArrayBuffer(wrapped.ct), iv: toArrayBuffer(wrapped.iv) },
    };
  }

  async attachmentKey(attachmentId: string, wrapped: Sealed): Promise<CryptoKey> {
    const raw = await open(
      this.require(),
      toBytes(wrapped.ct),
      toBytes(wrapped.iv),
      ctx.attachmentKeyWrap(attachmentId),
    );
    const key = await importAesKey(raw);
    wipe(raw);
    return key;
  }

  /* --------------------------------------------------------------- folders */

  async sealFolderName(folderId: string, name: string): Promise<Sealed> {
    const { ct, iv } = await seal(
      this.require(),
      new TextEncoder().encode(name),
      ctx.folderName(folderId),
    );
    return { ct: toArrayBuffer(ct), iv: toArrayBuffer(iv) };
  }

  async openFolderName(folderId: string, sealed: Sealed): Promise<string> {
    const plain = await open(
      this.require(),
      toBytes(sealed.ct),
      toBytes(sealed.iv),
      ctx.folderName(folderId),
    );
    return new TextDecoder().decode(plain);
  }
}

export class VaultLockedError extends Error {
  constructor() {
    super("金庫がロックされています。");
    this.name = "VaultLockedError";
  }
}

export const vault = new VaultSession();

/* ------------------------------------------------------------------ setup */

export type PreparedVault = {
  record: {
    argon: ArgonParams;
    saltPw: ArrayBuffer;
    pwWrap: Sealed;
    recWrap: { hkdfSalt: ArrayBuffer; ct: ArrayBuffer; iv: ArrayBuffer };
  };
  /** Shown once, never stored. Losing every factor means losing the data. */
  recoveryKey: Uint8Array;
  /**
   * Starts using the new key in this session. Call it only once the server
   * has stored `record`: a key the server never saw opens nothing after a
   * reload, and anything locked with it in the meantime is lost.
   */
  adopt(): void;
  /** Throws the key away, for when the server already holds a vault. */
  discard(): void;
};

/**
 * Makes a vault key and wraps it under both a password and a recovery key,
 * without using it yet.
 *
 * Two independent wrappings exist from the very first moment on purpose: a
 * single-factor vault is one forgotten password away from permanent data loss,
 * and no one can reset it for the user.
 *
 * The key is held back until the caller has the server's answer. Adopting it
 * straight away is how an account that already had a vault could end up
 * locking notes under a second key that was never saved.
 */
export async function prepareVault(
  password: string,
  params: ArgonParams = DEFAULT_ARGON,
): Promise<PreparedVault> {
  const vaultRaw = randomBytes(KEY_BYTES);

  const saltPw = randomBytes(16);
  const kekPw = await argonKey(password, saltPw, params);
  const pwWrap = await seal(kekPw, vaultRaw, ctx.vaultWrap("password"));

  const recoveryKey = randomBytes(KEY_BYTES);
  const recSalt = randomBytes(16);
  const kekRec = await hkdfKey(recoveryKey, recSalt, HKDF_INFO.recovery);
  const recWrap = await seal(kekRec, vaultRaw, ctx.vaultWrap("recovery"));

  let key: CryptoKey | null = await importAesKey(vaultRaw);
  wipe(vaultRaw);

  return {
    record: {
      argon: params,
      saltPw: toArrayBuffer(saltPw),
      pwWrap: { ct: toArrayBuffer(pwWrap.ct), iv: toArrayBuffer(pwWrap.iv) },
      recWrap: {
        hkdfSalt: toArrayBuffer(recSalt),
        ct: toArrayBuffer(recWrap.ct),
        iv: toArrayBuffer(recWrap.iv),
      },
    },
    recoveryKey,
    adopt() {
      if (!key) throw new Error("This vault key was already used or thrown away.");
      vault.adopt(key);
      key = null;
    },
    discard() {
      key = null;
      recoveryKey.fill(0);
    },
  };
}

/**
 * Creates the vault on the server and only then starts using its key.
 *
 * `store` sends the record to the server. The order is the whole point: if an
 * account already has a vault ("already"), or the request fails, the new key
 * is thrown away and the existing vault stays the only one.
 */
export async function setUpVault(
  password: string,
  store: (record: PreparedVault["record"]) => Promise<{ status: "ok" | "already" }>,
  params: ArgonParams = DEFAULT_ARGON,
): Promise<{ status: "ok"; recoveryKey: Uint8Array } | { status: "already" }> {
  const prepared = await prepareVault(password, params);
  let result: { status: "ok" | "already" };
  try {
    result = await store(prepared.record);
  } catch (cause) {
    prepared.discard();
    throw cause;
  }
  if (result.status !== "ok") {
    prepared.discard();
    return { status: "already" };
  }
  prepared.adopt();
  return { status: "ok", recoveryKey: prepared.recoveryKey };
}

async function adoptFrom(kek: CryptoKey, wrapped: Sealed, method: "password" | "recovery" | "passkey") {
  const raw = await open(kek, toBytes(wrapped.ct), toBytes(wrapped.iv), ctx.vaultWrap(method));
  vault.adopt(await importAesKey(raw));
  wipe(raw);
}

export async function unlockWithPassword(
  record: VaultRecord,
  password: string,
): Promise<void> {
  const kek = await argonKey(password, toBytes(record.saltPw), record.argon);
  await adoptFrom(kek, record.pwWrap, "password");
}

export async function unlockWithRecoveryKey(
  record: VaultRecord,
  recoveryKey: Uint8Array,
): Promise<void> {
  if (!record.recWrap) throw new Error("リカバリーキーが設定されていません。");
  const kek = await hkdfKey(
    recoveryKey,
    toBytes(record.recWrap.hkdfSalt),
    HKDF_INFO.recovery,
  );
  await adoptFrom(
    kek,
    { ct: record.recWrap.ct, iv: record.recWrap.iv },
    "recovery",
  );
}

export async function unlockWithPrf(
  entry: VaultRecord["passkeys"][number],
  prfOutput: Uint8Array,
): Promise<void> {
  const kek = await hkdfKey(prfOutput, toBytes(entry.hkdfSalt), HKDF_INFO.passkey);
  await adoptFrom(kek, { ct: entry.ct, iv: entry.iv }, "passkey");
}

/**
 * Re-wraps the *same* vault key under a new password. Note contents are keyed
 * separately, so changing a password never rewrites a single document.
 */
export async function rewrapWithPassword(
  record: VaultRecord,
  currentPassword: string,
  nextPassword: string,
  params: ArgonParams = DEFAULT_ARGON,
): Promise<{ argon: ArgonParams; saltPw: ArrayBuffer; pwWrap: Sealed }> {
  const currentKek = await argonKey(currentPassword, toBytes(record.saltPw), record.argon);
  const raw = await open(
    currentKek,
    toBytes(record.pwWrap.ct),
    toBytes(record.pwWrap.iv),
    ctx.vaultWrap("password"),
  );
  const saltPw = randomBytes(16);
  const nextKek = await argonKey(nextPassword, saltPw, params);
  const pwWrap = await seal(nextKek, raw, ctx.vaultWrap("password"));
  wipe(raw);
  return {
    argon: params,
    saltPw: toArrayBuffer(saltPw),
    pwWrap: { ct: toArrayBuffer(pwWrap.ct), iv: toArrayBuffer(pwWrap.iv) },
  };
}

/** Wraps the currently unlocked vault key under a passkey's PRF output. */
export async function wrapForPasskey(
  prfOutput: Uint8Array,
  vaultRaw: Uint8Array,
): Promise<{ hkdfSalt: ArrayBuffer; ct: ArrayBuffer; iv: ArrayBuffer }> {
  const hkdfSalt = randomBytes(16);
  const kek = await hkdfKey(prfOutput, hkdfSalt, HKDF_INFO.passkey);
  const wrapped = await seal(kek, vaultRaw, ctx.vaultWrap("passkey"));
  return {
    hkdfSalt: toArrayBuffer(hkdfSalt),
    ct: toArrayBuffer(wrapped.ct),
    iv: toArrayBuffer(wrapped.iv),
  };
}

/**
 * Recovers the raw vault key from a factor the user just proved.
 *
 * Registering a passkey needs the raw bytes to wrap them again, and the session
 * key is deliberately non-extractable, so the caller re-derives them from a
 * password or recovery key rather than reading them out of memory.
 */
export async function extractVaultRaw(
  record: VaultRecord,
  factor: { password: string } | { recoveryKey: Uint8Array },
): Promise<Uint8Array> {
  if ("password" in factor) {
    const kek = await argonKey(factor.password, toBytes(record.saltPw), record.argon);
    return open(
      kek,
      toBytes(record.pwWrap.ct),
      toBytes(record.pwWrap.iv),
      ctx.vaultWrap("password"),
    );
  }
  if (!record.recWrap) throw new Error("リカバリーキーが設定されていません。");
  const kek = await hkdfKey(
    factor.recoveryKey,
    toBytes(record.recWrap.hkdfSalt),
    HKDF_INFO.recovery,
  );
  return open(
    kek,
    toBytes(record.recWrap.ct),
    toBytes(record.recWrap.iv),
    ctx.vaultWrap("recovery"),
  );
}
