export type Stamp = { t: number; d: string };
export type Sealed = { ct: ArrayBuffer; iv: ArrayBuffer };

export type FolderStamps = {
  name: Stamp;
  place: Stamp;
  trash: Stamp;
  lock: Stamp;
};

export type NoteStamps = {
  title: Stamp;
  /** Absent on rows written before the preview had its own stamp. */
  preview?: Stamp;
  place: Stamp;
  pin: Stamp;
  /** Its place among the pinned (pinKey): absent until it is given one. */
  pinPlace?: Stamp;
  trash: Stamp;
  lock: Stamp;
};

export type Folder = {
  folderId: string;
  parentId: string | null;
  name: string | null;
  nameSealed?: Sealed;
  icon: string | null;
  sortKey: string;
  locked: boolean;
  /** Inbox, or the folder of templates (see lib/templates); null for any other. */
  system: "inbox" | "templates" | "journal" | null;
  deletedAt: number | null;
  purged: boolean;
  ts: FolderStamps;
  seq: number;
};

export type Note = {
  noteId: string;
  folderId: string | null;
  kind: "note" | "quick";
  title: string | null;
  titleSealed?: Sealed;
  preview: string | null;
  pinned: boolean;
  /**
   * Where it is among the pinned notes, in every list, as placed by hand: a
   * sort key, on a stamp of its own (ts.pinPlace). Missing on notes pinned
   * before this was kept. Kept, unused, once unpinned.
   */
  pinKey?: string;
  sortKey: string;
  locked: boolean;
  keyEpoch: number;
  wrappedKey?: Sealed;
  /**
   * Why it is locked: by hand ("note") or as part of a locked folder
   * ("folder"). Missing on notes locked before this was recorded.
   */
  lockOrigin?: "note" | "folder";
  deletedAt: number | null;
  purged: boolean;
  lastUpdateSeq: number;
  snapshotSeq: number;
  /**
   * The `lastUpdateSeq` the server's record of the files this note uses is
   * based on. Behind `lastUpdateSeq` (or missing) means a device should report
   * them again.
   */
  refsThroughSeq?: number;
  ts: NoteStamps;
  seq: number;
  updatedAt: number;
};

export type Attachment = {
  attachmentId: string;
  noteId: string;
  status: "reserved" | "committed" | "orphan";
  bytes: number;
  mime: string | null;
  name: string | null;
  metaSealed?: Sealed;
  locked: boolean;
  wrappedKey?: Sealed;
  contentIv?: ArrayBuffer;
  width: number | null;
  height: number | null;
  deletedAt: number | null;
  seq: number;
};

/** A tree node for the sidebar, with children resolved. */
export type FolderNode = Folder & {
  children: FolderNode[];
  depth: number;
  /** True when this folder or any ancestor is locked. */
  inLockedTree: boolean;
};
