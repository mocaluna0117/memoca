# Memoca

Notion 風のブロックエディタを備えた、ローカルファーストのメモ PWA。

Web ブラウザと、ホーム画面に追加した iOS / Android の PWA で同じメモを扱えます。
オフラインでも読み書きでき、オンラインに戻ると自動で同期します。

## 主な機能

| 機能 | 概要 |
| --- | --- |
| フォルダ | 無制限の階層。パソコンではドラッグ&ドロップ、スマートフォンではメニューから移動 |
| ブロックエディタ | 見出し・リスト・チェックリスト・トグル・コード・引用・表・数式・図など |
| 画像 / 動画 | 画像は端末側で WebP に圧縮。動画はアップロードと URL 埋め込みの両対応 |
| 即席メモ | Inbox にワンタップで書き捨て、後から整理 |
| ロック | 端末側で暗号化する E2EE。パスワード / Face ID・Touch ID / リカバリーキーで解除 |
| ゴミ箱 | ソフト削除と復元。保持期間を過ぎたものは自動で完全削除 |
| 検索 | フォルダ名・メモ名に加えて本文も検索。ひらがな/カタカナ/半角カナの違いを吸収。⌘K でも開く |
| 同期 | 複数端末でリアルタイム同期。オフライン中の編集も競合せずマージ |

## 技術スタック

- **フロントエンド**: Next.js 16（App Router / Turbopack）, React 19, TypeScript, Tailwind CSS v4, shadcn/ui
- **エディタ**: BlockNote + Yjs（CRDT）
- **バックエンド**: Convex（データベース / ファイル / リアルタイム / cron）
- **認証**: Better Auth on Convex（Google ログイン）
- **ローカル保存**: Dexie（IndexedDB）
- **PWA**: Serwist
- **暗号**: WebCrypto（AES-256-GCM / HKDF）, Argon2id（hash-wasm）, WebAuthn PRF

詳しい設計と実装計画は [docs/PLAN.md](docs/PLAN.md)、公開の手順は [docs/DEPLOY.md](docs/DEPLOY.md) にあります。

## 実装の状況

動作を確認済みのもの。

- フォルダの作成・改名・入れ子・移動（パソコンはドラッグ&ドロップ）
- ブロックエディタ（Markdown ショートカット、日本語 UI、スマートフォン用のブロック操作バー）
- 画像の自動圧縮つきアップロード（512px の PNG 78KB が WebP 約 5KB に）
- 即席メモ（共有パラメータからの取り込みを含む）
- ロック（金庫の作成、リカバリーキーの提示、メモのロック、再読み込み後の解除）
- ゴミ箱への移動と復元、完全削除
- 本文を含む検索、⌘K のコマンドパレット
- オフラインでの作成・編集と、復帰後に別端末へ届くこと
- 登録上限、招待コード、1 人あたりの容量

まだ入っていないもの。

- 漢字を読みで引く検索（「薬局」を「やっきょく」で探す）。
  表記ゆれ（ひらがな/カタカナ/半角カナ/全角英数）は吸収しますが、
  読み仮名での検索には形態素解析辞書が必要なため見送っています。
- 生体認証（Face ID / Touch ID）でのロック解除は実装済みですが、
  実機での確認がまだです。パスワードとリカバリーキーでの解除は確認済みです。
- 他の人とのメモの共有・共同編集。
- iOS の共有シートからの直接取り込み（iOS が Web の共有先に対応していないため、
  設定画面にショートカットアプリを使う方法を載せています）。

## 開発

```bash
pnpm install

# Convex をこのパソコンの中だけで動かします（アカウント登録は不要）
CONVEX_AGENT_MODE=anonymous pnpm dev:convex

# 別のターミナルで
pnpm dev          # http://localhost:3000
```

初回だけ、ローカルの Convex に設定を入れます。

```bash
npx convex env set BETTER_AUTH_SECRET "$(openssl rand -base64 32)"
npx convex env set SITE_URL http://localhost:3000
npx convex env set ALLOW_PASSWORD_AUTH true   # ローカルとテストのログイン用
npx convex env set MAX_USERS 100000           # テストが作るアカウント用
```

`ALLOW_PASSWORD_AUTH` はメールとパスワードでのログインを有効にします。
Google ログインの設定なしで開発と自動テストを回すためのもので、本番では設定しません。

| コマンド | 内容 |
| --- | --- |
| `pnpm dev` | 開発サーバー |
| `pnpm dev:convex` | Convex 開発デプロイの監視 |
| `pnpm build` | 本番ビルド |
| `pnpm typecheck` | 型チェック |
| `pnpm lint` | ESLint |
| `pnpm test` | 単体テスト（Vitest） |
| `pnpm e2e` | E2E テスト（Playwright。Convex と開発サーバーを起動しておく） |
| `pnpm format` | Prettier |

必要な環境変数は [.env.example](.env.example) を参照してください。

## ライセンス

[MIT](LICENSE)
