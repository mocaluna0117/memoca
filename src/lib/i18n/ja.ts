/**
 * All user-facing copy in one place. Keeping it out of the components makes a
 * second language a matter of adding a file, not editing every screen.
 */
export const ja = {
  app: {
    name: "Memoca",
    tagline: "書いて、しまって、どこでも開く。",
    description:
      "フォルダで整理でき、画像や動画も貼れて、ロックしたメモは端末の中だけで読めるメモ帳です。",
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
    // Two different acts, and never the same words: 「ロックを外す」 takes the
    // lock off an item for good, while opening the vault only lets this tab
    // read locked items for a while (金庫を開く).
    lock: "ロックする",
    unlock: "ロックを外す…",
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
    lockedNote: "ロックされたメモ",
    lockedHint: "金庫を開くと読めます。",
  },
  vault: {
    title: "金庫とロック",
    setupTitle: "金庫を作成",
    password: "金庫のパスワード",
    passwordAgain: "確認のためもう一度入力",
    open: "金庫を開く",
    closeNow: "いますぐ閉じる",
    recoveryKey: "リカバリーキー",
    wrongPassword: "パスワードが違います。",
    isOpen: "金庫：開いています",
    isClosed: "金庫：閉じています",
  },
  storage: {
    title: "内訳",
    asOf: (time: string) => `${time} 時点`,
    refresh: "更新",
    loading: "内訳を調べています…",
    offline: "オフラインのため、内訳を表示できません。インターネットに接続すると表示されます。",
    failed: "内訳を読み込めませんでした。もう一度お試しください。",
    signedOut: "内訳を読み込めませんでした。ログインし直してから、もう一度お試しください。",
    images: "画像",
    videos: "動画",
    lockedFiles: "ロックされたファイル",
    otherFiles: "その他のファイル",
    text: "メモの本文",
    trash: "ゴミ箱",
    unused: "使われなくなったファイル",
    unusedDetail: (count: number, date: string) => `${count} 件。${date}以降、順に自動で削除されます`,
    unusedSoon: (count: number) => `${count} 件。まもなく自動で削除されます`,
    uploading: "送信中",
    uncounted: "内訳に含まれない分",
    free: "空き",
    mismatch: (kept: string, counted: string) =>
      `管理者向け：記録上の使用量（${kept}）と、メモとファイルを数え直した合計（${counted}）が合いません。npx convex run --prod admin:recomputeUsage で数え直せます。`,
    truncated: "ファイルやメモが多いため、一部だけを数えています。",
    largest: "大きいファイル",
    lockedFile: "ロックされたファイル",
    noName: "名前のないファイル",
    inTrash: "ゴミ箱の中",
    notUsed: "どのメモにも使われていません",
    notHere: "この端末にないメモ",
    untitled: "無題のメモ",
  },
  quota: {
    used: (used: string, total: string) => `${used} / ${total} 使用中`,
    exceeded: "保存できる容量を超えました。不要なメモや画像を削除してください。",
    imageTooLarge: (limit: string) => `画像が大きすぎて追加できません（1 枚 ${limit} まで）。`,
    videoTooLarge: (limit: string) => `動画が大きすぎて追加できません（1 本 ${limit} まで）。`,
    fileTooLarge: (limit: string) => `ファイルが大きすぎて追加できません（1 つ ${limit} まで）。`,
    heicUnreadable:
      "HEIC 形式の画像は、このブラウザでは読み込めません。JPEG か PNG にするか、iPhone や Mac の Safari から追加してください。",
    unsupportedImage:
      "この形式の画像は追加できません。JPEG・PNG・WebP・GIF のいずれかにしてから、もう一度お試しください。",
    unsupportedFile: "この種類のファイルは追加できません。追加できるのは画像と動画（MP4・MOV・WebM）です。",
  },
} as const;

export type Copy = typeof ja;
export const t = ja;
