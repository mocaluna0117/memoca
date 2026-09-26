# ロック機能の再設計（詳細仕様）

2026-09-25 時点の設計です。行番号は作成時点のもので、実装が進むとずれます。進め方の要約は README から辿れる計画と、各コミットの本文を見てください。

**状態（2026-09-25）**: C0〜C20 をすべて実装し、本番にデプロイしました。残っているのは次の 2 つです。
- 実機での確認（「検証」の最後の節）。
- 古い版のクライアント向けに残しているサーバー関数（`vault.status`、`vault.pendingLockCascade`、`setFolderLock` の `name` / `nameSealed` 引数）の削除。すべての端末が新しい版になったことを確かめてから行います。2026-09-25 12:27〜15:47 の本番ログでは、`vault.status` の呼び出しは 0 件でした。

## 背景

**オーナーからの報告（iPhone の PWA と Mac で使用）**
1. 「ロックする」を押すと、タイトルが「ロックを解除」のモーダルが開く。
2. 「Face ID / Touch ID で解除」を押すと、ブラウザのパスキー選択画面や QR コードが出る。
3. 解除モーダルを閉じると「ロックを設定」に飛ぶ。

加えて、ロック機能全体が使いにくいので作り直したい、という依頼です。

**原因（コードで確認済み）**

| 報告 | 原因 |
|---|---|
| 1 | `requestUnlock()` は開いた理由を受け取らない（`src/lib/store/vault-ui.ts:27-32`）。そのため、題名もボタンも常に `t.vault.unlock`（「ロックを解除」、`src/lib/i18n/ja.ts:68`。`vault-dialog.tsx:232,299` で使用）になる。これは、メモから暗号化を外す操作 `t.action.unlock`（`ja.ts:37`、`folder-tree.tsx:410`）とまったく同じ文字列。 |
| 2 | `vault-dialog.tsx:133-145` が、全端末のパスキーを 1 件ずつ順に `get()` している。`transports:["internal","hybrid"]`（`src/lib/crypto/passkey.ts:133`）のため、この端末にないパスキーでは QR コードが出る。キャンセルすると次のパスキーの画面が開く。どのパスキーがこの端末のものかは記録していない。 |
| 3 | 閉じる操作はすべて `close(false)` になる（`vault-dialog.tsx:157`）。受け取った側は `false` を「金庫がない」と解釈して `openSetup()` を呼ぶ（`workspace-shell.tsx:60-62`、`note-pane.tsx:133-135`）。ダイアログは `mode==="setup"` だけで作成画面を出す（`vault-dialog.tsx:79`）。 |

**同時に直すデータ消失と平文漏れ（重大度「高」）**
- **既存の金庫の鍵を失う経路がある。** `createVault` は、サーバーの返事を待たずに新しい鍵を使い始める（`src/lib/crypto/vault.ts:218`）。`setup` が返す `{status:"already"}`（`convex/vault.ts:67`）も無視している（`vault-dialog.tsx:94-100`）。
- **これまでに表示したリカバリーキーはすべて使えない。** `grouped()` が 52 文字のうち 40 文字で切っている（`vault-dialog.tsx:38-44`）。本番のオーナーのキーも同じです。
- **自動ロックが操作で延長されない。** `touch()` を外から呼ぶ箇所がない（`vault.ts:69-74`）。ロックされる直前の入力が消える（`docs.ts:97-103`、`docs.ts:210-220`）。
- **ロックしたフォルダに平文が入る。** 新規作成や移動で入ったメモは平文のまま同期される（`mutations.ts:220-279`、`331-354`、`convex/sync.ts:420-431`）。Inbox もロックできてしまう。
- **フォルダのロックを外すと、個別にロックしたメモまで外れる**（`actions.ts:314-320`）。
- **一部しか処理できなくても「ロックしました」と表示する**（`actions.ts:323-330`）。
- **ロックしたメモの添付ファイルが平文で端末に残る**（`src/lib/media/attachments.ts:166-171`、`208-214`）。
- **オフラインで金庫を開けない。** 金庫のレコードを端末に保存していない（`src/lib/db/meta.ts:4-15`）。

**計画の前提として確認した事実**
- `vercel.json:3` により、`main` への push ごとに Convex（本番）と Vercel の両方が同じビルドでデプロイされる。問題は、古いバンドルのまま動き続ける PWA です。そのため、サーバー側の変更はすべて追加だけにし、古いクライアントの送信形式も受け付けます。
- 拒否された push op はクライアントで削除される（`src/lib/sync/engine.ts:426-430`）。サーバーで何かを新たに拒否すると、古いクライアントの編集がその場で消えます。
- `vault.status` は `requireUser` を使うため、サインイン前には例外を投げる。常時購読するなら `getUser` を使う新しいクエリが必要です（`convex/sync.ts:32-37` と同じ作り）。
- TypeScript 5.9 の DOM 型には `prf.evalByCredential` はあるが、`hints` は JSON 版の型（`PublicKeyCredentialRequestOptionsJSON` など）にしかない。`hints` を渡すには、`PublicKeyCredentialRequestOptions & { hints?: string[] }` のような型を自前で定義する。Signal API は型がないので、使うなら機能検出が必要です。
- Chromium の仮想認証器（`hasPrf: true`）は、プラットフォーム認証器として認識され、作成時に PRF の結果を返し、`eval` と `evalByCredential` のどちらでも 32 バイトを返す（`e2e/passkey-support.spec.ts` で確認済み）。
- Next.js の新しい API は使いません（既存の `next/dynamic` のみ。`node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md`）。
- Convex の変更は `convex/_generated/ai/guidelines.md` に従います。全関数に validator を付け、`withIndex` と `.unique()`/`.take()` を使い、配列は上限付き、新しいインデックスは作りません。

**オーナーが決めたこと（見直さない）**
1. 対称鍵の階層（金庫の鍵 VK が各メモの鍵 DEK を包む）はそのまま。金庫が閉じているときのロック操作は、目的を書いたダイアログで Face ID / Touch ID かパスワードを先に求める（Apple メモと同じ）。
2. フォルダ名は暗号化しない。暗号化するのはメモのタイトル・本文・添付ファイルだけ。すでに暗号化されたフォルダ名は平文に戻す。
3. メモ単位のロックとフォルダ単位のロックは両方残す。

## 用語と文言

### 用語（UI で使ってよいのはこれだけ）

| 概念 | 使う言葉 | 使わない言葉 |
|---|---|---|
| 鍵の入れ物（このタブの中だけで開いている状態） | **金庫**。金庫を開く／金庫を閉じる／いますぐ閉じる／自動で閉じる。状態表示は「金庫：開いています」「金庫：閉じています」 | ロック（金庫に対して）、解除 |
| 初めての作成 | 金庫を作成 | ロックを設定 |
| 金庫の秘密 | 金庫のパスワード | 金庫パスワード、ロック用パスワード |
| 予備の鍵 | リカバリーキー（作り直す／試す） | 再発行 |
| 本人確認の手段 | 下の `{m}`。設定画面だけ「パスキー」と呼ぶ | 生体認証、PRF |
| メモ・フォルダの保護 | ロックする／ロックを外す／ロックされたメモ／ロック中 | ロックを解除 |
| 親フォルダから受け継いだロック | フォルダ「X」でロック中 | — |

**`{m}` の決め方**
- 新規ファイル `src/lib/crypto/platform.ts` の `unlockMethodName()` で決める。

| 端末 | `{m}` |
|---|---|
| iPhone・iPad（Mac の UA で `maxTouchPoints>1` のものは iPad として扱う） | Face ID / Touch ID |
| Mac | Touch ID |
| Android | 指紋・顔認証 |
| Windows | Windows Hello |
| その他 | パスキー |

- `joinJa(m, 語)` は、`{m}` が英字で終わるときだけ半角スペースを入れる。例：「Face ID / Touch ID で続ける」「指紋・顔認証で続ける」。

### 既存文字列の変更（旧 → 新）

**`src/lib/i18n/ja.ts`**

| 箇所 | 旧 | 新 |
|---|---|---|
| app.description | 「…鍵をかけたメモは端末の中だけで復号されるメモ帳です。」 | 「フォルダで整理でき、画像や動画も貼れて、ロックしたメモは端末の中だけで読めるメモ帳です。」 |
| action.lock | ロックする | ロックする（メモ）。フォルダのメニューでは「ロックする…」 |
| action.unlock | ロックを解除 | ロックを外す… |
| empty.lockedNote | ロック中のメモ | ロックされたメモ |
| empty.lockedHint | 解除すると内容を表示できます。 | 金庫を開くと読めます。 |
| vault.title | ロック | 金庫とロック |
| vault.setupTitle | ロックを設定 | 金庫を作成 |
| vault.password | 金庫パスワード | 金庫のパスワード |
| vault.passwordAgain | もう一度入力 | 確認のためもう一度入力 |
| vault.unlock | ロックを解除 | 金庫を開く |
| vault.lockNow | いますぐロック | いますぐ閉じる |
| vault.biometric | Face ID / Touch ID で解除 | `openWith(m)`＝「{m}で開く」、`continueWith(m)`＝「{m}で続ける」 |
| vault.locked | ロックされています | 閉じています |

**直書きの文字列（コンポーネント・フック・暗号コード）**

| 箇所 | 旧 | 新 |
|---|---|---|
| `use-decrypted.ts:18`、`use-search.ts:51`、`data.ts:132` | 🔒 ロック中のメモ | ロックされたメモ（絵文字なし。アイコンは別に描く） |
| `use-decrypted.ts:19`、`data.ts:121`、`folder-tree.tsx:274`、`folder-picker.tsx:123` | 🔒 ロック中のフォルダ／ロック中のフォルダ | 本当の名前。旧形式で暗号化された名前が金庫を閉じた状態で残っているときだけ「ロックされたフォルダ」、読めないときは「名前を読めないフォルダ」 |
| `folder-tree.tsx:410` | ロックを解除／ロックする | ロックを外す…／ロックする… |
| `folder-tree.tsx:119,460`（ドラッグ中の表示） | フォルダ | 本当の名前（なければ「無題のフォルダ」） |
| `workspace-shell.tsx:46` | {n} 件のメモのロックを完了しました | ロックが途中だったメモ {n} 件をロックしました |
| `workspace-shell.tsx:66,70` | フォルダをロックしています…／ロックを解除しています…／{d} / {t} 件を処理中… | フォルダ「{name}」をロックしています…（{done} / {total}）／フォルダ「{name}」のロックを外しています…（{done} / {total}） |
| `workspace-shell.tsx:74` | ロックしました／ロックを解除しました | フォルダ「{name}」をロックしました（メモ {n} 件）※0 件なら「フォルダ「{name}」をロックしました」／フォルダ「{name}」のロックを外しました（メモ {n} 件） |
| `workspace-shell.tsx:78`、`note-pane.tsx:143,145` | 同期が終わってからもう一度お試しください。／未送信の変更があります。同期後にもう一度お試しください。 | 待っている間：同期を待っています…／時間切れ：同期が終わらないため、ロックできませんでした。インターネット接続を確認して、もう一度お試しください。 |
| `workspace-shell.tsx:79`、`note-pane.tsx:147` | 処理できませんでした。 | ロックできませんでした。もう一度お試しください。／ロックを外せませんでした。もう一度お試しください。 |
| `note-pane.tsx:141` | ロックしました／ロックを解除しました | メモをロックしました／メモのロックを外しました |
| `note-pane.tsx:240` | ロックを解除（ボタン） | {m}で開く（パスキーがないときは「金庫を開く」） |
| `vault-dialog.tsx:103` | 設定できませんでした。時間をおいて試してください。 | 金庫を作成できませんでした。インターネット接続を確認して、もう一度お試しください。 |
| `vault-dialog.tsx:121` | リカバリーキーが正しくありません。 | このリカバリーキーでは開けません。／リカバリーキーは 52 文字です（いま {n} 文字）。／（40 文字のとき）このリカバリーキーは、以前の不具合で一部しか表示されていなかったため使えません。パスワードか {m} で開いたあと、設定でリカバリーキーを作り直してください。 |
| `vault-dialog.tsx:149` | 生体認証で解除できませんでした。パスワードをお試しください。 | {m}で開けませんでした。パスワードを使ってください。 |
| `vault-dialog.tsx:167-168` | パスワードを忘れたときに、ロックしたメモを開ける唯一の手段です。これは一度しか表示されません。私たちも復元できません。 | パスワードを忘れたときに金庫を開ける、ただひとつの方法です。この画面を閉じると二度と表示されません。Memoca でも復元できないので、紙に書き写すか、パスワード管理アプリに保存してください。 |
| `vault-dialog.tsx:184` | 保管しました | 次へ |
| `vault-dialog.tsx:192-193` | ロックしたメモは、このパスワードから作った鍵で端末の中だけで暗号化されます。サーバーには暗号文しか届きません。 | ロックしたメモの本文・タイトル・添付ファイルは、この金庫の鍵で暗号化されます。鍵はこの端末の中だけで使われ、Memoca のサーバーでも読めません。 |
| `vault-dialog.tsx:225` | 設定する | 作成する（処理中は「金庫を作成しています…」） |
| `vault-dialog.tsx:234` | ロックしたメモを開くために、金庫を解除します。 | 目的ごとの文言（下の表） |
| `vault-dialog.tsx:258` | XXXXX-XXXXX-XXXXX-XXXXX | XXXX-XXXX-XXXX-…（52 文字） |
| `vault-dialog.tsx:289` | パスワードで解除する／リカバリーキーで解除する | パスワードを使う／パスワードを忘れた場合 |
| `ui/dialog.tsx:79`、`ui/sheet.tsx:80`（読み上げ用）、`ui/dialog.tsx:118` | Close | 閉じる |
| `settings/page.tsx:169` | ロックしたメモは、この端末の中だけで暗号化・復号されます。サーバーには暗号文しか保存されません。 | ロックしたメモの本文・タイトル・添付ファイルは、金庫の鍵で暗号化され、あなたの端末の中でだけ読めます。フォルダ名、メモの件数、更新日時は暗号化されません。 |
| `settings/page.tsx:180` | 状態：解除中／状態：ロックされています | 金庫：開いています／金庫：閉じています |
| `settings/page.tsx:194` | 自動ロック | 自動で閉じるまでの時間（選択肢の 1・5・15・60 分は変えない） |
| `settings/page.tsx:215` | 生体認証（Face ID / Touch ID） | パスキー（Face ID・Touch ID など） |
| `settings/page.tsx:220-242` | パスワードの変更（入力欄はプレースホルダーのみ）＋「変更」 | 小見出し「金庫のパスワード」、ボタン［パスワードを変更］、リンク「パスワードを忘れた場合」 |
| `settings/page.tsx:245` | メモの中身を暗号化し直す必要はありません。鍵の包み方だけが変わります。 | ロックしたメモを暗号化し直す必要はないので、すぐに終わります。 |
| `settings/page.tsx:106` | パスワードを変更しました | 金庫のパスワードを変更しました |
| `settings/page.tsx:108` | 現在のパスワードが正しくありません。（どの失敗でもこれ） | 失敗の種類ごとに分ける（設定の表） |
| `passkey-manager.tsx:45` | 先にロックを設定すると、生体認証を登録できます。 | 削除 |
| `passkey-manager.tsx:71-75` | iPhone／Android／この端末 | `deviceLabel()` による名前：iPhone（Safari）、iPad（Safari）、Mac（Safari）、Mac（Chrome）、Android（Chrome）、Windows（Edge）、不明な端末 |
| `passkey-manager.tsx:78` | 生体認証を登録しました | この端末で {m} を使えるようにしました |
| `passkey-manager.tsx:83` | 登録できませんでした。パスワードが正しいか確認してください。 | 登録できませんでした。もう一度お試しください。 |
| `passkey-manager.tsx:104,107` | {label} を削除（aria）／削除しました | {label} のパスキーを削除／パスキーを削除しました（削除前に確認あり） |
| `passkey-manager.tsx:120,132` | 登録するには金庫パスワードを入力してください／登録 | ボタン［この端末で {m} を使う］（本人確認はダイアログで行う） |
| `passkey-manager.tsx:139` | この端末では生体認証が使えません。パスワードで解除してください。 | この端末ではパスキー（Face ID など）を使えません。金庫はパスワードで開けます。 |
| `passkey.ts:17` | この端末では生体認証によるロック解除に対応していません。 | この端末またはブラウザは、パスキーで金庫を開く機能に対応していません。パスワードを使ってください。 |
| `passkey.ts:103` | パスキーの作成が取り消されました。 | 登録をキャンセルしました。 |
| `passkey.ts:108` | この端末のパスキーは、ロック解除に必要な機能（PRF）に対応していません。 | この端末のパスキーは、金庫を開く機能に対応していません。金庫はパスワードで開けます。 |
| `passkey.ts:144` | ロック解除が取り消されました。 | 表示しない（ボタンの画面に戻るだけ） |
| `passkey.ts:148` | この端末では生体認証からロック解除用の鍵を取り出せませんでした。パスワードで解除してください。 | この端末の {m} では金庫を開けませんでした。パスワードを使ってください。 |
| `vault.ts:176` | 金庫がロックされています。 | 金庫が閉じています。 |
| `vault.ts:254,338` | リカバリーキーが設定されていません。 | この金庫にはリカバリーキーがありません。 |
| `privacy/page.tsx:30` | …メモの件数・データの大きさ・更新日時・フォルダ名は暗号化されず… | …フォルダ名（ロックしたフォルダの名前を含む）、メモの件数・データの大きさ・更新日時は暗号化されず… |
| `privacy/page.tsx:36-37` | ロック用のパスワード、リカバリーキー、登録した生体認証をすべて失うと… | 金庫のパスワード、リカバリーキー、登録したパスキー（Face ID など）をすべて失うと、ロックしたメモは復元できません。提供者による復旧もできません。 |

### 本人確認ダイアログ：目的ごとの文言（新規。`src/lib/vault/purpose-copy.ts`）

主ボタンの規則：
- 金庫が閉じていてパスキーがあるとき、主ボタンは「{m}で続ける」。目的が `open` のときだけ「{m}で開く」。
- パスワード画面の送信ボタンは、下の表の動詞。
- 金庫が開いているときは、確認が必要な目的だけ動詞ボタンの画面を出す。

| 目的 | タイトル | 本文 | パスワード画面の送信 | 金庫が開いているとき |
|---|---|---|---|---|
| open（メモ画面から） | ロックされたメモを開く | このメモを読むには、金庫を開きます。 | 開く | ダイアログなし |
| open（バッジ・設定から） | 金庫を開く | 金庫を開くと、ロックしたメモを読んだり編集したりできます。 | 開く | ダイアログなし |
| lockNote | メモをロック | 「{title}」の本文・タイトル・添付ファイルを暗号化します。続けるには本人確認をしてください。 | ロックする | ダイアログなし |
| unlockNote | メモのロックを外しますか？ | 「{title}」を通常のメモに戻します。本文・タイトル・添付ファイルは、暗号化されない状態でサーバーに保存されます。 | ロックを外す | 同じ本文と［ロックを外す］ |
| lockFolder | フォルダ「{name}」をロックしますか？ | ・中にあるメモ {n} 件（サブフォルダを含む）の本文・タイトル・添付ファイルを暗号化します。<br>・あとから追加・移動したメモも自動でロックされます。<br>・フォルダ名は暗号化されず、ロック中も表示されます。<br>・インターネット接続が必要です。終わるまでこの画面を開いたままにしてください。 | ロックする | ［ロックする］ |
| unlockFolder | フォルダ「{name}」のロックを外しますか？ | ・このフォルダでロックされていたメモ {n} 件を通常のメモに戻します。暗号化されない状態でサーバーに保存されます。<br>・（k>0 のとき）個別にロックしたメモと、ほかのロックで守られているメモ {k} 件は、ロックしたままにします。 | ロックを外す | ［ロックを外す］ |
| createInLocked | ロックされたフォルダにメモを作成 | 「{name}」に作るメモは、最初からロックされます。続けるには本人確認をしてください。 | 作成する | ダイアログなし |
| moveIntoLocked | ロックされたフォルダへ移動しますか？ | 「{name}」に移動すると、このメモもロックされます。（フォルダを動かすとき：「{name}」に移動すると、「{folder}」の中のメモ {n} 件もロックされます。）インターネット接続が必要です。 | 移動する | ［移動する］ |
| reissueRecovery | リカバリーキーを作り直す | 新しいキーを作ると、いまのリカバリーキーは使えなくなります。続けるには本人確認をしてください。 | 続ける | 本人確認が必要（鍵そのものが要るため） |
| resetPassword | 金庫のパスワードを再設定 | リカバリーキーか、この端末の {m} で本人確認をしてから、新しいパスワードを決めます。 | 続ける | 同じ |
| addPasskey | この端末で {m} を使う | 登録するため、金庫のパスワードを入力してください。 | 次へ | 同じ |

ロック関連の目的をオフラインで開いたときは、ボタンを押せなくして次の一文だけを出します。
- ロックするにはインターネット接続が必要です。
- ロックを外すにはインターネット接続が必要です。
- 移動してロックするにはインターネット接続が必要です。

### 本人確認画面の部品（新規）

**リンクと入力欄**
- リンク：「パスワードを使う」／「{m}を使う」（その端末でパスキーが使えるときだけ）／「パスワードを忘れた場合」。
- パスワード欄のラベル「金庫のパスワード」。表示切り替え「パスワードを表示」／「パスワードを隠す」。
- リカバリーキー欄のラベル「リカバリーキー」。説明「大文字・小文字、ハイフンや空白はどちらでもかまいません。」。文字数表示「{n} / 52 文字」。

**進行中の表示**
- {m}で確認しています…
- 確認しています…（Argon2 の計算中）
- 金庫の情報を読み込んでいます…

**エラーと再試行**
- パスキーの結果が返らなかったとき：「もう一度 {m} で確認してください。」とボタン［もう一度 {m} で続ける］。
- 古い登録：「{m}の登録が古くなっています。パスワードで開いたあと、設定で登録し直してください。」。

**特別な画面**
- オフライン：タイトル「金庫を開けません」、本文「この端末にはまだ金庫の情報がありません。インターネットに接続してから、もう一度お試しください。」、［閉じる］。
- すでに金庫がある：「このアカウントにはすでに金庫があります。金庫のパスワードで開いてください。」。
- 作成中にほかの端末で作られた：「ほかの端末で金庫が作成されました。その金庫のパスワードで開いてください。」。
- リカバリーキーで開いた直後：タイトル「新しいパスワードを設定しますか？」、本文「リカバリーキーで開きました。新しいパスワードを決めておくと、次からはパスワードで開けます。」、［あとで］［新しいパスワードを設定］。

### 金庫の作成（新規）

**冒頭の一文（目的ごと）**
- lockNote：「メモをロックする前に、金庫を作成します。」
- lockFolder：「フォルダ「{name}」をロックする前に、金庫を作成します。」

**パスワード入力**
- 入力欄の説明：「8 文字以上。Memoca へのログインとは別の、金庫専用のパスワードです。」
- 注意書き：「このパスワードを忘れても、次に表示するリカバリーキーがあれば開けます。両方なくすと、誰にも開けません。」
- エラー（文言は変えない）：「パスワードは 8 文字以上にしてください。」「2 つのパスワードが一致しません。」
- オフライン：「金庫の作成にはインターネット接続が必要です。」

**リカバリーキーの表示**
- ボタン［コピー］［ファイルに保存］［次へ］。
- ［ファイルに保存］は、`navigator.share({files})` が使えればそれを使い、使えなければ `<a download>` で保存する。
- ファイル名は `memoca-recovery-key.txt`。中身は「Memoca 金庫のリカバリーキー\n{key}\n作成日: {yyyy/mm/dd}\n金庫のパスワードを忘れたときに使います。人に見せないでください。」。
- コピーに失敗したとき：「コピーできませんでした。キーを長押しして選択するか、書き写してください。」

**保管の確認**
- タイトル「リカバリーキーの確認」、本文「保管したキーの、最後の 4 文字を入力してください。」、入力欄のラベル「最後の 4 文字」、ボタン［確認］。
- 一致しないとき：「一致しません。保管したキーをもう一度確認してください。」
- リンク「キーをもう一度表示」。

**パスキーの提案**
- タイトル「{m}でも開けるようにしますか？」
- 本文「次からはパスワードを入力せずに、{m}だけで金庫を開けます。この端末にパスキーが保存されます。」
- ボタン［あとで］［{m}を使う］。
- Safari で 2 回目の確認が必要なとき：「登録を完了するため、もう一度 {m} で確認してください。」と［{m}で確認］。

**完了**
- この後に続けるロック操作がないときだけ「金庫を作成しました」と表示する。

### 画面表示・メニュー・バッジ（新規・変更）

| 場所 | 金庫が閉じているとき | 金庫が開いているとき |
|---|---|---|
| サイドバー：自分でロックしたフォルダ | `FolderLock` と本当の名前。読み上げ用に「（ロック中）」 | 同じ |
| サイドバー：親から受け継いだロック | `Folder` と小さい `Lock`。読み上げ用に「（親フォルダでロック中）」 | 同じ |
| サイドバー：旧形式の暗号化名 | 「ロックされたフォルダ」。ツールチップ「金庫を開くと名前が表示されます」 | 数秒で平文に移行する |
| サイドバー：処理中 | アイコンが回転する `Loader2` に変わり、メニュー項目は「処理中…」で押せない | 同じ |
| フォルダのメニュー | 「ロックする…」／「ロックを外す…」。受け継いだロックでは押せない「親フォルダ「{name}」でロック中」。Inbox には項目を出さない | 同じ |
| メモのメニュー | 「ロックする」／「ロックを外す…」。フォルダのロックで守られているときは押せない「フォルダ「{name}」でロック中」と、2 行目「外すには、メモをフォルダの外へ移動します」 | 同じ |
| メモ一覧の行 | 1 行目「ロックされたメモ」、2 行目「金庫を開くと読めます」 | 本当のタイトル、2 行目「ロック中」 |
| メモ画面 | タイトル欄は「ロックされたメモ」で編集不可。本文の位置に大きな鍵アイコン、「このメモはロックされています」「読むには金庫を開いてください。」、主ボタン「{m}で開く」（パスキーがなければ「金庫を開く」）、パスキーが主のときはリンク「パスワードで開く」 | タイトルの前に `Lock` アイコン。ツールチップ「ロックされたメモです。金庫が開いているあいだだけ表示されます。」 |
| まだ暗号化されていないメモ | 帯「このメモはロックされたフォルダにありますが、まだ暗号化されていません。暗号化が終わるまで編集できません。」と［いますぐロック］ | 同じ（すぐに自動で修復される） |
| 復号に失敗したメモ | — | 「このメモを開けませんでした。金庫の鍵が合わない可能性があります。設定の「開けないメモ」を確認してください。」 |
| ロックしたフォルダの一覧の見出し | 帯「このフォルダのメモはロックされています。」と［金庫を開く］ | 名前と `Lock` |
| 検索・⌘K | ロックされたメモは結果に出さない。下の注記「ロックされたメモは、金庫を開くとタイトルで検索できます。」 | タイトルを検索できる。注記「ロックされたメモの本文は検索されません。」 |
| ゴミ箱 | メモは「ロックされたメモ」、フォルダは本当の名前 | 本当のタイトル |
| フォルダ選択 | 本当の名前と `Lock`。cmdk の value は `${id} ${name}` | 同じ |
| 金庫バッジ（新規 `vault-badge.tsx`） | 表示しない | `LockOpen` と「金庫：開いています」（sm 以上で文字も表示）。ポップオーバーは見出し「金庫は開いています」、本文「ロックしたメモを読んだり編集したりできます。{n} 分間操作がないと自動で閉じます。」、［いますぐ閉じる］ |

### トースト（新規・変更）

**金庫**
- 金庫を閉じました
- 金庫を閉じました（{n} 分間操作がなかったため）
- 処理が終わったら金庫を閉じます
- 読み上げ用の live region：「金庫を開きました」／「金庫を閉じました」

**メモのロック**
- メモをロックしています… → メモをロックしました
- メモのロックを外しています… → メモのロックを外しました
- ほかのメモからコピーした画像を暗号化しきれなかったとき：「メモをロックしました。ただし、ほかのメモからコピーした画像 {n} 件は、まだこのメモ用に暗号化できていません。容量やネットワークが整いしだい、自動で暗号化します。」（フォルダのロックと移動では「このメモ用に」を省く）
- ロックしたメモに貼った画像の暗号化コピーが容量に入らないとき（メモごとに 1 回）：「ほかのメモからコピーした画像を、このメモ用に暗号化する容量が足りません。不要なファイルを削除してください。」

**フォルダのロック**
- 一部だけ終わったとき：「{ok} 件をロックしました。残りの {k} 件は、同期が終わりしだい自動でロックします。」
- 失敗したとき：「ロックできませんでした。もう一度お試しください。」［再試行］

**フォルダのロックを外す**
- 一部だけ終わったとき：「{k} 件のメモのロックを外せませんでした。ロックしたままになっています。」［続ける］

**接続と中断**
- オフライン：「オフラインのため、いまはロックできません。インターネットに接続してから、もう一度お試しください。」（外すとき：「…いまはロックを外せません。…」）
- 接続待ち：「接続が戻るのを待っています…」
- 途中で閉じたとき：「金庫が閉じたため中断しました。金庫を開くと続きから再開します。」

**移動**
- 移動してロックしました
- 移動しました。メモのロックはそのままです。
- 移動しました。中のメモはロックされたままです。
- ロックできなかったメモがあるため、移動しませんでした。もう一度お試しください。

**修復と移行**
- ロックが途中だったメモ {n} 件をロックしました
- フォルダのロックを外す処理を再開しました
- ロックしたフォルダの名前を、ロック中も表示されるようにしました（{n} 件）。
- Inbox はロックできなくなったため、Inbox のロックを外しました。ロックしていたメモは、ロックされたままです。
- ロックしたメモの添付ファイル {n} 件を暗号化しました
- ほかのメモからロックしたメモにコピーされていた画像 {n} 件を、そのメモ用に暗号化しました
- 容量不足で暗号化コピーを作れないとき（1 回のセッションに 1 度）：「ロックしたメモに、ほかのメモからコピーした画像が {n} 件あり、容量が足りないため暗号化できていません。不要なファイルを削除すると、自動で暗号化します。」［設定を開く］

**リカバリーキーの催促**（1 日 1 回まで）
- リカバリーキーを作り直してください［設定を開く］

### 設定画面の文言（新規 `src/components/vault/vault-settings.tsx`）

**金庫の状態**
- 読み込み中：「金庫の情報を読み込んでいます…」
- オフラインで状態が分からないとき：「オフラインのため、金庫の情報を確認できません。」
- 金庫がないとき：「まだ金庫はありません。メモやフォルダを初めてロックするときに作成します。」［金庫を作成］
- 自動で閉じるまでの時間の説明：「金庫を開いたあと、この時間なにも操作しないと自動で閉じます。アプリを閉じたときや再読み込みしたときも閉じます。」

**パスキー**
- 説明：「登録すると、パスワードを入力せずに Face ID や Touch ID で金庫を開けます。パスキーは端末のパスワード管理（iCloud キーチェーンや Google パスワードマネージャー）に「Memoca の金庫」として保存されます。」
- 一覧の各行：バッジ「この端末」、日付「{date} に登録」。

**パスキーの削除**
- 確認ダイアログ：「「{label}」のパスキーを削除しますか？」
- 本文：「この登録では金庫を開けなくなります。金庫のパスワードとリカバリーキーはそのまま使えます。端末のパスワード管理に残るパスキーは、必要なら端末の設定から削除してください。」
- ボタン［キャンセル］［削除する］。
- 失敗したとき：「削除できませんでした。インターネット接続を確認してください。」

**パスキーの登録**
- 2 段階目：見出し「{m}を登録」、本文「「登録を始める」を押すと、パスキーを保存する画面が表示されます。」、［登録を始める］。
- 3 段階目：「登録を完了するため、もう一度 {m} で確認してください。」［{m}で確認］。
- すでに使えるとき：「この端末では、登録済みのパスキーがすでに使えます。確認のため一度 {m} で開いてください。」［{m}で確認］ → 「この端末のパスキーを使えるようにしました」。
- 上限に達したとき：「登録できるパスキーは 10 件までです。使っていないものを削除してください。」

**リカバリーキー**
- 説明：「金庫のパスワードを忘れたときに金庫を開くためのキーです。」
- 確認済みの表示：「{date} に保管を確認済み」。
- ボタン［リカバリーキーを作り直す］［リカバリーキーを試す］。
- 旧形式の警告：見出し「リカバリーキーを作り直してください」、本文「以前に表示されたリカバリーキーは、表示の不具合で一部が欠けていたため、金庫を開けません。新しいキーを作って保管してください。」、［いますぐ作り直す］。
- 未確認の警告：見出し「リカバリーキーの保管が確認できていません」、本文「作成時の確認が終わっていません。念のため新しいキーを作って保管してください。」。
- 試す画面：見出し「リカバリーキーを試す」、本文「保管したリカバリーキーを入力すると、使えるかどうかを確かめます。金庫は開きません。」。結果は「このリカバリーキーは使えます。」／「このリカバリーキーでは開けません。」。
- 作り直しの結果：
  - 成功：「新しいリカバリーキーを保存しました」
  - ほかの端末と競合：「ほかの端末で金庫の設定が変わりました。画面を閉じて、もう一度お試しください。」
  - オフライン：「リカバリーキーの作り直しにはインターネット接続が必要です。」
  - 失敗：「保存できませんでした。インターネット接続を確認して、もう一度お試しください。」

**金庫のパスワード**
- 変更ダイアログ：見出し「金庫のパスワードを変更」、入力欄「いまのパスワード」「新しいパスワード」「新しいパスワード（確認）」、ボタン［変更する］。
- 変更のエラー：
  - 「いまのパスワードが違います。」
  - 「新しいパスワードは 8 文字以上にしてください。」
  - 「2 つの新しいパスワードが一致しません。」
  - 「変更できませんでした。インターネット接続を確認して、もう一度お試しください。」
  - ほかの端末と競合したときは、上と同じ競合の文言。
- 再設定ダイアログ：見出し「金庫のパスワードを再設定」、ボタン［再設定する］、完了「金庫のパスワードを再設定しました」。

**開けないメモ**
- 見出し「開けないメモがあります」
- 本文「{n} 件のメモが、この金庫の鍵では開けません。以前の不具合で、別の鍵でロックされた可能性があります。メモは削除されていません。」
- ［一覧を見る］。各行に［ゴミ箱に移動］。
- 名前を読めないフォルダ：「名前を読めないフォルダが {n} 件あります。」［名前を付け直す］。

**共通**
- オフラインで変更できないとき：「オフラインのため、この設定はいま変更できません。」

## 体験の流れ

1. **初めてロックする（金庫がない）**
   - メモの ⋯ から「ロックする」を押すと「金庫を作成」の画面が出る（冒頭に目的の一文が入る）。
   - 手順：パスワードを 2 回入力 →［作成する］→ サーバーが ok を返す → リカバリーキー（52 文字）を表示する。この画面は × でも外側のタップでも閉じない。
   - ［コピー］か［ファイルに保存］→［次へ］→ 最後の 4 文字を入力 →［確認］→ パスキーの提案（［あとで］でも可）。
   - そのまま元の操作が続き、「メモをロックしました」と表示される。
2. **金庫が閉じた状態でロックする**
   - メモの場合：「ロックする」を押すと Face ID のシートがすぐ出る（その端末のパスキーが分かっているとき）。後ろには「メモをロック」のダイアログ（「{m}で確認しています…」）。認証が通るとロックされる。
   - フォルダの場合：「ロックする…」を押すと「フォルダ「仕事」をロックしますか？」（件数入り）が出る。［{m}で続ける］（またはパスワード）を 1 回押すと、進み具合 → 完了、一部だけ、失敗のいずれかを正直に表示する。
3. **金庫が開いた状態でロックする**
   - メモは確認なしですぐロックする。
   - フォルダは同じ確認画面（動詞ボタン［ロックする］）を 1 回押す。
4. **ロックされたメモを開く**
   - 一覧から選ぶ。自動では何も起きない。
   - メモ画面の［{m}で開く］を押すとシートが 1 回出て、本文が表示される。
   - パスワードでも開ける。「パスワードを忘れた場合」からはリカバリーキーで開ける（開いたあと、新しいパスワードを設定するか聞く）。
5. **ロックを外す**
   - メモは「ロックを外す…」から、必ず確認を経る（金庫が閉じていれば同じ画面で本人確認も行う）。
   - フォルダでは、このフォルダでロックしたメモだけを外す。個別にロックしたメモと、ほかのロックで守られているメモは残し、その件数を確認画面に出す。
   - フォルダのロックで守られているメモのメニューは押せず、外し方を説明する。
6. **閉じる・キャンセル（どの画面でも）**
   - Esc、外側のタップ、×、キャンセルは、すべて「キャンセル」として扱う。作成画面に飛ぶことはない。
   - 計算中や通信中は、閉じる操作を受け付けない。
   - リカバリーキーの表示中と確認中は閉じられない。
   - パスキーのシートが出ている間に閉じると、`AbortController` で中止する。
7. **Face ID / Touch ID**
   - 1 回のタップで `get()` を 1 回だけ呼ぶ。
   - 対象は、この端末で成功したことのあるパスキーだけ（まだ分からなければ全件を 1 回の呼び出しでまとめて渡す）。`transports:["internal"]` と `hints:["client-device"]` を付ける。
   - キャンセルするとボタンの画面に戻る。次のシートは出さない。
   - 最初に出すのは、この端末（ブラウザ）で登録したか使ったことのあるパスキーがあるときだけ。ほかの端末やブラウザにしかないときは、パスワードを先に出し、「{m}を試す」だけを並べる（2026-09-26。Mac の Chrome で、Safari に保存したパスキーを探して「このデバイスにパスキーがありません」が出たため）。試してだめなら、登録がない可能性とパスワードで開いてから登録できることを伝える。
   - パスワードで開いたとき、この端末で {m} が使え、この端末のパスキーがまだなければ「この端末でも {m}で開けるようにしますか？」と聞く。［あとで］なら 30 日は聞かない（`META.passkeyOfferAt`）。
8. **オフライン**
   - 一度オンラインで金庫の情報を受け取った端末なら、パスワードでも Face ID でも開いて読み書きできる。ロックされたフォルダへのメモ作成もできる（最初から暗号化される）。
   - ロック、ロックを外す、ロックされたフォルダへの移動、作成、リカバリーキーの作り直しは、ボタンを押せなくして理由を表示する。
9. **自動で閉じる**
   - 最後の操作から N 分たったら閉じる。
   - 閉じる前に、編集中の本文とタイトルを暗号化して保存する。
   - バックグラウンドから戻ったときに期限を過ぎていれば、その場で閉じる。
   - 閉じたらトーストで知らせる。ロック処理の途中は閉じない。
10. **設定**
    - 「金庫とロック」にまとめる。並びは、状態、自動で閉じるまでの時間、パスキー、リカバリーキー（作り直す・試す・警告）、金庫のパスワード（変更・再設定）、開けないメモ（1 件以上あるときだけ）。

## 仕組みの変更

### 1. ロックのモデル（新規 `src/lib/vault/model.ts`）

`src/lib/tree.ts` の `lockedFolderIds` と `subtreeIds` を使う純粋関数にします。

- **`coverage(folders)`**：完全削除されていないフォルダで `lockedFolderIds` を計算する。
  - ゴミ箱内のフォルダも数える。
  - Inbox の `locked` フラグは無視する。これで、旧データで Inbox が locked のままでも新しい即席メモは平文で作れ、`/quick`（`WorkspaceShell` の外）でも問題が起きない。
- **`folderLockKind(folder)`**：`"own" | "inherited" | "none"` を返す。
- **`coveringFolder(folderId)`**：いちばん近いロック中の祖先（自分自身を含む）を返す。
- **`lockOriginOf(note, covered)`**：`note.lockOrigin` があればそれを返す。なければ、フォルダのロックで守られていれば `"folder"`、そうでなければ `"note"`。
- **`needsLock(note)`**：`!purged && !locked && covered.has(folderId)`。
- **`planFolderLock(id)`**：サブツリー内で、完全削除されていない平文のメモ（ゴミ箱内を含む）を返す。
- **`planFolderUnlock(id)`**：このフォルダのフラグを外したと仮定して被覆を計算し直す。まだ守られているメモ、または `lockOriginOf === "note"` のメモは `keep` に、残りは `unlock` に入れる。
- **`canLockFolder(f)`**：Inbox ではなく、かつ種類が `"none"` のとき true。

### 2. 金庫レコードのキャッシュ

- 新規 `src/lib/vault/record.ts`（zustand）が `{ availability: "unknown"|"none"|"exists", record, source }` を持つ。
  - `hydrate()`：`META.vaultRecord` の値を `{userKey, record}` として読む。`userKey` が違えば無視する。なければ `META.profile.hasVault` を見る（`convex/users.ts:156`、`sync-provider.tsx:96`）。
  - `acceptServer()`：`none` はサーバーが今回のセッションでそう答えたときだけ設定し、キャッシュには書かない。
- 新規 `src/components/vault/vault-record-sync.tsx` を `WorkspaceShell` に置き、`api.vault.record` を常に購読する。
- ダイアログ、設定、`passkey-manager.tsx` は、`useQuery(api.vault.status)` をやめてこのストアを読む。
- `sync-provider.tsx:121-134` の `userKey` effect の cleanup で `vault.lock()` を呼ぶ（アカウントを切り替えたとき、前の人の鍵を残さない）。
- 新規 `src/lib/vault/local-passkeys.ts`：`META.passkeyLocal: string[]` を起動時にメモリへ読み込み、同期的に参照できるようにする。
- `platformAuthenticatorAvailable()` の結果も起動時に 1 回だけ取ってキャッシュする。

### 3. 本人確認ダイアログと状態遷移

新規 `src/lib/store/vault-gate.ts`（`vault-ui.ts` の置き換え）と、純粋なリデューサー `src/lib/vault/gate-machine.ts`（新規）です。

```ts
requestVault(purpose: VaultPurpose, opts?: { need?: "session" | "raw"; gesture?: boolean; returnFocus?: HTMLElement | null }): Promise<VaultResult>
type VaultResult = { ok: true; raw?: Uint8Array } | { ok: false; reason: "cancelled" | "offline" };
```

**呼び出しの規則**
- 金庫が開いていて、`need:"session"` で、確認のいらない目的（`open`、`lockNote`、`createInLocked`）なら、ダイアログを出さずにすぐ `{ok:true}` を返す。
- 次の依頼が来たら、前の依頼は `cancelled` で終える。
- `openSetup` はなくす。作成は `{kind:"setup"}` の依頼だけで行う。

**Face ID の自動起動**
- 条件：`gesture:true`、目的が `open`／`lockNote`／`createInLocked`、レコードがキャッシュ済み、プラットフォーム認証が使える、この端末のパスキーが分かっている、このダイアログで一度もキャンセルしていない。
- 条件を満たせば、`await` を挟まずに `startPasskey()` を同期で呼ぶ。
- 定数 `AUTO_START_PASSKEY`（既定 true）で止められるようにする。300 ms 以内に画面を出さずに拒否されたら、何も言わずにボタンの画面にする。
- 呼び出し側でも、`requestVault` より前に `await` を置かない（件数などは `useLiveQuery` で取得済みの値を使う）。

**状態**

| 状態 | 入る条件 | 主操作 | 閉じる操作 |
|---|---|---|---|
| loading | レコードがなく、オンライン | —（10 秒たつと offline の文言に切り替える） | cancelled |
| offline | レコードがなく、オフライン | ［閉じる］ | cancelled |
| confirm | 金庫が開いていて、確認が要る目的 | 目的の動詞 | cancelled |
| passkey | レコードがあり、この端末で使える | {m}で続ける／開く | cancelled |
| passkeyPending | `get()` の実行中 | — | cancelled して中止（abort） |
| password | パスキーがない、またはユーザーが選んだ | 目的の動詞 | cancelled |
| recovery | 「パスワードを忘れた場合」 | 開く／続ける | cancelled |
| recovered | リカバリーキーで開いた直後 | 新しいパスワードを設定 | ［あとで］と同じ |
| create.password | サーバーが none と答えた | 作成する | cancelled |
| create.recovery／create.confirm | setup が ok を返した | 次へ／確認 | 受け付けない（× も出さない） |
| create.passkey | 端末で使える | {m}を使う | ［あとで］と同じ |
| （処理中） | Argon2 の計算やサーバー呼び出し | — | 受け付けず、キャンセルも押せない |

**主な遷移**
- passkeyPending から：
  - 成功 → ok で閉じる。
  - `NotAllowedError` → passkey に戻る（メッセージなし）。
  - `PasskeyNeedsRetryError` → passkey に戻り、「もう一度…」を出す。
  - PRF が得られない、または非対応 → password に移り、エラーを出す。
- create.password の送信：`prepareVault` → `setup` の結果で分かれる。
  - ok → 鍵を使い始めて create.recovery へ。
  - already → 用意した鍵を捨て、password に移ってその旨を出す。
  - 例外 → エラーを出す。
- create.* の途中でほかの端末でレコードができたら、password に移ってその旨を出す。

**不変条件（テストで確かめる）**
- `availability==="exists"` のとき、create.* には絶対に入らない。
- 依頼の Promise は必ず 1 回だけ解決される。

**レイアウトと操作**
- スマホでは画面下から出すシートにする。
  - `inset-x-0 bottom-0 top-auto translate-x-0 translate-y-0 rounded-t-2xl`
  - `style={{bottom: useKeyboardInset()}}`（既存の `src/lib/hooks/use-keyboard-inset.ts`）
  - `pb-[env(safe-area-inset-bottom)]`
- 全画面を `<form onSubmit>` にし、Enter で送信する。日本語入力の変換中（`nativeEvent.isComposing`）は送信しない。
- パスワード欄には `enterKeyHint="go" autoCapitalize="none" autoCorrect="off" spellCheck={false}` を付ける。
- 開いたときのフォーカス（`onOpenAutoFocus`）：passkey の画面ではボタン、パスワード欄は `(pointer: fine)` のときだけ。
- 閉じたときのフォーカス（`onCloseAutoFocus`）は `returnFocus` に戻す。
- 新規 `src/lib/hooks/use-menu-dialog.ts` で、`folder-tree.tsx:98-105` の `openingDialog` の仕組みを共通化する。`note-pane.tsx:185` のメニューにも使う。
- エラーには `role="alert"` と `aria-invalid` を付ける。「{m}で確認しています…」は polite の live region で読み上げる。
- Argon2 を始める前に `await new Promise(requestAnimationFrame)` を入れ、「確認しています…」を先に描画する。

### 4. パスキー（`src/lib/crypto/passkey.ts` の書き直し）

**`buildAssertionOptions(record, localIds)`（純粋関数）**
- 対象：`localIds` と一致するものがあればそれだけ。なければ全件。
- `allowCredentials`：各パスキーに `transports:["internal"]` を付ける。
- `hints:["client-device"]`、`rpId: location.hostname`、`userVerification:"required"`、`timeout: 60_000`。
- PRF：1 件なら `prf.eval`、2 件以上なら `prf.evalByCredential`。

**`startPasskey(built, signal)`**
- `navigator.credentials.get` を 1 回だけ呼ぶ。
- `rawId` から該当のパスキーを選ぶ。成功したら `META.passkeyLocal` に追加する。
- エラーは次のクラスにして返し、再試行も次の呼び出しもしない。
  - `NotAllowedError`／`AbortError` → `PasskeyCancelledError`
  - 候補が 2 件以上で PRF が返らない → `PasskeyNeedsRetryError(credentialId)`。次のタップでは、そのパスキー 1 件に `eval` を使う。
  - 候補が 1 件で PRF が返らない → `PasskeyNoPrfError`
- `vault-dialog.tsx:133-145` のループは削除する。

**`registerPasskey({exclude})`**
- `user.id` は登録ごとに作るランダムな 16 バイト。`user.name` と `displayName` は「Memoca の金庫」。
- `excludeCredentials` にサーバー上の全パスキーを渡す（`transports:["internal"]`）。
- `hints:["client-device"]`、`attestation:"none"`、`authenticatorSelection` は今と同じ。
- `InvalidStateError` → `PasskeyAlreadyRegisteredError`（この場合、1 回のタップで `get()` を試し、成功すればこの端末のものとして記録する）。
- 作成時に PRF が返らなくても、2 回目の `get()` は自動で呼ばない。`prfOutput:null` を返し、画面側で 3 段階目のタップを求める（`passkey.ts:117` の問題を解消）。

**登録の流れ**
1. `requestVault({kind:"addPasskey"},{need:"raw"})`
2. タップで `create()`
3. PRF がなければ、タップで `get()`
4. `wrapForPasskey`（開き直して自己確認する）
5. `addPasskey`（`label: deviceLabel()`）
6. `META.passkeyLocal` に追加
7. `finally` で raw を消去する

### 5. 作成ガード（金庫を上書きしない）

- `src/lib/crypto/vault.ts`：`createVault` を `prepareVault(password, params)` に置き換える。戻り値は `{ record, recoveryText, adopt(), discard() }` で、生の VK はクロージャの中だけに置く。
- 返す前に、`recoveryText` を `parseRecoveryKey` にかけ、そのキーで `recWrap` を開けることを確かめる（表示するキーで本当に開けることの保証）。
- サーバーが `ok` を返すまで `adopt()` は呼ばない。`already` か例外なら `discard()` する。

### 6. リカバリーキーの修正と作り直し

- 新規 `src/lib/crypto/recovery-key.ts`（`src/lib/bytes.ts` の `toBase32`/`fromBase32` を使う）。
  - `formatRecoveryKey(bytes)`：52 文字を 4 文字ずつ 13 組にする。32 バイトであることと、元に戻せることを確かめる。
  - `parseRecoveryKey(text)`：
    1. NFKC で正規化し、大文字にする。
    2. `0→O`、`1→I`、`8→B` に置き換え、`A-Z2-7` 以外を取り除く。
    3. ちょうど 40 文字なら `legacy`、52 文字以外なら `length` を返す。
  - `recoveryKeyTail()`：最後の 4 文字を返す。
- `vault.ts` に追加する関数：
  - `openVaultRaw(record, {password}|{recoveryKey}|{prf:{entry,output}})`：`extractVaultRaw` を一般化したもの。
  - `issueRecoveryWrap(raw)`：表示用の文字列を元に戻して開けることを自己確認する。
  - `verifyRecoveryKey(record, bytes)`：金庫は開かずに確かめるだけ。
  - `rewrapPasswordFromRaw(raw, next, params)`
- 作り直しの流れ：
  1. `requestVault({kind:"reissueRecovery"},{need:"raw"})`
  2. `issueRecoveryWrap`
  3. `rewrap({recWrap, recoveryFormat:2, expectedVersion})`（サーバーに先に保存する）
  4. `RecoveryKeyView`（新規 `src/components/vault/recovery-key-view.tsx`。作成時と共通。閉じられない）で表示する。
  5. 最後の 4 文字を確かめる。
  6. `markRecoveryChecked`
- 金庫を開いたとき、`recoveryFormat !== 2` または `recoveryCheckedAt` がなければ、1 日 1 回まで催促のトーストを出す。

### 7. フォルダ名を平文に戻す

- `mutations.ts` の `renameFolder` は暗号化しない（`nameSealed: undefined`。vault の動的 import も削除する）。
- `actions.ts` のフォルダのロックも名前を暗号化しない。
- `useFolderName` は平文の名前を優先し、旧形式の暗号化名のときだけ復号する。
- ツリー、フォルダ選択、ゴミ箱（`data.ts:121`）、検索（`use-search.ts:35`）、ドラッグ表示は本当の名前を使う。
- `RenameDialog` の送信に try/catch とトーストを付ける。
- 移行は新規 `src/lib/vault/reconcile.ts` の `unsealFolderNames()` で行う。
  - 金庫が開いていて、`name===null && nameSealed` のフォルダがあれば実行する（`useLiveQuery` で件数を監視し、古いクライアントがあとから暗号化した名前にも反応する）。
  - `openFolderName` で復号し、新しいスタンプで `renameFolder(id, plain)` する。
  - サーバーの既存の処理（`convex/sync.ts:339-345`）が `nameSealed` を消すので、新しいサーバー関数は要らない。
  - 読めなかったものは `META.vaultHealth.unreadableFolders` に記録する。

### 8. カスケード（新規 `src/lib/vault/cascade.ts`）

**`runCascade(client, engine, {direction, noteIds, origin, onProgress})`**
- 戻り値：`{total, done[], pending[{noteId,reason}], aborted?}`
- 手順：
  1. `navigator.locks.request("memoca-vault-cascade")` を取る（修復処理とも共有する）。
  2. `vault.hold()` を取り、`try/finally` で必ず解放する。
  3. オンラインか確かめる（`client.connectionState().isWebSocketConnected && navigator.onLine`）。
  4. `settle(noteIds, 10s)`：`flushAll()`（`docs.ts:261`）→ `engine.kick(0)` → 未送信の更新や outbox がなく、本文が追いつくまで Dexie を見て待つ。遅れているメモは `engine.fetchBodies` で取り直す。
  5. メモを 1 件ずつ処理する。結果は次のとおり。
     - `behind`／`unsent`／`uploadPending`／`attachmentsNotCovered`：`settle` のあと最大 2 回まで再試行する。
     - `compactFirst`：`engine.compact` してから再試行する。
     - `alreadyLocked`／`notLocked`：完了として数える。
     - `VaultLockedError`：`aborted:"vaultClosed"` で止める。
     - `fetch` の `TypeError`：`aborted:"offline"` で止める。

**ロックする**
- 先にフラグを立てる（`setFolderLock(true)`）。
- 次に `planFolderLock` のメモを `origin:"folder"` でロックする。

**ロックを外す**
- 先にフラグを外し、`META.unlockJob = {folderId, noteIds}` を保存する。
- `planFolderUnlock.unlock` のメモだけを外し、終わったらジョブを消す。
- 一部だけ終わったら［続ける］を出す。次に金庫を開いたときも、この端末でだけ再開する。

**`actions.ts` の変更**
- `lockNote(client, id, {origin})`
  - 暗号化したスナップショットが `SNAPSHOT_INLINE_LIMIT` を超えたら、既存の `uploadBytes` と `api.notes.snapshotUploadUrl` でアップロードし、`storageId` を送る。これで約 900 KB の上限がなくなる。
  - ローカルにも `title:null`、`titleSealed`、`lockOrigin`、`ts.lock`、`ts.title` を書く（サーバーに送ったのと同じスタンプ）。
  - そのメモの添付ファイルの `blobs` を消し、URL を revoke する。
- `unlockNote` に `unsent` の確認を足す。ローカルの `lockOrigin` は `undefined` にする。
- `setFolderLocked` と `resumeCascades` は削除する（`cascade.ts` と `reconcile.ts` に移す）。

**画面との接続**
- 新規 `src/components/vault/use-lock-actions.ts` が次を受け持つ：`lockNote`、`unlockNote`、`lockFolder`、`unlockFolder`、`createNote`、`moveNote`、`moveFolder`。
- 処理中のフォルダは小さなストアで管理し、回転アイコンを出す。
- これで `workspace-shell.tsx:57-85`、`note-pane.tsx:129-152`、`onRequestLock` のバケツリレー（`app-shell.tsx`、`sidebar.tsx`）、`ShellContext.requestLock`（`app-shell.tsx:21-25,43`）を置き換える。

### 9. ロックしたフォルダでの新規作成と移動

**新規作成**
- `createNote({folderId, lock:true})`：
  1. `vault.createNoteKey(noteId, 1)`
  2. `ctx.noteTitle(noteId,1)` で空のタイトル `""` を暗号化する。
  3. ローカルに書く：`locked:true, keyEpoch:1, wrappedKey, title:null, titleSealed, preview:null, lockOrigin:"folder", ts.lock=ts`。本文は `bodies{keyEpoch:1,text:null}`。
  4. op を 1 件積む：`create{…, lock:{keyEpoch:1, wrappedKey, ts}}`、`title{value:null, sealed, preview:null, ts}`、`place`。
- フォルダのロックで守られた場所に、金庫が閉じたまま作ろうとしたら `VaultLockedError` を投げる。平文では作らない。
- 本文は `docs.ts` の `flush` が最初から暗号化する（`docs.ts:97-110`）。オフラインでも動く。
- 呼び出し元：`note-list.tsx:187,201`、`command-palette.tsx:104`。いずれも `useLockActions().createNote` 経由にする。

**移動**
- 平文のメモをロックしたフォルダへ移すとき：オンラインか確かめる → `requestVault(moveIntoLocked)` → `lockNote(origin:"folder")` → 成功したら `moveNote`。失敗したら移動しない。
- フォルダを移すとき：サブツリーを先にロックし、全件成功したら `moveFolder` する。
- 対象の呼び出し箇所：`note-pane.tsx:252`、`folder-tree.tsx:138,150,166,451`（`183` の上下移動は同じ親の中なので対象外）。
- ロックしたフォルダから外へ出すときは、ロックをそのまま残し、トーストで知らせる。

**まだ暗号化されていないメモ**
- `needsLock` のメモは、`NotePane` に帯を出し、タイトル欄を編集不可にし、`NoteEditor` に新しい `readOnly` prop（BlockNote の `editable=false`）を渡す。
- `note-editor.tsx:41-51` の `acquireDoc` の失敗を catch して、エラー文言を出す（スケルトンが出たままにしない）。

### 10. Inbox

- メニューに項目を出さない。サーバーの `setFolderLock` は Inbox への `locked:true` を `"systemFolder"` で拒否する。被覆の計算でも Inbox の旗は無視する。
- 旧データで Inbox が locked なら、修復処理がフラグだけ外す（`setFolderLock(false)`。金庫は不要）。中のロック済みメモはそのまま残し、トーストで知らせる。

### 11. 自動で閉じる

**`VaultSession`（`vault.ts`）の追加**
- 期限は、最後の操作の時刻に N 分を足したもの。タイマーは 1 本で、残り時間に合わせて張り直す。
- `touch()`（公開）、`checkDeadline()`、`hold(): () => void`。
- `onBeforeClose(fn)`：閉じる前に、鍵を持ったまま実行するフック。
- `close(reason: "manual"|"idle"|"account")`：フックを `Promise.allSettled` で最大 1.5 秒待ってから `lock()` し、理由を知らせる。
- 自動で閉じる処理は、hold 中は待つ。手動で閉じたときは「処理が終わったら金庫を閉じます」と出す。
- `lock()` は同期のまま残す（サインアウトとテスト用）。

**新規 `src/lib/vault/activity.ts`（`WorkspaceShell` から組み込む）**
- `pointerdown`／`keydown`／`input`／`wheel`／`touchstart` を `window` の capture・passive で受け、5 秒ごとに間引いて `touch()` する。
- `visibilitychange` で hidden になったら `flushAll()`、visible に戻ったら（`pageshow` も）`checkDeadline()`。

**閉じる前のフック**
- `docs.ts` の `flushAll`
- `NotePane` の保留中のタイトル（`note-pane.tsx:89-111`）

### 12. 添付ファイル

- `flushUploads`（`attachments.ts`）は、アップロード時点のメモの `locked` を読み直す。
  - サーバーがまだ知らないメモ（オフラインで作ったメモ）のファイルは、`unknownNote` で拒まれても消さずに、メモが届いてから送る（ファイルはメモより先に送られるため）。
  - ロック済みで金庫が閉じていれば、今回は送らない。
  - サーバーが `lockMismatch` を返したら、保留中のアップロードを消さずに、あとで暗号化して送り直す。
  - ロック済みのファイルは `blobs` に入れない。
- `resolveAttachment` は、`row.locked` なら `blobs` を使わない。
- サーバー側の防止：`attachments.reserve` は、ロック済みのメモへの平文アップロードを拒否する。`lockNote` は、平文の添付やアップロード途中のものが残っていればロックを拒否する（Convex の表を参照）。
- 旧データの修復：ロック済みのメモに付いている平文の添付を、修復処理が暗号化して `vault.lockAttachments` で差し替える。
- まだ送っていない暗号化予定のファイル（`pendingUploads` の平文）は、金庫が閉じている間は表示も読み出しもしない（`resolveAttachment`・`loadAttachmentBlob`）。
- 本文のスナップショットと、ロックのために読み出す平文のファイルは `cache: "no-store"` で取り、Service Worker はそういう要求をキャッシュしない。

**ほかのメモからコピーした画像**（`src/lib/media/relock-copies.ts`、2026-09-26）

ブロックの url は `memoca://att/<id>` なので、画像ブロックをコピーすると、ほかのメモのファイルをそのまま指す。ロックが暗号化するのはメモ自身のファイルだけなので、そのままではサーバーで平文のまま残る。そこで、ロックしたメモには、そういうファイルごとに暗号化した自分用のコピーを持たせる。

- ロック時（`copiesForLock`）：暗号化したコピーを `pendingUploads` に用意し、コピーを指すように直した版の文書を封緘してサーバーに渡す（`withSwaps`）。メモそのものは書き換えないので、書き換えの平文の更新は生まれない。用意したコピーは `heldForLock` で送らずにおき、ロックが通ったら送り、通らなければ取り消す。ロックの途中でサーバーに届くことも、拒まれることもない。暗号化したファイルはサーバーのロック判定（`plaintextAttachmentsLeft`）を止めないので、アップロードを待たない。
- ロックの途中でタブが閉じて `heldForLock` のまま残ったコピーは、修復パスが片づける：メモがロックされていれば送り、ロックされていないまま、コピーを作ってから 10 分以上あとの同期に追いついていれば取り消す。
- ロック済みのメモ（`relockCopies`）：エディタが開いたときと編集の 1 秒後に、修復パスが変わったメモを 1 回 5 件まで、コピーを用意して文書を書き換える。書き換えは undo の一手にならない。書き換えたらすぐ保存してから次へ進む。
- 1 つのメモを扱うのは 1 度に 1 つ：`navigator.locks` の `"memoca-relock:<noteId>"`。ロックとロック解除は順番を待ち、エディタと修復パスは使用中なら後回しにする。
- 作らないもの：容量や 1 ファイルの上限（暗号化の 16 バイト込み。種類が分からないうちは緩いほうの上限）を超えるもの、サーバーにもうないもの。待つもの：持ち主のメモがロック済みなのに行がまだ平文のもの、平文のはずなのに行のサイズより長く届いたもの（ほかの端末で暗号化されたあとで、この端末にまだその知らせが届いていない）。
- ロックを外すときは、そのメモのファイルで、この端末から送っている途中のもの（コピーを含む）が済むまで待つ（`uploadPending`）。ロック解除は保存済みのファイルしか平文に戻さないため。
- サーバーがコピーを受け付けなかったら、`META.refusedCopies` に記録してから行を消し、メモを元の画像に戻す。あとから届いた書き換えも次のパスで戻し、同じ画像は 10 分コピーし直さない。
- ロックは、コピーを作れない画像があっても止めない。サーバーで読める状態のまま残った件数を `copiesLeft` として返し、画面で知らせる。

### 13. 修復と健康診断（新規 `src/lib/vault/reconcile.ts`）

**実行の仕方**
- `navigator.locks` の `"memoca-vault-cascade"` を `ifAvailable` で取る。カスケードの実行中は動かない。
- きっかけ：金庫を開いたとき、同期が落ち着いたとき（2 秒待つ）、`online` イベント。

**金庫がなくてもできること**
- Inbox の旧フラグを外す。
- ロック済みの添付ファイルの `blobs` を消す。

**金庫が開いているとき**
1. フォルダ名を平文に戻す。
2. この端末の `unlockJob` を再開する。
3. `needsLock` のメモを `origin:"folder"` でロックする（ジョブ中のメモは除く）。
4. 平文の添付を修復する。
5. ほかのメモからコピーされた画像に、ロックしたメモ用の暗号化コピーを作る（変わったメモから 1 回 5 件まで、順番に）。
6. 健康診断（開くたびに 1 回）：ロック済みの全メモで `noteKey` とタイトルの復号を、暗号化名の全フォルダで `openFolderName` を試す。結果は `META.vaultHealth` に入れる。**自動では何も削除しない。**
7. リカバリーキーの催促。

### 14. Convex の変更（すべて追加のみ。新しいインデックスはなし）

| ファイル | 変更 |
|---|---|
| `convex/schema.ts` | `vaults` に `recoveryFormat: v.optional(v.number())`（2 は全文表示済み）と `recoveryCheckedAt: v.optional(v.number())`。`notes` に `lockOrigin: v.optional(v.union(v.literal("note"), v.literal("folder")))`。`folders.nameSealed` は旧データのため残す |
| `convex/lib/ops.ts` | `noteOpV.create` に `lock: v.optional(v.object({ keyEpoch: v.number(), wrappedKey: sealedV, ts: stampV }))`。`folderOpV.name.sealed` は旧クライアントのため受け付け続ける |
| `convex/lib/constants.ts` | `MAX_PASSKEYS = 10`、`REPLACE_BODY_LIMIT = 2000` |
| `vault.record`（新規クエリ） | `getUser` を使う。戻り値は `{state:"signedOut"} \| {state:"none"} \| {state:"exists", record:{…status と同じ項目, recoveryFormat: number\|null, recoveryCheckedAt: number\|null}}` |
| `vault.status` | 変えない（古い PWA 用。最後に削除する） |
| `vault.setup` | 引数に `recoveryFormat` を追加。`already` の扱いは今と同じ |
| `vault.rewrap` | 引数に `expectedVersion`（食い違えば何も書かずに `{status:"stale"}`）と `recoveryFormat` を追加。`recWrap` を書き換えるときは `recoveryCheckedAt` を消す |
| `vault.markRecoveryChecked`（新規、引数 `{}`） | `recoveryCheckedAt = Date.now()` |
| `vault.addPasskey` | 10 件を超えたら `{status:"tooMany"}`。`label` は 64 文字までに切る |
| `vault.lockNote` | 引数に `origin` を追加し、`lockOrigin` に書く。**書き込みの前に**次を確かめる：更新行を `.take(REPLACE_BODY_LIMIT+1)` で数えて多すぎれば `compactFirst`。`by_user_note` の `.take(500)` で期限内の平文の `reserved` があれば `uploadPending`、削除されていない平文の `committed` が swaps に含まれていなければ `attachmentsNotCovered` |
| `vault.unlockNote` | `compactFirst` を確かめ、`lockOrigin: undefined` にする |
| `vault.setFolderLock` | `name` と `nameSealed` を省略可能にし、ロック時は無視する。`missingSealedName` は削除。Inbox への `locked:true` は `systemFolder` で拒否。`!isNewer(args.ts, folder.ts.lock)` なら何もせず ok（後勝ち）。書き換えるのは `locked`、`ts.lock`、`seq` だけ。例外として、`locked:false` で `folder.name===null` のとき（古いクライアントが旧形式のフォルダを外す場合）だけ、`args.name` を採用して `nameSealed` を消す |
| `vault.lockAttachments`（新規） | `{noteId, attachments: attachmentSwapV}`。`note.locked` が必要。既存の `swapAttachments` を使い、`usedBytes` と seq を扱う |
| `attachments.reserve` | `note.locked && !args.locked` なら `{status:"rejected", reason:"lockMismatch", uploadUrl:null}` |
| `convex/sync.ts` | `publicNote` に `lockOrigin` を追加。`applyNoteOp`：`futureStamp` で `op.create?.lock?.ts` も確かめる。`create.lock` での挿入は、`keyEpoch` が 1 以上の整数でなければ `badEpoch`、`op.title` があって暗号化されていなければ `plaintextIntoLockedNote`。挿入内容は `locked:true, keyEpoch, wrappedKey, lockOrigin:"folder", title:null, titleSealed, preview:null, ts.lock`。`applyFolderOp` は変えない |
| 削除（最後のコミット） | `vault.pendingLockCascade`、`vault.status` |

新しく書くコードは、ガイドラインどおり `ctx.db.patch("vaults", id, …)` の形にします。

### 15. Dexie

- バージョンは上げません。
- 新しいデータは `meta` の値にします：`vaultRecord`、`passkeyLocal`、`vaultHealth`、`unlockJob`、`recoveryNudgeAt`。
- `Note.lockOrigin` はインデックスのない項目です。
- `resetLocalData`（`src/lib/db/index.ts:128`）はすでに `meta` を消すので、追加の対応は要りません。
- `src/lib/types.ts` の `Note` に `lockOrigin?` を追加します。
- `src/lib/sync/apply.ts:93-103` の lock グループで `lockOrigin` も写します。

### 16. 触るファイル

**新規**
- `src/lib/crypto/`：`recovery-key.ts`、`platform.ts`
- `src/lib/vault/`：`model.ts`、`record.ts`、`local-passkeys.ts`、`gate-machine.ts`、`purpose-copy.ts`、`cascade.ts`、`reconcile.ts`、`activity.ts`、`online.ts`
- `src/lib/store/vault-gate.ts`
- `src/lib/hooks/use-menu-dialog.ts`
- `src/components/vault/`：`vault-record-sync.tsx`、`views/{loading,offline,confirm,passkey,password,recovery,recovered,create-password,create-confirm,create-passkey}.tsx`、`recovery-key-view.tsx`、`use-lock-actions.ts`、`vault-badge.tsx`、`vault-settings.tsx`、`password-dialogs.tsx`、`lock-health.tsx`

**変更**
- 暗号：`src/lib/crypto/vault.ts`、`src/lib/crypto/passkey.ts`
- 同期・データ：`src/lib/vault/actions.ts`、`src/lib/sync/mutations.ts`、`src/lib/sync/apply.ts`、`src/lib/types.ts`、`src/lib/db/meta.ts`、`src/lib/media/attachments.ts`
- フック：`src/lib/hooks/use-decrypted.ts`、`use-search.ts`、`data.ts`
- ダイアログ・画面：`src/components/vault/vault-dialog.tsx`、`passkey-manager.tsx`、`src/components/notes/note-pane.tsx`、`note-list.tsx`、`src/components/editor/note-editor.tsx`、`src/components/search/command-palette.tsx`
- フォルダ：`src/components/folders/folder-tree.tsx`、`folder-picker.tsx`、`rename-dialog.tsx`
- シェル・プロバイダー：`src/components/shell/workspace-shell.tsx`、`app-shell.tsx`、`sidebar.tsx`、`src/components/providers/sync-provider.tsx`
- ページ：`src/app/app/settings/page.tsx`、`src/app/privacy/page.tsx`
- UI 部品：`src/components/ui/dialog.tsx`、`src/components/ui/sheet.tsx`
- 文言：`src/lib/i18n/ja.ts`
- Convex：`convex/schema.ts`、`convex/lib/ops.ts`、`convex/lib/constants.ts`、`convex/vault.ts`、`convex/sync.ts`、`convex/attachments.ts`
- `vault-ui.ts` は削除する。

## 本番データの移行

1. **事前（本番に触るので、オーナーの同意を得てから）**
   - C1、C12、C14 のデプロイ前ごとに `npx convex export --prod --path memoca-backup-YYYYMMDD.zip` を取る（convex-deploy-guard と convex-backup の手順）。
   - 以下の手順は、どれもメモの中身を勝手に復号しない。
2. **C1 のあと**
   - iPhone の PWA で「新しいバージョンがあります」の［更新］を押す（`pwa-prompts.tsx:42-50`）。Mac のタブは再読み込みする。
   - 更新前の古いバンドルで「ロックを設定」が出ても、入力しないよう伝える。
3. **C7 のあと：リカバリーキーを作り直す（最優先）**
   - Mac で、設定の警告から［いますぐ作り直す］を押す。
   - Touch ID かパスワードで本人確認すると、52 文字のキーが表示される。［ファイルに保存］するかパスワード管理に保存し、最後の 4 文字を入力する。
   - ［リカバリーキーを試す］で「このリカバリーキーは使えます。」を確かめる。
   - VK は変わらないので、暗号化し直すものはない。古い `recWrap` はもともと使えなかった。
   - パスワードを覚えていなくても Face ID で進められる。必要なら、続けて「パスワードを忘れた場合」からパスワードを再設定する。
4. **C10 のあと：パスキーを整理する**
   - iPhone と Mac で一度ずつ Face ID / Touch ID で開き、「この端末」の印を付ける。
   - 両方の端末で試しても印が付かない古い登録を削除する。
5. **C13 のあと：フォルダ名**
   - Mac で金庫を開くと、暗号化されていたフォルダ名が平文に戻り、トーストが出る。
   - iPhone でも開いてみる（何度実行しても同じ結果になる）。
   - 読めない名前は健康診断に出るので、［名前を付け直す］で直す。
   - 平文に戻す処理は元に戻せない（決定どおり）。
6. **C17 のあと：途中だったロック**
   - 金庫を開くと、次がまとめて行われる。
     - ロックしたフォルダの中にある平文のメモをロックする。
     - Inbox の旧フラグを外す。
     - 平文の添付を暗号化する。
     - 健康診断を実行する。
   - 設定に「開けないメモ」が出なければ、鍵が失われた経路は通っていなかったということ。
   - 出た場合、選べるのは［ゴミ箱に移動］だけ。自動では削除しない。
   - `lockOrigin` のない旧メモは、フォルダのロックで守られていればフォルダ由来として扱う（これまでと同じ動作）。
7. **ロールバック**
   - サーバー側は追加だけなので、クライアントを戻しても安全です。
   - `vault.status` は最後のコミットまで残します。

## 実装の順番

`main` に push すると、Convex と Vercel が同じビルドでデプロイされます。そのため各コミットは単独で出しても安全です。毎回 `pnpm typecheck && pnpm lint && pnpm test` と、そのコミットに対応する Playwright のスペックを通します。

| # | コミットの件名 | 内容 | 確認すること |
|---|---|---|---|
| C0 | `test: fixtures for vault and lock tests` | `vitest.config.mts` に `@convex` の alias。新規 `tests/helpers/fake-convex.ts`（`getFunctionName` で振り分け、`connectionState` を返す）。新規 `tests/helpers/seed.ts`（`tests/inbox.test.ts` の `seedInbox` を移す。`FAST_ARGON`）。新規 `e2e/webauthn.ts`、`e2e/local-db.ts`、`e2e/vault-helpers.ts`、`e2e/passkey-support.spec.ts`（仮想認証器で UVPAA、作成時の PRF、`evalByCredential` と `eval` が 32 バイトを返すかを調べる） | 既存のテストが緑。調べた結果をコミット本文に書く |
| C1 | `fix(vault): an existing vault is never replaced, and closing the prompt never opens setup` | `prepareVault`。`already` を尊重。`creating = status===null` だけにし、`undefined` なら loading。処理中は閉じられない。リカバリー画面は閉じられない。呼び出し側は `if (!ready) return`。設定は 3 状態 | 報告 3。unit：already／例外／ok。convex：setup を 2 回。E2E：閉じ方 4 通り × 作成画面が出ない |
| C2 | `fix(vault): the recovery key is shown in full and accepted however it is typed` | `recovery-key.ts`、全文表示、入力欄、自己確認 | 表示した文字列で開けること。40 文字は legacy になること |
| C3 | `fix(vault): edits typed just before the vault closes are saved first` | `close(reason)`、`onBeforeClose`、`flushAll`、タイトルのフック、hidden 時の flush | 閉じたあとに、`iv` 付きの update と入力した文字が残っていること |
| C4 | `feat(convex): a vault query that is safe to keep open, and recovery-key bookkeeping` | 表のうち `record`、`setup`、`rewrap`、`markRecoveryChecked`、`addPasskey`。クライアントは作成時に `recoveryFormat:2` と `markRecoveryChecked` を送る | convex-test |
| C5 | `feat(vault): keep the vault record on the device so locked notes open offline` | `record.ts`、`vault-record-sync.tsx`、オフライン画面、アカウント切り替え時の `vault.lock()` | E2E：オフラインでパスワードを使って開ける |
| C6 | `fix(passkey): one Face ID / Touch ID prompt, only this device's passkeys, and Cancel means cancel` | `buildAssertionOptions`、`startPasskey`、エラーのクラス、`passkeyLocal`、`platform.ts` | 報告 2。unit と、仮想認証器で `get()` が 1 回だけのこと |
| C7 | `feat(vault): make a new recovery key, test it, or reset a forgotten password` | `openVaultRaw`、`issueRecoveryWrap`、`verifyRecoveryKey`、`RecoveryKeyView`、設定の警告、再設定、催促 | 移行手順 3 |
| C8 | `feat(vault): the prompt says why it opened` | `gate-machine.ts`、`vault-gate.ts`、目的ごとの文言、各画面、下から出るシート、フォーカス、`use-menu-dialog`、`ja.ts` の用語、「閉じる」 | 報告 1。状態遷移の全行と不変条件 |
| C9 | `feat(vault): first-time setup explains itself and continues what you started` | 作成画面（パスワード、リカバリー、最後の 4 文字）と、元の操作の続行 | E2E：初めてのロックの流れ |
| C10 | `feat(passkey): safe registration and a clear list` | 2〜3 段階の登録、`excludeCredentials`、ランダムな `user.id`、「Memoca の金庫」、`deviceLabel`、「この端末」、削除前の確認、作成後の提案 | 移行手順 4 |
| C11 | `feat(vault): close after inactivity, not N minutes after opening, and show when it is open` | `activity.ts`、期限の管理、`hold`、トースト、`VaultBadge` | 偽タイマーと `page.clock` |
| C12 | `feat(convex): folder locks never seal names; Inbox cannot be locked` | `setFolderLock` の新しい動作 | convex-test（古い引数も通ること） |
| C13 | `feat(folders): folder names stay readable, and names sealed earlier are restored` | 読む側、書く側、`unsealFolderNames`、名前変更の失敗処理、プライバシーの文言 | 移行手順 5 |
| C14 | `feat(convex): record why a note is locked, accept notes created locked, refuse locks that would leave plaintext` | `lockOrigin`、`create.lock`、事前チェック、`reserve` の拒否、`lockAttachments` | convex-test |
| C15 | `feat(lock): confirm, report honestly, and keep notes you locked yourself` | `model.ts`、`cascade.ts`、`use-lock-actions.ts`、`unlockJob`、Inbox の UI、受け継いだロックの表示、バケツリレーの撤去、大きいメモのロック | unit と E2E |
| C16 | `feat(lock): notes written in or moved into a locked folder are encrypted from the start` | 作成時からロック、先にロックしてから移動、未暗号化の帯と編集禁止、`acquireDoc` の catch | 2 つ目のコンテキストで平文がないこと |
| C17 | `fix(lock): repair what earlier versions left behind` | `reconcile.ts`、添付ファイル、`blobs`、健康診断の UI | 移行手順 6 |
| C18 | `feat(search): find locked notes by title while the vault is open` | `use-search.ts` でタイトルをメモリ内で復号する | 検索テストの更新 |
| C19 | `feat(settings): 金庫とロック in one place` | 最終的な並び、確認欄付きのパスワード変更、`htmlFor` | E2E：確認欄の不一致 |
| C20 | `chore(vault): remove what nothing uses any more` | 全端末が更新されたあとで `vault.status`、`pendingLockCascade`、旧形式の名前表示の分岐を消す。`docs/PLAN.md` を更新 | 型チェック |

## 検証

### 単体テスト（vitest、jsdom、`fake-indexeddb`、`FAST_ARGON`）

- **`tests/recovery-key.test.ts`**
  - 表示した文字列から開けること：`prepareVault` → format → parse → 開く、の往復。
  - 小文字、全角、空白、`0/1/8` の置き換え。
  - 40 文字は `legacy`、51 文字と 53 文字は `length`。
  - 4 文字 × 13 組になること。
  - 切り詰める formatter を差し込むと、自己確認で失敗すること。
- **`tests/crypto.test.ts`**
  - `prepareVault` は、`adopt` を呼ぶまで鍵を使い始めないこと。
  - `openVaultRaw` の 3 つの手段。
  - 作り直したあと、新しいキーは使え、古いキーは使えないこと。
  - パスキー（偽の PRF 出力）でパスワードを再設定できること。
- **`tests/gate-machine.test.ts`**
  - 遷移表のすべての行。
  - 閉じ方 4 通り × 全状態。
  - `exists` からどんな順で操作しても create に入らないこと。
- **`tests/vault-gate.test.ts`**
  - 依頼が 1 回だけ解決されること。
  - 新しい依頼が古い依頼を cancelled にすること。
  - 金庫が開いていれば `lockNote` はダイアログなしで解決されること。
- **`tests/passkey.test.ts`**（`navigator.credentials` のモック）
  - `get()` を同期で 1 回だけ呼ぶこと。
  - 分かっている端末のパスキーだけを渡すこと。`["internal"]` と `hints` が付くこと。
  - 1 件なら `eval`、2 件以上なら `evalByCredential`。
  - `NotAllowedError` なら 2 回目を呼ばないこと。
  - 登録時の `excludeCredentials` と `user.name`。
  - 端末名の表：iPhone、iPad（Mac の UA）、Mac、Android、Windows。
- **`tests/vault-session.test.ts`**（偽タイマー）
  - `touch` で期限が延びること。
  - `hold` で閉じるのを待つこと。
  - 時計を飛ばしたあとの `checkDeadline`。
  - フックが鍵のあるうちに実行されること。
- **`tests/close-vault.test.ts`**
  - 閉じる直前の入力が `iv` 付きの update になること。
  - 保留中のタイトルが保存されること。
- **`tests/lock-model.test.ts`**
  - `lockOriginOf` の旧データ扱い。
  - `planFolderUnlock` が、個別にロックしたメモ、入れ子のロック、外側の祖先で守られたメモを残すこと。
  - Inbox の旗を無視すること。
- **`tests/cascade.test.ts`**
  - `unsent` を `settle` のあと再試行すること。
  - 途中で閉じたら `vaultClosed` になること。
  - `compactFirst` で compact すること。
  - 外すときにフラグを先に外し、`unlockJob` から再開できること。
  - `hold` を必ず解放すること。
- **`tests/mutations-lock.test.ts`**
  - 閉じている金庫でロックしたフォルダに作ろうとすると例外になること。
  - 開いていれば、エポック 1 でロックされ、op 1 件に `create.lock` が入り、最初の flush が暗号文になること。
  - `renameFolder` が暗号化しないこと。
- **`tests/reconcile.test.ts`**
  - フォルダ名の移行で平文の op が積まれること。
  - Inbox の旗を外すこと。
  - 別の VK で包まれたメモを「開けない」と数えること。
- **`tests/record.test.ts`**
  - ArrayBuffer が Dexie に保存されること。
  - `none` をキャッシュしないこと。
  - `hasVault` のヒント。
- **`tests/search.test.ts:25-33,86-89`** の更新
  - 金庫が閉じていれば、ロックされたメモは「ロック」で見つからないこと。
  - 開いていれば、本当のタイトルで見つかること。

### convex-test（新規 `convex/vault.test.ts`。`sync.test.ts` の `setup` と `seedUser` を先頭に写す。`convex/` 直下にテスト以外のヘルパーを増やさない）

- **金庫**
  - `setup` を 2 回呼ぶと 2 回目は `already` を返し、`pwWrap` も `version` も変わらないこと。
  - `record`：signedOut、none、exists。ユーザー B からは A の金庫が見えないこと。
  - `rewrap`：`stale` のときは何も書かないこと。正しいときは version が 1 増え、`recoveryFormat=2` になり、`recoveryCheckedAt` が消えること。
  - `markRecoveryChecked`。
- **パスキー**
  - `addPasskey` の重複排除と、10 件での `tooMany`。
  - `removePasskey` で `pwWrap` が残ること。
- **メモのロック**
  - `lockNote` と `unlockNote` で `lockOrigin` を付け外しすること。
  - `compactFirst`／`uploadPending`／`attachmentsNotCovered` のとき、スナップショットも更新も変わらないこと。
  - 既存の拒否理由がすべて返ること。
  - 添付を差し替えたときの `usedBytes`。
- **フォルダのロック**
  - `setFolderLock` が `name`、`nameSealed`、`ts.name` を変えないこと。
  - Inbox を拒否すること。古いスタンプでは何もしないこと。
  - 古いクライアントの外し方で名前が戻ること。
- **追加の関数**
  - `lockAttachments` は、ロック済みのメモでだけ動くこと。
  - `attachments.reserve` の `lockMismatch`。
- **`convex/sync.test.ts` への追加**
  - 平文の名前変更で、旧形式の `nameSealed` が消えること。
  - `create.lock` で作ったメモは、`iv` のない update を拒否し、エポック 1 の暗号文を受け付けること。平文のタイトルと `keyEpoch 0` を拒否すること。
  - 他人の id への `lockNote`／`setFolderLock` が `unknown*` になること。

### E2E（Chromium の desktop と Pixel 7、メールとパスワードでのテスト用ログイン）

**進め方**
- `e2e/helpers.ts` の `signUp`、`openApp`、`createNote`、`folderPanel`、`waitForSynced` を使う。
- ボタンは `/で続ける$/` や `/で開く$/` のような正規表現で探す。

**`vault.spec.ts`**
1. 金庫がない状態でメモの「ロックする」を押す。
   - 見出しが「金庫を作成」になり、「ロックを解除」がどこにも出ないこと。
   - リカバリーキーの画面では Esc が効かないこと。
   - 最後の 4 文字を入力すると「メモをロックしました」が出ること。
2. バッジから［いますぐ閉じる］を押すと、ロックされたメモの表示になること。「パスワードを忘れた場合」に、表示されたキーを小文字と空白入りで入力すると本文が出ること。
3. 金庫が閉じた状態で、Esc、外側（5,5 の位置）、キャンセル、× のどれで閉じても、作成画面が出ず、メモも変わらないこと。
4. 2 つ目のコンテキストでは作成画面が一度も出ないこと。

**`lock.spec.ts`**
1. メモ 3 件とサブフォルダ内のメモ 1 件があるフォルダで、確認画面に「メモ 4 件」と出ること。ロック後、サイドバーに本当の名前が出て、`readNotes` で `title===null`、`hasTitleSealed`、`text===null` になっていること。
2. フォルダのロックを外しても、個別にロックしたメモは残ること。
3. ロックしたフォルダに金庫を閉じたまま新規作成すると、目的のダイアログが出て、作られたメモが `locked`、`keyEpoch 1` になっていること。2 つ目のコンテキストで、全 update に `iv` があること。
4. 受け継いだロックのメニュー項目が押せないこと。Inbox のメニューに項目がないこと。

**`lock-offline.spec.ts`**
- `setOffline(true)` で、ロックがボタンを押せない状態と文言になること（くるくるが出続けないこと）。
- パスワードで開けること。

**`passkey.spec.ts`**（desktop。C0 の結果で動かせないときは `test.skip`）
- CDP で `WebAuthn.addVirtualAuthenticator` を使う（`ctap2`、`transport:"internal"`、`hasResidentKey`、`hasUserVerification`、`isUserVerified`、`hasPrf:true`）。
- init script で `get()` の呼び出し回数を記録する。
1. 登録すると「この端末」と表示されること。
2. 閉じて `/で開く$/` を押すと、`get()` が 1 回だけで、`transports` と `hints` が正しいこと。
3. `setUserVerified(false)` のとき、呼び出しが 1 回でボタンの画面に戻ること。
4. もう一度登録すると「すでに使えます」になること。

**`auto-lock.spec.ts`**（`goto` の前に `page.clock.install()`）
1. 1 分の設定で、50 秒 → 入力 → 50 秒たっても開いたままであること。
2. 70 秒たつと閉じてトーストが出ること。開き直すと入力した文字が残っていること。
3. hidden の状態で時間を進め、visible に戻すと閉じること。

### 実機での確認（自動化できないもの）

**iPhone（ホーム画面の PWA）**
- ［Face ID / Touch ID で開く］と、⋯ メニューからの自動起動のどちらでも、シートが 1 回だけ出て、QR コードや選択画面が出ないこと。
- キャンセルするとボタンの画面に戻ること。
- 移行前に Face ID で登録したパスキーで、初回に全件を渡した場合も選択画面が出ないこと。
- メニューの `onSelect` と、確認のあとのボタンから呼んだ `get()` で、ユーザー操作の判定が保たれていること。
- 登録時に PRF が返るか。3 段階目が必要か。「Memoca の金庫」がどう表示されるか。2 回目の登録で `excludeCredentials` が `InvalidStateError` になるか。
- `evalByCredential` の対応状況（対応していなければ `PasskeyNeedsRetryError` の経路で進むこと）。iOS と macOS が 18 以上であること。
- 下から出るシートがキーボードに隠れないこと。
- ［ファイルに保存］で共有シートが出ること。
- バックグラウンドから戻ったときに期限の確認が動くこと。アプリ切り替え画面の見え方。
- オフラインで再起動しても開けること。

**Mac の Safari と Chrome**
- iPhone で登録した iCloud 同期のパスキーで、QR コードなしに Touch ID で開けること。
- Chrome の Google パスワードマネージャーでの動き（記録する）。
- 新しい Service Worker に更新されたあとで、リカバリーキーを作り直すこと。
