import "fake-indexeddb/auto";
import { beforeEach, expect, test } from "vitest";
import { db, resetLocalData } from "@/lib/db";
import { orderNotes } from "@/lib/note-order";
import {
  createFolder,
  createNote,
  placePinned,
  setNotePinned,
  setNotesPinned,
} from "@/lib/sync/mutations";
import { seedInbox } from "./helpers/seed";

beforeEach(async () => {
  await resetLocalData();
  await seedInbox();
});

/** The pinned notes, in their order among the pinned. */
async function pinned() {
  const notes = (await db().notes.toArray()).filter((note) => note.pinned);
  return orderNotes(notes).map((note) => note.noteId);
}

type Sent = { noteId?: string; pin?: { pinned: boolean }; pinPlace?: { key: string } };
/** What was sent to be synced for a note, its last pin and place. */
async function sent(noteId: string) {
  const ops = (await db().outbox.toArray())
    .map((each) => each.payload as Sent)
    .filter((payload) => payload.noteId === noteId);
  return {
    pin: ops.filter((op) => op.pin).at(-1)?.pin,
    place: ops.filter((op) => op.pinPlace).at(-1)?.pinPlace,
  };
}

test("a note pinned goes first among the pinned, its pin and its place sent", async () => {
  const folderId = await createFolder({ parentId: null, name: "仕事" });
  const one = await createNote({ folderId });
  const two = await createNote({ folderId });
  await setNotePinned(one, true);
  await setNotePinned(two, true);
  expect(await pinned()).toEqual([two, one]);
  const { pin, place } = await sent(two);
  expect(pin?.pinned).toBe(true);
  expect(place?.key).toBe((await db().notes.get(two))?.pinKey);
});

test("unpinned: only its pin is written, its place left as it was", async () => {
  const one = await createNote({ folderId: null });
  await setNotePinned(one, true);
  const { place } = await sent(one);
  const ops = await db().outbox.count();
  await setNotePinned(one, false);
  const note = await db().notes.get(one);
  expect(note?.pinned).toBe(false);
  expect(note?.pinKey).toBe(place?.key);
  expect(await db().outbox.count()).toBe(ops + 1);
  expect((await sent(one)).pin?.pinned).toBe(false);
});

test("several pinned at once go first in the order given", async () => {
  const before = await createNote({ folderId: null });
  await setNotePinned(before, true);
  const one = await createNote({ folderId: null });
  const two = await createNote({ folderId: null });
  await setNotesPinned([two, one], true);
  expect(await pinned()).toEqual([two, one, before]);
});

test("placed among the pinned of a list, between its neighbours there, others hidden from it between them", async () => {
  const notes: string[] = [];
  for (let i = 0; i < 4; i += 1) notes.push(await createNote({ folderId: null }));
  const [a, b, c, d] = notes as [string, string, string, string];
  for (const id of [d, c, b, a]) await setNotePinned(id, true);
  expect(await pinned()).toEqual([a, b, c, d]);
  // A list showing a, c and d only (b in another folder): d let go between a and c.
  await placePinned(d, [a, c], 1);
  const order = await pinned();
  expect(order.indexOf(a)).toBeLessThan(order.indexOf(d));
  expect(order.indexOf(d)).toBeLessThan(order.indexOf(c));
});

test("placed between two by them, not by its index: one shown above it unpinned meanwhile", async () => {
  const notes: string[] = [];
  for (let i = 0; i < 4; i += 1) notes.push(await createNote({ folderId: null }));
  const [a, b, c, d] = notes as [string, string, string, string];
  for (const id of [d, c, b, a]) await setNotePinned(id, true);
  // Let go between b and c, b unpinned (on another device, say) as it was dragged.
  await setNotePinned(b, false);
  await placePinned(d, [a, b, c], 2);
  expect(await pinned()).toEqual([a, d, c]);
});

test("between two that share a place (pinned at once on two devices): those placed anew, the note between them", async () => {
  const [a, b, c] = [
    await createNote({ folderId: null }),
    await createNote({ folderId: null }),
    await createNote({ folderId: null }),
  ];
  for (const id of [c, b, a]) await setNotePinned(id, true);
  // a and b given one place, as two devices pinning at once would.
  const key = (await db().notes.get(b))!.pinKey!;
  await db().notes.update(a, { pinKey: key });
  const shared = await pinned();
  const [first, second] = shared.filter((id) => id !== c) as [string, string];
  await placePinned(c, [first, second], 1);
  expect(await pinned()).toEqual([first, c, second]);
});

test("those pinned before there were places are given them, in the order they were in, and sent", async () => {
  const [placed, old1, old2, fresh] = [
    await createNote({ folderId: null }),
    await createNote({ folderId: null }),
    await createNote({ folderId: null }),
    await createNote({ folderId: null }),
  ];
  await setNotePinned(placed, true);
  const placedKey = (await db().notes.get(placed))?.pinKey;
  const ops = await db().outbox.count();
  // As an app from before would have left them: pinned, no place.
  for (const [id, t] of [
    [old1, 1],
    [old2, 2],
  ] as const) {
    const note = (await db().notes.get(id))!;
    await db().notes.update(id, { pinned: true, ts: { ...note.ts, pin: { t, d: "old" } } });
  }
  expect(await pinned()).toEqual([old2, old1, placed]);
  await setNotePinned(fresh, true);
  expect(await pinned()).toEqual([fresh, old2, old1, placed]);
  // The one with a place left as it was, nothing sent for it.
  expect((await db().notes.get(placed))?.pinKey).toBe(placedKey);
  expect(await db().outbox.count()).toBe(ops + 3);
  for (const id of [old1, old2]) {
    const key = (await db().notes.get(id))?.pinKey;
    expect(key).toBeTruthy();
    expect((await sent(id)).place?.key).toBe(key);
    // Its place only: not pinned again.
    expect((await sent(id)).pin).toBeUndefined();
  }
});
