"use client";

import { useMutation, useQuery } from "convex/react";
import { Copy, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@convex/_generated/api";
import { MobileHeader } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { formatBytes } from "@/lib/bytes";

const MB = 1024 * 1024;

export default function AdminPage() {
  const overview = useQuery(api.admin.overview);
  const setConfig = useMutation(api.admin.setConfig);
  const createInvite = useMutation(api.admin.createInvite);
  const revokeInvite = useMutation(api.admin.revokeInvite);

  const [maxUsers, setMaxUsers] = useState<string>("");
  const [quotaMb, setQuotaMb] = useState<string>("");

  if (overview === undefined) return null;
  if (overview === null) {
    return <p className="p-6 text-sm">権限がありません。</p>;
  }

  const { config, users, invites } = overview;

  return (
    <div className="flex min-h-dvh flex-1 flex-col">
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
        </section>

        <Separator />

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">招待コード</h2>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={async () => {
                const code = await createInvite({ uses: 1, expiresInDays: 30 });
                await navigator.clipboard.writeText(code).catch(() => {});
                toast.success(`${code} をコピーしました`);
              }}
            >
              <Plus className="size-4" aria-hidden />
              発行
            </Button>
          </div>
          {invites.length === 0 ? (
            <p className="text-muted-foreground text-sm">まだありません。</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {invites.map((invite) => (
                <li key={invite.code} className="flex items-center gap-3 px-3 py-2">
                  <span className="flex-1 font-mono text-sm">{invite.code}</span>
                  <span className="text-muted-foreground text-xs">
                    残り {invite.usesLeft} 回
                    {invite.expiresAt
                      ? `・${new Date(invite.expiresAt).toLocaleDateString("ja-JP")} まで`
                      : ""}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="コピー"
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
              ))}
            </ul>
          )}
        </section>

        <Separator />

        <section className="space-y-3">
          <h2 className="text-sm font-semibold">利用者</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-muted-foreground text-left text-xs">
                <tr>
                  <th className="py-2 pr-4 font-normal">メール</th>
                  <th className="py-2 pr-4 font-normal">使用量</th>
                  <th className="py-2 font-normal">登録日</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {users.map((user) => (
                  <tr key={user.email}>
                    <td className="py-2 pr-4">{user.email}</td>
                    <td className="py-2 pr-4 tabular-nums">
                      {formatBytes(user.usedBytes)} / {formatBytes(user.quotaBytes)}
                    </td>
                    <td className="py-2 tabular-nums">
                      {new Date(user.createdAt).toLocaleDateString("ja-JP")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
