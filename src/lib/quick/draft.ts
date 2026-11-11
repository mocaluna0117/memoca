"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { uuidv7 } from "uuidv7";
import { db, getMeta, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
import { copiedBlob } from "@/lib/media/blob-copy";
import { quickLines } from "@/lib/quick/text";
import { QUICK_TAB_PREFIX, TODO_TAB_ID, isQuickTab } from "@/lib/quick/todo-id";
import { setNoteTrashed } from "@/lib/sync/mutations";

/**
 * A text as it is compared where there is no body to tell by: its lines
 * with text, as the text read back from a body has them (it leaves out
 * blank lines). A tab saved before the quick note had an editor, with a
 * blank line in it, is then still saved once read back as a body.
 */
const plain = (text: string) =>
  quickLines(text)
    .filter((line) => line.trim() !== "")
    .join("\n");

/**
 * What was being written in one of the quick note's tabs, kept on this device
 * until it is saved, with the account it was written in: another account
 * signed in on the same device is never shown it.
 */
export type QuickDraft = {
  /** Its text, a line per block: for its tab's name, and to tell it is empty. */
  text: string;
  /**
   * What it holds, lists, toggles and marks with it: its editor's document,
   * as one Yjs update. Missing on drafts from before the quick note had an
   * editor, which held the text alone.
   */
  body?: Uint8Array;
  /** What its body says, to tell it changed since it was saved (lib/quick/body quickKey). */
  key?: string;
  /** The images added to it, made ready (compressed) already. Missing on drafts from before. */
  images?: DraftImage[];
  updatedAt: number;
  userKey: string;
  /** What it was last saved as, if it has been: saved again, that note is written over. */
  saved?: SavedAs;
};

/** The note a tab was saved as, and what it held then. */
export type SavedAs = {
  noteId: string;
  text: string;
  /** What its body said then; missing on what was saved before the quick note had an editor. */
  key?: string;
  /**
   * The folder it was saved into, as chosen then: saved again into another
   * chosen since, the note goes there too. Missing on what was saved before
   * a folder could be chosen.
   */
  folderId?: string | null;
  /** Its images, by their keys. */
  images: string[];
};

/** An image added to the quick note, as it will be stored. */
export type DraftImage = {
  /** Which one it is, among those of the draft. */
  key: string;
  name: string;
  blob: Blob;
  mime: string;
  width: number;
  height: number;
  /** Where it went up, once the tab was saved: saved again, it is not sent twice. */
  ref?: string;
};

/**
 * Whether a tab holds something not saved: written since it was last saved
 * (or never saved). An empty one holds nothing.
 */
export function unsaved(tab: {
  text: string;
  /** What its body says (lib/quick/body quickKey): a list made of a line is a change its text does not show. */
  key?: string;
  images: readonly { key: string }[];
  saved?: SavedAs | null;
}): boolean {
  if (tab.text.trim() === "" && tab.images.length === 0) return false;
  const { saved } = tab;
  if (!saved) return true;
  const same =
    tab.key !== undefined && saved.key !== undefined
      ? saved.key === tab.key
      : plain(saved.text) === plain(tab.text);
  return (
    !same ||
    saved.images.length !== tab.images.length ||
    tab.images.some((image, index) => saved.images[index] !== image.key)
  );
}

/** What a tab holds of text: its text, and (from its editor) its body and what that says. */
export type DraftContent = { text: string; body?: Uint8Array; key?: string };

/** How long typing has to pause before the draft is written. */
export const DRAFT_DELAY_MS = 300;

/** Where a tab's draft is kept. */
const draftKey = (tabId: string) => `${META.quickDraft}:${tabId}`;

/** The draft as stored, its images' files as read from the device (see {@link loadDraft}). */
async function readDraft(userKey: string, tabId: string): Promise<QuickDraft | null> {
  const draft = await getMeta<QuickDraft | null>(draftKey(tabId), null);
  return draft && draft.userKey === userKey ? draft : null;
}

/**
 * The draft this account left in a tab on this device, if any: its images'
 * files as copies in memory. Read from the device, a file's blob points at
 * what is stored there, and WebKit loses the file when a row is written
 * again with such a blob after the app has started anew (lib/media/blob-copy),
 * which the draft is, as it is read and as it is typed in: an image added to
 * the quick note was gone once the desktop app had been restarted.
 */
export async function loadDraft(userKey: string, tabId: string): Promise<QuickDraft | null> {
  const draft = await readDraft(userKey, tabId);
  if (!draft?.images?.length) return draft;
  const images = await Promise.all(
    draft.images.map(async (image) => ({ ...image, blob: await copiedBlob(image.blob) })),
  );
  return { ...draft, images };
}

/**
 * Forgets this account's draft in a tab. One of another account's, left on
 * the device when it signed in, is not this one's to forget: an empty field
 * there says nothing about it.
 */
export function clearDraft(userKey: string, tabId: string): Promise<void> {
  const database = db();
  return database.transaction("rw", database.meta, async () => {
    const draft = await getMeta<Partial<QuickDraft> | null>(draftKey(tabId), null);
    if (draft && draft.userKey !== userKey) return;
    await database.meta.delete(draftKey(tabId));
  });
}

/**
 * Writes a tab's draft, what it was saved as kept with it; or forgets it
 * once there is nothing in it.
 */
async function writeDraft(
  content: DraftContent,
  images: DraftImage[],
  userKey: string,
  tabId: string,
): Promise<void> {
  if (content.text.trim() === "" && images.length === 0) return clearDraft(userKey, tabId);
  // Only what it was saved as is wanted of it: not its images, copied.
  const kept = await readDraft(userKey, tabId);
  await setMeta(draftKey(tabId), {
    ...contentOf(content),
    images,
    updatedAt: Date.now(),
    userKey,
    ...(kept?.saved ? { saved: kept.saved } : {}),
  } satisfies QuickDraft);
}

/** A draft's text, and its body and what that says where it has them. */
const contentOf = ({ text, body, key }: DraftContent) => ({
  text,
  ...(body ? { body } : {}),
  ...(key !== undefined ? { key } : {}),
});

/** A tab saved as a note: what it held then, kept as its draft, and the note it went into. */
export function markSaved(
  userKey: string,
  tabId: string,
  noteId: string,
  content: string | DraftContent,
  images: DraftImage[],
  folderId?: string | null,
): Promise<void> {
  const held = typeof content === "string" ? { text: content } : content;
  return setMeta(draftKey(tabId), {
    ...contentOf(held),
    images,
    updatedAt: Date.now(),
    userKey,
    saved: {
      noteId,
      text: held.text,
      ...(held.key !== undefined ? { key: held.key } : {}),
      ...(folderId !== undefined ? { folderId } : {}),
      images: images.map((image) => image.key),
    },
  } satisfies QuickDraft);
}

/**
 * Keeps a tab's draft as it is typed: written once typing pauses,
 * and at once when the page goes out of sight or away, which on a phone can
 * be the last the page ever runs; then whatever the field holds is written,
 * even what another window wrote over meanwhile.
 *
 * Nothing is written until {@link release}: until the draft already on the
 * device has been read and offered, writing would put it out of reach.
 */
export function keepDraft(
  userKey: string,
  tabId: string,
): {
  /**
   * What it holds now: its text, or (from its editor) its text, body and
   * what that says, or how to read them, read only as it is written (not on
   * every key).
   */
  update(content: string | DraftContent | (() => DraftContent)): void;
  /** The images added, as they now are. */
  images(images: DraftImage[]): void;
  /** The draft on the device has been read: writing may start. */
  release(): void;
  /** Writes what the field holds now; `always`, even if it was written already. */
  flush(always?: boolean): Promise<void>;
  /** The field's text has been saved as a note: it is not a draft any more. */
  cancel(): void;
  dispose(): void;
} {
  let held = true;
  /** What it holds, as last told, or how to read it; null once it has been saved. */
  let latest: DraftContent | (() => DraftContent) | null = null;
  const read = (told: DraftContent | (() => DraftContent)) =>
    typeof told === "function" ? told() : told;
  /** The images, as last told. */
  let pictures: DraftImage[] = [];
  /** What this window last wrote. */
  let written: DraftContent | null = null;
  let writtenPictures: DraftImage[] = [];
  const same = (a: DraftContent | null, b: DraftContent | null) =>
    a !== null && b !== null && a.text === b.text && a.key === b.key;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const flush = async (always = false) => {
    stop();
    if (held || latest === null) return;
    const content = read(latest);
    if (!always && same(content, written) && pictures === writtenPictures) return;
    written = content;
    writtenPictures = pictures;
    await writeDraft(content, pictures, userKey, tabId);
  };
  const schedule = () => {
    stop();
    if (!held) timer = setTimeout(() => void flush(), DRAFT_DELAY_MS);
  };
  const onHidden = () => {
    if (document.visibilityState === "hidden") void flush(true);
  };
  const onLeave = () => void flush(true);
  document.addEventListener("visibilitychange", onHidden);
  window.addEventListener("pagehide", onLeave);
  return {
    update(content) {
      latest = typeof content === "string" ? { text: content } : content;
      schedule();
    },
    images(images) {
      pictures = images;
      // Images alone are a draft too.
      latest ??= { text: "" };
      schedule();
    },
    release() {
      held = false;
      if (latest !== null && (!same(read(latest), written) || pictures !== writtenPictures)) schedule();
    },
    flush,
    cancel() {
      stop();
      latest = null;
      written = null;
      pictures = [];
      writtenPictures = [];
    },
    dispose() {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onLeave);
      void flush(true);
    },
  };
}

/* ------------------------------------------------------------------- tabs */

/** The quick note's tabs on this device, for one account: in their order, and the one shown. */
export type QuickTabs = {
  userKey: string;
  ids: string[];
  active: string;
  /**
   * The empty tab made for this device as it had none (not one opened by
   * +): out of sight, while it is empty, where the account has tabs of its
   * own, so that a device signed in anew shows those, not an empty one.
   */
  fresh?: string;
};

/** The most tabs the quick note keeps open. */
export const MAX_TABS = 20;

/** Where an account's tabs are kept: each its own, another's never written over. */
const tabsKey = (userKey: string) => `${META.quickTabs}:${userKey}`;

/**
 * A new tab's id, the id of its note too (see lib/quick/tabs): made as the
 * tab is first shown, synced as any note is, so that every device of the
 * account has it.
 */
export const newTabId = () => `${QUICK_TAB_PREFIX}${uuidv7()}`;

/** When a tab was made: its id is a v7 UUID, which begins with the time. */
function tabMadeAt(tabId: string): number {
  const hex = tabId.slice(QUICK_TAB_PREFIX.length).replace(/-/g, "").slice(0, 12);
  const at = Number.parseInt(hex, 16);
  return Number.isFinite(at) ? at : 0;
}

/** How long a tab just made may have no note yet (written as it is first shown): one older with none is long gone. */
const NOTE_MADE_WITHIN_MS = 10 * 60 * 1000;

/**
 * This device's tabs closed elsewhere: their notes in the trash, or, made
 * long ago, nowhere on this device (purged from the trash, and the row
 * with it). Kept, they counted against MAX_TABS (+ doing nothing at all),
 * and one purged came back as an empty tab whose note the server no
 * longer takes.
 */
export function goneTabs(
  ids: readonly string[],
  notes: readonly { noteId: string; deletedAt: number | null; purged?: boolean }[],
  now: number,
): string[] {
  const rows = new Map(notes.map((note) => [note.noteId, note]));
  return ids.filter((id) => {
    if (!isQuickTab(id)) return false;
    const note = rows.get(id);
    if (note) return note.purged === true || note.deletedAt !== null;
    return now - tabMadeAt(id) > NOTE_MADE_WITHIN_MS;
  });
}

/**
 * Whether the tab shown here is the empty one made for this device, out of
 * sight while the account has tabs with something in them (as
 * useQuickTabs hides it): nothing put into it would be seen.
 */
export async function shownIsHidden(tabs: QuickTabs, text: string): Promise<boolean> {
  if (!tabs.fresh || tabs.active !== tabs.fresh || text.trim() !== "") return false;
  const others = await db()
    .notes.where("noteId")
    .startsWith(QUICK_TAB_PREFIX)
    .filter((note) => note.noteId !== tabs.fresh && !note.purged && note.deletedAt === null && (note.preview ?? "").trim() !== "")
    .count();
  return others > 0;
}

/** Tabs closed elsewhere taken out of this device's: another shown in place of the one shown, if it went. */
export function forgetTabs(userKey: string, gone: readonly string[]): Promise<QuickTabs> {
  return changeTabs(userKey, (tabs) => {
    if (!gone.some((id) => tabs.ids.includes(id))) return tabs;
    const ids = tabs.ids.filter((id) => !gone.includes(id));
    if (ids.length === 0) return fresh(userKey);
    return {
      ...tabs,
      ids,
      active: ids.includes(tabs.active) ? tabs.active : ids.at(-1)!,
      fresh: tabs.fresh && ids.includes(tabs.fresh) ? tabs.fresh : undefined,
    };
  });
}

/** One empty tab, the one shown. */
const fresh = (userKey: string): QuickTabs => {
  const id = newTabId();
  return { userKey, ids: [id], active: id, fresh: id };
};

/**
 * Changes this account's tabs, as they are when it is changed: one change at
 * a time, from whichever window. None yet (or none left): one empty tab.
 */
function changeTabs(userKey: string, change: (tabs: QuickTabs) => QuickTabs): Promise<QuickTabs> {
  const database = db();
  return database.transaction("rw", database.meta, async () => {
    const kept = await getMeta<QuickTabs | null>(tabsKey(userKey), null);
    const now = kept && kept.userKey === userKey && kept.ids.length > 0 ? kept : fresh(userKey);
    const next = change(now);
    if (next !== kept) await setMeta(tabsKey(userKey), next);
    return next;
  });
}

/**
 * This account's tabs, one made if it has none. A draft left by a version
 * with no tabs (one, under META.quickDraft itself) becomes the first tab's.
 */
export function loadTabs(userKey: string): Promise<QuickTabs> {
  const database = db();
  return database.transaction("rw", database.meta, async () => {
    const tabs = await changeTabs(userKey, (tabs) => tabs);
    const old = await getMeta<QuickDraft | null>(META.quickDraft, null);
    if (old && old.userKey === userKey) {
      const into = tabs.ids[0]!;
      const there = await getMeta<QuickDraft | null>(draftKey(into), null);
      // Into the first tab, if it is empty; a tab of its own otherwise.
      if (there) {
        const id = uuidv7();
        await setMeta(draftKey(id), old);
        tabs.ids.push(id);
        await setMeta(tabsKey(userKey), tabs);
      } else {
        await setMeta(draftKey(into), old);
      }
      await database.meta.delete(META.quickDraft);
    }
    return tabs;
  });
}

/** A new, empty tab, after the others, shown; none past {@link MAX_TABS}. */
export async function openTab(userKey: string): Promise<string | null> {
  let made: string | null = null;
  await changeTabs(userKey, (tabs) => {
    if (tabs.ids.filter((id) => id !== TODO_TAB_ID).length >= MAX_TABS) return tabs;
    made = newTabId();
    return { ...tabs, ids: [...tabs.ids, made], active: made };
  });
  return made;
}

/**
 * This device's tabs under other ids (a draft of its own become a tab's
 * note): each of `renames` to its new id, or taken out (null).
 */
export function renameTabs(
  userKey: string,
  renames: ReadonlyMap<string, string | null>,
  added: readonly string[] = [],
): Promise<QuickTabs> {
  return changeTabs(userKey, (tabs) => {
    const adding = added.filter((id) => !tabs.ids.includes(id));
    if (![...renames.keys()].some((id) => tabs.ids.includes(id)) && adding.length === 0) return tabs;
    const to = (id: string) => (renames.has(id) ? renames.get(id)! : id);
    const ids = [...tabs.ids.map(to).filter((id): id is string => id !== null), ...adding];
    if (ids.length === 0) return fresh(userKey);
    const active = to(tabs.active);
    return { ...tabs, ids, active: active && ids.includes(active) ? active : ids[0]! };
  });
}

/** A new, empty tab shown, where none is left to show (all closed, here or elsewhere). */
export function addFreshTab(userKey: string): Promise<QuickTabs> {
  return changeTabs(userKey, (tabs) => {
    const id = newTabId();
    return { ...tabs, ids: [...tabs.ids, id], active: id, fresh: id };
  });
}

/**
 * The Todo's tab shown: put first, if it is not open, there being one Todo
 * (lib/quick/todo). Not counted against MAX_TABS.
 */
export function openTodoTab(userKey: string): Promise<QuickTabs> {
  return changeTabs(userKey, (tabs) => {
    if (tabs.ids.includes(TODO_TAB_ID)) {
      return tabs.active === TODO_TAB_ID ? tabs : { ...tabs, active: TODO_TAB_ID };
    }
    return { ...tabs, ids: [TODO_TAB_ID, ...tabs.ids], active: TODO_TAB_ID };
  });
}

/**
 * Shows a tab: one another device opened, among this one's from now on
 * (shown already, as the one in place of this device's empty one, too: one
 * not this device's goes from its tabs as it is emptied).
 */
export function showTab(userKey: string, tabId: string): Promise<QuickTabs> {
  return changeTabs(userKey, (tabs) => {
    if (tabs.active === tabId && tabs.ids.includes(tabId)) return tabs;
    const ids = tabs.ids.includes(tabId) ? tabs.ids : [...tabs.ids, tabId];
    return { ...tabs, ids, active: tabId };
  });
}

/**
 * Closes a tab, its draft with it: the one after it shown in its place (or,
 * the last, the one before). The last tab closed leaves an empty one.
 */
export async function closeTab(userKey: string, tabId: string): Promise<QuickTabs> {
  // Its note to the trash, out of sight, on every device: closed there too.
  // First, so that it is never shown meanwhile as another device's tab with
  // something in it. Not deleted for good at once: what was saved from it
  // may still be telling the server of the files it uses (trash.ts purgeNote).
  if (isQuickTab(tabId) && (await db().notes.get(tabId))) await setNoteTrashed(tabId, true);
  const tabs = await changeTabs(userKey, (tabs) => {
    const at = tabs.ids.indexOf(tabId);
    if (at < 0) return tabs;
    const ids = tabs.ids.filter((id) => id !== tabId);
    if (ids.length === 0) return fresh(userKey);
    const active = tabs.active === tabId ? ids[Math.min(at, ids.length - 1)]! : tabs.active;
    return { ...tabs, ids, active };
  });
  await clearDraft(userKey, tabId);
  return tabs;
}

/** A tab closed a moment ago put back, shown, where it was among the others (for 元に戻す). */
export async function restoreTab(userKey: string, tabId: string, at: number): Promise<void> {
  if (isQuickTab(tabId) && (await db().notes.get(tabId))) await setNoteTrashed(tabId, false);
  await changeTabs(userKey, (tabs) => {
    if (tabs.ids.includes(tabId)) return tabs.active === tabId ? tabs : { ...tabs, active: tabId };
    const ids = [...tabs.ids];
    ids.splice(Math.min(Math.max(at, 0), ids.length), 0, tabId);
    return { ...tabs, ids, active: tabId };
  });
}

/** Keeps whether a tab holds what is not saved, as last seen here: for one not shown, closed. */
export async function rememberUnsaved(userKey: string, tabId: string, held: boolean): Promise<void> {
  const key = `${META.quickUnsaved}:${userKey}`;
  const kept = await getMeta<Record<string, boolean>>(key, {});
  if (kept[tabId] === held) return;
  await setMeta(key, { ...kept, [tabId]: held });
}

/** What a tab shows of itself, in the tabs: its text (its first line), its images, whether it holds what is not saved. */
export type TabFace = { text: string; images: number; unsaved: boolean };

/**
 * This account's tabs, as they change (in any window, on any device): the
 * Todo's, if it is open here, then the tabs' notes (lib/quick/tabs) in the
 * order they were made. Each device's own tabs, and those of the others with
 * anything in them (an empty one, opened elsewhere, is that device's
 * alone); not one closed (its note in the trash), here or anywhere. The one
 * shown is this device's own. Each with what it shows of itself: its note's
 * first line, its images, and, as last seen here, whether it holds what is
 * not saved (one never seen here: whether it holds anything).
 */
export function useQuickTabs(
  userKey: string,
): { tabs: QuickTabs; faces: ReadonlyMap<string, TabFace>; own: readonly string[]; gone: readonly string[] } | undefined {
  return useLiveQuery(async () => {
    const kept = await getMeta<QuickTabs | null>(tabsKey(userKey), null);
    if (!kept || kept.userKey !== userKey || kept.ids.length === 0) return undefined;
    const database = db();
    const notes = await database.notes.where("noteId").startsWith(QUICK_TAB_PREFIX).toArray();
    const known = new Set(notes.map((note) => note.noteId));
    const open = notes.filter((note) => !note.purged && note.deletedAt === null);
    const files = await database.attachments
      .where("noteId")
      .anyOf(open.map((note) => note.noteId))
      .filter((file) => file.deletedAt === null)
      .toArray();
    const images = new Map<string, number>();
    for (const file of files) images.set(file.noteId, (images.get(file.noteId) ?? 0) + 1);
    const seen = await getMeta<Record<string, boolean>>(`${META.quickUnsaved}:${userKey}`, {});
    const own = new Set(kept.ids);
    const faces = new Map<string, TabFace>();
    for (const note of open) {
      const text = note.preview ?? "";
      const count = images.get(note.noteId) ?? 0;
      if (!own.has(note.noteId) && text.trim() === "" && count === 0) continue;
      faces.set(note.noteId, { text, images: count, unsaved: seen[note.noteId] ?? (text.trim() !== "" || count > 0) });
    }
    // Closed on another device: to be taken out of this one's (Tabbed).
    const gone = goneTabs(kept.ids, notes, Date.now());
    // Opened here a moment ago, its note not made yet: shown, empty.
    for (const id of kept.ids) {
      if (isQuickTab(id) && !known.has(id) && !gone.includes(id)) faces.set(id, { text: "", images: 0, unsaved: false });
    }
    // The empty one made for this device, out of sight while the account
    // has tabs of its own: the newest of those shown in its place.
    const holds = (face: TabFace) => face.text.trim() !== "" || face.images > 0;
    const made = kept.fresh ? faces.get(kept.fresh) : undefined;
    const hidden =
      made !== undefined && !holds(made) && [...faces].some(([id, face]) => id !== kept.fresh && holds(face));
    if (hidden) faces.delete(kept.fresh!);
    const drafts = [...faces.keys()].sort();
    const ids = [...(own.has(TODO_TAB_ID) ? [TODO_TAB_ID] : []), ...drafts];
    const active = ids.includes(kept.active)
      ? kept.active
      : ((hidden && kept.active === kept.fresh ? drafts.at(-1) : drafts[0]) ?? ids[0] ?? "");
    return { tabs: { userKey, ids, active }, faces, own: kept.ids, gone };
  }, [userKey]);
}
