import { blocksToYDoc, yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { joinTodoLists } from "@/lib/quick/todo-repair";
import { FRAGMENT, bodyFragment } from "@/lib/sync/ydoc";
import { editor, valid } from "./helpers/blocknote";

const list = (doc: Y.Doc) =>
  yXmlFragmentToBlocks(editor, bodyFragment(doc)).map((block) =>
    (block.content as { text: string }[]).map((run) => run.text).join(""),
  );
const merge = (...docs: Y.Doc[]) => {
  const merged = new Y.Doc();
  for (const doc of docs) Y.applyUpdate(merged, Y.encodeStateAsUpdate(doc));
  return merged;
};
const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
};

describe("the Todo begun apart on two devices", () => {
  test("is put back as one list, the other's items after, its empty starting line left out", () => {
    const one = blocksToYDoc(editor, [{ type: "checkListItem", content: "牛乳" }], FRAGMENT);
    const two = blocksToYDoc(
      editor,
      [
        { type: "checkListItem", content: "卵" },
        { type: "checkListItem", content: "" },
      ],
      FRAGMENT,
    );
    const doc = merge(one, two);
    expect(bodyFragment(doc).length).toBe(2);
    expect(joinTodoLists(doc)).toBe(true);
    expect(bodyFragment(doc).length).toBe(1);
    expect(valid(doc)).toBe(true);
    expect(list(doc).sort()).toEqual(["牛乳", "卵"].sort());
    // Once is enough.
    expect(joinTodoLists(doc)).toBe(false);
  });

  test("put together on both at once, both end with the same list, each item once", () => {
    const one = blocksToYDoc(editor, [{ type: "checkListItem", content: "牛乳" }], FRAGMENT);
    const two = blocksToYDoc(editor, [{ type: "checkListItem", content: "卵" }], FRAGMENT);
    const a = merge(one, two);
    const b = merge(one, two);
    joinTodoLists(a);
    joinTodoLists(b);
    sync(a, b);
    // Each copied the same items: there twice, until put right again.
    joinTodoLists(a);
    joinTodoLists(b);
    sync(a, b);
    expect(list(a)).toEqual(list(b));
    expect(list(a).sort()).toEqual(["牛乳", "卵"].sort());
    expect(valid(a)).toBe(true);
  });

  test("a list begun on one device alone is left as it is", () => {
    const doc = blocksToYDoc(editor, [{ type: "checkListItem", content: "牛乳" }], FRAGMENT);
    expect(joinTodoLists(doc)).toBe(false);
  });
});

describe("two lists each begun with the editor's one first id", () => {
  /** A list whose one item has BlockNote's first id, as each device's editor makes it. */
  const begun = (text: string) => {
    const doc = blocksToYDoc(editor, [{ type: "checkListItem", content: text }], FRAGMENT);
    const group = bodyFragment(doc).get(0) as Y.XmlElement;
    (group.get(0) as Y.XmlElement).setAttribute("id", "initialBlockId");
    return doc;
  };

  test("keeps both items: nothing written is lost, and each has an id of its own", () => {
    const doc = merge(begun("牛乳"), begun("卵"));
    joinTodoLists(doc);
    expect(list(doc).sort()).toEqual(["牛乳", "卵"].sort());
    const group = bodyFragment(doc).get(0) as Y.XmlElement;
    const ids = group.toArray().map((item) => (item as Y.XmlElement).getAttribute("id"));
    expect(new Set(ids).size).toBe(2);
  });

  test("put together on both at once, both end with the same list, each item once", () => {
    const one = begun("牛乳");
    const two = begun("卵");
    const a = merge(one, two);
    const b = merge(one, two);
    joinTodoLists(a);
    joinTodoLists(b);
    sync(a, b);
    joinTodoLists(a);
    joinTodoLists(b);
    sync(a, b);
    expect(list(a)).toEqual(list(b));
    expect(list(a).sort()).toEqual(["牛乳", "卵"].sort());
  });
});
