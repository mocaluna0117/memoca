# Memoca

Notion 風のブロックエディタを備えた、ローカルファーストのメモ PWA。

Web ブラウザと、ホーム画面に追加した iOS / Android の PWA で同じメモを扱えます。
オフラインでも読み書きでき、オンラインに戻ると自動で同期します。

## 主な機能

| 機能 | 概要 |
| --- | --- |
| フォルダ | 無制限の階層。ドラッグ&ドロップで並べ替え・移動 |
| ブロックエディタ | 見出し・リスト・チェックリスト・トグル・コード・引用・表・数式・図など |
| 画像 / 動画 | 画像は端末側で WebP に圧縮。動画はアップロードと URL 埋め込みの両対応 |
| 即席メモ | Inbox にワンタップで書き捨て、後から整理 |
| ロック | 端末側で暗号化する E2EE。パスワード / Face ID・Touch ID / リカバリーキーで解除 |
| ゴミ箱 | ソフト削除と復元。保持期間を過ぎたものは自動で完全削除 |
| 検索 | フォルダ名・メモ名に加えて本文も検索。日本語の表記ゆれを吸収 |
| 同期 | 複数端末でリアルタイム同期。オフライン中の編集も競合せずマージ |

## 技術スタック

- **フロントエンド**: Next.js 16（App Router / Turbopack）, React 19, TypeScript, Tailwind CSS v4, shadcn/ui
- **エディタ**: BlockNote + Yjs（CRDT）
- **バックエンド**: Convex（データベース / ファイル / リアルタイム / cron）
- **認証**: Better Auth on Convex（Google ログイン）
- **ローカル保存**: Dexie（IndexedDB）
- **PWA**: Serwist
- **暗号**: WebCrypto（AES-256-GCM / HKDF）, Argon2id（hash-wasm）, WebAuthn PRF

詳しい設計と実装計画は [docs/PLAN.md](docs/PLAN.md) にあります。

## 開発

```bash
pnpm install
pnpm dev:convex   # 別ターミナルで。初回はブラウザで Convex にログイン
pnpm dev          # http://localhost:3000
```

| コマンド | 内容 |
| --- | --- |
| `pnpm dev` | 開発サーバー |
| `pnpm dev:convex` | Convex 開発デプロイの監視 |
| `pnpm build` | 本番ビルド |
| `pnpm typecheck` | 型チェック |
| `pnpm lint` | ESLint |
| `pnpm test` | 単体テスト（Vitest） |
| `pnpm e2e` | E2E テスト（Playwright） |
| `pnpm format` | Prettier |

必要な環境変数は [.env.example](.env.example) を参照してください。

## ライセンス

[MIT](LICENSE)
