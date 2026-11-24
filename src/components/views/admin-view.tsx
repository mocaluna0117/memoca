"use client";

import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import type { FunctionReturnType } from "convex/server";
import { Copy, Loader2, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@convex/_generated/api";
import { useSync } from "@/components/providers/sync-provider";
import { MobileHeader } from "@/components/shell/app-shell";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { formatBytes } from "@/lib/bytes";

const MB = 1024 * 1024;
/**
 * Convex's free plan stores 1 GB of files for the whole team: production,
 * the dev deployment and the E2E one together.
 */
const FREE_FILE_STORAGE = 1024 * MB;

export default function AdminView() {
  const overview = useQuery(api.admin.overview);
  const setConfig = useMutation(api.admin.setConfig);
  const { me } = useSync();

  const [maxUsers, setMaxUsers] = useState<string>("");
  const [quotaMb, setQuotaMb] = useState<string>("");

  if (overview === undefined) return null;
  if (overview === null) {
    return <p className="p-6 text-sm">権限がありません。</p>;
  }

  const { config, users, invites, usedBytes } = overview;
  const promised = config.maxUsers * config.defaultQuotaBytes;

  return (
    <div className="flex flex-1 flex-col">
      <MobileHeader title="管理" />
      <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-6 sm:px-6">
        <h1 className="text-lg font-semibold tracking-tight">管理</h1>

        <section className="space-y-4">
          <h2 className="text-sm font-semibold">登録の受付</h2>
          <div className="flex items-center justify-between gap-4 rounded-md border px-4 py-3">
            <div>
              <p className="text-sm">誰でも登録できるようにする</p>
              <p className="text-muted-foreground text-xs">
                オフにすると、招待コードを持つ人だけが登録できます。
              </p>
            </div>
            <Switch
              checked={config.signupOpen}
              onCheckedChange={(checked) => void setConfig({ signupOpen: checked })}
            />
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="max-users">登録上限</Label>
              <Input
                id="max-users"
                inputMode="numeric"
                className="w-32"
                placeholder={String(config.maxUsers)}
                value={maxUsers}
                onChange={(event) => setMaxUsers(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="quota">1 人あたりの容量 (MB)</Label>
              <Input
                id="quota"
                inputMode="numeric"
                className="w-40"
                placeholder={String(Math.round(config.defaultQuotaBytes / MB))}
                value={quotaMb}
                onChange={(event) => setQuotaMb(event.target.value)}
              />
            </div>
            <Button
              variant="outline"
              onClick={async () => {
                await setConfig({
                  ...(maxUsers ? { maxUsers: Number(maxUsers) } : {}),
                  ...(quotaMb ? { defaultQuotaBytes: Number(quotaMb) * MB } : {}),
                });
                setMaxUsers("");
                setQuotaMb("");
                toast.success("保存しました");
              }}
            >
              保存
            </Button>
          </div>

          <p className="text-muted-foreground text-sm">
            現在 {config.userCount} / {config.maxUsers} 人
          </p>
          <div className="space-y-1 text-sm">
            <p>
              全員の使用量：{formatBytes(usedBytes)}（Convex の無料枠は{" "}
              {formatBytes(FREE_FILE_STORAGE)}）
            </p>
            <p
              className={
                promised > FREE_FILE_STORAGE ? "text-destructive" : "text-muted-foreground"
              }
            >
              容量 × 登録上限：{formatBytes(promised)}
              {promised > FREE_FILE_STORAGE
                ? "。全員が容量いっぱいまで使うと無料枠を超え、保存できなくなることがあります。"
                : "。全員が容量いっぱいまで使っても無料枠に収まります。"}
            </p>
            <p className="text-muted-foreground text-xs">
              1 人あたりの容量を変えると、これまでの既定値のままの人の容量も新しい値になります。
            </p>
          </div>
        </section>

        <Separator />

        <section className="space-y-3">
          <h2 className="text-sm font-semibold">招待コード</h2>
          <InviteForm />
          {invites.length === 0 ? (
            <p className="text-muted-foreground text-sm">まだありません。</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {invites.map((invite) => (
                <InviteRow key={invite.code} invite={invite} />
              ))}
            </ul>
          )}
        </section>

        <Separator />

        <section className="space-y-3">
          <h2 className="text-sm font-semibold">利用者</h2>
          <p className="text-muted-foreground text-xs">
            容量は 1 人ずつ変えられます。ちょうど「1 人あたりの容量」と同じにすると、その人も既定値に戻り、次に既定値を変えたときにいっしょに変わります。
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-muted-foreground text-left text-xs">
                <tr>
                  <th className="py-2 pr-4 font-normal">メール</th>
                  <th className="py-2 pr-4 font-normal">使用量 / 容量</th>
                  <th className="py-2 pr-4 font-normal">登録日</th>
                  <th className="py-2 font-normal">
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {users.map((user) => (
                  <UserRow key={user.id} user={user} isMe={user.email === me?.email} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

type Overview = NonNullable<FunctionReturnType<typeof api.admin.overview>>;

/** What the server said was wrong, in its words; else something general. */
const reason = (error: unknown, fallback: string) =>
  error instanceof ConvexError && typeof (error.data as { message?: unknown })?.message === "string"
    ? (error.data as { message: string }).message
    : fallback;

/** A day as a date field writes it (YYYY-MM-DD), on this device's calendar. */
function dayValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The last moment of a day written so, on this device's calendar: a code good "until" it is good all that day. */
export function endOfDay(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const end = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 999);
  return Number.isNaN(end.getTime()) ? null : end.getTime();
}

/** A new invite code: how many may use it, and until when (or for good). */
function InviteForm() {
  const createInvite = useMutation(api.admin.createInvite);
  // Today, as the form was opened: a code may be good until its end at the earliest.
  const [today] = useState(() => dayValue(new Date()));
  const [uses, setUses] = useState("1");
  const [until, setUntil] = useState(() => dayValue(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)));
  const [forGood, setForGood] = useState(false);
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);

  const count = Number(uses);
  const usesOk = Number.isInteger(count) && count >= 1 && count <= 100;
  const expiresAt = forGood ? null : endOfDay(until);
  const untilOk = forGood || (expiresAt !== null && until >= today);

  const issue = async () => {
    setBusy(true);
    try {
      const code = await createInvite({
        uses: count,
        expiresInDays: null,
        ...(expiresAt !== null ? { expiresAt } : {}),
        ...(memo.trim() ? { memo: memo.trim() } : {}),
      });
      await navigator.clipboard.writeText(code).catch(() => {});
      toast.success(`${code} を発行して、コピーしました`);
      setMemo("");
    } catch (error) {
      toast.error(reason(error, "発行できませんでした。もう一度お試しください。"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 rounded-md border px-4 py-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="invite-uses">使える回数</Label>
          <Input
            id="invite-uses"
            type="number"
            inputMode="numeric"
            min={1}
            max={100}
            className="w-24"
            value={uses}
            onChange={(event) => setUses(event.target.value)}
            aria-invalid={!usesOk}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="invite-until">期限（この日の終わりまで）</Label>
          <Input
            id="invite-until"
            type="date"
            className="w-44"
            min={today}
            value={until}
            disabled={forGood}
            onChange={(event) => setUntil(event.target.value)}
            aria-invalid={!untilOk}
          />
        </div>
        <label className="flex h-9 items-center gap-2 text-sm">
          <Switch checked={forGood} onCheckedChange={setForGood} />
          期限なし
        </label>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor="invite-memo">メモ（だれに渡すかなど・任意）</Label>
          <Input id="invite-memo" value={memo} maxLength={80} onChange={(event) => setMemo(event.target.value)} />
        </div>
        <Button className="gap-1.5" disabled={!usesOk || !untilOk || busy} onClick={() => void issue()}>
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
          発行
        </Button>
      </div>
      {!usesOk ? <p className="text-destructive text-xs">使える回数は 1 から 100 のあいだにしてください。</p> : null}
      {!untilOk ? <p className="text-destructive text-xs">期限は今日以降の日にしてください。</p> : null}
    </div>
  );
}

function InviteRow({ invite }: { invite: Overview["invites"][number] }) {
  const revokeInvite = useMutation(api.admin.revokeInvite);
  // Whether it has run out, as of when the list was drawn.
  const [now] = useState(() => Date.now());
  const expired = invite.expiresAt !== null && invite.expiresAt <= now;
  const usedUp = invite.usesLeft <= 0;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
      <span className={expired || usedUp ? "text-muted-foreground font-mono text-sm line-through" : "font-mono text-sm"}>
        {invite.code}
      </span>
      <span className="text-muted-foreground min-w-0 flex-1 text-xs">
        残り {invite.usesLeft} 回・
        {invite.expiresAt === null
          ? "期限なし"
          : expired
            ? `期限切れ（${new Date(invite.expiresAt).toLocaleDateString("ja-JP")}）`
            : `${new Date(invite.expiresAt).toLocaleDateString("ja-JP")} まで`}
        {invite.memo ? `・${invite.memo}` : ""}
      </span>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`${invite.code} をコピー`}
        onClick={async () => {
          await navigator.clipboard.writeText(invite.code);
          toast.success("コピーしました");
        }}
      >
        <Copy className="size-4" aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive"
        onClick={() => void revokeInvite({ code: invite.code })}
      >
        取り消し
      </Button>
    </li>
  );
}

function UserRow({ user, isMe }: { user: Overview["users"][number]; isMe: boolean }) {
  const setUserQuota = useMutation(api.admin.setUserQuota);
  const removeUser = useMutation(api.admin.removeUser);
  const [quotaMb, setQuotaMb] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);

  const typed = Number(quotaMb);
  const quotaOk = quotaMb.trim() !== "" && Number.isFinite(typed) && typed >= 0 && typed <= 100 * 1024;

  const saveQuota = async () => {
    setSaving(true);
    try {
      const result = await setUserQuota({ userId: user.id, quotaBytes: Math.round(typed * MB) });
      if (result.status === "ok") {
        toast.success(`${user.email} の容量を ${formatBytes(Math.round(typed * MB))} にしました`);
        setQuotaMb("");
      } else {
        toast.error("この利用者はもういません。");
      }
    } catch (error) {
      toast.error(reason(error, "保存できませんでした。もう一度お試しください。"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setRemoving(true);
    try {
      const result = await removeUser({ userId: user.id });
      if (result.status === "scheduled") toast.success(`${user.email} を退会させました`);
      else if (result.status === "gone") toast(`${user.email} はもう退会しています`);
      else toast.error("自分や管理者は、ここからは退会させられません。");
      setConfirming(false);
    } catch (error) {
      toast.error(reason(error, "退会させられませんでした。もう一度お試しください。"));
    } finally {
      setRemoving(false);
    }
  };

  if (user.removed) {
    return (
      <tr className="text-muted-foreground">
        <td className="py-2 pr-4">{user.email}</td>
        <td className="py-2 pr-4" colSpan={3}>
          退会の処理中（メモとファイルを削除しています）
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td className="py-2 pr-4">
        <span className="break-all">{user.email}</span>
        {user.admin ? <span className="text-muted-foreground ml-1.5 text-xs whitespace-nowrap">管理者</span> : null}
        {isMe ? <span className="text-muted-foreground ml-1.5 text-xs whitespace-nowrap">（自分）</span> : null}
      </td>
      <td className="py-2 pr-4">
        <div className="flex items-center gap-2 whitespace-nowrap tabular-nums">
          <span>{formatBytes(user.usedBytes)} /</span>
          <Input
            aria-label={`${user.email} の容量 (MB)`}
            inputMode="decimal"
            className="h-8 w-24"
            placeholder={String(Math.round(user.quotaBytes / MB))}
            value={quotaMb}
            onChange={(event) => setQuotaMb(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && quotaOk && !saving) void saveQuota();
            }}
          />
          <span className="text-muted-foreground text-xs">MB</span>
          {quotaMb.trim() !== "" ? (
            <Button size="sm" variant="outline" disabled={!quotaOk || saving} onClick={() => void saveQuota()}>
              保存
            </Button>
          ) : null}
        </div>
      </td>
      <td className="py-2 pr-4 tabular-nums whitespace-nowrap">
        {new Date(user.createdAt).toLocaleDateString("ja-JP")}
      </td>
      <td className="py-2 text-right">
        {isMe || user.admin ? null : (
          <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirming(true)}>
            退会させる
          </Button>
        )}
        <AlertDialog open={confirming} onOpenChange={(open) => !removing && setConfirming(open)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{user.email} を退会させますか？</AlertDialogTitle>
              <AlertDialogDescription>
                すべての端末でログアウトされ、メモとファイルはすべて削除されます。元には戻せません。登録の受付が開いていれば、同じアドレスでまた登録できます。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={removing}>キャンセル</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                disabled={removing}
                onClick={(event) => {
                  event.preventDefault();
                  void remove();
                }}
              >
                {removing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                退会させる
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </td>
    </tr>
  );
}

