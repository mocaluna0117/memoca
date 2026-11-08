import "fake-indexeddb/auto";
import { beforeEach, describe, expect, test } from "vitest";
import { resetLocalData } from "@/lib/db";
import {
  quickFolderAllowed,
  quickFolderOf,
  rememberQuickFolder,
  rememberedQuickFolder,
} from "@/lib/quick/folder";
import type { Folder } from "@/lib/types";

const folder = (folderId: string, over: Partial<Folder> = {}): Folder =>
  ({
    folderId,
    parentId: null,
    name: folderId,
    icon: null,
    system: null,
    sortKey: "a",
    locked: false,
    deletedAt: null,
    purged: false,
    ...over,
  }) as unknown as Folder;

const folders = [
  folder("inbox", { system: "inbox" }),
  folder("work"),
  folder("trashed", { deletedAt: 1 }),
  folder("inside-trashed", { parentId: "trashed" }),
  folder("locked", { locked: true }),
  folder("inside-locked", { parentId: "locked" }),
  folder("templates", { system: "templates" }),
  folder("journal", { system: "journal" }),
];
const byId = (id: string) => folders.find((each) => each.folderId === id);

describe("the folders a quick note may be saved into", () => {
  test("an ordinary one, and Inbox", () => {
    expect(quickFolderAllowed(byId("work"), folders)).toBe(true);
    expect(quickFolderAllowed(byId("inbox"), folders)).toBe(true);
  });

  test("not one in the trash or locked, nor inside one, nor the templates' or the days'", () => {
    for (const id of ["trashed", "inside-trashed", "locked", "inside-locked", "templates", "journal"]) {
      expect(quickFolderAllowed(byId(id), folders), id).toBe(false);
    }
    expect(quickFolderAllowed(undefined, folders)).toBe(false);
  });

  test("the one chosen while it may be saved into; Inbox once it is gone, trashed or locked", () => {
    expect(quickFolderOf("work", "inbox", folders)).toBe("work");
    expect(quickFolderOf(null, "inbox", folders)).toBe("inbox");
    expect(quickFolderOf("gone", "inbox", folders)).toBe("inbox");
    expect(quickFolderOf("inside-locked", "inbox", folders)).toBe("inbox");
  });
});

describe("the folder chosen", () => {
  beforeEach(() => resetLocalData());

  test("is remembered on this device, for each account apart", async () => {
    expect(await rememberedQuickFolder("me")).toBeNull();
    await rememberQuickFolder("me", "work");
    expect(await rememberedQuickFolder("me")).toBe("work");
    expect(await rememberedQuickFolder("someone-else")).toBeNull();
  });
});
