import "fake-indexeddb/auto";
import { beforeEach, describe, expect, test } from "vitest";
import { db, resetLocalData } from "@/lib/db";
import {
  TEMPLATES_FOLDER_ID,
  createFolder,
  ensureTemplatesFolder,
  moveFolder,
  setFolderTrashed,
  topLevelKeys,
} from "@/lib/sync/mutations";
import { buildTree } from "@/lib/tree";
import { seedInbox } from "./helpers/seed";

beforeEach(async () => {
  await resetLocalData();
});

describe("the folder of templates", () => {
  test("is made once, with the same id on every device, and sent as a system folder", async () => {
    expect(await ensureTemplatesFolder()).toEqual({ folderId: TEMPLATES_FOLDER_ID, made: true });
    expect(await ensureTemplatesFolder()).toEqual({ folderId: TEMPLATES_FOLDER_ID, made: false });
    expect(await db().folders.where("system").equals("templates").count()).toBe(1);
    const ops = (await db().outbox.toArray()).filter((op) => op.entityId === TEMPLATES_FOLDER_ID);
    expect(ops).toHaveLength(1);
    expect((ops[0]!.payload as { create?: { system: string } }).create?.system).toBe("templates");
  });

  test("sits below Inbox, above the other folders, and outside their order", async () => {
    await seedInbox();
    const work = await createFolder({ parentId: null, name: "仕事" });
    await ensureTemplatesFolder();
    const tree = buildTree(await db().folders.toArray());
    expect(tree.map((folder) => folder.system ?? folder.name)).toEqual(["inbox", "templates", "仕事"]);
    // Placed among the others, a folder or a note at the top level goes by their keys alone.
    expect(await topLevelKeys()).toEqual([(await db().folders.get(work))!.sortKey]);
  });

  test("is never moved or trashed", async () => {
    await createFolder({ parentId: null, name: "仕事" });
    await ensureTemplatesFolder();
    await moveFolder(TEMPLATES_FOLDER_ID, "elsewhere");
    await setFolderTrashed(TEMPLATES_FOLDER_ID, true);
    const folder = (await db().folders.get(TEMPLATES_FOLDER_ID))!;
    expect(folder.parentId).toBeNull();
    expect(folder.deletedAt).toBeNull();
  });
});
