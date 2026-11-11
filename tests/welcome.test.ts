import "fake-indexeddb/auto";
import { beforeEach, describe, expect, test } from "vitest";
import { db, resetLocalData } from "@/lib/db";
import { withStoredDoc } from "@/lib/sync/docs";
import { bodyFragment } from "@/lib/sync/ydoc";
import { PRACTICE_TITLE, WELCOME_OFF, rememberWelcomeSeen, welcomeOff, welcomeSeenHere } from "@/lib/welcome";
import { createPracticeNote } from "@/lib/welcome-note";
import { seedInbox } from "./helpers/seed";

beforeEach(async () => {
  await resetLocalData();
  localStorage.clear();
});

describe("the note an account just made gets, to try things in", () => {
  test("is in its Inbox, by its title, with things to do as items to tick, and sent as any note is", async () => {
    const inbox = await seedInbox();
    const noteId = await createPracticeNote(inbox);
    const note = (await db().notes.get(noteId))!;
    expect(note.title).toBe(PRACTICE_TITLE);
    expect(note.folderId).toBe(inbox);
    const kinds = await withStoredDoc(noteId, (doc) => {
      const group = bodyFragment(doc).get(0) as unknown as { toArray(): { get(i: number): { nodeName: string } }[] };
      return group.toArray().map((container) => container.get(0).nodeName);
    });
    expect(kinds.filter((kind) => kind === "checkListItem").length).toBeGreaterThanOrEqual(5);
    expect(kinds).toContain("heading");
    expect((await db().outbox.toArray()).some((op) => op.entityId === noteId)).toBe(true);
  });
});

describe("whether the welcome is shown on this device", () => {
  test("seen by an account here, not again for it; another account's is its own", () => {
    expect(welcomeSeenHere("me")).toBe(false);
    rememberWelcomeSeen("me");
    expect(welcomeSeenHere("me")).toBe(true);
    expect(welcomeSeenHere("someone-else")).toBe(false);
  });

  test("turned off for the device (the tests'): none at all", () => {
    expect(welcomeOff()).toBe(false);
    localStorage.setItem(WELCOME_OFF, "1");
    expect(welcomeOff()).toBe(true);
  });
});
