import "fake-indexeddb/auto";
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import type { ConvexReactClient } from "convex/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { toArrayBuffer } from "@/lib/bytes";
import { db, resetLocalData, setMeta } from "@/lib/db";
import { META } from "@/lib/db/meta";
import "@/lib/media/attachments";
import "@/lib/media/report-refs";
import "@/lib/search/yomi";
import { SyncEngine } from "@/lib/sync/engine";
import "@/lib/sync/mutations";
import { linkTargets, noteIdFromLink, noteLink } from "@/lib/note-links";
import { openNoteLink } from "@/lib/open-link";
import { acquireDoc, flushDoc, releaseDoc } from "@/lib/sync/docs";
import { bodyFragment } from "@/lib/sync/ydoc";
import type { Note } from "@/lib/types";
import { fakeConvex } from "./helpers/fake-convex";
import { zero } from "./helpers/seed";

const ORIGIN = window.location.origin;

const note = (noteId: string): Note => ({
  noteId,
  folderId: null,
  kind: "note",
  title: noteId,
  preview: null,
  pinned: false,
  sortKey: "a",
  locked: false,
  keyEpoch: 0,
  deletedAt: null,
  purged: false,
  lastUpdateSeq: 0,
  snapshotSeq: 0,
  ts: { title: zero, preview: zero, place: zero, pin: zero, trash: zero, lock: zero },
  seq: 0,
  updatedAt: 0,
});

/** A note's body holding a line with a link to each of these addresses. */
function bodyLinkingTo(...hrefs: string[]): Y.Doc {
  const editor = BlockNoteEditor.create();
  editor.replaceBlocks(editor.document, [
    {
      type: "paragraph",
      content: hrefs.flatMap((href, index) => [
        { type: "link", href, content: `リンク${index}` },
        " と ",
      ]),
    },
  ] as never);
  const doc = new Y.Doc();
  blocksToYXmlFragment(editor, editor.document, bodyFragment(doc));
  return doc;
}

describe("a link to a note", () => {
  test("is the app's own address for it, and is read back as the note", () => {
    expect(noteLink("n-1", "https://memoca.test")).toBe("https://memoca.test/app?n=n-1");
    expect(noteIdFromLink("https://memoca.test/app?n=n-1", "https://memoca.test")).toBe("n-1");
  });

  test("is not one on another site, or to anything but a note", () => {
    expect(noteIdFromLink("https://example.com/app?n=n-1", "https://memoca.test")).toBeNull();
    expect(noteIdFromLink("https://memoca.test/app?f=folder", "https://memoca.test")).toBeNull();
    expect(noteIdFromLink("https://memoca.test/sign-in?n=n-1", "https://memoca.test")).toBeNull();
  });

  test("is found in a note's text, each note once, other links left out", () => {
    const doc = bodyLinkingTo(
      noteLink("a", ORIGIN),
      "https://example.com/",
      noteLink("b", ORIGIN),
      noteLink("a", ORIGIN),
    );
    expect(linkTargets(doc, ORIGIN)).toEqual(["a", "b"]);
  });

  test("clicked, opens the note in the app; any other link is left to open apart", () => {
    const open = vi.fn();
    const anchor = (href: string) => {
      const a = document.createElement("a");
      a.setAttribute("data-inline-content-type", "link");
      a.setAttribute("href", href);
      document.body.append(a);
      return a;
    };
    const click = (target: Element) => {
      const event = new MouseEvent("click", { cancelable: true });
      Object.defineProperty(event, "target", { value: target });
      return event;
    };
    const toNote = click(anchor(noteLink("n-9", ORIGIN)));
    expect(openNoteLink(toNote, open)).toBe(true);
    expect(open).toHaveBeenCalledWith("n-9");
    expect(toNote.defaultPrevented).toBe(true);
    expect(openNoteLink(click(anchor("https://example.com/")), open)).toBe(false);
  });
});

describe("the notes a note links to", () => {
  beforeEach(async () => {
    await resetLocalData();
    await db().notes.put(note("n1"));
  });

  test("are kept with its text when it is written, for the list of those that link to each", async () => {
    const doc = await acquireDoc("n1");
    try {
      const linking = bodyLinkingTo(noteLink("target", ORIGIN));
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(linking));
      // Not from another device: as typed here.
      bodyFragment(doc).insert(bodyFragment(doc).length, [new Y.XmlElement("blockContainer")]);
      await flushDoc("n1");
    } finally {
      await releaseDoc("n1");
    }
    expect((await db().bodies.get("n1"))?.links).toEqual(["target"]);
  });
});

describe("a note changed on another device", () => {
  test("has its text and the notes it links to taken again, though it is not open here", async () => {
    await resetLocalData();
    await setMeta(META.pinPlacesPulled, true);
    await db().notes.put({ ...note("n1"), seq: 1 });
    await db().bodies.put({ noteId: "n1", throughSeq: 0, keyEpoch: 0, text: "", updatedAt: 0 });

    const typed = bodyLinkingTo(noteLink("target", ORIGIN));
    const batch = {
      headSeq: 3,
      cursor: 3,
      complete: true,
      serverTime: Date.now(),
      folders: [],
      notes: [],
      updates: [
        {
          noteId: "n1",
          opId: "elsewhere-1",
          deviceId: "elsewhere",
          keyEpoch: 0,
          payload: toArrayBuffer(Y.encodeStateAsUpdate(typed)),
          seq: 3,
        },
      ],
      snapshots: [],
      attachments: [],
    };
    const server = fakeConvex({});
    const client = {
      ...server.client,
      watchQuery: (_query: unknown, args: { since: number }) => ({
        localQueryResult: () =>
          args.since === 0
            ? batch
            : { ...batch, headSeq: args.since, cursor: args.since, updates: [] },
        onUpdate: () => () => {},
      }),
    };
    const engine = new SyncEngine(client as unknown as ConvexReactClient);
    await engine.start("me");
    try {
      await vi.waitFor(
        async () => expect((await db().bodies.get("n1"))?.links).toEqual(["target"]),
        {
          timeout: 5_000,
        },
      );
      expect((await db().bodies.get("n1"))?.text).toContain("リンク0");
    } finally {
      engine.stop();
    }
  });
});
