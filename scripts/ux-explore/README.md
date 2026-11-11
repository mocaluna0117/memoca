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

## ふつうのメモの内訳（どこに時間を使っているか、何が描き直されているか）

- `UX_BASE=http://localhost:3100 node scripts/ux-explore/profile-note.mjs --device=pixel7|desktop`
  短いメモと 300 行のメモに 200 文字打つとき、日本語の変換中の入力のときの CPU プロファイルを、関数とチャンクごとにまとめる。
  - `--only=short` / `--only=long` で絞る。
  - `--notes=300`：この端末にメモを 300 件足してから測る（アプリで作った 1 件の行を写したもの。サーバーには送らない）。一覧やサイドバーの読み直しの重さは、メモの数で大きく変わる。
  - `--renders`：打っているあいだに、どの部品が何回描き直されたか、そのうちどれが自分の state・context・store の変化で描き直しを始めたか（`部品#フック番号`）を出す。React DevTools と同じ仕組み（`__REACT_DEVTOOLS_GLOBAL_HOOK__`）。
  - `--save=<dir>`：プロファイルを JSON で残す。`node scripts/ux-explore/inclusive.mjs <file> --callers=関数名,…` で、部品ごとの（呼んだ先を含む）時間と、指定した関数の呼び出し元をたどれる。
- 部品や関数の名前を読めるようにするには、名前を縮めずにビルドする：
  `NEXT_PUBLIC_CONVEX_URL=http://127.0.0.1:3210 NEXT_PUBLIC_CONVEX_SITE_URL=http://127.0.0.1:3211 npx next build --no-mangling`
  （調べ終わったら、ふつうの `pnpm build` に戻してから E2E と前後比較をする）。
- 打つ文字は `keyboard.type`（日本語は文字を挿入するだけで keydown が出ない）。BlockNote の「⋮⋮」は keydown で隠れるので、keydown が出ない入力でも隠れるようにしてある（`side-menu-input.ts`）。


## 記法を実際に打つ・メモリを測る（2026-11-11）

- `UX_BASE=http://localhost:3100 node scripts/ux-explore/notations.mjs [--only=note,quick,todo] [--case=id,...]`
  - ふつうのメモ（ケースごとに新しいメモ）、即席メモ（ケースごとに新しいタブ）、Todo（末尾に項目を足しながら）に、記法を 1 つずつ打ちます。
  - ブロックの種類・文字・深さ・書式を記録します。
  - 日本語入力は、CDP の `Input.imeSetComposition` と `Input.insertText` で、変換して確定する流れを再現します。
  - 期待と違ったものは `shots/notation-*.png` に残し、結果は `notations-<時刻>.json` に出します。
- `UX_BASE=http://localhost:3100 node scripts/ux-explore/memory.mjs [--cycles=60] [--only=notes,quick,palette,pressure]`
  - 次の 3 つを繰り返し、10 回ごとに数えます。数える前に、使っていないメモリを片付けさせます。
    - メモの切り替え
    - 即席メモ（Todo とタブの切り替え、ベル、入力）
    - コマンドパレット
  - 数えるのは、JS のメモリ・画面の要素の数・見張り（イベントリスナー）の数・文書の数です。慣らし（10 回）のあとの 1 回あたりの増え方を出します。
  - そのあと、300 行のメモに 200 文字打ちます（CPU 4 倍遅く）。次の 3 つの状態で測ります。
    - ふつう
    - 「メモリが足りない」知らせを 0.5 秒ごとに送り続ける
    - JS のメモリを 160MB に絞る
  - 結果は `memory-<時刻>.json` に出します。
- 見張りが増えたときに、どこで付けられたかを探すには、CDP の `Runtime.queryObjects` で EventTarget の種類ごとに集め、`DOMDebugger.getEventListeners` の `scriptId` と行・列から、元のコードを引きます。
- 試しのスクリプトは `tmp-*.mjs` という名前にすると、git に入りません。
