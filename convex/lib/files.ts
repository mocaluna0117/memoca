/**
 * What a deleted file's row becomes: a tombstone, kept so every device learns
 * the file is gone and lets go of its own copy. Nothing about the file is
 * kept with it, its name included; `bytes` stays, for the record.
 */
export function fileTombstone(now: number, seq: number) {
  return {
    storageId: null,
    unreferencedAt: null,
    deletedAt: now,
    name: null,
    mime: null,
    width: null,
    height: null,
    metaSealed: undefined,
    wrappedKey: undefined,
    contentIv: undefined,
    seq,
  };
}
