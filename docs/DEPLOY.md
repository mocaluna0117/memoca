# 公開までの手順

開発は Convex のローカル（匿名）デプロイで完結しているため、ここまでアカウント登録は不要でした。
インターネットに公開するには、以下 3 つのアカウント作業だけ、ご自身で行っていただく必要があります。

所要時間の目安は 30〜40 分です。

---

## 1. Convex にログインして本番デプロイを作る

```bash
cd ~/memo_app
npx convex login          # ブラウザが開きます（GitHub か Google でログイン）
npx convex dev            # プロジェクトとリージョンを聞かれます
```

リージョンは日本から近い **US East (N. Virginia)** を選びます。あとから変更できません。

ここで作られるのが「開発用デプロイ」です。本番用は Vercel 連携時に自動で作られます。
どちらも同じプロジェクトに属し、データは完全に分かれています。

> `npx convex login` の途中でもプロジェクト名を聞かれます。
> そこで作ったプロジェクトと `npx convex dev` で作るプロジェクトは別物になるため、
> 使っていない方はダッシュボードから削除してください。
>
> 完了すると `.env.local` がクラウドのデプロイを指すように書き換わります。
> ローカルだけで動かす状態に戻したいときは `.env.local` を削除して
> `CONVEX_AGENT_MODE=anonymous npx convex dev` を実行します。

開発用デプロイにも設定を入れておきます。

```bash
npx convex env set BETTER_AUTH_SECRET "$(openssl rand -base64 32)"
npx convex env set SITE_URL http://localhost:3000
npx convex env set ALLOW_PASSWORD_AUTH true
npx convex env set MAX_USERS 100000
npx convex env set ADMIN_EMAILS <あなたのメールアドレス>
```

## 2. Google ログインを設定する

[Google Cloud Console](https://console.cloud.google.com/) で作業します。すべて無料です。

設定画面は「Google Auth Platform」という区画にまとまっています。
メニューを探すより、下のリンクを直接開くのが速いです。

### 2-1. プロジェクトを選ぶ

新しい Google アカウントには「My First Project」が最初から用意されています。
それを使っても構いませんが、後から見て分かりやすいので `Memoca` という名前で
新しく作るのがおすすめです。画面上部のプロジェクト選択から作成できます。

### 2-2. ブランディング

[console.cloud.google.com/auth/branding](https://console.cloud.google.com/auth/branding)

ログイン時にユーザーへ表示される情報です。

| 項目 | 値 |
| --- | --- |
| アプリ名 | `Memoca` |
| ユーザーサポートメール | ご自身のアドレス |
| アプリのホームページ | `https://<あなたのドメイン>/` |
| プライバシーポリシー | `https://<あなたのドメイン>/privacy` |
| 利用規約 | `https://<あなたのドメイン>/terms` |
| 承認済みドメイン | `vercel.app`（独自ドメインを使う場合はそのドメイン） |

### 2-3. 対象ユーザー

[console.cloud.google.com/auth/audience](https://console.cloud.google.com/auth/audience)

ユーザーの種類は **外部** を選びます。

**ここが重要です。** 初期状態は「テスト中」で、登録したテストユーザー（最大 100 人）
しかログインできません。誰でも登録できるようにするには **「アプリを公開」** を押して
本番モードに切り替えてください。

Memoca が要求するのはメールアドレスと氏名だけで、これは機密スコープではないため、
公開しても Google の審査待ちは発生せず、すぐに有効になります。

### 2-4. クライアントを作成

[console.cloud.google.com/auth/clients](https://console.cloud.google.com/auth/clients)

「クライアントを作成」を押し、種類は **ウェブ アプリケーション** を選びます。
承認済みのリダイレクト URI に次の 2 つを登録します。

```
http://localhost:3000/api/auth/callback/google
https://<あなたのドメイン>/api/auth/callback/google
```

発行された **クライアント ID** と **クライアント シークレット** を控えます。
シークレットはこの画面を離れると再表示できないので、その場で保存してください。

> 承認済みドメインに `vercel.app` を登録できない場合は、独自ドメインが必要です。
> Vercel でドメインを購入し（`memoca.dev` が 1 年 9.99 USD で空いています）、
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
