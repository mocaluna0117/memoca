# Memoca — Notion 風メモ PWA 実装計画

## Context

Notion のようなブロックエディタを持つメモアプリ「Memoca」を、Web + PWA（iOS / Android はホーム画面追加）で作る。
複数端末同期・オフライン動作・フォルダ階層・画像/動画・即席メモ・E2EE ロック・ゴミ箱・全文検索を備え、
無料枠の範囲で「誰でも登録できる公開サービス」として `memoca-app.vercel.app` で公開する。
ディレクトリ `/Users/daiki.kimura/memo_app` は空（greenfield）。作業は小さくコミットし、GitHub `mocaluna0117/memoca`（Public・MIT）へ随時 push する。

## ヒアリングで確定した事項

| 項目 | 決定 |
|---|---|
| 利用者 | 誰でも登録可の公開サービス（無料枠内で運用） |
| 無料枠対策 | ユーザーごとの容量上限（既定 100MB、動画 1 本 30MB）＋ 登録上限（既定 50 人）到達で招待コード制に自動切替。管理画面で変更可 |
| オフライン | ローカルファースト（IndexedDB が一次ストア。オフラインで閲覧・作成・編集、復帰時に自動同期。本文は Yjs CRDT） |
| バックエンド | Convex（DB / ファイル / リアルタイム / cron） |
| 認証 | Better Auth を Convex 上で動かす（`@convex-dev/better-auth`）。**Google ログインのみ**（独自ドメインが無いためメール送信不可 → メール+パスワード / OTP は提供しない） |
| ドメイン | 当面 `memoca-app.vercel.app`（`memoca.vercel.app` は使用済）。独自ドメインへ移る場合、パスキーは全員再登録（金庫のパスワードで開けるためデータは失われない） |
| ロック | E2EE。ロック対象の本文・タイトル・添付を端末側で AES-256-GCM 暗号化。金庫を開く手段は金庫のパスワード（Argon2id）/ Face ID・Touch ID・端末ロック（WebAuthn PRF）/ リカバリーキー |
| 即席メモ | Inbox 型（⚡ボタン・ホーム画面ショートカット・共有から即入力 → Inbox フォルダに保存、後で整理） |
| フォルダ | 無制限階層、ドラッグ&ドロップ、フォルダロックは配下全体に適用 |
| メディア | 画像は端末側で長辺 2048px・WebP 圧縮。動画は 30MB まで＋ YouTube 等 URL 埋め込み |
| リポジトリ | GitHub `mocaluna0117/memoca`、Public、MIT |

### 仮定（未確認だが妥当と判断。違えば指摘してください）

- UI は日本語。文字列は `src/i18n/ja.ts` に集約し、英語追加を容易にする。
- ゴミ箱の保持期間は既定 30 日（設定で 7 / 30 / 90 日）。
- 他ユーザーとの共有・共同編集は v1 の対象外。
- 金庫パスワードは 1 ユーザー 1 つ（Apple メモ方式）。フォルダ名は暗号化しない（ナビゲーションのため）。
- デプロイは Vercel Hobby（非商用なら可）＋ Convex Starter（無料）。`main` への push で本番デプロイ。
- コミットは Conventional Commits、意味のある単位ごとに push。

## 技術スタック（2026-09 時点で確認済のバージョン）

| 層 | 選定 | 備考 |
|---|---|---|
| フレームワーク | Next.js 16.3（App Router, Turbopack）, React 19.2, TypeScript strict | `create-next-app@latest` の既定 |
| UI | Tailwind CSS v4 + shadcn/ui（`-b radix` で初期化）, lucide-react | shadcn の既定は Base UI になったが、BlockNote の `@blocknote/shadcn` が Radix 前提なので Radix を明示 |
| エディタ | BlockNote 0.54（core / react / shadcn）+ Yjs 13.6 | `withCollaboration`（`@blocknote/core/yjs`）。`@blocknote/xl-*` は GPL のため使わない。Yjs 14 RC は使わない |
| バックエンド | Convex 1.45, `@convex-dev/better-auth`, `@convex-dev/rate-limiter` | Vercel Marketplace のネイティブ連携あり |
| 認証 | better-auth 1.7 + Google OAuth | `app/api/auth/[...all]/route.ts` が Convex へプロキシ |
| ローカル DB | Dexie 4.4 | Yjs 永続化も Dexie に自作（y-indexeddb は非メンテ） |
| PWA | `@serwist/turbopack` 9.5 | Turbopack 対応版。`next-pwa` は使わない |
| 暗号 | WebCrypto（AES-GCM, HKDF）, hash-wasm（Argon2id）, WebAuthn PRF（生 API + `@simplewebauthn/browser` のヘルパ） | サーバー検証不要（鍵導出のみ）なので server ライブラリは不要 |
| 状態管理 | zustand（UI 状態）, Dexie liveQuery（データ） | |
| D&D | @dnd-kit | フォルダツリー・並べ替え |
| テスト | Vitest, convex-test, Playwright | |
| 品質 | ESLint（next）, Prettier + prettier-plugin-tailwindcss, GitHub Actions | |
| PM | pnpm 10（Node 24） | |

## アーキテクチャ

```
[端末] Next.js PWA ── Dexie(IndexedDB) ←→ 同期エンジン ←→ Convex(WebSocket 購読 + mutation)
        │  BlockNote + Y.Doc(メモ毎)        │  outbox / cursor         │  files: Convex Storage
        │  検索 Worker(端末内インデックス)   │  Yjs update 暗号化(ロック時) │  crons: purge / cleanup
        └─ Service Worker(Serwist): shell 精キャッシュ・添付 CacheFirst
[認証] Better Auth(Convex HTTP action) ← Next.js /api/auth/* プロキシ ← Google OAuth
```

### 1. Convex データモデル（`convex/schema.ts`）

全テーブルに `userId` を持たせ、すべての関数で認証ユーザーとの一致を検証する。エンティティ ID はクライアント生成 UUIDv7（オフライン作成・冪等再送のため。Convex の `_id` は同期に使わない）。

- `users`: authId, email, name, image, role('user'|'admin'), quotaBytes, usedBytes, reservedBytes, settings{theme, trashRetentionDays, autoLockMinutes}
- `syncHeads`: userId, **seq**（ユーザー単位の同期クロック）, lastPushByDevice{deviceId: ms}（他端末の活動検知に流用）
- `appConfig`（単一行）: signupOpen, maxUsers, userCount
- `inviteCodes`: code, createdBy, usesLeft, expiresAt
- `folders`: folderId, parentId|null, name, icon, sortKey, locked, system('inbox'|null), deletedAt|null, ts{name, place, trash, lock}（HLC）, deviceId, seq, purged
- `notes`: noteId, folderId, kind('note'|'quick'), title|null, titleCt?, preview|null, pinned, sortKey, locked, keyEpoch, wrappedKey?, deletedAt|null, ts{title, place, pin, trash, lock}, lastUpdateSeq, snapshotSeq, sinceSnapshot{count, bytes}, bodyBytes, deviceId, seq, purged
- `noteUpdates`: noteId, opId, deviceId, keyEpoch, payload(bytes), iv?, size, seq
- `noteSnapshots`: noteId, keyEpoch, coversThroughSeq, payload(bytes)|storageId（約 900KB 超は File Storage に退避。Convex のドキュメント上限 1MiB 対策）, iv?, size, seq — メモごとに常に 1 件
- `attachments`: attachmentId, noteId, status('reserved'|'committed'|'orphan'), storageId?, reservedBytes, bytes, mime|null, metaCt?（ロック時のファイル名・MIME）, locked, wrappedKey?, unreferencedAt, deletedAt, expiresAt, seq
- `vaults`: argon{m,t,p}, saltPw, pwWrap{ct,iv}, prfWraps[{credentialId, prfInput, hkdfSalt, ct, iv, label}], recWrap{hkdfSalt, ct, iv}, version

インデックス: `by_user_seq`（folders / notes / noteUpdates / noteSnapshots / attachments）, `by_user_id`, `by_user_parent`, `by_user_folder`, `by_note_seq`, `by_user_op`（重複排除）, `by_status_expires`（予約掃除）, `by_deletedAt`（purge）, `users.by_authId`。

**単調増加 seq**: 同期対象を書く mutation はすべて `syncHeads` を read → 書く行ごとに `++seq` を割り当て → head を write する。この 1 ドキュメントへの OCC で同一ユーザーの書き込みが直列化され、seq 順 = コミット順が保証される（`Date.now()` や `_creationTime` はカーソルに使わない）。

### 2. ローカルストア（Dexie, `src/lib/db/`）

`folders`, `notes`（+ `plainText`。ロック中メモの復号結果は保存しない）, `noteBodies{noteId, throughSeq, keyEpoch}`, `yUpdates{noteId, seq|null, pushed, data}`, `ySnapshots`, `attachments`, `blobs`（添付キャッシュ、LRU 200MB）, `pendingUploads{attachmentId, blob}`, `outbox{opId, kind, entityId, payload, ts, attempts}`, `meta{deviceId, cursor, clockOffset, userId}`, `vaultLocal{credentialId}`。
複数タブは Web Locks API で「同期リーダー」を 1 タブに限定し、Yjs 更新は BroadcastChannel でタブ間に中継する。Yjs の `Uint8Array` は `byteOffset` 付きビューのことがあるので、Convex の `v.bytes()` に渡す前に必ず `buffer.slice(byteOffset, byteOffset + byteLength)` する。

### 3. 同期プロトコル（`src/lib/sync/`）

- **Pull**: リアクティブ購読 `sync.pull({since, limit: 300})` が 5 テーブルの `by_user_seq` を `seq > since` で `take(limit)` ずつ読む。UNION が無いのでカーソル規則は「**満杯になったページの末尾 seq の最小値**を次カーソルにし、それより大きい行は捨てる（満杯ページが無ければ見た最大 seq）」。スナップショットはヘッダのみ（payload なし）。クライアントは行の適用と `meta.cursor` 更新を 1 つの Dexie トランザクションで行い、新カーソルで再購読。自端末 `deviceId` の行はスキップ。差分しか流れないので帯域（月 1GB）を節約。
- **本文は遅延取得**: メタデータだけなら 2,000 件で約 600KB。`noteBodies.throughSeq < snapshot.coversThroughSeq` または未取得のメモは `notes.getBodies({items:[{noteId, haveThroughSeq}]})`（40 件 / 1MiB 単位）で snapshot + それ以降の更新を取得（Yjs は冪等なので重複適用は無害）。開いたメモは即時、残りは新しい順にバックグラウンドで全件プリフェッチ（設定でオフ可）。添付は表示時に取得し `blobs` にキャッシュ。
- **Push**: Dexie `outbox` を同期リーダーが最大 1MiB/回で送る。同一メモの Yjs 行は `Y.mergeUpdates`、同一エンティティのメタは項目ごとの最新のみに合流。`sync.push({deviceId, ops})` は op ごとに `ok | rejected(reason)` を返し、業務上の拒否で他の op を巻き込まない。`by_user_op` で重複排除、LWW は自然に冪等なので応答ロスト後の再送も安全。失敗は指数バックオフ。
- **送信間隔（関数呼び出し 100 万回/月の節約）**: `lastPushByDevice` で 3 分以内に他端末が push していれば 1 秒間隔、それ以外は 5 秒アイドル・`visibilitychange:hidden`・`pagehide` で flush。
- **メタデータの競合**: HLC `ts = max(now + offset, last + 1)` を項目グループごとに持つ（notes: title / place(folderId, sortKey) / pin / trash / lock、folders: name / place / trash / lock）。`(ts, deviceId)` が大きい方を採用。A で改名・B で移動 → 両方生きる。
- **時計ずれ**: サーバーは `ts > serverNow + 60s` を `clockSkew` で拒否。クライアントは `serverTime` を取得して `clockOffset` を保存し、書き直して再送。
- **循環移動**（A: F1 を F2 配下へ、B: F2 を F1 配下へ）: head 直列化で後続 upsert が先行を見られるので、サーバーが親を辿り（上限 64）循環ならルートに付け替えて `repaired` を返す。
- **本文**: メモ毎の Y.Doc。`ydoc.on('update')` を 500ms でまとめ、ロック中なら暗号化して push。受信側は `Y.applyUpdate(doc, data, 'remote')`。CRDT なので 2 端末のオフライン同時編集も競合しない。
- **コンパクション（サーバーは暗号文をマージできないためクライアント主導）**: push 応答の `shouldCompact`（未スナップショット更新が 64 件 or 256KB 超）を受けた端末が `notes.compact({noteId, keyEpoch, payload, coversThroughSeq: lastUpdateSeq})` を呼ぶ。サーバーは `coversThroughSeq == lastUpdateSeq && keyEpoch 一致` のときだけ受理し、同一 mutation で新 snapshot 挿入・旧 snapshot 削除・`seq <= covers` の更新削除（500 件超は scheduler で継続）。遅れている端末はヘッダの `coversThroughSeq` で snapshot の再取得が必要と分かるため取りこぼさない。ローカルも `pushed = true` の行だけ `ySnapshots` に畳む。
- **削除の伝播**: 完全削除はメタ行を `purged: true` のトゥームストーンとして 90 日残す。それより古いカーソルの端末は全再同期。
- **オフライン → 復帰**: `online` / `visibilitychange` / Convex 接続復帰で outbox flush → pull。iOS は Background Sync 非対応なので起動時同期を徹底。3 か月ぶりの端末も同じ経路（古いメタは LWW で負け、Yjs は正しくマージ、`keyEpoch` 不一致の op は拒否 → §4 の再導出）。
- **認証が取れない間も UI は Dexie から描画**（Better Auth / Convex の読み込みを UI のゲートにしない）。

### 4. E2EE 金庫（`src/lib/crypto/`）

ロック機能は 2026-09-25 に作り直しました。詳しい仕様（文言表・状態遷移・移行手順）は [`docs/LOCK.md`](LOCK.md) にあります。ここには仕組みの要点だけを書きます。

- 鍵階層: 金庫鍵 VK（256bit 乱数。メモリ上は non-extractable CryptoKey）を 3 系統の KEK でラップして `vaults` に保存。金庫は 1 ユーザー 1 つ。サーバーが `setup` に ok を返してから新しい鍵を使い始め、`already` なら捨てる（既存の金庫を上書きしない）。
  - パスワード: Argon2id(m=64MiB, t=3, p=1, hash-wasm。中級スマホで 1〜2 秒。パラメータは保存し将来引き上げ可) → KEK
  - リカバリーキー: 256bit 乱数を Base32 52 文字（4 文字 × 13 組）で表示し、最後の 4 文字を打ち戻させて確認（`recoveryFormat: 2`、`recoveryCheckedAt`）。入力は大文字・小文字、ハイフン・空白、0/1/8 の読み替えを許す。設定から作り直す・試すことができる。40 文字で表示していた旧形式は警告を出して作り直させる
  - パスキー: WebAuthn PRF（`userVerification: "required"`）→ HKDF-SHA256 → KEK。1 タップで `get()` を 1 回だけ呼ぶ。対象はこの端末で使えたパスキーだけ（1 件なら `eval`、2 件以上なら `evalByCredential`）、`transports: ["internal"]`、`hints: ["client-device"]`。キャンセルしたら次のシートは出さない。登録は `excludeCredentials` とランダムな `user.id`、10 件まで
  - 「パスワード違い」の判定は GCM タグ検証の失敗で行う（別の検証子は持たない）
- 金庫のレコード（ラップ済みの鍵と塩だけ）は `vault.record` で常時購読し、端末の `meta.vaultRecord` に保存する。一度オンラインで受け取った端末は、オフラインでもパスワードやパスキーで金庫を開いて読み書きできる。
- メモ・添付ごとのデータ鍵 DEK（乱数）を VK でラップして `notes.wrappedKey` / `attachments.wrappedKey` に保存（AAD `wrap:v1:<id>:<keyEpoch>`）。VK のローテーションは 48 バイトの再ラップ n 回で済み、本文の再暗号化は不要。Yjs 更新（AAD `yupd:v1:<noteId>:<keyEpoch>`）・スナップショット・タイトル（`titleCt`、`title = null, preview = null`）・添付 Blob（≤30MB は一括 GCM、AAD `att:v1:<attachmentId>`、ファイル名と MIME は `metaCt`）を個別に暗号化。
- **本人確認**: 金庫が必要な操作は `requestVault(purpose)` で目的を伝え、目的どおりの見出しとボタン（例「フォルダ「仕事」をロックしますか？」［Face ID / Touch ID で続ける］）を出す。状態遷移は純粋なリデューサー（`src/lib/vault/gate-machine.ts`）。Esc・外側のタップ・×・キャンセルはすべてキャンセルで、作成画面へは移らない。
- **メモのロック（オンライン時のみ）**: ①そのメモの outbox を送り切り、サーバーに追いつくまで待つ ②平文添付をダウンロードし DEK で暗号化して新 storageId にアップロード ③ `vault.lockNote({noteId, keyEpoch: n+1, wrappedKey, titleCt, snapshotCt, coversThroughSeq, attachments[], origin})`。サーバーは `coversThroughSeq == lastUpdateSeq` を要求し（更新行が多すぎれば `compactFirst`、アップロード中なら `uploadPending`、平文の添付が残れば `attachmentsNotCovered` で断る）、同一 mutation で平文の更新・スナップショット・title・preview・旧添付ファイルを全削除して `locked, keyEpoch, lockOrigin` を設定。ロックを外すときは必ず確認を挟み、正確に逆手順。古い平文 op を持つ別端末の push は `keyEpoch` 不一致で拒否され、その端末は差分を新 epoch で暗号化して再送する。
- **フォルダのロック**: `folders.locked` は方針、`notes.locked` は実体。メモには `lockOrigin: "note" | "folder"` を記録する。ロックは、旗を立ててから配下の平文メモを順に `lockNote`（Web Locks で 1 度に 1 つ、進捗と結果を正直に表示）。ロックを外すときは、旗を先に外し、そのフォルダのロックだけで守られていたメモだけを外す（個別にロックしたメモ、別のロックで守られているメモは残し、確認画面に件数を出す）。途中で止まった分は `meta.unlockJob` で再開する。Inbox はロックできない。フォルダ名は暗号化しない（以前に暗号化した名前は金庫を開いたときに平文へ戻す）。
- **ロックしたフォルダへの作成と移動**: 新しいメモは最初から暗号化して作る（`create.lock`、エポック 1。金庫が閉じていれば本人確認。オフラインでも作れる）。平文メモの移動は、先にロックし、成功してから移動する。ロック済みのメモを外へ出してもロックのまま（外すのは明示操作だけ）。まだ暗号化されていないメモは帯を出して編集を止め、［いますぐロック］を出す。
- **表示と検索**: 一覧では「ロックされたメモ」と表示する。金庫が開いている間だけ、タイトルをメモリ上で復号して表示し、検索でもタイトルで見つかる（本文は検索しない。金庫を閉じると復号したタイトルは捨てる）。Dexie には常に暗号文だけを置き、ロックしたメモの添付は `blobs` にキャッシュしない。
- **自動で閉じる**: 最後の操作から N 分（既定 5）で VK・DEK・復号済みのものをメモリから破棄する。閉じる前に編集中の内容を暗号化して保存する。ロックの処理中は閉じない。バックグラウンドから戻ったときに期限を過ぎていれば閉じ、トーストで知らせる。開いている間はサイドバーに「金庫：開いています」と［いますぐ閉じる］を出す。iOS のプロセス kill でも自然に閉じる。
- **修復**: 金庫を開いたとき・同期が落ち着いたとき・オンラインに戻ったときに、途中だったロック、Inbox の旧フラグ、平文の添付、暗号化されていたフォルダ名を直し、開けないメモを数える（自動では削除しない。設定の「開けないメモがあります」から［ゴミ箱に移動］）。
- パスワード変更・リカバリーキーの作り直し・パスキー登録は VK の再ラップのみ（`vaults.version` を上げ、`expectedVersion` で他端末との競合を検出。本文の再暗号化なし）。どれか 1 つ生きていれば他を再設定できる。全部紛失 → 復元不可（作成時に明示）。
- 許容するメタデータ漏れ（利用規約で開示）: フォルダ名、メモの存在・数・ツリー形状・並び順、サイズ（暗号文 = 平文 + 16B）、更新日時と編集頻度、`locked` フラグ、どの端末が編集したか。ロック直後しばらくは Convex のバックアップに平文が残り得る。
- 古い版のまま動く PWA のため、サーバーの変更は追加だけにしている。`vault.status`、`vault.pendingLockCascade`、`setFolderLock` の `name` / `nameSealed` 引数は、いまのクライアントは使わないが、古いクライアント向けに残している。すべての端末が新しい版になったことを確かめてから削除する。

### 5. 検索（`src/lib/search/`, Web Worker）

Convex の全文検索は日本語を分かち書きできないため使わない。端末内の `plainText`（Y.Doc → ブロック → テキスト）とタイトル・フォルダ名を対象に、NFKC・小文字化・カタカナ→ひらがな正規化した部分一致（スペース区切り AND）。2,000 件超はバイグラム転置インデックスで前絞り。タイトル一致 > 本文一致 > 新しい順でランク付け、ハイライト付きスニペット。⌘K / 検索タブから即時。

### 6. メディア（`src/lib/media/`）

圧縮（Canvas → WebP 2048px、画像上限 2MB）→（ロック時は暗号化）→ `attachments.reserve({attachmentId, noteId, bytes, mime})`（`used + reserved + bytes <= quota` と種別上限を検査し、`reserved` 行と `expiresAt = 1h` を作って uploadUrl を返す）→ POST → storageId を即 Dexie に保存 → `attachments.commit({attachmentId, storageId})` を outbox 経由で送る（再送安全）。commit は `ctx.db.system.get(storageId)` の**実サイズ**で検査し、超過なら `storage.delete` して拒否、正常なら `used += 実サイズ, reserved -= 予約` で `committed` に。本文サイズ `bodyBytes` も容量に含める。
ブロック内 URL は `memoca://att/<id>` とし `resolveFileUrl` で Convex Storage URL（Service Worker が CacheFirst）または復号後の `blob:` URL に解決（再暗号化やオフラインでも参照が壊れない）。オフライン中は Blob を `pendingUploads` に保持しローカル URL で表示、復帰後に送信。
cron: 毎時、期限切れ `reserved` を `orphan` にして予約分を返却。日次で `_storage` を走査して参照の無いファイルを削除し、`used` を実測から再計算。エディタから外された画像は compaction 時に参照 ID を報告 → `unreferencedAt` を付けて 30 日後に削除。許可 MIME は image/* と video/mp4・webm・quicktime。

### 7. 即席メモ / Inbox

- サインアップ時に `system:'inbox'` フォルダを作成（削除不可）。
- ⚡ FAB（モバイル）/ ヘッダーボタン（PC）/ `Q` キーで下からシートを開き、プレーンテキストで即入力 → `kind:'quick'` として Inbox に保存（タイトルは 1 行目）。「エディタで開く」でリッチ編集へ。
- `GET /quick?text=&title=&url=` はメモを作成して開く（Android の `share_target`・iOS ショートカット・PWA `shortcuts` から利用）。iOS は `share_target` 非対応なので、設定画面に「共有シートから Memoca に送るショートカットの作り方」を掲載。画像共有（POST）は v1.5。

### 8. ゴミ箱

ソフト削除は自分の `deletedAt` を 1 行書くだけ（配下へのファンアウトはしない）。「ゴミ箱にあるか」は**派生**で決める: `effectivelyTrashed = 自分の deletedAt ?? 最も近い祖先の deletedAt`。
- フォルダ復元は自分の `deletedAt` を消すだけ。先に個別削除していた配下（自分の `deletedAt` あり）はゴミ箱に残る。
- A でフォルダ削除・B でその中にオフライン作成したメモ → メモは `deletedAt = null` のままゴミ箱内のフォルダに現れ、復元で一緒に戻る（黙って消えない）。
- 祖先がまだゴミ箱にある単体アイテムを復元する場合はルートへ移動。
- ゴミ箱画面: トップレベル（自分の `deletedAt` があり祖先は削除されていないもの）を一覧、復元 / 完全削除 / 空にする。
- 日次 cron: `by_deletedAt` で保持期間超過（既定 30 日）を 100 件ずつ完全削除（派生的に削除された子孫も `by_user_parent` で辿る）。更新・スナップショット・添付ファイルを消し `usedBytes` を減算、メタ行は `purged: true` のトゥームストーンとして 90 日保持。ゴミ箱内も容量にカウント。ロック中メモも鍵なしで削除できる。

### 9. 公開サービスのガードレール

- 初回ログイン時 `users.ensure`：`appConfig.userCount < maxUsers` または有効な招待コードなら作成、それ以外は `SIGNUP_CLOSED` → 「満員です／招待コード入力」画面。
- `@convex-dev/rate-limiter` で push / upload / quick 作成を制限。容量超過は `reserve` で拒否し UI に残量バーを表示。
- `/app/admin`（`ADMIN_EMAILS` 環境変数に一致するユーザー）：登録上限・受付状態・招待コード発行・利用者と使用量一覧。
- `/terms`, `/privacy`（Google OAuth 同意画面にも必要）、設定からのアカウント削除（全データ + Better Auth ユーザー削除）。

### 10. PWA

`app/manifest.ts`（name/short_name Memoca, display standalone, start_url /app, maskable アイコン, shortcuts, share_target）、`@serwist/turbopack` で shell 事前キャッシュ・ナビゲーションは NetworkFirst（オフライン時はキャッシュ済 shell）・添付は CacheFirst（上限付き）。ログイン後に `navigator.storage.persist()`。Android は `beforeinstallprompt`、iOS は手順バナー。新バージョン検知で「更新」トースト。iOS は Safari とホーム画面アプリでストレージが分かれるため、インストール直後は再ログイン → サーバーから再同期（想定内として案内）。

## 画面 / ルーティング

- `/` ランディング（未ログイン）→ ログイン済は `/app` へ。`/sign-in`（Google ボタンのみ）。`/terms`, `/privacy`。
- `/app` シェル: PC は 3 ペイン（フォルダツリー / メモ一覧 / エディタ、幅可変）、モバイルはスタック遷移＋下部タブ（ホーム・検索・⚡・設定）。
- `/app/f/[folderId]`, `/app/n/[noteId]`, `/app/inbox`, `/app/trash`, `/app/search`, `/app/settings`（外観・保持期間・読みで検索・金庫とロック・保存容量・アカウント削除）, `/app/admin`。
- `/quick`, `/share`（Android 共有受け口）, `/api/auth/[...all]`。
- ダークモード（system / light / dark）、キーボードショートカット（⌘K 検索、⌘N 新規、Q 即席）。

## ディレクトリ構成

```
memoca/
  app/                      ルート・レイアウト・manifest.ts・sw.ts・serwist/[path]/route.ts
  convex/                   schema.ts, convex.config.ts, auth.ts, auth.config.ts, http.ts, crons.ts,
                            users.ts, folders.ts, notes.ts, noteUpdates.ts, attachments.ts, vault.ts, trash.ts, sync.ts, admin.ts, lib/
  src/components/           ui/(shadcn) shell/ folders/ notes/ editor/ vault/ search/ media/
  src/lib/                  db/ sync/ crypto/ search/ media/ store/ i18n/
  src/workers/              search.worker.ts
  tests/ (Vitest)  e2e/ (Playwright)  .github/workflows/ci.yml  LICENSE  README.md
```

## 実装フェーズ（各フェーズ内で小刻みに commit → push。main への push で Vercel 本番デプロイ）

### Phase 0 — 土台とデプロイ（〜1 日）
1. `pnpm create next-app@latest memoca --ts --tailwind --app --src-dir --turbopack`、shadcn `init -b radix`、Prettier、Vitest、Playwright、ESLint。
2. GitHub リポジトリ `mocaluna0117/memoca`（Public, MIT, README）作成・初回 push。
3. Convex プロジェクト作成（`npx convex dev` の初回ログインはユーザー操作）、`@convex-dev/better-auth` + Google プロバイダ設定、`/sign-in` 動作確認。
4. Vercel プロジェクト `memoca-app` 作成・GitHub 連携・環境変数（`NEXT_PUBLIC_CONVEX_URL`, `NEXT_PUBLIC_CONVEX_SITE_URL`, `CONVEX_DEPLOY_KEY`, `BETTER_AUTH_SECRET`, `SITE_URL`, Google 資格情報は Convex 側 env）。ビルドコマンド `npx convex deploy --cmd 'pnpm build'`。
5. CI（typecheck / lint / unit / build）。`memoca-app.vercel.app` でログインまで通す。
6. **スパイク**: `/labs/prf` で WebAuthn PRF を iPhone（ホーム画面追加後）と Android で実機確認。NG なら金庫の生体解除を「端末内キー + WebAuthn ゲート」方式にフォールバック（Phase 7 の設計判断ゲート）。

### Phase 1 — 同期コア（2〜3 日）
Convex schema・`syncHeads` による seq・`sync.pull`（最小値カーソル規則）/ `sync.push`（op 単位の結果）/ `notes.getBodies` / `notes.compact`・HLC 項目グループ LWW・時計ずれ拒否・循環修復・トゥームストーン、Dexie schema、同期エンジン（カーソル＋行の単一トランザクション適用・outbox・送信間隔制御・Web Locks・BroadcastChannel）、Vitest（LWW / 再送冪等性 / HLC / カーソル規則）、convex-test（他ユーザーのデータに触れないこと、compact の受理条件）。

### Phase 2 — フォルダ・メモ UI（2 日）
レスポンシブシェル、フォルダツリー（無制限階層・dnd-kit）、メモ一覧、作成/改名/移動/削除、モバイル遷移、ダークモード、設定画面の骨格。

### Phase 3 — エディタとメディア（3 日）
BlockNote + Yjs + Dexie 永続化 + Convex プロバイダ、タイトル欄、自動保存表示、添付パイプライン（圧縮 / 予約 / アップロード / commit / SW キャッシュ / オフライン待ち行列）、動画 30MB 制限と URL 埋め込み、**モバイル用ブロック操作ツールバー**（BlockNote のドラッグハンドルはタッチ非対応のため自作：上下移動・種類変更・削除・書式）。

### Phase 4 — 即席メモと PWA（1〜2 日）
Inbox、⚡シート、`/quick`、`share_target`、`shortcuts`、Serwist 導入、manifest・アイコン、インストール案内、オフライン fallback、`storage.persist()`、更新トースト。

### Phase 5 — 検索（1 日）
Worker インデックス、日本語正規化、検索 UI とハイライト、⌘K。

### Phase 6 — ゴミ箱（1 日）
派生型ゴミ箱（自分の `deletedAt` のみ書く）、復元規則、ゴミ箱画面、日次 purge cron（子孫の走査・容量返却）、トゥームストーン伝播。

### Phase 7 — E2EE 金庫（3〜4 日）
暗号ライブラリ + テスト（往復・AAD 改ざん検知・Argon2 パラメータの実機所要時間）、金庫セットアップウィザード（パスワード + リカバリーキー確認）、パスキー PRF 登録/解除、メモ/フォルダのロック・解除（再暗号化・添付差し替え）、プレースホルダ表示、自動ロック、解除中検索、パスワード変更、リカバリー導線。

### Phase 7b — ロック機能の作り直し（2026-09-25、完了）
報告された 3 点（「ロックする」で解除の画面が出る、Face ID でパスキーの選択画面や QR コードが出る、画面の外を押すとロックの設定に移る）と、調査で見つかったデータ消失・平文漏れを直すため、4 段・21 コミット（C0〜C20）で作り直した。目的を伝える本人確認、1 回だけのパスキーのシート、使えるリカバリーキー、オフラインで開ける金庫、操作で延びる自動で閉じる、個別のロックを残すフォルダのロック、ロックしたフォルダでは最初から暗号化、修復と健康診断、金庫が開いている間のタイトル検索、設定「金庫とロック」。仕様と経緯は [`docs/LOCK.md`](LOCK.md)。

### Phase 8 — 公開向けガードレール（1〜2 日）
登録上限 / 招待コード、レート制限、管理画面、容量表示、利用規約・プライバシー、アカウント削除、エラーバウンダリ。

### Phase 9 — 仕上げと公開（1〜2 日）
ショートカット、Markdown エクスポート、空状態、Lighthouse（PWA / a11y）、E2E 一式、README、実機 QA チェックリスト、Google OAuth 同意画面を本番公開。

## 検証方法

- **単体（Vitest）**: 暗号往復・改ざん検知、HLC/LWW マージ、outbox 再送の冪等性、検索正規化（ひらがな/カタカナ/全角半角）、容量計算。
- **Convex（convex-test）**: 認可（他人のデータ不可）、`reserve` の容量拒否、`lock` 後に平文更新が残らない、purge が容量を返す。
- **E2E（Playwright, PC + モバイル viewport）**: Google ログイン（テスト用にメール+パスワードプロバイダを開発環境のみ有効化）、フォルダ/メモ CRUD、リロード後の永続化、`context.setOffline(true)` で編集 → 復帰で別コンテキストに反映、ゴミ箱復元、ロック → Convex 上のデータが暗号文であることを確認、PWA インストール可能性。
- **実機**: iPhone（ホーム画面追加 → 再ログイン → Face ID でロック解除 → 機内モードで編集 → 復帰同期）、Android（インストール → 他アプリから共有 → Inbox に入る）。
- **運用**: Convex ダッシュボードの帯域・ストレージ使用量を確認し、上限値を管理画面で調整。

## 実装上の落とし穴（独立設計レビューで洗い出し、上記設計に反映済み）

1. 時刻ベースのカーソルは遅れてコミットされた行を取りこぼす → OCC 直列化した per-user カウンタ。カーソルは適用後に進める。
2. 複数テーブルのページングで「見た最大 seq」に進めると、満杯になったテーブルの行を飛ばす → 満杯ページ末尾の最小値ルール。
3. コンパクションで、遅れた端末がまだ受け取っていない更新を消し、その端末は「本文を持っている」と思って snapshot を取り直さない → フィードに snapshot ヘッダ、メモ毎の `throughSeq`、削除は snapshot と同一 mutation、`coversThroughSeq == lastUpdateSeq` を要求。
4. 時計が進んだ端末が LWW に永遠に勝つ → サーバーで 60 秒超のずれを拒否し、クライアントが offset を補正。
5. ロック後に平文 op がサーバーに届く → 全 push に `keyEpoch`、不一致は拒否、クライアントが差分を再導出。
6. 行は適用したがカーソル更新前に iOS に kill される（または逆） → 行とカーソルを 1 つの Dexie トランザクションで書き、適用は冪等に。
7. Yjs の `Uint8Array` を `v.bytes()` にそのまま渡すと `byteOffset` 付きビューで壊れる → 書き込み前に `buffer.slice`。
8. クライアント申告サイズを信じると容量がずれる → commit で `_storage` の実サイズ、予約の回収、日次の実測再計算。

## リスクと対策

| リスク | 対策 |
|---|---|
| ~~iOS ホーム画面 PWA での WebAuthn PRF 動作が未確認~~ | **解消**。iPhone のホーム画面アプリで Face ID によるロック解除が動作することを実機で確認（2026-09-18） |
| ~~BlockNote のモバイル操作性（ドラッグハンドルがタッチ非対応）~~ | **解消**。キーボードの上に出るブロック操作バーを自作し、実機で動作を確認 |
| Convex 無料枠の帯域 1GB/月 | 差分同期・スナップショット・SW キャッシュ・容量上限。超過時は Pro（25USD/月） |
| ~~Google OAuth 同意画面で `memoca-app.vercel.app` を承認済ドメインにできない可能性~~ | **解消**。リダイレクト URI を登録した時点で `vercel.app` が自動で承認済みドメインに入り、独自ドメインは不要でした |
| Vercel Hobby は非商用限定 | 広告・課金を入れない。入れる時は Pro へ |
| 金庫パスワード紛失 | リカバリーキー必須表示、パスキー併用を推奨 |
| Better Auth × Convex がまだ 0.x | API 変更に備え認証層を `src/lib/auth/` に隔離 |

## ユーザー側にお願いした作業（すべて完了）

1. **Convex ログイン** — 完了。プロジェクト `memoca`、本番デプロイ `kindhearted-goose-499`（US East）
2. **Google Cloud OAuth** — 完了。プロジェクト `memoca-509004`。localhost と本番の
   リダイレクト URI を登録済み。`vercel.app` は自動で承認済みドメインに入りました
3. **実機テスト** — 完了。iPhone のホーム画面追加、再ログイン、Face ID でのロック解除、
   機内モードでの編集と復帰後の同期、すべて動作
4. **独自ドメイン** — 不要でした。`memoca-app.vercel.app` で運用しています

残っているのは、誰でも登録できるようにするかどうかの判断だけです。
Google Cloud の「対象」で「アプリを公開」を押すと、テストユーザー以外も登録できます。
