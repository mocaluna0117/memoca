import { BlockNoteEditor } from "@blocknote/core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { withoutColors } from "@/components/editor/colors";
import { usePlainTextCopy } from "@/components/editor/plain-copy";
import { SCHEMA } from "@/components/editor/schema";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** As a page in dark mode puts its text on the clipboard. */
const DARK = '<p><span style="background-color: rgb(33, 33, 33); color: rgb(236, 236, 236)">・11月30日（月）16:00〜18:00</span></p>';

describe("HTML copied out of a note, without colours", () => {
  test("of text, and behind it and a block, other styles kept", () => {
    expect(withoutColors(DARK)).toBe("<p><span>・11月30日（月）16:00〜18:00</span></p>");
    expect(
      withoutColors('<p style="background-color: rgb(0, 0, 0); text-align: center"><b style="color: red; font-weight: 700">x</b></p>'),
    ).toBe('<p style="text-align: center;"><b style="font-weight: 700;">x</b></p>');
    expect(withoutColors('<div style="background: #111">y</div>')).toBe("<div>y</div>");
  });

  test("none: left as it is", () => {
    const html = '<ul><li><p style="text-align: left">牛乳</p></li></ul>';
    expect(withoutColors(html)).toBe(html);
  });
});

describe("colours in a note", () => {
  test("not taken from a page pasted in", () => {
    const editor = BlockNoteEditor.create({ schema: SCHEMA });
    const [block] = editor.tryParseHTMLToBlocks(DARK);
    const [text] = block!.content as { text: string; styles: Record<string, unknown> }[];
    expect(text!.text).toBe("・11月30日（月）16:00〜18:00");
    expect(text!.styles).toEqual({});
  });

  test("one a note holds (taken before) still opens, and is copied out with none", () => {
    const editor = BlockNoteEditor.create({ schema: SCHEMA });
    editor.replaceBlocks(editor.document, [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "・12月2日", styles: { backgroundColor: "rgb(33, 33, 33)", textColor: "rgb(236, 236, 236)" } },
        ],
      },
    ]);
    const html = editor.blocksToHTMLLossy(editor.document);
    expect(html).toContain("・12月2日");
    expect(html).not.toMatch(/color/);
  });
});

function Hook({ editor }: { editor: BlockNoteEditor }) {
  usePlainTextCopy(editor);
  return null;
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

test("a copy from a note whose lines were pasted from a dark page goes to Gmail with no colours", async () => {
  const editor = BlockNoteEditor.create({ schema: SCHEMA }) as unknown as BlockNoteEditor;
  const host = document.createElement("div");
  document.body.append(host);
  editor.mount(host);
  editor.replaceBlocks(editor.document, [
    {
      type: "paragraph",
      content: [{ type: "text", text: "・12月3日", styles: { backgroundColor: "rgb(33, 33, 33)", textColor: "rgb(236, 236, 236)" } }],
    },
    // A block's own colour, as BlockNote took one from a pasted page.
    { type: "paragraph", props: { backgroundColor: "rgb(17, 17, 17)", textColor: "rgb(250, 250, 250)" }, content: "・12月4日" },
  ] as never);
  const [a, b] = editor.document;
  editor.setSelection(a!, b!);
  const box = document.createElement("div");
  document.body.append(box);
  const root = createRoot(box);
  await act(async () => root.render(createElement(Hook, { editor })));
  cleanup = () => {
    act(() => root.unmount());
    editor.unmount();
    host.remove();
    box.remove();
  };

  const data = new Map<string, string>();
  const event = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      setData: (t: string, v: string) => data.set(t, v),
      getData: (t: string) => data.get(t) ?? "",
      clearData: () => data.clear(),
    },
  });
  editor.prosemirrorView!.dom.dispatchEvent(event);

  const html = data.get("text/html") ?? "";
  expect(html).toContain("・12月3日");
  expect(html).toContain("・12月4日");
  // No colour Gmail draws (style), nor one another BlockNote takes (a block's).
  expect(html).not.toMatch(/style="[^"]*(color|background)/);
  expect(html).not.toMatch(/data-(background|text)-color/);
});
