# 容量対策と、デスクトップ版の即席メモ

2026-09-26 に決めた計画です。ロック機能の仕様は [`LOCK.md`](LOCK.md)、全体計画は [`PLAN.md`](PLAN.md) にあります。進捗はこのファイルの「状態」に追記します。

## 状態

| 段 | 項目 | 状態 |
|---|---|---|
| S0 | この計画を docs に置く | 済み（2026-09-26） |
| S1 | ロックしたメモにコピーした画像を、そのメモ用のコピーにする | 済み（2026-09-26）。下の「S1 の実装で決めたこと」 |
| S2 | 平文のコピーが残るロックをサーバーで拒む | 保留（同じく下に理由） |
| S3 | WebP の判定を 1 回に、1 枚の上限を守る、追加する前に容量を確かめる | 済み（2026-09-26）。下の「S3 の実装で決めたこと」 |
| S4 | canvas で WebP を書けないブラウザ（Safari）では WebAssembly で書く | 済み（2026-09-26）。下の「S4 の実装で決めたこと」 |
| S5〜S7 | 容量対策の残り | 未着手（S5 は実機の診断結果を見てから） |
| Q1〜Q6 | 即席メモ画面の改修 | 未着手 |
| D0〜D3 | デスクトップ版 | 未着手 |

### S1 の実装で決めたこと（2026-09-26）

- **ロックは、コピーした画像のせいで失敗しない。** コピーを作れない画像（オフライン、容量不足、この端末にまだ届いていない画像）があっても、本文とタイトルは暗号化してロックを終え、「ほかのメモからコピーした画像 n 件は、まだ暗号化できていません」と知らせる（メモ単体・フォルダ・ロックしたフォルダへの移動のどれでも）。数えるのは、サーバーで読める状態のものだけ。残りは、メモを開いている間はエディタが、それ以外は修復パス（金庫を開いたとき・通信が戻ったとき・同期のたび、1 回 5 件まで）が作り直す。容量不足は 1 回のセッションに 1 度だけ、設定を開く導線つきで知らせる。
- **ロックするときのコピー**：ほかのメモの画像の暗号化したコピーを先に用意し、コピーを指すように直した版のメモを暗号化してサーバーに渡す。メモそのものを書き換えるのはロックが通ってからなので、コピーのことが平文でサーバーに届くことはなく、ロックが通らなければメモは元のまま（用意したコピーは取り消す）。コピーはロックが通るまで送らずにおき、通ったらふつうのアップロードの列で送る。アップロードを待たないので、ロックはすぐ終わる。ロックを外すときは、送っている途中のファイルが済むのを待つ。
- **ロック済みのメモ**：エディタ（貼ったとき）と修復パスが、同じように暗号化したコピーを作ってメモを書き換える。1 つのメモを扱うのは 1 度に 1 つだけ（タブをまたいでも、ロック・ロック解除とも重ならない）。金庫を開いたままにはしない。
- **サーバーがコピーを受け取らなかったとき**（容量超過など）は、メモを元の画像に戻し、そのことを端末に記録する。書き換えがあとから届いても（別のタブ、保存待ちの編集）、次のパスで元に戻す。同じ画像は 10 分コピーし直さない。1 ファイルの上限（画像・動画ごと、暗号化で増える 16 バイト込み）も、ダウンロードの前に確かめる。
- **古い状態のままコピーしない**：持ち主のメモがロック済みなのに、ファイルの行がまだ平文と書かれているとき、また平文のはずのファイルが行のサイズより長く届いたとき（ほかの端末で暗号化され、この端末にその知らせがまだ届いていない）は、中身が暗号文かもしれないので待つ。
- **端末に平文を残さない**：まだ送っていない暗号化予定のファイルは、金庫を閉じている間は表示しない。本文のスナップショットと、ロックのために読み出す平文のファイルは、Service Worker とブラウザのキャッシュに残さない。
- オフラインで作ったメモに貼った画像が、通信が戻ったときに消えることがあった（ファイルがメモより先に送られ、サーバーが「知らないメモ」として断り、端末から消していた）。メモが届くまで待って送るように直した。
- 途中で見つけた同期の不具合 2 件も直した：同じメモを同時に開くと文書が 2 つでき、片方の編集が保存されない。ロック・ロック解除・本文の取り直しのあとの読み直し（`reloadDoc`）の間に書いた編集が保存されず、保存待ちの編集もすぐには書かれない。
- **残した課題**：
  - `<img>` で表示したふつうの画像は、あとでロックしても、ブラウザ自身のキャッシュに最大 30 日残る（Convex のストレージが `max-age=2592000` を返すため）。オフラインでの表示に使っているので、いまは残す。
  - ロックしたメモに貼った直後（1 秒以内）にトリミングを開くと、そのあいだにコピーへ書き換わり、「変更されたため」とトリミングが断られることがある。
  - 同じメモを 2 つのタブで同時に開くと、タブ間では編集がその場で反映されない（以前から）。
- **S2 を保留にした理由**：サーバーで「平文のコピーが残るロック」を拒むと、上の「ロックは失敗しない」と矛盾する（容量不足やオフラインのたびにロックできなくなる）。拒んで守れるのは S1 より古い版のアプリだけで、PWA は次に開いたときに新しい版へ切り替わるため、効き目が小さい。第 1 段の報告でオーナーに確認する。

### S3 の実装で決めたこと（2026-09-26）

- **WebP を書けるかは 1 度だけ確かめる**：1 ピクセルの canvas で確かめ、書けない Safari では、フルサイズで WebP を試して PNG を受け取る無駄をやめる（予備の形式を最初から書く）。
- **1 枚の上限（既定 5 MB）**：書き出したものが上限を超えるときだけ、長辺 1600 → 1280 px、画質を 1 段ずつ下げて最大 2 回書き直す。それでも超えるものは、追加する前に「画像が大きすぎて追加できません（1 枚 5 MB まで）」と断る。上限内の画像は 1 回しか書き出さない。サーバーが受け付けない形式の元画像（Safari で読める HEIC など）は、書き出したものを必ず使う。
- **追加する前に確かめる**：エディタへの貼り付け・ドロップ・ファイル選択は、圧縮 → 容量と 1 ファイルの上限の確認 → 端末に置く、の順にする。これまではすべて置いてから裏でサーバーに断られ、何も言われずに画像が消えていた。確認に使う容量の数字は、ファイルを追加するたびに最新のものを読む。送信中のファイルは、サーバーが予約を受け付けた時点で端末側の数から外す（二重に数えて断らないため）。
- **断るもの**：このブラウザで読めず、サーバーも受け付けない画像（Chrome の HEIC、TIFF、SVG など）と、画像と動画以外でサーバーが受け付けない種類（PDF、音声など）。HEIC には「iPhone や Mac の Safari から追加してください」と添える。ロックしたメモは暗号化して送り、サーバーは中身の種類を見ないので、読めない画像もほかの種類のファイルもそのまま受け付ける（これまでどおり）。
- **断ったファイルのブロック**：BlockNote はファイルを受け取る前にブロックを作り「Loading...」のまま残すので、貼り付け・ドロップで作られたものは元の空の行に戻し、自分で作った空の画像ブロックは「画像を追加」の状態に戻す。
- トリミングも、1 枚の上限を超えたときは容量不足ではなく上限の文言で断る。

### S4 の実装で決めたこと（2026-09-26）

- **Safari では WebAssembly で WebP を書く**：iPhone・iPad・Mac の Safari は canvas で WebP を書けないため、libwebp を WebAssembly にした `@jsquash/webp`（Apache-2.0、SIMD なし 281 KB）を Web Worker で動かす。これまで Safari では、スクショは PNG、写真は JPEG 90% のままだった。
- **速さを優先した設定**：libwebp の `method` は 2（既定の 4 より 2〜3 倍速く、大きさは 3〜4% 増えるだけ。レビューでの計測）。1 枚ずつ処理し、エンコードは 8 秒、初回の読み込みは 30 秒で打ち切る。画面を離れている間（iOS はアプリを止める）は数えない。
- **失敗したとき**：その画像はこれまでどおり JPEG／PNG で保存する。エンコードが続けて 2 回失敗したら、そのセッションでは使わない（成功すれば数え直す）。オフラインで読み込めなかったときは失敗に数えず、通信が戻ったらまた使う。20 秒使わなければ worker を終了し、メモリ（35〜50 MB）を返す。
- **置き場と更新**：`scripts/build-webp-worker.mjs`（esbuild）がビルド時に `public/webp/<版>/` へ置く（リポジトリには入れない）。版と、元になるファイルの指紋を `src/lib/media/webp-asset.json` に記録し、worker やビルドを変えて版を上げ忘れるとテストが落ちる（1 年キャッシュするため、同じ版のままでは届かない）。古い版のキャッシュは Service Worker が消す。
- **先読みしない**：Chrome・Firefox は canvas で WebP を書けるので使わない。全員の初回ダウンロードを増やさないよう precache には入れず、初めて使ったとき（Safari ではエディタを開いたとき）に Service Worker が保存する。その後はオフラインでも使える。
- **診断**：設定の「保存容量」に、管理者だけの「画像の診断」を置いた。画像を 1 枚選ぶと、ブラウザと画面、canvas で WebP を書けるか、エンコーダーの状態と端末への保存、元画像の寸法と読み込み時間、各段階の大きさ・形式・時間の内訳（画素の読み出し、待ち、読み込み、エンコード、メモリ）を表示する（アップロードはしない）。iPhone と Mac で測って、S5 の数値を決める。
- 見送り：`createImageBitmap` に縮小後の大きさを渡してメモリを抑える案（大きさを知るには一度読み込む必要があり、実機で困ってから考える）。

## 背景

依頼は 2 つ。

1. **保存容量の節約**。画像を貼ると 100 MB の容量を圧迫する。
2. **デスクトップ版の即席メモ**。macOS の「クイックメモ」のように、Mac と Windows で画面の隅やキーで即席メモをすぐ出したい。今後やりたいことなので、1 の設計に織り込む。

### 現状（2026-09-26、本番のバックアップから）

- 使用量 4.4 MB / 100 MB。画像 56 件（WebP 47 件・平均 63 KB、PNG 9 件・平均 159 KB）。
- 圧縮は `src/lib/media/compress.ts` の `prepareImage`（長辺 2048px、WebP 82%）。**Safari（iPhone・iPad・Mac、そして Tauri の Mac 窓）は canvas で WebP を書けない**ため、スクショは PNG のまま（Chrome の約 2.5 倍）、写真は JPEG 90%（1 枚 0.7〜1 MB 見込み）になる。
- `encodeCanvas` は Safari で無駄な PNG エンコードを 1 回してから予備の形式に落ちる。「元より小さくならなければ元を使う」ため、5 MB の上限を超える元がそのまま通る。
- 貼り付け時の容量チェックがない（`note-editor.tsx` の `uploadFile`）。サーバーの拒否は同期エンジンで握りつぶされ、`t.quota.exceeded` のトーストは出ない。

### 調査で見つかった、ロックの抜け（先に直す）

- ロックしていないメモ A の画像を、ロックしたメモ B にコピーして貼ると、その画像は**サーバー上で平文のまま**残る。ロック時に暗号化するのは `attachments.where("noteId")` の自分の画像だけ（`src/lib/vault/actions.ts`、`convex/vault.ts` の `plaintextAttachmentsLeft`、`reconcile.ts` の `lockPlaintextAttachments`）。Service Worker の `memoca-media` キャッシュも平文を消さない。

### デスクトップ版の可否（調査結果）

- 本番サイトはネイティブの窓（Mac は WKWebView、Windows は WebView2）に読み込める（ヘッダーの制限なし、Cookie は同一オリジン、Convex に origin 検査なし）。
- **Google のログインは埋め込みの窓では拒否される**（`disallowed_useragent`）。システムのブラウザでログインし、Better Auth の `oneTimeToken` プラグイン（better-auth 1.6.33 に同梱）で窓に引き継ぐ。`trustedOrigins` も Google Console も変更不要。
- **PWA だけでは**全体ホットキー・ホットコーナー・最前面・窓サイズ固定・トレイはできない。
- **macOS のホットコーナーは Apple 純正機能専用**。Memoca はカーソル位置を監視して自分で出す（任意設定）。
- `/quick` はテキスト欄だけで画像は貼れず、保存後に `/app` へ移る。`/quick` と `/app` は別レイアウトで、行き来のたびに同期エンジンを作り直し **`vault.lock()` が走る**（`sync-provider.tsx`）。

## 決まっていること（オーナー回答 2026-09-26）

| 項目 | 決定 |
|---|---|
| 順番 | **第 1 段 容量対策 → 第 2 段 即席メモ改修 → 第 3 段 デスクトップ版** |
| 作り方 | **Tauri v2 の軽い殻**（本番 URL を読み込む。バンドル配信はしない） |
| 呼び出し方 | **ホットキー（既定 ⌘⇧M / Ctrl+Shift+M）＋メニューバー／トレイのアイコン＋ホットコーナー（任意設定、既定オフ）** |
| 署名 | **最初は署名なし（自分用）**。Apple Developer Program は第 3 段の終わりに再検討 |
| 元の画像 | トリミング等で使われなくなった画像は 30 日後に自動削除（実装済み） |

守ること：Convex の変更は追加のみ、サーバー変更のコミット前に `npx convex export --prod` でバックアップ（`~/memoca-backups/`）、E2E の前に `npx convex dev --once`、秘密はリポジトリに置かない、UI の文言は日本語、コミットは Conventional Commit（英語本文）。

## 進め方

- 各コミットはエージェントが作業ツリーで作り、別のエージェント 3 人が異なる観点でレビューし、確かめられた指摘だけを直してから取り込む。取り込み後に E2E 全件を通して push する。
- 各段の終わりに報告し、実機での確認が要る点をまとめる。

---

## 第 1 段：容量対策（S1〜S7、各コミットは単独でデプロイ可）

| # | コミット | 内容 |
|---|---|---|
| S1 | `fix(lock): a file copied into a locked note becomes its own encrypted copy` | 新規 `src/lib/media/relock-copies.ts`：`stageLockedCopy(client, noteId, attachmentId, me)`（`loadAttachmentBlob` → `fitsAllowance`+`queuedBytes` → `stageUpload({locked:true, prepared})`）と `rewriteRefInDoc(doc, oldRef, newRef)`（`ydoc.ts` の `attachmentRefs` の走査を流用し `setAttribute("url")`）。使う場所は 3 つ：(a) ロック中メモの編集中（`note-editor.tsx` の `EditorSurface`、`onChange` を 1 秒デバウンス＋マウント時。`apply-crop.ts` の段取りを流用、`vault.hold()`、undo で戻ったときは対応表で再利用）、(b) ロック時（`actions.ts lockNote` の `unsent` 判定のあと。書き換えたら `{status:"skipped", reason:"unsent"}` を返し、`cascade.ts` の再試行に乗せる）、(c) 修復パス（`reconcile.ts` の `repairLocks`、1 回 5 件まで、`RepairReport.copiesRelocked`）。あわせて `purgeMediaCache()`（`caches.delete("memoca-media")`）を `purgeLockedBlobs`・ロック成功後・`apply.ts` で locked が false→true になったときに呼ぶ。判定は「ロックしたメモが参照する画像の `noteId !== そのメモ`、または `!locked`」。 |
| S2 | `feat(convex): refuse a lock that would leave a copied plaintext file` | `convex/vault.ts plaintextAttachmentsLeft` が `attachmentRefs`（`by_user_note`）も見て、`covered` にない平文ファイルがあれば新しい理由 `foreignPlaintext`。`cascade.ts` の `TRANSIENT` に追加。**S1 が本番に出て全端末が更新されてからデプロイ**（バックアップを先に）。 |
| S3 | `fix(media): probe WebP once, respect the image cap, and check the allowance before staging` | 新規 `src/lib/media/webp-encoder.ts` に `canvasWritesWebp()`（1×1 canvas で 1 度だけ判定）。`encodeCanvas` は判定が偽なら WebP を試さず予備へ（Safari の無駄な PNG エンコードをなくす）。`prepareImage(file, {maxBytes})`：元が上限超なら再エンコード結果を使い、なお超えるなら `長辺 1600→1280`・画質 1 段下げで最大 2 回やり直す。`note-editor.tsx uploadFile` は `applyCrop` と同じく `prepareFile` → `fitsAllowance` → `stageUpload({prepared})` にし、`QuotaError` のトーストを生かす。デコード不能な非対応形式（Chromium の HEIC）は `UnsupportedImageError` で説明する。 |
| S4 | `feat(media): encode WebP in a worker where the canvas cannot` | `@jsquash/webp` 1.5.0（Apache-2.0）。`src/workers/webp-worker.ts` を新規 `scripts/build-webp-worker.mjs`（esbuild、iife、`target: safari15`）で `public/webp/<ver>/webp-worker.js` に束ね、`webp_enc.wasm`（非 SIMD、281 KB）を隣に置く。`predev`/`build` に追加、`/public/webp` を gitignore（`copy-kuromoji-dict.mjs` と同じ流儀）。クライアントは `yomi.ts` の Worker の作り（遅延起動、pending map、`unavailable`）を写す：`encodeWebp(imageData, options, {timeoutMs: 8000})`、バッファは transfer、同時 1 件、失敗 2 回で以後は予備へ。Serwist は既定の precache に任せる（約 320 KB）。`vercel.json` に `/webp/(.*)` の immutable ヘッダー（Service Worker のない WKWebView 向け）。`WEBP_ASSET_VERSION` 定数と、`node_modules/@jsquash/webp/package.json` の版と一致することを確かめる単体テスト。「圧縮してから表示」は維持し、処理を裏側へ移す。`createImageBitmap` に `resizeWidth/Height` を渡してメモリを抑える（WebKit で効かなければ `drawImage` に戻す）。**診断**：設定の保存容量に管理者だけの「診断」欄（ファイルを選ぶと UA・canvas WebP 可否・各段の形式／時間／サイズを表示）。iPhone と Mac で実測してから S5 の定数を決める。 |
| S5 | `feat(media): choose image quality and size by what the image is` | 新規 DOM 不要の `src/lib/media/classify.ts`：`classifyImage({mime, name, sample(64×64), width, height}) → screenshot / photo / graphic`（名前 `screenshot|スクリーンショット|スクショ|IMG_\d+\.PNG`、JPEG/HEIC は写真、色数 ≤ 96 か平坦率 ≥ 0.5 で図）。`encodingPlan`：スクショは q0.90（WASM 経路で ≤ 1.2 MP なら near-lossless も試し小さい方）、写真は q0.82 → 120 KB/MP を超えたら q0.72 → q0.62、図は ≤ 1 MP なら可逆。`fitScale(size, {maxEdge, maxPixels})` を `crop.ts` に足し、スクショは `{maxEdge: 2560, maxPixels: 3.3e6}`（iPhone の縦長スクショを縮めない）、写真は `{maxEdge: 2048}`。全体の時間予算 6 秒。定数は `ENCODING` に集約。 |
| S6 | `feat(convex): storage breakdown, file tombstones on purge, and an honest recompute` | `attachments.category`（任意）を `reserve` で保存。新クエリ `attachments.usageBreakdown`（`by_user_seq` を 5000 件まで）：画像・動画・その他・本文（生きている／ゴミ箱）・ゴミ箱の添付・未使用（削除待ち、`nextDeleteAt`）・予約中・再計算した合計・大きい順 20 件（`attachmentRefs` からどのメモが使っているか）。`trash.ts purgeNote` は行を消さず `{deletedAt, storageId:null, seq}` のトゥームストーンにする（端末の Dexie に残る古い行をなくす）。`admin.recomputeUsage` は `deletedAt === null` を条件に加える。バックアップを先に。 |
| S7 | `feat(settings): 保存容量の内訳と大きいファイル` | 新規 `src/components/settings/storage-breakdown.tsx` を保存容量の欄に。内訳の帯、行ごとの数字、`recomputedUsed !== usedBytes` のときは注記。大きいファイル一覧は名前（ロックは「ロックされたファイル」）、`formatBytes`、幅×高さ、使っているメモのタイトル（`useNoteTitle`）、クリックで `useWorkspace().openNote`。文言は `ja.ts` の `storage` に追加。 |

**期待する効果**：iPhone のスクショ PNG → WebP で約 −60%、iPhone の写真 JPEG 90% → WebP で約 −65%、Chrome の写真は段階的な画質で −20〜30%、Chrome のスクショはほぼ変わらず。既存画像の再圧縮は、使用量が 50 MB を超えるまで見送る（S1 の部品で後から作れる）。

---

## 第 2 段：即席メモ画面の改修（Q1〜Q6）

スマホ（従来どおり）とデスクトップの小窓（Tauri の窓、またはブラウザのポップアップ）の 2 つの表示モードを同じ `/quick` で持つ。

| | `page`（スマホ、ナビの ⚡、共有先） | `window`（小窓） |
|---|---|---|
| 判定 | 既定 | `?window=1`、または `window.memocaShell`、または UA の `MemocaShell/` |
| 配置 | 画面全体スクロール＋固定ヘッダー | `h-dvh`、ヘッダー固定、テキスト欄は内側でスクロール（`field-sizing-fixed`） |
| ⌘/Ctrl+Enter | 保存 → `/app?n=` へ（今どおり） | 保存 → その場で欄を空にし「保存しました ・ エディタで開く」 |
| Esc | なし | 下書きを保存して閉じる（`memocaShell.hide()` → なければ `window.close()`） |
| ヒント | `{⌘|Ctrl} + Enter で保存` | 同上 ＋ `Esc で閉じる` |

| # | コミット | 内容 |
|---|---|---|
| Q1 | `feat(quick): pure helpers` | 新規 `src/lib/quick/`：`mode.ts`（`detectQuickMode`、`useQuickMode` は `useClientValue` で hydration 不一致を避ける）、`shell.ts`（`window.memocaShell?: {hide, openExternal, beginSignIn?, platform}` の型と no-op 付きラッパー）、`text.ts`（`joinShared`、`splitQuickText`：1 行目が 80 字以内ならタイトルにして本文から外す。今はタイトルと本文に同じ行が重複表示される）、`body.ts`（`appendQuickBlocks(doc, parts)`：BlockNote と同じ `blockGroup > blockContainer > paragraph/image` の形で書く。今は素の `paragraph` を根に置いていて、エディタが直すまで不正な形）、`draft.ts`（`META.quickDraft` に 300 ms デバウンスで保存、`pagehide`/非表示で flush、保存で消す。Blob も入れられる形）。`platform.ts` に `modKeyLabel()`（⌘ / Ctrl）。 |
| Q2 | `refactor(app): one workspace layout for /app and /quick` | `src/app/(workspace)/layout.tsx` に `SyncProvider`+`AccountGate` をまとめ、`app/` と `quick/` を配下に移す（URL は不変）。`/quick` ↔ `/app` で同期エンジンを作り直さず、`vault.lock()` も走らない。`prefetchBodies` は pathname が `/app` のときだけ。`SerwistProvider` に `reloadOnOnline={false}`（オンライン復帰の自動リロードで下書きが消えるのを止める。直前 0.5 秒の編集も、保存が間に合わずに消えることがある：2026-09-26 の E2E で確認）。 |
| Q3 | `feat(quick): window mode, drafts, honest save` | `quick-capture.tsx` を上の表どおりに。`try/finally` で `saving` を戻す、IME 変換中の Enter を無視、`autoFocus`、窓では `window` の focus で再フォーカス、トーストは使わず `role="status"` の行で伝える。 |
| Q4 | `feat(auth): return to where sign-in started` | `/quick` のページで `isAuthenticated()` を見て `/sign-in?next=/quick?...` へ。`sign-in-card.tsx` は `next`（`/` 始まりのみ）を `signInWithGoogle(next)` に渡す。 |
| Q5 | `feat(sw): keep /quick as an offline shell` | `sw.ts` の `/app` の規則を `/quick` にも（クエリを除いたパスで 1 エントリ）。precache には入れない（未ログインのリダイレクトを保存してしまう）。 |
| Q6 | `feat(quick): open it from the desktop web app` | サイドバーの「すべてのメモ」の上に ⚡ ボタン、⌘K に「即席メモ」、`Q` キー（入力欄・エディタ・ダイアログ中は無効）。いずれも `window.open("/quick?window=1", "memoca-quick", "popup,width=380,height=460")`、ブロックされたら `router.push("/quick")`。 |

テスト：`tests/quick-*.test.ts`（形の検証は `BlockNoteEditor.create()` ＋ `yXmlFragmentToProseMirrorRootNode().check()`、jsdom で動かなければ構造の検証だけにして E2E の往復で補う）。Playwright に `window` プロジェクト（380×460、`testMatch: /quick-window/`）を追加し、既存 2 プロジェクトは除外。`e2e/quick.spec.ts`（保存 → `/app?n=` で本文が出る、prefill、下書き、Esc、デスクトップの 3 つの入口）と `e2e/quick-window.spec.ts`（60 行でもヘッダーと保存が画面内、Ctrl+Enter で保存して欄が空、Esc でポップアップが閉じ再開で下書き復元、UA ごとのヒント表示）。

---

## 第 3 段：デスクトップ版（D0〜D3）

### 仕組み

```
Mac / Windows                              Vercel（Next）                 Convex
┌────────────────────────┐  ホットキー／トレイ／隅  ┌──────────────────┐   ┌────────┐
│ Memoca.app（Tauri v2）  │ ── 表示／非表示 ──▶ │ /quick（window）   │◀─▶│ 同期・認証 │
│  常駐、窓は隠して先読み   │  本番 URL を読み込む   │ /sign-in（殻用）    │   │ +oneTime │
│  IPC は hide/openExternal│                      │ /desktop/complete │   │  Token  │
│  /beginSignIn の 3 つ    └──┐                   └──────────────────┘   └────────┘
└────────────────────────┘   │ システムのブラウザ：/desktop/sign-in?state → Google → /desktop/handoff
                             └── memoca://auth?token&state ◀── oneTimeToken.generate
```

- 窓：`quick` 1 つ、420×360（最小 320×240）、枠なし（ヘッダーが `data-tauri-drag-region`）、常に最前面、起動時は非表示で先読み、タスクバーに出さない、全ワークスペースで表示。UA に `MemocaShell/<ver> (macos|windows)` を付け、初期化スクリプトで `window.memocaShell` を注入。
- 表示：ホットキー → カーソルのある画面の上中央、トレイのクリック → トレイの近く、ホットコーナー → その隅。フォーカスが外れたら隠す（トレイの「ピン留め」で無効化）。Esc と × は `hide`。
- 認証：`convex/auth.ts` に `oneTimeToken({storeToken:"hashed", expiresIn:3})`、`src/lib/auth/client.ts` に `oneTimeTokenClient()`。殻の `beginSignIn` は 32 バイトの `state` を作ってブラウザで `/desktop/sign-in?state=` を開く → Google → `/desktop/handoff` が `generate()` して `memoca://auth?token=&state=` へ → 殻が `state` と 10 分以内を確かめて窓を `/desktop/complete?token=` に移す → `verify()` で Cookie が入り `/quick` へ。`tauri dev` では deep link が効かないので「コードを貼り付け」の予備を残す。窓は Google のドメインへの遷移をブロックしてブラウザで開く。
- 権限：capability は `quick` 窓と `https://memoca-app.vercel.app/*` に限定し、`core:event:allow-listen/unlisten`、`core:window:allow-start-dragging`、自前の 3 コマンドだけ。プラグイン（global-shortcut、positioner、autostart、updater、deep-link、single-instance、opener）は Rust からのみ使う。`open_external` は本番オリジン配下だけ許可。
- 金庫：殻は `/app` を開かない（「エディタで開く」は既定のブラウザ）。即席メモは Inbox 行きで金庫が不要。もし金庫の画面が出ても、この窓にはパスキーの記録がないのでパスワードが先に出る（署名なしでは Touch ID は使えない）。
- 置き場：`desktop/`（`package.json`、`pnpm-lock.yaml`、`src-tauri/`）を**独立パッケージ**として置く（pnpm workspace にはしない）。`tsconfig.json` の exclude、`eslint.config.mjs` の ignores、`.vercelignore`、`.gitignore`（`desktop/src-tauri/target`、`gen`）、`.prettierignore` に追加。`vercel.json` に `ignoreCommand` で desktop のみの変更は Web をデプロイしない。
- 配布：署名なし。Mac は初回だけ「システム設定 → プライバシーとセキュリティ → このまま開く」（macOS 15 以降は右クリック→開くが使えない）、Windows は SmartScreen で「実行」。手順は新規 `docs/DESKTOP.md`（README からリンク）。

### 段階

| # | 内容 | 目安 |
|---|---|---|
| D0 | Web 側の下地：`src/lib/shell/native.ts`（UA 判定）、`sign-in/page.tsx` で殻用カード（「ブラウザでログイン」＋コード貼り付け）、`/desktop/sign-in`・`/desktop/handoff`・`/desktop/complete`（`robots: noindex`）、`oneTimeToken` の配線、リポジトリの除外設定。バックアップを先に。 | 1 日 |
| D1 | Mac 版：Rust 環境（`rustup`）、`desktop/` の Tauri プロジェクト、窓・トレイ（日本語メニュー：即席メモを開く／ピン留め／ホットコーナー▸なし・4 隅／ブラウザで Memoca を開く／再読み込み／バージョン／終了）・ホットキー（既定 ⌘⇧M、`settings.json` で変更）・ホットコーナー（100 ms ごとにカーソルを監視、隅 2 px に 300 ms とどまる、離れるまで再発火しない、既定オフ）・single-instance・deep-link・opener、3 コマンドと capability、遷移ガード、blur で隠す＋ピン留め、`.github/workflows/desktop.yml`（`desktop-v*` タグで macOS ビルド、下書きリリースに `.dmg`）。 | 4〜6 日 |
| D2 | Windows 版（NSIS、WebView2 のブートストラップ、Ctrl 表示、Alt-Tab から隠す）、ログイン時起動（`--hidden`）、自動更新（更新鍵、6 時間ごと）、窓の位置とサイズの記憶、12 時間以上たった窓を表示時に再読み込み、`docs/DESKTOP.md`。Windows 機か VM で確認。 | 3〜4 日 |
| D3 | 即席メモに画像（テキスト欄に `image/*` の貼り付け・ドロップを受け、サムネイル付きの一覧に持ち、保存時に `stageUpload` → `appendQuickBlocks` の image。`flushUploads` の `unknownNote` を `lockMismatch` と同じく再試行に。HEIC は不可と表示。BlockNote は載せない：保存前に `noteId` が要る、起動が重い、WKWebView の contenteditable は未検証）。Apple Developer Program に入る場合のみ：Developer ID 署名＋公証、Associated Domains と `public/.well-known/apple-app-site-association` でパスキー。 | 3〜5 日 |

---

## 検証

- **単体（vitest）**：S1 `rewriteRefInDoc`・`stageLockedCopy`（`tests/apply-crop.test.ts` の fixture を流用）、S3 判定 1 回・上限・容量チェック（`tests/compress.test.ts` のスタブ）、S4 `FakeWorker` で transfer・タイムアウト・`unavailable`、版の一致、S5 分類と `fitScale` と段階の上限、Q1 の各モジュール、D0 の UA 判定と `state` の検証。
- **Convex（convex-test）**：S2 `foreignPlaintext`、S6 内訳・トゥームストーン・再計算。
- **E2E（Playwright）**：S1 `pasteHtml` で A の画像を B に貼る → `{noteId: B, locked: true}` の行と `blobs` が空（`image-crop.spec.ts` の流れ）、S3/S4 `pasteImage` → `mime: image/webp` でサイズが縮む、第 2 段の `quick.spec` と `quick-window.spec`、D0 の `shell` プロジェクト（UA に `MemocaShell/`、偽の `window.memocaShell` で `hide`/`openExternal` の呼び出しを記録、`/desktop/complete?token=` の往復）。実行は `pnpm build && pnpm start`、`E2E_BASE_URL=http://localhost:3000`、Convex の変更後は `npx convex dev --once`。
- **実機（自動化できない）**：iPhone と Mac の Safari で診断欄を使い、スクショ・写真・HEIC・10 MB の PNG の圧縮時間とサイズを記録して `ENCODING` を決める。Tauri：起動して何も出ない → ホットキーで出て入力欄にフォーカス → 保存で Inbox に入る → blur で隠れる → ログアウト状態から「ブラウザでログイン」で戻る（ビルド版）→ 2 回目の起動は既存の窓を出す → スリープ復帰後の再読み込み。Windows は SmartScreen、WebView2、Ctrl 表示、自動更新。
- **本番**：Convex を変えるコミット（S2・S6・D0）の前に `npx convex export --prod`。デプロイ後は `gh api repos/mocaluna0117/memoca/commits/<sha>/status` と、`/serwist/sw.js` の一覧から本番チャンクを取って文言で確認。

## リスク

- WebKit の挙動（canvas のメモリ上限、`createImageBitmap` のリサイズ、Worker）は実機でしか確かめられない。Playwright に WebKit がないため、S5 の定数は診断結果で決める。
- Tauri の deep link は `tauri dev` では動かない（貼り付けの予備を残す）。macOS 15 以降の Gatekeeper の手順を文書化する。
- WKWebView の Service Worker は未検証。殻は SW に依存しない（Dexie と先読みした窓）。
- S1 のコピーは 30 日間は容量が二重になる（S7 の「未使用」欄で見える）。
- 長く開いたままの窓は古いビルドを持ち続ける（表示時の 12 時間ルールで再読み込み）。
- `Ctrl+Shift+M` は Windows の Teams と重なる（設定で変更可）。
