# UX の探索（Playwright で実際に操作する）

E2E が覆っていない流れを、手元の Convex と手元のビルドに対して実際に操作し、
見たものと計測（入力の遅れ、画像貼り付けの長い処理）を JSON に残す。
`playwright test` ではなく node のスクリプト。

1. 手元の Convex を起動：`npx convex dev --env-file .env.e2e-local`
2. 手元向けにビルドして起動：
   `NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:3210 NEXT_PUBLIC_CONVEX_SITE_URL=http://127.0.0.1:3211 pnpm build && pnpm start`
3. `node scripts/ux-explore/run.mjs --device=desktop`（`pixel7` も）。
   `--only=typing-latency,paste-perf` で絞る。`--no-offscreen` でページ側の画像処理と比べる。
   結果は `scripts/ux-explore/findings-<device>-<時刻>.json` とスクリーンショット（`shots/`、git には入れない）。

計測のシナリオは CPU を 4 倍遅くして走る（`cpuSlow`）。数値は 3 回の中央値。

即席メモだけを測るとき：`UX_BASE=http://localhost:3100 node scripts/ux-explore/measure-quick.mjs`
（Pixel 7・CPU 4 倍遅く・3 回の中央値で、`/quick` が打てるようになるまでの時間と、1 文字ごとの遅れ）。
前後を比べるときは、前の版を別のフォルダ（git worktree）でビルドし、同じ 3100 番で順に起動して測る
（ログインは 3100 番の origin しか受け付けない）。
どこに時間を使っているかは `UX_BASE=http://localhost:3100 node scripts/ux-explore/profile-quick.mjs`
（開くとき・最初の 1 文字・200 文字・日本語の変換中の入力それぞれの CPU プロファイルを、関数とチャンクごとにまとめる。
打っている途中の長い処理があれば、その時間だけを切り出して出す）。
