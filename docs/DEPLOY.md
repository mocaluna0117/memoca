# 公開までの手順

開発は Convex のローカル（匿名）デプロイで完結しているため、ここまでアカウント登録は不要でした。
インターネットに公開するには、以下 3 つのアカウント作業だけ、ご自身で行っていただく必要があります。

所要時間の目安は 30〜40 分です。

---

## 1. Convex にログインして本番デプロイを作る

```bash
cd ~/memo_app
npx convex login          # ブラウザが開きます（GitHub か Google でログイン）
npx convex dev --configure new --project memoca
```

ここで作られるのが「開発用デプロイ」です。本番用は Vercel 連携時に自動で作られます。

> 現在 `.env.local` はローカル匿名デプロイを指しています。上のコマンドで上書きされます。
> ローカルに戻したいときは `.env.local` を削除して
> `CONVEX_AGENT_MODE=anonymous npx convex dev` を実行してください。

## 2. Google ログインを設定する

[Google Cloud Console](https://console.cloud.google.com/) で作業します。すべて無料です。

1. **プロジェクトを作成**（名前は何でも構いません）。
2. **API とサービス → OAuth 同意画面**
   - ユーザーの種類: 外部
   - アプリ名: `Memoca`
   - サポートメール: ご自身のアドレス
   - 承認済みドメイン: `vercel.app`（独自ドメインを使う場合はそのドメイン）
   - アプリのホームページ: `https://<あなたのドメイン>/`
   - プライバシーポリシー: `https://<あなたのドメイン>/privacy`
   - 利用規約: `https://<あなたのドメイン>/terms`
   - スコープは既定のまま（email と profile のみ）
3. **認証情報 → OAuth クライアント ID を作成**
   - 種類: ウェブアプリケーション
   - 承認済みのリダイレクト URI に次の 2 つを登録
     - `http://localhost:3000/api/auth/callback/google`
     - `https://<あなたのドメイン>/api/auth/callback/google`
4. 発行された **クライアント ID** と **クライアントシークレット** を控えます。

> 承認済みドメインに `vercel.app` を登録できない場合は、独自ドメインが必要です。
> その場合は Vercel でドメインを購入し（`memoca.dev` が 1 年 9.99 USD で空いています）、
> そのドメインを上記すべてに設定してください。

## 3. Vercel にデプロイする

```bash
npx vercel link          # プロジェクト名は memoca-app
npx vercel git connect   # GitHub リポジトリと接続（main への push で自動デプロイ）
```

Vercel のダッシュボードで **Integrations → Convex** を追加すると、
本番用 Convex デプロイが作られ、`NEXT_PUBLIC_CONVEX_URL` と `CONVEX_DEPLOY_KEY` が自動で設定されます。

続けて、残りの環境変数を設定します。

### Vercel 側（Project Settings → Environment Variables）

| 変数 | 値 |
| --- | --- |
| `NEXT_PUBLIC_CONVEX_SITE_URL` | `NEXT_PUBLIC_CONVEX_URL` の `.cloud` を `.site` に変えたもの |

ビルドコマンドは `vercel.json` で `npx convex deploy --cmd 'pnpm build'` に設定済みです。
これにより、アプリのビルド前に Convex の関数とスキーマが本番へデプロイされます。

### Convex 側（`npx convex env set ... --prod`）

```bash
npx convex env set BETTER_AUTH_SECRET "$(openssl rand -base64 32)" --prod
npx convex env set SITE_URL https://<あなたのドメイン> --prod
npx convex env set GOOGLE_CLIENT_ID <クライアントID> --prod
npx convex env set GOOGLE_CLIENT_SECRET <シークレット> --prod
npx convex env set ADMIN_EMAILS <あなたのメールアドレス> --prod
```

`ALLOW_PASSWORD_AUTH` は **本番では設定しないでください**。
これはローカルと自動テストがメールとパスワードでログインするためだけのものです。

## 4. 動作を確認する

1. `https://<あなたのドメイン>` を開き、Google でログイン
2. メモを 1 つ作る
3. スマートフォンで同じ URL を開き、ホーム画面に追加する
4. 追加したアプリを開いてもう一度ログインする
   （iOS は Safari とホーム画面アプリでデータが分かれているため、初回のみ必要です）
5. 機内モードにしてメモを編集し、解除して数秒後に PC 側へ反映されることを確認

`ADMIN_EMAILS` に入れたアカウントでログインすると、サイドバーに「管理」が現れます。
登録上限（既定 50 人）や 1 人あたりの容量（既定 100MB）はそこから変更できます。

## 運用の目安

| 項目 | 無料枠 | 超えたら |
| --- | --- | --- |
| Convex データベース | 0.5 GB | Pro 25 USD/月 |
| Convex ファイル保存 | 1 GB | 同上 |
| Convex 帯域 | 1 GB/月 | 同上 |
| Vercel | Hobby（非商用） | Pro 20 USD/月 |

Convex のダッシュボードで使用量を確認できます。
上限に近づいたら、管理画面で 1 人あたりの容量か登録上限を下げてください。
