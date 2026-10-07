# E2E を手元の Convex で流す

Convex の無料プランの月の上限（関数の呼び出し 100 万回、データベースの読み書き 1GB）は、本番と、クラウドにあるすべての開発用デプロイメントで共有です。E2E をクラウドの開発用デプロイメントに向けて流すと、1 回で約 2 万回・0.02GB を使います。2026-10-07 には、これで読み書きの上限を超えました。

手元の Convex（このパソコンの中で動くサーバー）に向けて流せば、クラウドの上限は使いません。

## 流し方

```sh
pnpm e2e:local e2e/quick.spec.ts --project=desktop
```

- 引数は、そのまま `playwright test` に渡ります。
- `scripts/e2e-local.sh` が次の順に動きます。
  1. 手元の Convex がまだ動いていなければ起動し、このチェックアウトの関数を入れる
  2. 手元の Convex 向けにアプリをビルドして :3100 で動かす
  3. テストを流す
  4. 終わったら、起動したものを止める
- 終わったあとの `.next` は手元の Convex 向けのビルドです。いつものビルドが要るときは `pnpm build` をやり直します。
- ブラウザ 2 つと Convex を同じパソコンで動かすので、たまに読み込みが遅くて時間切れになります。失敗したテストだけ流し直してください（`--last-failed`）。

## はじめに一度だけ

2026-10-07 に済ませてあります。作り直すときの手順です。

1. 手元のデプロイメントを、`.env.local`（いつもの開発用クラウド）を変えずに作ります。`.env.local` は先に控えておき、最後に元に戻します（CLI が書き換えるため）。
   ```sh
   cp .env.local /tmp/env.local.bak
   CI=1 npx convex dev --configure existing --team daibon20020117 --project memoca \
     --dev-deployment local --env-file .env.e2e-local   # 「functions ready」が出たら Ctrl+C
   cp /tmp/env.local.bak .env.local
   ```
2. `.env.e2e-local` は次の 3 行にします（git には入りません）。
   ```
   CONVEX_DEPLOYMENT=local:local-daibon20020117-memoca-2
   NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:3210
   NEXT_PUBLIC_CONVEX_SITE_URL=http://127.0.0.1:3211
   ```
3. 環境変数を、開発用クラウドから手元に写します。値は画面に出さず、`SITE_URL` は `http://localhost:3100` にします。
   ```sh
   umask 077; T=$(mktemp)
   npx convex env list > "$T"
   sed -i '' 's#^SITE_URL=.*#SITE_URL=http://localhost:3100#' "$T"
   npx convex env set --deployment local --from-file "$T"; rm -f "$T"
   ```

手元のデータは `.convex/local/default/` にあります。消すと空からやり直しになり、環境変数も入れ直しが必要です。
