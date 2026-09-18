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

### 3-1. Convex の本番デプロイを作る

先にバックエンドを用意します。これでプロジェクトに本番デプロイが作られます。

```bash
npx convex deploy --yes
```

続けて本番用の設定を入れます。末尾の `--prod` を忘れないでください。

```bash
npx convex env set BETTER_AUTH_SECRET "$(openssl rand -base64 32)" --prod
npx convex env set SITE_URL https://<あなたのドメイン> --prod
npx convex env set GOOGLE_CLIENT_ID <クライアントID> --prod
npx convex env set GOOGLE_CLIENT_SECRET <シークレット> --prod
npx convex env set ADMIN_EMAILS <あなたのメールアドレス> --prod
```

`ALLOW_PASSWORD_AUTH` と `MAX_USERS` は **本番には設定しません**。
前者はメールとパスワードでのログインを開ける変数で、ローカルと自動テスト専用です。
後者を省くと登録上限が既定の 50 人になり、無料枠を守れます。

### 3-2. Vercel プロジェクトを作る

```bash
vercel link --yes --project <プロジェクト名>
```

GitHub リポジトリとの接続も同時に行われ、以降は `main` への push で自動デプロイされます。

### 3-3. デプロイキーを発行する

Vercel のビルドが Convex へ関数を反映するための鍵です。CLI では発行できないので、
Convex ダッシュボードの **Settings → Deploy Keys → Create Deploy Key** で作ります。

| 項目 | 値 |
| --- | --- |
| Name | `Vercel` |
| Expiration | No expiration |
| 権限 | **`deployment:deploy` だけ** |

「Select all」は選ばないでください。この鍵は Vercel の環境変数に保存されるため、
漏れたときの被害範囲が権限の広さそのものになります。`deployment:deploy` だけなら
関数の差し替えに限られますが、`deployment:env:view` を足すと Google のシークレットや
認証鍵まで読めてしまいます。

有効期限を設けると、切れた日から何の前触れもなくデプロイが失敗します。

### 3-4. Vercel の環境変数

```bash
printf '<デプロイキー>' | vercel env add CONVEX_DEPLOY_KEY production
printf 'https://<Convex の .site ドメイン>' | vercel env add NEXT_PUBLIC_CONVEX_SITE_URL production
```

| 変数 | 置く場所 | 理由 |
| --- | --- | --- |
| `CONVEX_DEPLOY_KEY` | Vercel | ビルド時に Convex へ反映するため |
| `NEXT_PUBLIC_CONVEX_SITE_URL` | Vercel | Convex は自動で入れてくれないため手で設定 |
| `NEXT_PUBLIC_CONVEX_URL` | 設定不要 | ビルド時に `convex deploy` が注入する |
| `SITE_URL` | **Convex のみ** | 読むのは `convex/auth.ts` だけ。Vercel 側に置いても効きません |

`SITE_URL` を Vercel に置くと、設定できたように見えて OAuth のコールバックだけが
静かに壊れます。置く場所を間違えやすい変数なので注意してください。

### 3-5. デプロイ

`main` に push すれば GitHub 連携でビルドが始まります。

CLI から `vercel deploy --prod` も使えますが、ローカルのファイルをアップロードするため、
`.next` などを `.vercelignore` で除外しておかないと数十 MB の転送になり失敗しやすくなります。
このリポジトリには `.vercelignore` を用意済みです。

### 3-6. Google にリダイレクト URI を追加

公開 URL が決まったら、[クライアント](https://console.cloud.google.com/auth/clients) の
承認済みリダイレクト URI に本番の 1 行を追加します。

```
https://<あなたのドメイン>/api/auth/callback/google
```

これを忘れると、ログイン時に `redirect_uri_mismatch` で止まります。

### 3-7. 誰でも登録できるようにする

最後に [対象](https://console.cloud.google.com/auth/audience) で **「アプリを公開」** を押します。

押すまでは、テストユーザーに登録した人だけがログインできます。
自分のアカウントで一通り動作を確かめてから公開するのが安全です。

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
