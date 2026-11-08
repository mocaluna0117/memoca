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
