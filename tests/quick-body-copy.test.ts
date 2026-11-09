import { blocksToYDoc, yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import {
  appendParagraphs,
  copyQuickBody,
  prependParagraphs,
  quickImageKey,
  quickImageRef,
  quickKey,
  referencedImages,
} from "@/lib/quick/body";
import { FRAGMENT, bodyFragment } from "@/lib/sync/ydoc";
import { editor, valid } from "./helpers/blocknote";

const textOf = (block: { content?: unknown }) =>
  Array.isArray(block.content)
    ? (block.content as { text?: string }[]).map((run) => run.text ?? "").join("")
    : "";

/** A body as BlockNote writes one: a block group, a container per block, the block in it. */
function body(blocks: { type: string; text?: string; attrs?: Record<string, string>; children?: Parameters<typeof body>[0] }[]): Y.Doc {
  const doc = new Y.Doc();
  const fragment = bodyFragment(doc);
  const group = (items: typeof blocks) => {
    const element = new Y.XmlElement("blockGroup");
    for (const [index, item] of items.entries()) {
      const container = new Y.XmlElement("blockContainer");
      container.setAttribute("id", `${item.type}-${item.text ?? ""}-${index}`);
      const content = new Y.XmlElement(item.type);
      for (const [name, value] of Object.entries(item.attrs ?? {})) content.setAttribute(name, value);
      if (item.text) {
        const text = new Y.XmlText();
        text.insert(0, item.text);
        content.insert(0, [text]);
      }
      container.insert(0, [content]);
      if (item.children?.length) container.insert(1, [group(item.children)]);
      element.insert(element.length, [container]);
    }
    return element;
  };
  fragment.insert(0, [group(blocks)]);
  return doc;
}

/** Each block of a body: its type, its text, and those inside it indented. */
function outline(doc: Y.Doc): string[] {
  const lines: string[] = [];
  const walk = (group: Y.XmlElement, depth: number) => {
    for (const container of group.toArray() as Y.XmlElement[]) {
      const [content, inner] = container.toArray() as Y.XmlElement[];
      const text = content!.toArray().map(String).join("");
      const checked = content!.getAttribute("checked");
      lines.push(`${"  ".repeat(depth)}${content!.nodeName}:${text}${checked ? ` checked=${checked}` : ""}`);
      if (inner) walk(inner, depth + 1);
    }
  };
  const group = bodyFragment(doc).toArray()[0];
  if (group instanceof Y.XmlElement) walk(group, 0);
  return lines;
}

describe("a quick note's body, saved into a note", () => {
  test("keeps its lists, checks and toggles, with what is inside them", () => {
    const from = body([
      { type: "paragraph", text: "買い物" },
      { type: "bulletListItem", text: "牛乳" },
      { type: "checkListItem", text: "返信", attrs: { checked: "true" } },
      { type: "toggleListItem", text: "メモ", children: [{ type: "paragraph", text: "中身" }] },
    ]);
    const into = new Y.Doc();
    copyQuickBody(from, into, []);
    expect(outline(into)).toEqual([
      "paragraph:買い物",
      "bulletListItem:牛乳",
      "checkListItem:返信 checked=true",
      "toggleListItem:メモ",
      "  paragraph:中身",
    ]);
  });

  test("leaves out blank lines at either end, not between, and puts its images after", () => {
    const from = body([
      { type: "paragraph" },
      { type: "paragraph", text: "一" },
      { type: "paragraph", text: "  " },
      { type: "paragraph", text: "二" },
      { type: "paragraph" },
    ]);
    const into = new Y.Doc();
    copyQuickBody(from, into, [{ kind: "image", url: "memoca://a1", name: "a.png" }]);
    expect(outline(into)).toEqual(["paragraph:一", "paragraph:  ", "paragraph:二", "image:"]);
  });

  test("saved again, writes over what the note held, and leaves the quick note as it was", () => {
    const into = new Y.Doc();
    appendParagraphs(into, ["前の版"]);
    const from = body([{ type: "bulletListItem", text: "新しい版" }]);
    const before = quickKey(from);
    copyQuickBody(from, into, []);
    expect(outline(into)).toEqual(["bulletListItem:新しい版"]);
    expect(quickKey(from)).toBe(before);
  });
});

describe("what a quick note's body says", () => {
  test("changes when a line is made a list, though its text does not", () => {
    const line = body([{ type: "paragraph", text: "牛乳" }]);
    const item = body([{ type: "bulletListItem", text: "牛乳" }]);
    expect(quickKey(line)).not.toBe(quickKey(item));
    expect(quickKey(line)).toBe(quickKey(body([{ type: "paragraph", text: "牛乳" }])));
  });
});

describe("prependParagraphs", () => {
  test("puts lines above what the body holds, in its one block group", () => {
    const doc = blocksToYDoc(editor, [{ type: "bulletListItem", content: "下書き" }], FRAGMENT);
    prependParagraphs(doc, ["共有された", ""]);
    expect(bodyFragment(doc).length).toBe(1);
    expect(valid(doc)).toBe(true);
    const blocks = yXmlFragmentToBlocks(editor, bodyFragment(doc));
    expect(blocks.map((block) => [block.type, textOf(block)])).toEqual([
      ["paragraph", "共有された"],
      ["paragraph", ""],
      ["bulletListItem", "下書き"],
    ]);
  });

  test("into an empty body, as appendParagraphs", () => {
    const doc = new Y.Doc();
    prependParagraphs(doc, ["一行"]);
    expect(valid(doc)).toBe(true);
    expect(yXmlFragmentToBlocks(editor, bodyFragment(doc)).map(textOf)).toEqual(["一行"]);
  });
});

describe("a quick note's images, in its body where they were put", () => {
  const image = (key: string, name = `${key}.webp`) => ({
    type: "image",
    attrs: { url: quickImageRef(key), name },
  });
  /** Each image block of a body, however far in: its reference and name. */
  const imagesIn = (doc: Y.Doc) => {
    const found: string[] = [];
    const walk = (node: Y.XmlElement | Y.XmlFragment) => {
      for (const child of node.toArray()) {
        if (!(child instanceof Y.XmlElement)) continue;
        if (child.nodeName === "image") found.push(`${child.getAttribute("url")} ${child.getAttribute("name")}`);
        else walk(child);
      }
    };
    walk(bodyFragment(doc));
    return found;
  };

  test("refer to the draft's images by their keys, read back as they were", () => {
    expect(quickImageKey(quickImageRef("0192-a/b"))).toBe("0192-a/b");
    expect(quickImageKey("memoca://att-1")).toBeNull();
    expect(quickImageKey("https://example.com/a.png")).toBeNull();
    expect(quickImageKey(undefined)).toBeNull();
  });

  test("are those of the draft the body shows, in the order it shows them, each once, however far in", () => {
    const doc = body([
      image("b"),
      { type: "paragraph", text: "間" },
      { type: "toggleListItem", text: "開くと", children: [image("a"), image("b")] },
      { type: "image", attrs: { url: "memoca://elsewhere" } },
    ]);
    expect(referencedImages(doc)).toEqual(["b", "a"]);
  });

  test("saved, are where they were in the note, each with the reference it went up as", () => {
    const from = body([
      { type: "paragraph", text: "上" },
      image("a", "写真.png"),
      { type: "bulletListItem", text: "項目", children: [image("b", "図.png")] },
      { type: "paragraph", text: "下" },
    ]);
    const into = new Y.Doc();
    copyQuickBody(from, into, [], new Map([["a", "memoca://att-a"], ["b", "memoca://att-b"]]));
    expect(outline(into)).toEqual(["paragraph:上", "image:", "bulletListItem:項目", "  image:", "paragraph:下"]);
    expect(imagesIn(into)).toEqual(["memoca://att-a 写真.png", "memoca://att-b 図.png"]);
    // The quick note's own body is left as it was: as what it was saved as.
    expect(imagesIn(from)).toEqual([`${quickImageRef("a")} 写真.png`, `${quickImageRef("b")} 図.png`]);
    expect(valid(into)).toBe(true);
  });

  test("one with no reference (never made ready) goes, its block with it, and a group left empty with that", () => {
    const from = body([
      { type: "paragraph", text: "上" },
      image("gone"),
      { type: "bulletListItem", text: "項目", children: [image("gone")] },
    ]);
    const into = new Y.Doc();
    copyQuickBody(from, into, [], new Map());
    expect(outline(into)).toEqual(["paragraph:上", "bulletListItem:項目"]);
    expect(valid(into)).toBe(true);
  });
});
