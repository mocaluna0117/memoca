"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { useMutation } from "convex/react";
import { Fingerprint, KeyRound, Loader2 } from "lucide-react";
import { useEffect, useReducer, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@convex/_generated/api";
import { PasskeyEnrollSteps } from "@/components/vault/passkey-enroll";
import { PasswordInput } from "@/components/vault/password-input";
import { RecoveryKeyView, recordKeptKey } from "@/components/vault/recovery-key-view";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  PasskeyCancelledError,
  PasskeyNeedsRetryError,
  PrfUnsupportedError,
  startPasskey,
} from "@/lib/crypto/passkey";
import { unlockMethodName, withMethod } from "@/lib/crypto/platform";
import { DEFAULT_ARGON, wipe } from "@/lib/crypto/primitives";
import {
  RECOVERY_FORMAT,
  RECOVERY_KEY_LENGTH,
  formatRecoveryKey,
  parseRecoveryKey,
  recoveryKeyCharacters,
} from "@/lib/crypto/recovery-key";
import {
  openVaultRaw,
  rewrapPasswordFromRaw,
  setUpVault,
  unlockWithPassword,
  unlockWithPrf,
  unlockWithRecoveryKey,
} from "@/lib/crypto/vault";
import { db } from "@/lib/db";
import { useMediaQuery } from "@/lib/hooks/use-client-value";
import { useVaultUnlocked } from "@/lib/hooks/use-decrypted";
import { useKeyboardInset } from "@/lib/hooks/use-keyboard-inset";
import { useOnline } from "@/lib/hooks/use-online";
import { t } from "@/lib/i18n/ja";
import { type AutoPasskey, type VaultRequest, useVaultGate } from "@/lib/store/vault-gate";
import { planFolderLock, planFolderUnlock } from "@/lib/vault/model";
import { cn } from "@/lib/utils";
import {
  type GateContext,
  type GateView,
  dismissResult,
  gateReducer,
  holdsOpen,
  startGate,
} from "@/lib/vault/gate-machine";
import {
  localPasskeyIds,
  rememberLocalPasskey,
  usePlatformPasskey,
} from "@/lib/vault/local-passkeys";
import {
  type VaultPurpose,
  creationLead,
  needsServer,
  passkeyAction,
  purposeCopy,
} from "@/lib/vault/purpose";
import { useVaultRecord } from "@/lib/vault/record";

const MIN_PASSWORD = 8;

/** How long the prompt waits for the vault record before calling it offline. */
const LOADING_GRACE_MS = 10_000;

/** Lets a "確認しています…" state paint before Argon2 blocks the main thread. */
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** The one prompt that opens, creates or confirms the vault for a purpose. */
export function VaultDialog() {
  const request = useVaultGate((s) => s.request);
  // Keyed per request, so nothing typed for one survives into the next.
  return request ? <VaultPrompt key={request.id} request={request} /> : null;
}

/**
 * How many notes a folder lock would change, and for an unlock how many it
 * leaves locked, for the confirmation text. The same plans the lock itself
 * follows, so the numbers are what will happen.
 */
function useFolderNoteCounts(purpose: VaultPurpose): { count: number | null; keep: number } {
  const folderId =
    purpose.kind === "lockFolder" || purpose.kind === "unlockFolder" ? purpose.folderId : null;
  const locking = purpose.kind === "lockFolder";
  return (
    useLiveQuery(
      async () => {
        if (!folderId) return { count: null, keep: 0 };
        const [folders, notes] = await Promise.all([db().folders.toArray(), db().notes.toArray()]);
        // Only what the person can see: trashed notes change too, silently.
        const visible = new Set(notes.filter((n) => n.deletedAt === null).map((n) => n.noteId));
        if (locking) {
          return { count: planFolderLock(folderId, folders, notes).filter((id) => visible.has(id)).length, keep: 0 };
        }
        const plan = planFolderUnlock(folderId, folders, notes);
        return {
          count: plan.unlock.filter((id) => visible.has(id)).length,
          keep: plan.keep.filter((id) => visible.has(id)).length,
        };
      },
      [folderId, locking],
      { count: null, keep: 0 },
    ) ?? { count: null, keep: 0 }
  );
}

function VaultPrompt({ request }: { request: VaultRequest }) {
  const { purpose } = request;
  const finish = useVaultGate((s) => s.finish);
  const availability = useVaultRecord((s) => s.availability);
  const record = useVaultRecord((s) => s.record);
  const online = useOnline();
  const unlocked = useVaultUnlocked();
  const platform = usePlatformPasskey();
  const setup = useMutation(api.vault.setup);
  const markChecked = useMutation(api.vault.markRecoveryChecked);
  const rewrap = useMutation(api.vault.rewrap);

  const passkeyReady = platform && (record?.passkeys.length ?? 0) > 0;
  const ctx: GateContext = { availability, online, unlocked, passkeyReady };
  const [method] = useState(() => unlockMethodName());
  const counts = useFolderNoteCounts(purpose);
  const copy = purposeCopy(purpose, { method, noteCount: counts.count, keepCount: counts.keep });
  const blockedOffline = needsServer(purpose) && !online;

  const [gate, dispatch] = useReducer(gateReducer, undefined, () => {
    const start = startGate(purpose, ctx);
    if ("immediate" in start) return { view: "confirm" as GateView, notice: null };
    // A sheet the tap already started belongs on the passkey screen.
    if (request.auto && start.view !== "create") return { view: "passkey" as GateView, notice: null };
    return { view: start.view, notice: null };
  });
  const { view, notice } = gate;

  const [error, setError] = useState<string | null>(null);
  // "passkey": a system sheet is up, which closing may cancel. "work": a key
  // is being derived or saved, which closing must not interrupt.
  const [pending, setPending] = useState<"passkey" | "work" | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [recoveryInput, setRecoveryInput] = useState("");
  const [retryPasskey, setRetryPasskey] = useState<string | null>(null);
  const [freshKey, setFreshKey] = useState<{ key: string; iv: ArrayBuffer } | null>(null);
  const [newPassword, setNewPassword] = useState<{ open: boolean; value: string; again: string }>({
    open: false,
    value: "",
    again: "",
  });
  const abort = useRef<AbortController | null>(null);
  // The recovery key that opened the vault, kept only while the offer to set a
  // new password is on screen.
  const recoveredKey = useRef<Uint8Array | null>(null);
  // The new vault's key, kept from creation until the offer to use Face ID /
  // Touch ID is answered, so that offer does not ask for the password again.
  const [createdRaw, setCreatedRaw] = useState<Uint8Array | null>(null);
  const createdRawRef = useRef<Uint8Array | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const content = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dispatch({ type: "context", ctx: { availability, online, unlocked, passkeyReady } });
  }, [availability, online, unlocked, passkeyReady]);

  // Opened while the vault was already open and nothing needs confirming.
  useEffect(() => {
    if ("immediate" in startGate(purpose, ctx)) finish({ ok: true });
    // Only at mount: later changes are handled by the reducer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (view !== "loading") return;
    const timer = setTimeout(() => dispatch({ type: "loadingTimedOut" }), LOADING_GRACE_MS);
    return () => clearTimeout(timer);
  }, [view]);

  useEffect(
    () => () => {
      abort.current?.abort();
      if (recoveredKey.current) wipe(recoveredKey.current);
      if (createdRawRef.current) wipe(createdRawRef.current);
    },
    [],
  );

  // Focus the screen's main control. A text field only with a mouse or
  // trackpad: on a phone it would raise the keyboard over the prompt.
  const fine = useMediaQuery("(pointer: fine)");
  useEffect(() => {
    const target = content.current?.querySelector<HTMLElement>("[data-autofocus]");
    if (!target) return;
    if (target instanceof HTMLInputElement && !fine) return;
    target.focus();
  }, [view, fine, newPassword.open]);

  const narrow = useMediaQuery("(max-width: 639px)");
  const keyboard = useKeyboardInset();

  const ok = () => finish({ ok: true });

  /** The vault exists and is open: carry on with whatever asked for it. */
  const finishCreation = () => {
    if (createdRawRef.current) wipe(createdRawRef.current);
    createdRawRef.current = null;
    setCreatedRaw(null);
    // Only when nothing follows; otherwise the next thing says it is done.
    if (purpose.kind === "setup") toast.success("金庫を作成しました");
    ok();
  };
  const cancel = () => {
    abort.current?.abort();
    finish(dismissResult(view) === "ok" ? { ok: true } : { ok: false, reason: "cancelled" });
  };

  const handleAttempt = ({ attempt, controller }: AutoPasskey) => {
    abort.current = controller;
    setPending("passkey");
    setError(null);
    void attempt
      .then(async ({ entry, output }) => {
        const full = record?.passkeys.find((p) => p.credentialId === entry.credentialId);
        if (!full) throw new PrfUnsupportedError();
        try {
          await unlockWithPrf(full, output);
        } catch {
          // The passkey answered, but its secret no longer opens this vault.
          throw new StalePasskeyError();
        }
        void rememberLocalPasskey(entry.credentialId);
        setRetryPasskey(null);
        ok();
      })
      .catch((cause) => {
        if (controller.signal.aborted || cause instanceof PasskeyCancelledError) return;
        if (cause instanceof PasskeyNeedsRetryError) {
          setRetryPasskey(cause.credentialId);
          setError(`もう一度 ${method} で確認してください。`);
          return;
        }
        setError(
          cause instanceof StalePasskeyError
            ? withMethod(method, "の登録が古くなっています。パスワードで開いたあと、設定で登録し直してください。")
            : cause instanceof PrfUnsupportedError
              ? cause.message
              : withMethod(method, "で開けませんでした。パスワードを使ってください。"),
        );
        dispatch({ type: "passkeyFailed" });
      })
      .finally(() => {
        if (abort.current === controller) abort.current = null;
        setPending(null);
      });
  };

  // Started from the tap that asked, before the prompt was even drawn.
  const autoHandled = useRef(false);
  useEffect(() => {
    if (autoHandled.current || !request.auto) return;
    autoHandled.current = true;
    handleAttempt(request.auto);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** One tap, one system sheet: nothing is awaited before it starts. */
  const runPasskey = () => {
    if (!record || pending) return;
    const controller = new AbortController();
    const attempt = startPasskey(record.passkeys, localPasskeyIds(), {
      signal: controller.signal,
      only: retryPasskey ?? undefined,
    });
    handleAttempt({ attempt, controller });
  };

  const work = async (run: () => Promise<void>) => {
    if (pending) return;
    setPending("work");
    setError(null);
    await nextFrame();
    try {
      await run();
    } finally {
      setPending(null);
    }
  };

  const submitPassword = () =>
    work(async () => {
      if (!record) return;
      if (password.length === 0) {
        setError("金庫のパスワードを入力してください。");
        return;
      }
      try {
        await unlockWithPassword(record, password);
      } catch {
        setError(t.vault.wrongPassword);
        return;
      }
      ok();
    });

  const submitRecovery = () =>
    work(async () => {
      if (!record) return;
      const parsed = parseRecoveryKey(recoveryInput);
      if (!parsed.ok) {
        setError(
          parsed.reason === "legacy"
            ? "このリカバリーキーは、以前の不具合で一部しか表示されていなかったため使えません。金庫のパスワードで開いたあと、設定でリカバリーキーを作り直してください。"
            : `リカバリーキーは ${RECOVERY_KEY_LENGTH} 文字です（いま ${parsed.length} 文字）。`,
        );
        return;
      }
      try {
        await unlockWithRecoveryKey(record, parsed.key);
      } catch {
        setError("このリカバリーキーでは開けません。");
        return;
      }
      recoveredKey.current = parsed.key;
      dispatch({ type: "openedWithRecovery" });
    });

  const saveNewPassword = () =>
    work(async () => {
      if (!record || !recoveredKey.current) return;
      if (newPassword.value.length < MIN_PASSWORD) {
        setError(`新しいパスワードは ${MIN_PASSWORD} 文字以上にしてください。`);
        return;
      }
      if (newPassword.value !== newPassword.again) {
        setError("2 つの新しいパスワードが一致しません。");
        return;
      }
      const raw = await openVaultRaw(record, { recoveryKey: recoveredKey.current });
      try {
        const next = await rewrapPasswordFromRaw(raw, newPassword.value);
        const result = await rewrap({ ...next, expectedVersion: record.version });
        if (result.status === "stale") {
          setError("ほかの端末で金庫の設定が変わりました。あとで設定からもう一度お試しください。");
          return;
        }
        if (result.status !== "ok") throw new Error(result.status);
      } catch {
        setError("変更できませんでした。インターネット接続を確認して、もう一度お試しください。");
        return;
      } finally {
        wipe(raw);
      }
      toast.success("金庫のパスワードを再設定しました");
      ok();
    });

  const submitCreate = () => {
    if (password.length < MIN_PASSWORD) {
      setError(`パスワードは ${MIN_PASSWORD} 文字以上にしてください。`);
      return;
    }
    if (password !== confirm) {
      setError("2 つのパスワードが一致しません。");
      return;
    }
    dispatch({ type: "setupStarted" });
    void work(async () => {
      try {
        const result = await setUpVault(
          password,
          (prepared) => setup({ ...prepared, recoveryFormat: RECOVERY_FORMAT }),
          DEFAULT_ARGON,
          // Kept only if Face ID / Touch ID can be offered right after.
          { keepRaw: platform },
        );
        if (result.status !== "ok") {
          // A vault already exists, made on another device or a moment ago in
          // another tab. Its key is the one every locked note uses.
          setPassword("");
          setConfirm("");
          dispatch({ type: "setupAlready" });
          return;
        }
        setFreshKey({ key: formatRecoveryKey(result.recoveryKey), iv: result.recWrapIv });
        wipe(result.recoveryKey);
        createdRawRef.current = result.raw;
        setCreatedRaw(result.raw);
        dispatch({ type: "setupSucceeded" });
      } catch {
        setError("金庫を作成できませんでした。インターネット接続を確認して、もう一度お試しください。");
        dispatch({ type: "setupFailed" });
      }
    });
  };

  const locked = pending === "work" || holdsOpen(view);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !locked) cancel();
      }}
    >
      <DialogContent
        ref={content}
        className={cn(
          "sm:max-w-md",
          // On a phone, a sheet from the bottom, lifted above the keyboard.
          "max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:max-h-[85dvh] max-sm:max-w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:overflow-y-auto max-sm:rounded-b-none max-sm:rounded-t-2xl max-sm:pb-[max(1rem,env(safe-area-inset-bottom))]",
        )}
        style={narrow ? { bottom: keyboard } : undefined}
        showCloseButton={!locked}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (request.returnFocus?.isConnected) request.returnFocus.focus();
        }}
        onEscapeKeyDown={(event) => locked && event.preventDefault()}
        onInteractOutside={(event) => locked && event.preventDefault()}
      >
        {view === "createKey" && freshKey ? (
          <RecoveryKeyView
            recoveryKey={freshKey.key}
            onConfirmed={async () => {
              const outcome = await recordKeptKey(() => markChecked({ recWrapIv: freshKey.iv }));
              if (outcome === "stale") {
                toast.error(
                  "ほかの端末でリカバリーキーが作り直されました。このキーは使えません。設定で作り直してください。",
                );
              }
              const offer = platform && online && createdRawRef.current !== null;
              dispatch({ type: "keyConfirmed", passkeyOffer: offer });
              if (!offer) finishCreation();
            }}
          />
        ) : view === "createPasskey" && record && createdRaw ? (
          enrolling ? (
            <PasskeyEnrollSteps
              record={record}
              raw={createdRaw}
              cancelLabel="あとで"
              onCancel={finishCreation}
              onDone={(result) => {
                toast.success(
                  result === "added"
                    ? withMethod(`この端末で ${method}`, "を使えるようにしました")
                    : "この端末のパスキーを使えるようにしました",
                );
                finishCreation();
              }}
            />
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{withMethod(method, "でも開けるようにしますか？")}</DialogTitle>
                <DialogDescription>
                  {withMethod(`次からはパスワードを入力せずに、${method}`, "だけで金庫を開けます。")}
                  この端末にパスキーが保存されます。
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="ghost" onClick={finishCreation}>
                  あとで
                </Button>
                <Button onClick={() => setEnrolling(true)} className="gap-2" data-autofocus>
                  <Fingerprint className="size-4" aria-hidden />
                  {withMethod(method, "を使う")}
                </Button>
              </DialogFooter>
            </>
          )
        ) : view === "offline" ? (
          <>
            <DialogHeader>
              <DialogTitle>金庫を開けません</DialogTitle>
              <DialogDescription>
                この端末にはまだ金庫の情報がありません。インターネットに接続してから、もう一度お試しください。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={cancel} data-autofocus>
                {t.action.close}
              </Button>
            </DialogFooter>
          </>
        ) : view === "loading" ? (
          <>
            <Header title={copy.title} body={copy.body} />
            <p role="status" className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              金庫の情報を読み込んでいます…
            </p>
            <DialogFooter>
              <Button variant="ghost" onClick={cancel}>
                {t.action.cancel}
              </Button>
            </DialogFooter>
          </>
        ) : view === "confirm" ? (
          <>
            <Header title={copy.title} body={copy.body} />
            {blockedOffline ? <OfflineNote text={copy.offline} /> : null}
            <DialogFooter>
              <Button variant="ghost" onClick={cancel}>
                {t.action.cancel}
              </Button>
              <Button
                onClick={ok}
                disabled={blockedOffline}
                variant={purpose.kind.startsWith("unlock") ? "destructive" : "default"}
                data-autofocus
              >
                {copy.verb}
              </Button>
            </DialogFooter>
          </>
        ) : view === "recovered" ? (
          <>
            <DialogHeader>
              <DialogTitle>新しいパスワードを設定しますか？</DialogTitle>
              <DialogDescription>
                リカバリーキーで開きました。新しいパスワードを決めておくと、次からはパスワードで開けます。
              </DialogDescription>
            </DialogHeader>
            {newPassword.open ? (
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveNewPassword();
                }}
              >
                <Field id="recovered-password" label="新しいパスワード">
                  <PasswordInput
                    id="recovered-password"
                    value={newPassword.value}
                    autoComplete="new-password"
                    enterKeyHint="next"
                    onChange={(event) => setNewPassword((s) => ({ ...s, value: event.target.value }))}
                    data-autofocus
                  />
                </Field>
                <Field id="recovered-again" label="新しいパスワード（確認）">
                  <PasswordInput
                    id="recovered-again"
                    value={newPassword.again}
                    autoComplete="new-password"
                    enterKeyHint="go"
                    onChange={(event) => setNewPassword((s) => ({ ...s, again: event.target.value }))}
                  />
                </Field>
                <ErrorLine error={error} />
                <DialogFooter>
                  <Button type="button" variant="ghost" onClick={ok} disabled={pending !== null}>
                    あとで
                  </Button>
                  <Button type="submit" disabled={pending !== null || !online}>
                    <Spinner on={pending === "work"} />
                    設定する
                  </Button>
                </DialogFooter>
              </form>
            ) : (
              <DialogFooter>
                <Button variant="ghost" onClick={ok}>
                  あとで
                </Button>
                <Button onClick={() => setNewPassword((s) => ({ ...s, open: true }))} data-autofocus>
                  新しいパスワードを設定
                </Button>
              </DialogFooter>
            )}
          </>
        ) : view === "create" || view === "creating" ? (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              submitCreate();
            }}
          >
            <Header
              title="金庫を作成"
              body={`${creationLead(purpose) ?? ""}${purposeCopy({ kind: "setup" }).body}`}
            />
            <div className="space-y-3">
              <Field id="vault-password" label="金庫のパスワード">
                <PasswordInput
                  id="vault-password"
                  value={password}
                  autoComplete="new-password"
                  enterKeyHint="next"
                  onChange={(event) => setPassword(event.target.value)}
                  aria-invalid={error ? true : undefined}
                  aria-describedby="vault-password-hint"
                  data-autofocus
                />
                <p id="vault-password-hint" className="text-muted-foreground text-xs">
                  8 文字以上。Memoca へのログインとは別の、金庫専用のパスワードです。
                </p>
              </Field>
              <Field id="vault-confirm" label="確認のためもう一度入力">
                <PasswordInput
                  id="vault-confirm"
                  value={confirm}
                  autoComplete="new-password"
                  enterKeyHint="go"
                  onChange={(event) => setConfirm(event.target.value)}
                  aria-invalid={error ? true : undefined}
                />
              </Field>
              <p className="text-muted-foreground text-xs">
                このパスワードを忘れても、次に表示するリカバリーキーがあれば開けます。両方なくすと、誰にも開けません。
              </p>
              <ErrorLine error={error} />
              {!online ? <OfflineNote text="金庫の作成にはインターネット接続が必要です。" /> : null}
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={cancel} disabled={locked}>
                {t.action.cancel}
              </Button>
              <Button type="submit" disabled={locked || !online}>
                <Spinner on={view === "creating"} />
                {view === "creating" ? "金庫を作成しています…" : "作成する"}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          // passkey, password or recovery: opening the vault, for the purpose.
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (view === "password") void submitPassword();
              else if (view === "recovery") void submitRecovery();
              else runPasskey();
            }}
          >
            <Header
              title={copy.title}
              body={view === "recovery" ? "保管したリカバリーキーを入力してください。" : copy.body}
            />
            {notice ? (
              <p role="status" className="rounded-md border px-3 py-2 text-sm">
                {notice === "createdElsewhere"
                  ? "ほかの端末で金庫が作成されました。その金庫のパスワードで開いてください。"
                  : "このアカウントにはすでに金庫があります。金庫のパスワードで開いてください。"}
              </p>
            ) : null}

            {view === "passkey" ? (
              <Button
                type="button"
                className="w-full gap-2"
                onClick={runPasskey}
                disabled={pending !== null || blockedOffline}
                data-autofocus
              >
                {pending === "passkey" ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Fingerprint className="size-4" aria-hidden />
                )}
                {pending === "passkey"
                  ? withMethod(method, "で確認しています…")
                  : retryPasskey
                    ? withMethod(`もう一度 ${method}`, "で続ける")
                    : passkeyAction(purpose, method)}
              </Button>
            ) : view === "password" ? (
              <Field id="vault-unlock-password" label="金庫のパスワード">
                <PasswordInput
                  id="vault-unlock-password"
                  value={password}
                  autoComplete="current-password"
                  enterKeyHint="go"
                  onChange={(event) => setPassword(event.target.value)}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? "vault-error" : undefined}
                  data-autofocus
                />
              </Field>
            ) : (
              <Field id="vault-recovery" label={t.vault.recoveryKey}>
                <Input
                  id="vault-recovery"
                  value={recoveryInput}
                  onChange={(event) => setRecoveryInput(event.target.value)}
                  placeholder={`XXXX-XXXX-XXXX-…（${RECOVERY_KEY_LENGTH} 文字）`}
                  aria-describedby="vault-recovery-hint"
                  aria-invalid={error ? true : undefined}
                  autoCapitalize="characters"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="go"
                  className="font-mono"
                  data-autofocus
                />
                <p id="vault-recovery-hint" className="text-muted-foreground text-xs">
                  大文字・小文字、ハイフンや空白はどちらでもかまいません。（
                  {recoveryKeyCharacters(recoveryInput)} / {RECOVERY_KEY_LENGTH} 文字）
                </p>
              </Field>
            )}

            <ErrorLine error={error} />
            {blockedOffline ? <OfflineNote text={copy.offline} /> : null}

            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {view !== "password" ? (
                <LinkButton onClick={() => dispatch({ type: "usePassword" })}>
                  パスワードを使う
                </LinkButton>
              ) : passkeyReady ? (
                <LinkButton onClick={() => dispatch({ type: "usePasskey" })}>
                  {withMethod(method, "を使う")}
                </LinkButton>
              ) : null}
              {view !== "recovery" && record?.recWrap ? (
                <LinkButton
                  onClick={() => {
                    setError(null);
                    dispatch({ type: "useRecovery" });
                  }}
                >
                  <KeyRound className="size-3.5" aria-hidden />
                  パスワードを忘れた場合
                </LinkButton>
              ) : null}
            </div>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={cancel} disabled={pending === "work"}>
                {t.action.cancel}
              </Button>
              {view !== "passkey" ? (
                <Button type="submit" disabled={pending !== null || blockedOffline}>
                  <Spinner on={pending === "work"} />
                  {pending === "work" ? "確認しています…" : copy.verb}
                </Button>
              ) : null}
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

class StalePasskeyError extends Error {}

function Header({ title, body }: { title: string; body: string | string[] }) {
  return (
    <DialogHeader>
      <DialogTitle>{title}</DialogTitle>
      {typeof body === "string" ? (
        <DialogDescription>{body}</DialogDescription>
      ) : (
        <DialogDescription asChild>
          <ul className="list-disc space-y-1 pl-5">
            {body.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </DialogDescription>
      )}
    </DialogHeader>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p id="vault-error" role="alert" className="text-destructive text-sm">
      {error}
    </p>
  );
}

function OfflineNote({ text }: { text: string | null }) {
  if (!text) return null;
  return <p className="text-muted-foreground text-sm">{text}</p>;
}

function LinkButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-xs underline-offset-4 hover:underline"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Spinner({ on }: { on: boolean }) {
  return on ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null;
}
