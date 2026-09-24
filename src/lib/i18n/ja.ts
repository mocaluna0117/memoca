/**
 * All user-facing copy in one place. Keeping it out of the components makes a
 * second language a matter of adding a file, not editing every screen.
 */
export const ja = {
  app: {
    name: "Memoca",
    tagline: "書いて、しまって、どこでも開く。",
    description:
      "フォルダで整理でき、画像や動画も貼れて、鍵をかけたメモは端末の中だけで復号されるメモ帳です。",
  },
  nav: {
    home: "ホーム",
    search: "検索",
    quick: "即席メモ",
    settings: "設定",
    trash: "ゴミ箱",
    inbox: "Inbox",
    admin: "管理",
    allNotes: "すべてのメモ",
    folders: "フォルダ",
  },
  action: {
    newNote: "新しいメモ",
    // Not "新しいフォルダ": that is also the name a fresh folder is given, so the
    // button and the folder it creates read identically.
    addFolder: "フォルダを追加",
    rename: "名前を変更",
    move: "移動",
    delete: "削除",
    restore: "復元",
    deleteForever: "完全に削除",
    emptyTrash: "ゴミ箱を空にする",
    pin: "ピン留め",
    unpin: "ピン留めを外す",
    lock: "ロックする",
    unlock: "ロックを解除",
    cancel: "キャンセル",
    save: "保存",
    close: "閉じる",
    signIn: "Google でログイン",
    signOut: "ログアウト",
    retry: "再試行",
    copy: "コピー",
    copied: "コピーしました",
  },
  sync: {
    idle: "同期済み",
    syncing: "同期中",
    offline: "オフライン",
    error: "同期エラー",
    pending: (n: number) => `未送信 ${n} 件`,
    catchingUp: "読み込み中",
  },
  empty: {
    noNotes: "まだメモがありません",
    noNotesHint: "右下のボタンから最初のメモを作りましょう。",
    noResults: "見つかりませんでした",
    trashEmpty: "ゴミ箱は空です",
    lockedNote: "ロック中のメモ",
    lockedHint: "解除すると内容を表示できます。",
  },
  vault: {
    title: "ロック",
    setupTitle: "ロックを設定",
    password: "金庫パスワード",
    passwordAgain: "もう一度入力",
    unlock: "ロックを解除",
    lockNow: "いますぐロック",
    biometric: "Face ID / Touch ID で解除",
    recoveryKey: "リカバリーキー",
    wrongPassword: "パスワードが違います。",
    locked: "ロックされています",
  },
  quota: {
    used: (used: string, total: string) => `${used} / ${total} 使用中`,
    exceeded: "保存できる容量を超えました。不要なメモや画像を削除してください。",
  },
} as const;

export type Copy = typeof ja;
export const t = ja;
