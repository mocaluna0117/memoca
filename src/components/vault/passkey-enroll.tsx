"use client";

import { useMutation } from "convex/react";
import { Fingerprint, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "@convex/_generated/api";
import { Reauth } from "@/components/vault/reauth";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  type CreatedPasskey,
  PasskeyAlreadyRegisteredError,
  PasskeyCancelledError,
  PrfUnsupportedError,
  createPasskey,
  startPasskey,
} from "@/lib/crypto/passkey";
import { unlockMethodName, withMethod } from "@/lib/crypto/platform";
import { wipe } from "@/lib/crypto/primitives";
import { openVaultRaw } from "@/lib/crypto/vault";
import { useOnline } from "@/lib/hooks/use-online";
import { savePasskey } from "@/lib/vault/enroll";
import { localPasskeyIds, rememberLocalPasskey } from "@/lib/vault/local-passkeys";
import type { StoredVaultRecord } from "@/lib/vault/record";

export type EnrollResult = "added" | "alreadyHere";

/**
 * The steps of putting this device's Face ID / Touch ID to use.
 *
 * Each system sheet has a tap of its own: creating the passkey, then, on
 * browsers that do not return its secret at creation, one more check. Asking
 * for that second sheet straight after the first, as before, happened outside
 * any tap, which WebKit may refuse.
 *
 * `raw` is the vault key's bytes; the caller owns and wipes them.
 */
export function PasskeyEnrollSteps({
  record,
  raw,
  onDone,
  onCancel,
  cancelLabel = "キャンセル",
}: {
  record: StoredVaultRecord;
  raw: Uint8Array;
  onDone: (result: EnrollResult) => void;
  onCancel: () => void;
  cancelLabel?: string;
}) {
  const add = useMutation(api.vault.addPasskey);
  const online = useOnline();
  const [method] = useState(() => unlockMethodName());
  const [step, setStep] = useState<"start" | "confirm" | "already">("start");
  const [created, setCreated] = useState<CreatedPasskey | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (passkey: CreatedPasskey, output: Uint8Array) => {
    const result = await savePasskey(add, record, passkey, output, raw);
    if (result === "tooMany") {
      setError("登録できるパスキーは 10 件までです。使っていないものを削除してください。");
      return;
    }
    onDone("added");
  };

  const failed = (cause: unknown) => {
    if (cause instanceof PasskeyCancelledError) return;
    if (cause instanceof PasskeyAlreadyRegisteredError) {
      setStep("already");
      setError(null);
      return;
    }
    setError(
      cause instanceof PrfUnsupportedError
        ? cause.message
        : "登録できませんでした。インターネット接続を確認して、もう一度お試しください。",
    );
  };

  // Each handler starts its system sheet before anything is awaited.
  const begin = () => {
    if (busy) return;
    const attempt = createPasskey(record.passkeys.map((p) => p.credentialId));
    setBusy(true);
    setError(null);
    void attempt
      .then(async (passkey) => {
        if (passkey.prfOutput) {
          await save(passkey, passkey.prfOutput);
        } else {
          setCreated(passkey);
          setStep("confirm");
        }
      })
      .catch(failed)
      .finally(() => setBusy(false));
  };

  const confirm = () => {
    if (busy || !created) return;
    const entry = { credentialId: created.credentialId, prfInput: created.prfInput.slice().buffer };
    const attempt = startPasskey([entry], [created.credentialId]);
    setBusy(true);
    setError(null);
    void attempt
      .then(({ output }) => save(created, output))
      .catch(failed)
      .finally(() => setBusy(false));
  };

  const useExisting = () => {
    if (busy) return;
    const attempt = startPasskey(record.passkeys, localPasskeyIds());
    setBusy(true);
    setError(null);
    void attempt
      .then(async ({ entry, output }) => {
        const full = record.passkeys.find((p) => p.credentialId === entry.credentialId)!;
        // Proves this device's passkey still opens the vault before trusting it.
        wipe(await openVaultRaw(record, { prf: { entry: full, output } }));
        await rememberLocalPasskey(entry.credentialId);
        onDone("alreadyHere");
      })
      .catch((cause) => {
        if (cause instanceof PasskeyCancelledError) return;
        setError(
          withMethod(method, "の登録が古くなっています。設定の一覧から削除して、登録し直してください。"),
        );
      })
      .finally(() => setBusy(false));
  };

  const title =
    step === "already" ? "この端末のパスキーは登録済みです" : withMethod(method, "を登録");
  const body =
    step === "start"
      ? "「登録を始める」を押すと、パスキーを保存する画面が表示されます。"
      : step === "confirm"
        ? withMethod(`登録を完了するため、もう一度 ${method}`, "で確認してください。")
        : withMethod(`この端末では、登録済みのパスキーがすでに使えます。確認のため一度 ${method}`, "で開いてください。");
  const action = step === "start" ? "登録を始める" : withMethod(method, "で確認");

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{body}</DialogDescription>
      </DialogHeader>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      {!online ? (
        <p className="text-muted-foreground text-sm">登録にはインターネット接続が必要です。</p>
      ) : null}
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button
          onClick={step === "start" ? begin : step === "confirm" ? confirm : useExisting}
          disabled={busy || !online}
          className="gap-2"
          data-autofocus
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Fingerprint className="size-4" aria-hidden />
          )}
          {action}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * Registration from Settings: prove who is asking with the password or the
 * recovery key (the key's bytes are needed to wrap it for the passkey), then
 * the passkey steps.
 */
export function PasskeyEnrollDialog({
  open,
  onOpenChange,
  record,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  record: StoredVaultRecord;
  onDone: (result: EnrollResult) => void;
}) {
  const [method] = useState(() => (typeof navigator === "undefined" ? "パスキー" : unlockMethodName()));
  const [raw, setRaw] = useState<Uint8Array | null>(null);
  const [authing, setAuthing] = useState(false);
  const rawRef = useRef<Uint8Array | null>(null);

  // The key's bytes live only while this dialog is open.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) setRaw(null);
  }
  const wipeRaw = () => {
    if (rawRef.current) wipe(rawRef.current);
    rawRef.current = null;
  };
  useEffect(() => {
    if (!open) wipeRaw();
  }, [open]);
  useEffect(() => wipeRaw, []);

  return (
    <Dialog open={open} onOpenChange={(next) => !authing && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md" showCloseButton={!authing}>
        {raw ? (
          <PasskeyEnrollSteps
            record={record}
            raw={raw}
            onCancel={() => onOpenChange(false)}
            onDone={(result) => {
              onDone(result);
              onOpenChange(false);
            }}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{withMethod(`この端末で ${method}`, "を使う")}</DialogTitle>
              <DialogDescription>登録するため、金庫のパスワードを入力してください。</DialogDescription>
            </DialogHeader>
            <Reauth
              record={record}
              factors={["password", "recovery"]}
              submitLabel="次へ"
              onBusyChange={setAuthing}
              onRaw={async (bytes) => {
                if (!open) {
                  wipe(bytes);
                  return;
                }
                wipeRaw();
                rawRef.current = bytes;
                setRaw(bytes);
              }}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
