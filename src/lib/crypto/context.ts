/**
 * Every AES-GCM operation names what it protects. Keeping the strings in one
 * place makes it obvious that no two kinds of ciphertext share a context, which
 * is what stops an attacker moving a blob from one slot to another.
 */
export const ctx = {
  /** Wrapping a per-note data key with the vault key. */
  noteKeyWrap: (noteId: string, epoch: number) => `wrap:note:v1:${noteId}:${epoch}`,
  /** Wrapping a per-attachment data key with the vault key. */
  attachmentKeyWrap: (attachmentId: string) => `wrap:att:v1:${attachmentId}`,
  /** Wrapping the vault key itself. */
  vaultWrap: (method: "password" | "recovery" | "passkey") => `wrap:vault:v1:${method}`,

  yjsUpdate: (noteId: string, epoch: number) => `yupd:v1:${noteId}:${epoch}`,
  yjsSnapshot: (noteId: string, epoch: number) => `ysnap:v1:${noteId}:${epoch}`,
  noteTitle: (noteId: string, epoch: number) => `title:v1:${noteId}:${epoch}`,
  folderName: (folderId: string) => `folder:v1:${folderId}`,
  attachmentBody: (attachmentId: string) => `att:v1:${attachmentId}`,
  attachmentMeta: (attachmentId: string) => `attmeta:v1:${attachmentId}`,
} as const;

export const HKDF_INFO = {
  passkey: "memoca-kek-passkey-v1",
  recovery: "memoca-kek-recovery-v1",
} as const;
