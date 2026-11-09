import "fake-indexeddb/auto";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { type MovedBlock, insertIntoTodo, removeFromTodo, todoBlocksOf } from "@/lib/quick/todo-move";
import { bodyFragment } from "@/lib/sync/ydoc";

const text = (value: string) => [{ type: "text", text: value, styles: {} }];
const block = (type: string, content: unknown, children: MovedBlock[] = []): MovedBlock => ({
  id: crypto.randomUUID(),
  type,
  content,
  children,
});
/** An item as the Todo reads: "[ ] 本選考", its details "  ・URL". */
const shown = (blocks: ReturnType<typeof todoBlocksOf>) =>
  blocks.flatMap((item) => [
    `[${item.props?.checked ? "x" : " "}] ${(item.content as { text?: string }[]).map((run) => run.text ?? "").join("")}`,
    ...item.children.map((detail) => `  ・${(detail.content as { text?: string }[]).map((run) => run.text ?? "").join("")}`),
  ]);

describe("the quick note's lines as the Todo's items", () => {
  test("each line an item, the lines under it its details, however far in", () => {
    const items = todoBlocksOf([
      block("paragraph", text("富士フイルム")),
      block("bulletListItem", text("インターン"), [
        block("bulletListItem", text("https://example.com/"), [block("paragraph", text("11/30 正午"))]),
      ]),
      block("heading", text("カプコン")),
    ]);
    expect(shown(items)).toEqual([
      "[ ] 富士フイルム",
      "[ ] インターン",
      "  ・https://example.com/",
      "  ・11/30 正午",
      "[ ] カプコン",
    ]);
  });

  test("empty lines, and what has no text (an image, a table), go; ticked lines go in to do", () => {
    const items = todoBlocksOf([
      block("paragraph", text("  ")),
      block("image", undefined),
      block("table", { type: "tableContent", rows: [] }),
      block("checkListItem", text("済んだ")),
      // Under an empty line: items of their own.
      block("paragraph", [], [block("paragraph", text("その下"))]),
    ]);
    expect(shown(items)).toEqual(["[ ] 済んだ", "[ ] その下"]);
  });

  test("a link's text is kept, the link with it", () => {
    const link = [{ type: "link", href: "https://example.com/", content: text("募集ページ") }];
    const [item] = todoBlocksOf([block("paragraph", link)]);
    expect(item?.content).toEqual(link);
  });
});

describe("the Todo's document", () => {
  /** The Todo as it reads, from its document. */
  const read = (doc: Y.Doc) => {
    const list = bodyFragment(doc).get(0) as Y.XmlElement;
    return list.toArray().map((container) => {
      const item = (container as Y.XmlElement).get(0) as Y.XmlElement;
      const checked = item.getAttribute("checked") as unknown;
      return `${item.nodeName} [${checked === true || checked === "true" ? "x" : " "}] ${item.toString().replace(/<[^>]+>/g, "")}`;
    });
  };

  test("takes the items in after those to do, before the done; and gives them back by their ids", () => {
    const doc = new Y.Doc();
    insertIntoTodo(doc, todoBlocksOf([block("paragraph", text("牛乳"))]));
    insertIntoTodo(doc, [
      { id: "done", type: "checkListItem", props: { checked: true }, content: text("済んだ"), children: [] },
    ]);
    const moved = todoBlocksOf([block("paragraph", text("本選考")), block("paragraph", text("カプコン"))]);
    insertIntoTodo(doc, moved);
    expect(read(doc)).toEqual([
      "checkListItem [ ] 牛乳",
      "checkListItem [ ] 本選考",
      "checkListItem [ ] カプコン",
      "checkListItem [x] 済んだ",
    ]);
    removeFromTodo(
      doc,
      moved.map((item) => item.id),
    );
    expect(read(doc)).toEqual(["checkListItem [ ] 牛乳", "checkListItem [x] 済んだ"]);
  });
});
