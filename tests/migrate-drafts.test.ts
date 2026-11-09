import "fake-indexeddb/auto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";

const h = vi.hoisted(() => ({ stage: vi.fn(), make: vi.fn(), docs: new Map<string, import("yjs").Doc>() }));
vi.mock("@/lib/media/attachments", () => ({ stageUpload: h.stage }));
vi.mock("@/lib/quick/tabs", async (original) => ({
  ...(await original<typeof import("@/lib/quick/tabs")>()),
  makeTabNote: h.make,
}));
vi.mock("@/lib/sync/docs", () => ({
  acquireDoc: async (noteId: string) => {
    if (!h.docs.has(noteId)) h.docs.set(noteId, new (await import("yjs")).Doc());
    return h.docs.get(noteId);
  },
  releaseDoc: async () => {},
  flushDoc: async () => {},
}));

import { db, resetLocalData } from "@/lib/db";
import { appendBlocks, appendParagraphs, imageUrls, quickImageRef } from "@/lib/quick/body";
import { keepDraft, loadDraft, loadTabs } from "@/lib/quick/draft";
import { migrateLocalDrafts } from "@/lib/quick/migrate-drafts";
import { readSaved } from "@/lib/quick/tabs";
import { extractText } from "@/lib/sync/ydoc";

const ME = "user-me";
const OLD = "01a1c000-0000-7000-8000-000000000001";
const NOTE = `quick-tab-${OLD}`;

/** A draft as a version before kept it, on this device alone, in a tab of its own. */
async function oldDraft(options: { body?: Y.Doc; text: string; images?: { key: string; name: string }[] }) {
  await db().meta.put({ key: `quickTabs:${ME}`, value: { userKey: ME, ids: [OLD], active: OLD } });
  const kept = keepDraft(ME, OLD);
  kept.update({
    text: options.text,
    ...(options.body ? { body: Y.encodeStateAsUpdate(options.body), key: "k" } : {}),
  });
  if (options.images) {
    kept.images(
      options.images.map((image) => ({ ...image, blob: new Blob(["x"]), mime: "image/webp", width: 4, height: 3 })),
    );
  }
  kept.release();
  await kept.flush(true);
  kept.dispose();
}

beforeEach(async () => {
  await resetLocalData();
  h.docs.clear();
  h.stage.mockReset().mockResolvedValue("memoca://att-1");
  h.make.mockReset().mockImplementation(async (noteId: string) => {
    await db().notes.put({ noteId, deletedAt: null, purged: false } as never);
  });
});

describe("a quick note's draft this device kept of its own", () => {
  test("becomes a tab of the account's: its note, what it held, its tab renamed, the draft forgotten here", async () => {
    await oldDraft({ text: "一行目\n二行目" });
    await migrateLocalDrafts(ME);
    expect(extractText(h.docs.get(NOTE)!)).toBe("一行目\n二行目");
    expect(await loadTabs(ME)).toMatchObject({ ids: [NOTE], active: NOTE });
    expect(await loadDraft(ME, OLD)).toBeNull();
    // Once: nothing left to do the next time.
    await migrateLocalDrafts(ME);
    expect(h.make).toHaveBeenCalledOnce();
  });

  test("its images sent up as the note's files, where they were; one of a strip after what is written", async () => {
    const body = new Y.Doc();
    appendParagraphs(body, ["上"]);
    appendBlocks(body, [{ kind: "image", url: quickImageRef("in-body"), name: "本文の.png" }]);
    await oldDraft({ body, text: "上", images: [{ key: "in-body", name: "本文の.png" }, { key: "strip", name: "列の.png" }] });
    h.stage.mockResolvedValueOnce("memoca://att-a").mockResolvedValueOnce("memoca://att-b");
    await migrateLocalDrafts(ME);
    expect(h.stage.mock.calls.map((call) => call[0].noteId)).toEqual([NOTE, NOTE]);
    expect(imageUrls(h.docs.get(NOTE)!)).toEqual(["memoca://att-a", "memoca://att-b"]);
  });

  test("an image that could not be sent is kept as it was, and tried again the next time", async () => {
    const body = new Y.Doc();
    appendParagraphs(body, ["写真つき"]);
    appendBlocks(body, [{ kind: "image", url: quickImageRef("photo"), name: "写真.png" }]);
    await oldDraft({ body, text: "写真つき", images: [{ key: "photo", name: "写真.png" }] });
    h.stage.mockRejectedValueOnce(new Error("idb"));
    await migrateLocalDrafts(ME);
    // Its text in its note, its tab the note's; the image as it was, the draft kept.
    expect(extractText(h.docs.get(NOTE)!)).toBe("写真つき");
    expect(imageUrls(h.docs.get(NOTE)!)).toEqual([quickImageRef("photo")]);
    expect((await loadTabs(ME)).ids).toEqual([NOTE]);
    expect(await loadDraft(ME, OLD)).not.toBeNull();

    await migrateLocalDrafts(ME);
    expect(imageUrls(h.docs.get(NOTE)!)).toEqual(["memoca://att-1"]);
    expect(extractText(h.docs.get(NOTE)!)).toBe("写真つき");
    expect(await loadDraft(ME, OLD)).toBeNull();
  });

  test("one whose note could not be made is kept, not a tab meanwhile, and made one the next time", async () => {
    await oldDraft({ text: "あとで" });
    h.make.mockRejectedValueOnce(new Error("idb"));
    await migrateLocalDrafts(ME);
    expect((await loadTabs(ME)).ids).not.toContain(OLD);
    expect(await loadDraft(ME, OLD)).not.toBeNull();

    await migrateLocalDrafts(ME);
    expect((await loadTabs(ME)).ids).toContain(NOTE);
    expect(extractText(h.docs.get(NOTE)!)).toBe("あとで");
    expect(await loadDraft(ME, OLD)).toBeNull();
  });

  test("what it was saved as comes with it: saved as it is, nothing new to save", async () => {
    const body = new Y.Doc();
    appendParagraphs(body, ["保存した"]);
    await oldDraft({ body, text: "保存した" });
    const draft = (await db().meta.get(`quickDraft:${OLD}`))!.value as Record<string, unknown>;
    await db().meta.put({
      key: `quickDraft:${OLD}`,
      value: { ...draft, saved: { noteId: "note-9", text: "保存した", key: "k", images: [] } },
    });
    await migrateLocalDrafts(ME);
    const saved = readSaved(h.docs.get(NOTE)!);
    expect(saved?.noteId).toBe("note-9");
    expect(saved?.key).toBe((await import("@/lib/quick/body")).quickKey(h.docs.get(NOTE)!));
  });
});
