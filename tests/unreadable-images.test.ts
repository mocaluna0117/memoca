import { describe, expect, test } from "vitest";
import { markUnreadableImages } from "@/components/editor/unreadable-images";

/** Notion's copy of a line, an image and a line, as its clipboard has it. */
const NOTION = [
  "<p>上の行</p>",
  '<img src="attachment:979e4c8e-de6a-45f9-967a-1d00c8ab8123:image.png" alt="image.png">',
  "<p>下の行</p>",
].join("");

describe("images pasted that cannot be read", () => {
  test("Notion's: a line in each one's place, said to be Notion's, by its name", () => {
    const { html, count, fromNotion } = markUnreadableImages(NOTION);
    expect(count).toBe(1);
    expect(fromNotion).toBe(true);
    expect(html).not.toContain("<img");
    expect(html).toContain("（Notion の画像：image.png）");
    expect(html).toContain("上の行");
    expect(html).toContain("下の行");
  });

  test("named by the end of where it is, with no alt; another app's, not Notion's", () => {
    expect(markUnreadableImages('<img src="attachment:abc:写真.jpg">').html).toContain(
      "（Notion の画像：写真.jpg）",
    );
    const other = markUnreadableImages('<img src="file:///Users/me/a.png" alt="a.png">');
    expect(other.fromNotion).toBe(false);
    expect(other.html).toContain("（貼り付けられなかった画像：a.png）");
  });

  test("each on its own a line of its own; in a line, its text there", () => {
    const two = markUnreadableImages(
      '<img src="attachment:a:image.png" alt="image.png"><img src="attachment:b:image.png" alt="image.png">',
    );
    expect(two.html).toBe("<p>（Notion の画像：image.png）</p><p>（Notion の画像：image.png）</p>");
    expect(markUnreadableImages('<ul><li>項目<img src="attachment:c:x.png"></li></ul>').html).toBe(
      "<ul><li>項目（Notion の画像：x.png）</li></ul>",
    );
  });

  test("ones that can be read are left as they are", () => {
    const html = [
      '<img src="https://example.com/a.png">',
      '<img src="data:image/png;base64,AAAA">',
      '<img src="blob:https://memoca-app.vercel.app/1">',
      '<img src="memoca://att/abc">',
    ].join("");
    const marked = markUnreadableImages(html);
    expect(marked.count).toBe(0);
    expect(marked.html).toBe(html);
  });
});
