// Every notation, typed for real, where it can be typed: a note, a quick
// note's tab, and the Todo. Each case starts from an empty line, types (or,
// for Japanese, composes and commits as an input method does, through the
// browser's own composition events), presses its keys, and records the
// blocks it made: their kind, text, depth, marks. A case whose blocks are not
// what a person would expect is a finding, with a screenshot.
//
//   UX_BASE=http://localhost:3100 node scripts/ux-explore/notations.mjs [--only=note,quick,todo] [--case=id,...]
//
// --set=more: what a person does around a notation, not the notation alone:
// ⌘Z, redo and Backspace straight after each, a notation typed before text
// that is already there or inside a list, a quote or a table, the way out of
// a code block, an item picked from a menu, marks closed at a line's end or
// around composed Japanese, keys with no pause between them. Each also says
// where the caret is left (its block, and whether it can be seen).
//
// Writes scripts/ux-explore/notations-<time>.json and shots/notation-*.png.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, webkit } from "@playwright/test";
import { BASE, LOOK, createNote, openApp, signUp } from "./lib.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? "1"];
  }),
);
const surfaces = (args.only ?? "note,quick,todo").split(",");
// --engine=webkit: Safari's engine (the Mac app's, an iPhone's). It has no way
// to compose as an input method does here, so the cases that do are left out.
const engine = args.engine === "webkit" ? webkit : chromium;
// --device=phone: a phone's width, with touch.
const VIEW =
  args.device === "phone"
    ? { viewport: { width: 390, height: 844 }, isMobile: engine === chromium, hasTouch: true }
    : { viewport: { width: 1280, height: 800 } };
const onlyCases = args.case ? new Set(args.case.split(",")) : null;
const more = args.set === "more";
const SHOTS = join(import.meta.dirname, "shots");
mkdirSync(SHOTS, { recursive: true });

/** The blocks under an editor: kind, depth, text, attributes, marks. */
const read = (root) =>
  root.evaluate((editor) =>
    [...editor.querySelectorAll(".bn-block-content")].map((content) => {
      let depth = 0;
      for (let at = content.parentElement; at && at !== editor; at = at.parentElement) {
        if (at.classList.contains("bn-block-group")) depth += 1;
      }
      const inline = content.querySelector(".bn-inline-content");
      const marks = inline
        ? [...inline.querySelectorAll("strong,em,s,code,u,a")].map(
            (each) => `${each.tagName.toLowerCase()}:${each.textContent}`,
          )
        : [];
      const box = content.querySelector('input[type="checkbox"]');
      return {
        depth: Math.max(0, depth - 1),
        type: content.dataset.contentType ?? "",
        text: (inline ?? content).textContent ?? "",
        level: content.dataset.contentType === "heading" ? content.dataset.level ?? "1" : undefined,
        index: content.dataset.index ?? undefined,
        checked: box ? box.checked : undefined,
        marks,
      };
    }),
  );

const brief = (blocks) =>
  blocks.map(
    (b) =>
      `${"  ".repeat(b.depth)}${b.type}${b.level ? b.level : ""}${b.checked === undefined ? "" : b.checked ? "[x]" : "[ ]"}${b.index ? `#${b.index}` : ""}:${JSON.stringify(b.text)}${b.marks.length ? " " + b.marks.join(",") : ""}`,
  );

/** Where the caret is: the block it is in (counted as `read` counts), its text before the caret, and whether it can be seen. */
const caretOf = (root) =>
  root.evaluate((editor) => {
    const selection = getSelection();
    if (!selection || selection.rangeCount === 0 || !editor.contains(selection.anchorNode)) return null;
    const contents = [...editor.querySelectorAll(".bn-block-content")];
    const node = selection.anchorNode.nodeType === Node.TEXT_NODE ? selection.anchorNode.parentElement : selection.anchorNode;
    const content = node.closest(".bn-block-content") ?? node.querySelector?.(".bn-block-content");
    const range = selection.getRangeAt(0).cloneRange();
    let before = null;
    const inline = content?.querySelector(".bn-inline-content");
    if (inline && inline.contains(selection.anchorNode)) {
      const lead = document.createRange();
      lead.selectNodeContents(inline);
      lead.setEnd(selection.anchorNode, selection.anchorOffset);
      before = lead.toString();
    }
    let box = range.getClientRects()[0] ?? null;
    if (!box && node.getBoundingClientRect) box = node.getBoundingClientRect();
    const seen = !!box && box.bottom > 0 && box.top < innerHeight && box.right >= 0 && box.left <= innerWidth;
    return { block: content ? contents.indexOf(content) : -1, before, collapsed: selection.isCollapsed, seen };
  });

/** Composes `text` as an input method does (shown, then committed). */
async function compose(page, cdp, text) {
  await cdp.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
  await page.waitForTimeout(30);
  await cdp.send("Input.insertText", { text });
  await page.waitForTimeout(30);
}

/** Runs a case's steps: "type:…" types keys, "ime:…" composes and commits, "press:…" presses, "insert:…" inserts as typed with the IME on (a full-width space), "home:" moves to the line's start, "wait:ms". */
async function play(page, cdp, steps) {
  for (const step of steps) {
    const [kind, ...rest] = step.split(":");
    const value = rest.join(":");
    if (kind === "type") await page.keyboard.type(value, { delay: 15 });
    // Keys with no pause between them, as a fast typist's.
    else if (kind === "fast") await page.keyboard.type(value, { delay: 0 });
    else if (kind === "end") await page.evaluate(() => getSelection()?.modify("move", "forward", "lineboundary"));
    // "repeat:Enter:40"
    else if (kind === "repeat") for (let i = 0; i < Number(rest[1]); i++) await page.keyboard.press(rest[0]);
    else if (kind === "press") await page.keyboard.press(value);
    else if (kind === "ime") await compose(page, cdp, value);
    else if (kind === "insert") await page.keyboard.insertText(value);
    else if (kind === "wait") await page.waitForTimeout(Number(value));
    else if (kind === "home") await page.evaluate(() => getSelection()?.modify("move", "backward", "lineboundary"));
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(250);
}

const only = (blocks) => blocks.filter((b) => !(b.type === "paragraph" && b.text === "" && b !== blocks[0]));
const is = (type, text, more = {}) => (b) =>
  b?.type === type && b.text === text && Object.entries(more).every(([k, v]) => b[k] === v);
const first = (pred) => (blocks) => pred(only(blocks)[0]);
const seq = (...preds) => (blocks) => {
  const list = only(blocks);
  return list.length === preds.length && preds.every((pred, i) => pred(list[i]));
};

// The cases. `want` is what a person would expect; `todo` overrides it for the
// Todo, where every line is a check item (or a plain 補足行 under one).
const CASES = [
  { id: "h1", steps: ["type:# 見出し"], want: "見出し 1", ok: first(is("heading", "見出し", { level: "1" })) },
  { id: "h2", steps: ["type:## 見出し"], want: "見出し 2", ok: first(is("heading", "見出し", { level: "2" })) },
  { id: "h3", steps: ["type:### 見出し"], want: "見出し 3", ok: first(is("heading", "見出し", { level: "3" })) },
  { id: "h4", steps: ["type:#### 見出し"], want: "見出し 4（無ければ文字のまま）", ok: (b) => first(is("heading", "見出し", { level: "4" }))(b) || first(is("paragraph", "#### 見出し"))(b) },
  { id: "h-enter", steps: ["type:# 見出し", "press:Enter", "type:本文"], want: "見出しの次は段落", ok: seq(is("heading", "見出し", { level: "1" }), is("paragraph", "本文")) },
  { id: "bullet-dash", steps: ["type:- 項目"], want: "箇条書き", ok: first(is("bulletListItem", "項目")) },
  { id: "bullet-star", steps: ["type:* 項目"], want: "箇条書き", ok: first(is("bulletListItem", "項目")) },
  { id: "bullet-plus", steps: ["type:+ 項目"], want: "箇条書き", ok: first(is("bulletListItem", "項目")) },
  { id: "bullet-enter-twice", steps: ["type:- a", "press:Enter", "press:Enter", "type:b"], want: "空の項目で Enter → 段落", ok: seq(is("bulletListItem", "a"), is("paragraph", "b")) },
  { id: "bullet-backspace-after", steps: ["type:- ", "press:Backspace"], want: "直後の Backspace で「- 」に戻るか、空の段落", ok: (b) => first(is("paragraph", "- "))(b) || first(is("paragraph", "-"))(b) || first(is("paragraph", ""))(b) },
  { id: "bullet-undo-after", steps: ["type:- ", "press:ControlOrMeta+z"], want: "直後の ⌘Z で「- 」の文字に戻る", ok: (b) => first(is("paragraph", "- "))(b) },
  { id: "bullet-tab", steps: ["type:- a", "press:Enter", "press:Tab", "type:b"], want: "Tab で 1 段下げる", ok: (b) => only(b).length === 2 && only(b)[1].type === "bulletListItem" && only(b)[1].depth === 1 },
  { id: "bullet-shift-tab", steps: ["type:- a", "press:Enter", "press:Tab", "type:b", "press:Shift+Tab"], want: "Shift+Tab で戻す", ok: (b) => only(b).length === 2 && only(b)[1].depth === 0 },
  { id: "bullet-start-backspace", steps: ["type:- a", "home:", "press:Backspace"], want: "行頭の Backspace で段落に", ok: first(is("paragraph", "a")) },
  { id: "numbered", steps: ["type:1. いち", "press:Enter", "type:に"], want: "番号付き 2 行", ok: seq(is("numberedListItem", "いち"), is("numberedListItem", "に")) },
  { id: "numbered-3", steps: ["type:3. さん"], want: "3 から始まる番号付き", ok: first(is("numberedListItem", "さん", { index: "3" })) },
  { id: "check-empty", steps: ["type:[] 項目"], want: "チェック項目", ok: first(is("checkListItem", "項目", { checked: false })) },
  { id: "check-space", steps: ["type:[ ] 項目"], want: "チェック項目", ok: first(is("checkListItem", "項目", { checked: false })) },
  { id: "check-x", steps: ["type:[x] 項目"], want: "チェック済み", ok: first(is("checkListItem", "項目", { checked: true })) },
  { id: "check-enter", steps: ["type:[] a", "press:Enter", "type:b"], want: "次も未チェックの項目", ok: seq(is("checkListItem", "a", { checked: false }), is("checkListItem", "b", { checked: false })) },
  { id: "quote", steps: ["type:> 引用"], want: "引用", ok: first(is("quote", "引用")) },
  { id: "quote-enter", steps: ["type:> 引用", "press:Enter", "type:次"], want: "引用の次（引用か段落）", ok: (b) => only(b).length === 2 && only(b)[1].text === "次" },
  { id: "code-space", steps: ["type:``` "], want: "コードブロック", ok: (b) => only(b)[0]?.type === "codeBlock" },
  { id: "code-enter", steps: ["type:```", "press:Enter", "type:x = 1", "press:Enter", "type:y = 2"], want: "コードブロックの中で改行", ok: (b) => only(b)[0]?.type === "codeBlock" && only(b)[0].text.includes("x = 1") && only(b)[0].text.includes("y = 2") },
  { id: "divider", steps: ["type:---"], want: "区切り線（無ければ文字のまま）", ok: (b) => only(b)[0]?.type === "divider" || first(is("paragraph", "---"))(b) },
  { id: "bold", steps: ["type:**太字** あと"], want: "太字", ok: (b) => only(b)[0]?.marks.includes("strong:太字") },
  { id: "italic-star", steps: ["type:*斜体* あと"], want: "斜体", ok: (b) => only(b)[0]?.marks.includes("em:斜体") },
  { id: "italic-under", steps: ["type:_斜体_ あと"], want: "斜体", ok: (b) => only(b)[0]?.marks.includes("em:斜体") },
  { id: "strike", steps: ["type:~~消す~~ あと"], want: "取り消し線", ok: (b) => only(b)[0]?.marks.includes("s:消す") },
  { id: "code-inline", steps: ["type:`code` あと"], want: "インラインコード", ok: (b) => only(b)[0]?.marks.includes("code:code") },
  { id: "url-space", steps: ["type:https://example.com/a あと"], want: "URL がリンクに", ok: (b) => only(b)[0]?.marks.some((m) => m.startsWith("a:https://example.com/a")) },
  { id: "url-enter", steps: ["type:https://example.com/b", "press:Enter", "type:次"], want: "URL の直後の Enter で改行（リンクのまま）", ok: (b) => only(b).length === 2 && only(b)[1].text === "次" },
  // As typed with a Japanese input method: composed, committed, then a full-width space.
  { id: "ja-choon", steps: ["ime:ー", "insert:　", "ime:項目"], want: "ー＋全角空白 → 箇条書き", ok: first(is("bulletListItem", "項目")) },
  { id: "ja-number", steps: ["ime:１．", "insert:　", "ime:いち"], want: "１．＋全角空白 → 番号付き", ok: first(is("numberedListItem", "いち")) },
  { id: "ja-kagi", steps: ["ime:「」", "insert:　", "ime:買う"], want: "「」＋全角空白 → チェック項目", ok: first(is("checkListItem", "買う", { checked: false })) },
  { id: "ja-kagi-x", steps: ["ime:「x」", "insert:　", "ime:済み"], want: "「x」＋全角空白 → チェック済み", ok: first(is("checkListItem", "済み", { checked: true })) },
  { id: "ja-nakaguro", steps: ["ime:・", "insert:　", "ime:項目"], want: "・＋全角空白（変えないなら文字のまま）", ok: (b) => first(is("bulletListItem", "項目"))(b) || first(is("paragraph", "・　項目"))(b) },
  { id: "ja-sentence-dash", steps: ["ime:ーー", "insert:　", "ime:文"], want: "ーー（2 つ）は文のまま", ok: first(is("paragraph", "ーー　文")) },
  { id: "ja-kagi-quote", steps: ["ime:「こんにちは」", "press:Enter", "type:x"], want: "「…」で始まる行は文のまま（引用にならない）", ok: (b) => only(b)[0]?.type === "paragraph" },
  { id: "ja-heading-fullwidth", steps: ["ime:＃", "insert:　", "ime:見出し"], want: "＃＋全角空白（変えないなら文字のまま）", ok: (b) => first(is("heading", "見出し", { level: "1" }))(b) || first(is("paragraph", "＃　見出し"))(b) },
  { id: "slash-menu", steps: ["type:/"], want: "スラッシュメニューが出る", menu: true },
  { id: "slash-fullwidth", steps: ["ime:／"], want: "全角の／でもメニュー（出ないなら文字のまま）", menu: true, soft: true },
  { id: "note-link", steps: ["type:[["], want: "メモへのリンクの候補が出る", menu: true, surfaces: ["note"] },
];

// --set=more. `ok` is given the blocks and the caret; "soft" ones record what
// happens where there is no one right answer.
const para = (text) => is("paragraph", text);
const plain = (b) => b && b.marks.length === 0;
const MORE_CASES = [
  // ⌘Z, redo and Backspace straight after each turn of a line.
  { id: "h1-undo", steps: ["type:# ", "press:ControlOrMeta+z"], want: "⌘Z で「# 」の文字に戻る", ok: first(para("# ")) },
  { id: "h1-backspace", steps: ["type:# ", "press:Backspace"], want: "Backspace で文字に戻るか空の段落", ok: (b) => only(b).length === 1 && only(b)[0].type === "paragraph" },
  { id: "h1-undo-typed", steps: ["type:# 見出し", "press:ControlOrMeta+z"], want: "打った文字だけ戻る（見出しのまま）", ok: first(is("heading", "", { level: "1" })) },
  { id: "bullet-undo-typed", steps: ["type:- 項目", "press:ControlOrMeta+z"], want: "打った文字だけ戻る（箇条書きのまま）", ok: first(is("bulletListItem", "")) },
  { id: "numbered-undo", steps: ["type:1. ", "press:ControlOrMeta+z"], want: "⌘Z で「1. 」に戻る", ok: first(para("1. ")) },
  { id: "numbered-backspace", steps: ["type:1. ", "press:Backspace"], want: "Backspace で文字に戻るか空の段落", ok: (b) => only(b).length === 1 && only(b)[0].type === "paragraph" },
  { id: "check-undo", steps: ["type:[] ", "press:ControlOrMeta+z"], want: "⌘Z で「[] 」に戻る", ok: first(para("[] ")) },
  { id: "check-backspace", steps: ["type:[] ", "press:Backspace"], want: "Backspace で文字に戻るか空の段落", ok: (b) => only(b).length === 1 && only(b)[0].type === "paragraph" },
  { id: "quote-undo", steps: ["type:> ", "press:ControlOrMeta+z"], want: "⌘Z で「> 」に戻る", ok: first(para("> ")) },
  { id: "quote-backspace", steps: ["type:> ", "press:Backspace"], want: "Backspace で文字に戻るか空の段落", ok: (b) => only(b).length === 1 && only(b)[0].type === "paragraph" },
  { id: "code-undo", steps: ["type:``` ", "press:ControlOrMeta+z"], want: "⌘Z で「``` 」に戻る", ok: first(para("``` ")) },
  { id: "code-backspace", steps: ["type:``` ", "press:Backspace"], want: "Backspace で段落に戻る", ok: (b) => only(b).length === 1 && only(b)[0].type === "paragraph" },
  { id: "divider-undo", steps: ["type:---", "press:ControlOrMeta+z"], want: "⌘Z で「---」（か「--」）に戻る", ok: (b) => first(para("---"))(b) || first(para("--"))(b) },
  { id: "divider-backspace", steps: ["type:---", "press:Backspace"], want: "Backspace で線が消えるか文字に戻る", ok: (b) => !b.some((x) => x.type === "divider") },
  { id: "bold-undo", steps: ["type:これは **太字**", "press:ControlOrMeta+z"], want: "⌘Z で記号つきの文字に戻る（前の文字は残る）", ok: (b) => only(b)[0]?.text === "これは **太字**" && plain(only(b)[0]) },
  { id: "bold-undo-after-space", steps: ["type:**太字** ", "press:ControlOrMeta+z"], want: "太字のあとに打った空白だけ戻る", ok: (b) => only(b)[0]?.text === "太字" && only(b)[0].marks.join() === "strong:太字" },
  { id: "bold-backspace", steps: ["type:**太字**", "press:Backspace"], want: "直後の Backspace で記号つきの文字に戻る（1 つだけ）", ok: (b) => only(b)[0]?.text === "**太字**" && plain(only(b)[0]) },
  { id: "bold-undo-then-type", steps: ["type:**太字**", "press:ControlOrMeta+z", "type: です"], want: "戻したあとは文字のまま打てる", ok: (b) => only(b)[0]?.text === "**太字** です" && plain(only(b)[0]) },
  { id: "code-inline-undo", steps: ["type:`code`", "press:ControlOrMeta+z"], want: "⌘Z で記号つきの文字に戻る", ok: (b) => only(b)[0]?.text === "`code`" && plain(only(b)[0]) },
  { id: "strike-undo", steps: ["type:~~消す~~", "press:ControlOrMeta+z"], want: "⌘Z で記号つきの文字に戻る", ok: (b) => only(b)[0]?.text === "~~消す~~" && plain(only(b)[0]) },
  { id: "italic-undo", steps: ["type:*斜体*", "press:ControlOrMeta+z"], want: "⌘Z で記号つきの文字に戻る", ok: (b) => only(b)[0]?.text === "*斜体*" && plain(only(b)[0]) },
  { id: "bullet-redo", steps: ["type:- ", "press:ControlOrMeta+z", "press:ControlOrMeta+Shift+z"], want: "やり直しで箇条書きに戻る", ok: first(is("bulletListItem", "")) },
  { id: "bullet-undo-twice", steps: ["type:- ", "press:ControlOrMeta+z", "press:ControlOrMeta+z"], want: "2 回目で空の行", ok: first(para("")) },
  { id: "bullet-undo-then-type", steps: ["type:- ", "press:ControlOrMeta+z", "type:x"], want: "戻したあとは文字のまま打てる（「- x」）", ok: first(para("- x")) },
  { id: "ja-choon-undo", steps: ["ime:ー", "insert:　", "press:ControlOrMeta+z"], want: "⌘Z で「ー　」に戻る", ok: first(para("ー　")) },
  { id: "ja-kagi-undo", steps: ["ime:「」", "insert:　", "press:ControlOrMeta+z"], want: "⌘Z で「「」　」に戻る", ok: first(para("「」　")) },
  { id: "ja-nakaguro-undo", steps: ["ime:・", "press:ControlOrMeta+z"], want: "⌘Z で「・」に戻る", ok: first(para("・")) },
  { id: "enter-undo", steps: ["type:あ", "wait:700", "press:Enter", "type:い", "wait:700", "press:ControlOrMeta+z"], want: "⌘Z で「い」が消える（「あ」は残る）", ok: (b) => only(b)[0]?.text === "あ" && !b.some((x) => x.text === "い") },

  // A notation typed before text that is already there.
  { id: "h1-on-text", steps: ["type:本文", "home:", "type:# "], want: "文字を保って見出しに", ok: first(is("heading", "本文", { level: "1" })), caret: (c) => c.before === "" },
  { id: "bullet-on-text", steps: ["type:本文", "home:", "type:- "], want: "文字を保って箇条書きに", ok: first(is("bulletListItem", "本文")), caret: (c) => c.before === "" },
  { id: "numbered-on-text", steps: ["type:本文", "home:", "type:1. "], want: "文字を保って番号付きに", ok: first(is("numberedListItem", "本文")) },
  { id: "check-on-text", steps: ["type:本文", "home:", "type:[] "], want: "文字を保ってチェック項目に", ok: first(is("checkListItem", "本文", { checked: false })) },
  { id: "quote-on-text", steps: ["type:本文", "home:", "type:> "], want: "文字を保って引用に", ok: first(is("quote", "本文")) },
  { id: "ja-choon-on-text", steps: ["type:本文", "home:", "ime:ー", "insert:　"], want: "文字を保って箇条書きに", ok: first(is("bulletListItem", "本文")) },
  { id: "ja-nakaguro-on-text", steps: ["type:本文", "home:", "ime:・"], want: "文の頭の「・」（箇条書きか文字のまま。文字は保つ）", ok: (b) => only(b).length === 1 && only(b)[0].text.endsWith("本文"), soft: true },
  { id: "nakaguro-mid-sentence", steps: ["type:りんご", "ime:・", "type:みかん"], want: "文の途中の「・」は文字のまま", ok: first(para("りんご・みかん")) },
  { id: "dash-mid-sentence", steps: ["type:a - b"], want: "文の途中の「- 」は文字のまま", ok: first(para("a - b")) },
  { id: "hash-mid-sentence", steps: ["type:C# は言語"], want: "文の途中の「# 」は文字のまま", ok: first(para("C# は言語")) },
  { id: "number-mid-sentence", steps: ["type:全部で 3. 以上"], want: "文の途中の「3. 」は文字のまま", ok: first(para("全部で 3. 以上")) },
  { id: "year-as-number", steps: ["type:2026. 年"], want: "「2026. 」（番号付きになるなら 2026 から）", ok: (b) => first(para("2026. 年"))(b) || first(is("numberedListItem", "年", { index: "2026" }))(b), soft: true },

  // One notation inside another.
  { id: "bullet-to-heading", steps: ["type:- 項目", "home:", "type:# "], want: "箇条書きの頭で「# 」→ 見出し（文字は保つ）", ok: (b) => only(b).length === 1 && only(b)[0].text === "項目", soft: true },
  { id: "bullet-then-check", steps: ["type:- [] 項目"], want: "「- [] 」→ チェック項目", ok: first(is("checkListItem", "項目", { checked: false })) },
  { id: "bullet-then-check-x", steps: ["type:- [x] 項目"], want: "「- [x] 」→ チェック済み", ok: first(is("checkListItem", "項目", { checked: true })) },
  { id: "nested-numbered", steps: ["type:- a", "press:Enter", "press:Tab", "type:1. b"], want: "箇条書きの中の番号付き", ok: (b) => only(b).length === 2 && only(b)[1].type === "numberedListItem" && only(b)[1].depth === 1 && only(b)[1].text === "b" },
  { id: "nested-enter-out", steps: ["type:- a", "press:Enter", "press:Tab", "type:b", "press:Enter", "press:Enter", "type:c"], want: "下げた空の項目で Enter → 1 段戻る", ok: (b) => only(b).length === 3 && only(b)[2].type === "bulletListItem" && only(b)[2].text === "c" && only(b)[2].depth === 0 },
  { id: "nested-enter-twice", steps: ["type:- a", "press:Enter", "press:Tab", "type:b", "press:Enter", "press:Enter", "press:Enter", "type:c"], want: "もう一度 Enter で段落に", ok: (b) => only(b).length === 3 && only(b)[2].type === "paragraph" && only(b)[2].depth === 0 && only(b)[2].text === "c" },
  { id: "numbered-continues", steps: ["type:1. a", "press:Enter", "type:b", "press:Enter", "type:c"], want: "1, 2, 3 と続く", ok: (b) => only(b).map((x) => x.index).join() === "1,2,3" },
  { id: "numbered-mid-enter", steps: ["type:1. ab", "press:ArrowLeft", "press:Enter"], want: "途中の Enter で 2 項目に分かれる", ok: seq(is("numberedListItem", "a"), is("numberedListItem", "b")), caret: (c) => c.block === 1 && c.before === "" },
  { id: "check-x-enter", steps: ["type:[x] a", "press:Enter", "type:b"], want: "チェック済みの次は未チェック", ok: seq(is("checkListItem", "a", { checked: true }), is("checkListItem", "b", { checked: false })) },
  { id: "heading-mid-enter", steps: ["type:# 見出し", "press:ArrowLeft", "press:ArrowLeft", "press:Enter"], want: "見出しの途中の Enter（「見」と「出し」）", ok: (b) => only(b).length === 2 && only(b)[0].text === "見" && only(b)[1].text === "出し" },
  { id: "heading-start-backspace", steps: ["type:# 見出し", "home:", "press:Backspace"], want: "見出しの頭の Backspace で段落に", ok: first(para("見出し")) },
  { id: "quote-start-backspace", steps: ["type:> 引用", "home:", "press:Backspace"], want: "引用の頭の Backspace で段落に", ok: first(para("引用")) },
  { id: "check-start-backspace", steps: ["type:[] 項目", "home:", "press:Backspace"], want: "チェック項目の頭の Backspace で段落に", ok: first(para("項目")) },
  { id: "quote-then-bullet", steps: ["type:> ", "type:- 項目"], want: "引用の中で「- 」（引用のままか箇条書き。文字は保つ）", ok: (b) => only(b).length === 1 && only(b)[0].text.endsWith("項目"), soft: true },
  { id: "table-notation", steps: ["type:/表", "press:Enter", "type:- a", "press:Tab", "type:# b"], want: "表のセルでは文字のまま、Tab で次のセル", ok: (b) => b.some((x) => x.type === "table" && x.text.includes("- a") && x.text.includes("# b")) },
  { id: "toggle-notation", steps: ["type:/折りたたみリスト", "press:Enter", "type:題", "press:Enter", "type:- 中"], want: "折りたたみの中で箇条書き", ok: (b) => b.some((x) => x.type === "bulletListItem" && x.text === "中"), soft: true },

  // Out of a code block; on from a divider.
  { id: "code-exit-enter", steps: ["type:```", "press:Enter", "type:x", "press:Enter", "press:Enter", "press:Enter", "type:後"], want: "末尾の空行で Enter を重ねると外へ出られる", ok: (b) => only(b).at(-1)?.type === "paragraph" && only(b).at(-1)?.text === "後" },
  { id: "code-exit-arrow", steps: ["type:```", "press:Enter", "type:x", "press:ArrowDown", "type:後"], want: "↓ で外の行へ出られる", ok: (b) => only(b).at(-1)?.type === "paragraph" && only(b).at(-1)?.text === "後" },
  { id: "code-exit-mod-enter", steps: ["type:```", "press:Enter", "type:x", "press:ControlOrMeta+Enter", "type:後"], want: "⌘Enter で外へ（効かないなら文字のまま）", ok: (b) => only(b).at(-1)?.type === "paragraph" && only(b).at(-1)?.text === "後", soft: true },
  { id: "code-notation-inside", steps: ["type:```", "press:Enter", "type:- a", "press:Enter", "type:# b **c** "], want: "コードの中では記法が働かない", ok: (b) => only(b)[0]?.type === "codeBlock" && only(b)[0].text.includes("- a") && only(b)[0].text.includes("# b **c**") },
  { id: "code-tab", steps: ["type:```", "press:Enter", "type:a", "press:Enter", "press:Tab", "type:b"], want: "コードの中の Tab は字下げ（外へ出ない）", ok: (b) => only(b)[0]?.type === "codeBlock" && /a\n\s+b/.test(only(b)[0].text) },
  { id: "divider-then-type", steps: ["type:---", "type:後"], want: "線の次の行に打てる", ok: (b) => b[0]?.type === "divider" && b[1]?.type === "paragraph" && b[1].text === "後" },
  { id: "divider-after-text", steps: ["type:前", "press:Enter", "type:---", "type:後"], want: "前・線・後", ok: (b) => b.map((x) => x.type).join() === "paragraph,divider,paragraph" && b[2].text === "後" },

  // An item picked from a menu.
  { id: "slash-pick", steps: ["type:/見出し", "press:Enter", "type:題"], want: "メニューから見出しを選んで打てる", ok: (b) => only(b)[0]?.type === "heading" && only(b)[0].text === "題" },
  { id: "slash-pick-ime", steps: ["type:/", "ime:みだし", "press:Enter", "type:題"], want: "日本語入力で絞り込んで選べる（読みでも）", ok: (b) => only(b)[0]?.type === "heading" && only(b)[0].text === "題" },
  { id: "slash-pick-ime-kanji", steps: ["type:/", "ime:見出し", "press:Enter", "type:題"], want: "日本語入力で絞り込んで選べる", ok: (b) => only(b)[0]?.type === "heading" && only(b)[0].text === "題" },
  { id: "slash-escape", steps: ["type:/", "press:Escape", "type:a"], want: "Esc で閉じて、そのまま打てる（「/a」）", ok: first(para("/a")) },
  { id: "slash-no-match", steps: ["type:/zzzz", "press:Enter", "type:次"], want: "当てはまらないときの Enter は改行", ok: (b) => only(b).length === 2 && only(b)[0].text === "/zzzz" && only(b)[1].text === "次", soft: true },
  { id: "slash-after-japanese", steps: ["type:きょうの予定", "type:/見出し", "press:Enter"], want: "日本語の行の末尾の「/」でその行が見出しに", ok: (b) => only(b).length === 1 && only(b)[0].type === "heading" && only(b)[0].text === "きょうの予定" },
  { id: "date-slash", steps: ["type:11/13 の予定", "press:Enter", "type:次"], want: "日付の「/」ではメニューが出ない", ok: seq(para("11/13 の予定"), para("次")) },
  { id: "note-link-pick", steps: ["type:[[", "press:Enter", "type: あと"], want: "候補を選ぶとメモへのリンクが入り、続けて打てる", ok: (b) => only(b).length === 1 && only(b)[0].text.includes("あと") && !only(b)[0].text.includes("[["), surfaces: ["note"] },
  { id: "note-link-escape", steps: ["type:[[", "press:Escape", "type:a"], want: "Esc で閉じて、そのまま打てる", ok: (b) => only(b)[0]?.text.startsWith("[[") && only(b)[0].text.endsWith("a"), surfaces: ["note"] },

  // Marks: closed at a line's end, around composed Japanese, and what must not be one.
  { id: "bold-enter", steps: ["type:**太字**", "press:Enter", "type:次"], want: "行末で閉じた太字（Enter の前に空白が要るなら文字のまま）。次の行は太字にならない", ok: (b) => only(b).length === 2 && plain(only(b)[1]), soft: true },
  { id: "bold-then-plain", steps: ["type:**太字** あと"], want: "太字のあとは太字でない", ok: (b) => only(b)[0]?.marks.join() === "strong:太字" && only(b)[0].text === "太字 あと" },
  { id: "bold-ime", steps: ["type:**", "ime:太字", "type:** あと"], want: "日本語入力をはさんだ太字", ok: (b) => only(b)[0]?.marks.includes("strong:太字") },
  { id: "code-inline-ime", steps: ["type:`", "ime:コード", "type:` あと"], want: "日本語入力をはさんだコード", ok: (b) => only(b)[0]?.marks.includes("code:コード") },
  { id: "bold-mid-spaced", steps: ["type:これは **重要** です"], want: "空白のあとの太字", ok: (b) => only(b)[0]?.marks.includes("strong:重要") },
  { id: "bold-italic", steps: ["type:***両方*** あと"], want: "太字かつ斜体（どちらか片方でも可）", ok: (b) => only(b)[0]?.marks.length > 0 && !only(b)[0].text.includes("*"), soft: true },
  { id: "snake-case", steps: ["type:my_var_name と user_id_list です"], want: "英単語の中の _ は斜体にならない", ok: (b) => plain(only(b)[0]) && only(b)[0].text === "my_var_name と user_id_list です" },
  { id: "glob", steps: ["type:ls *.txt *.md を実行"], want: "* を 2 つ含む行は斜体にならない", ok: (b) => plain(only(b)[0]) && only(b)[0].text === "ls *.txt *.md を実行" },
  { id: "sql-stars", steps: ["type:SELECT * FROM a; SELECT * FROM b"], want: "* を 2 つ含む行は斜体にならない", ok: (b) => plain(only(b)[0]) && only(b)[0].text === "SELECT * FROM a; SELECT * FROM b" },
  { id: "underscore-spaced", steps: ["type:a _ b _ c"], want: "空白にはさまれた _ は斜体にならない", ok: (b) => plain(only(b)[0]) && only(b)[0].text === "a _ b _ c" },
  { id: "multiply", steps: ["type:2 * 3 * 4 = 24"], want: "かけ算の * は斜体にならない", ok: (b) => plain(only(b)[0]) && only(b)[0].text === "2 * 3 * 4 = 24" },
  { id: "tilde-range", steps: ["type:10~~20 と 30~~40 です"], want: "「~~」の範囲（取り消し線になりうる）", ok: (b) => plain(only(b)[0]), soft: true },
  { id: "path-with-underscores", steps: ["type:/tmp/_a_/b と書く"], want: "パスの _ は斜体にならない", ok: (b) => plain(only(b)[0]) && only(b)[0].text === "/tmp/_a_/b と書く", soft: true },
  { id: "email", steps: ["type:foo@example.com に送る"], want: "メールアドレス（リンクでもそのままでも、文字は保つ）", ok: (b) => only(b)[0]?.text === "foo@example.com に送る", soft: true },
  { id: "url-paren", steps: ["type:（https://example.com/a）を見る"], want: "かっこの中の URL（閉じかっこまでリンクにしない）", ok: (b) => only(b)[0]?.marks.some((m) => m === "a:https://example.com/a"), soft: true },
  { id: "url-period", steps: ["type:https://example.com/a. Next"], want: "URL の直後のピリオドはリンクに入らない", ok: (b) => only(b)[0]?.marks.some((m) => m === "a:https://example.com/a"), soft: true },

  // Keys with no pause between them.
  { id: "fast-bullet", steps: ["fast:- 項目", "press:Enter", "fast:次"], want: "速く打っても箇条書き 2 項目", ok: seq(is("bulletListItem", "項目"), is("bulletListItem", "次")) },
  { id: "fast-heading", steps: ["fast:## 見出し", "press:Enter", "fast:本文"], want: "速く打っても見出し 2 と段落", ok: seq(is("heading", "見出し", { level: "2" }), para("本文")) },
  { id: "fast-check", steps: ["fast:[] a", "press:Enter", "fast:[x] b"], want: "速く打ってもチェック項目", ok: (b) => only(b).length === 2 && only(b).every((x) => x.type === "checkListItem") },
  { id: "fast-numbered", steps: ["fast:1. a", "press:Enter", "fast:b", "press:Enter", "fast:c"], want: "速く打っても 1, 2, 3", ok: (b) => only(b).map((x) => x.index).join() === "1,2,3" },
  { id: "fast-marks", steps: ["fast:**太字** と `code` と ~~消す~~ です"], want: "速く打っても 3 つの書式", ok: (b) => ["strong:太字", "code:code", "s:消す"].every((m) => only(b)[0]?.marks.includes(m)) },
  { id: "fast-code-block", steps: ["fast:```", "press:Enter", "fast:x = 1", "press:Enter", "fast:y = 2"], want: "速く打ってもコードブロック", ok: (b) => only(b)[0]?.type === "codeBlock" && only(b)[0].text.includes("x = 1") && only(b)[0].text.includes("y = 2") },
  { id: "fast-undo-burst", steps: ["fast:- a", "press:Enter", "fast:b", "press:ControlOrMeta+z", "press:ControlOrMeta+z", "press:ControlOrMeta+z", "press:ControlOrMeta+z", "press:ControlOrMeta+z", "fast:x"], want: "⌘Z を重ねても壊れず、続けて打てる", ok: (b) => only(b).length >= 1 && only(b).at(-1).text.endsWith("x") },

  // Far down a long note: the caret stays in sight as the line turns.
  { id: "deep-heading", steps: ["repeat:Enter:45", "type:# 見出し"], want: "長いメモの末尾でも、打っている行が見えている", ok: (b) => b.at(-1)?.type === "heading" && b.at(-1).text === "見出し" },
  { id: "deep-bullets", steps: ["repeat:Enter:45", "type:- a", "press:Enter", "type:b", "press:Enter", "type:c"], want: "長いメモの末尾で項目を足しても見えている", ok: (b) => b.at(-1)?.type === "bulletListItem" && b.at(-1).text === "c" },
  { id: "deep-code", steps: ["repeat:Enter:45", "type:```", "press:Enter", "type:x", "press:Enter", "type:y"], want: "長いメモの末尾のコードブロックでも見えている", ok: (b) => b.at(-1)?.type === "codeBlock" },
];

/** In the Todo, every line stays a check item; what is typed stays as text, or is refused. */
const TODO_OK = (blocks) => only(blocks).every((b) => b.type === "checkListItem" || b.type === "paragraph");

// The Todo's own: each typed on a new item at its end ("new:" makes one), and
// judged by its last blocks.
const last = (blocks, n = 1) => blocks.slice(-n);
const TODO_CASES = [
  { id: "t-plain", steps: ["new:", "type:牛乳を買う"], want: "チェック項目", ok: (b) => is("checkListItem", "牛乳を買う")(last(b)[0]) },
  { id: "t-heading", steps: ["new:", "type:# 見出し"], want: "チェック項目のまま（# は文字）", ok: (b) => last(b)[0].type === "checkListItem" },
  { id: "t-bullet", steps: ["new:", "type:- 卵"], want: "チェック項目のまま", ok: (b) => last(b)[0].type === "checkListItem" },
  { id: "t-check-syntax", steps: ["new:", "type:[] パン"], want: "チェック項目（「[] 」は消えるのが自然）", ok: (b) => is("checkListItem", "パン")(last(b)[0]) },
  { id: "t-ja-kagi", steps: ["new:", "ime:「」", "insert:　", "ime:りんご"], want: "チェック項目（「」は消えるのが自然）", ok: (b) => is("checkListItem", "りんご")(last(b)[0]) },
  { id: "t-enter", steps: ["new:", "type:a", "press:Enter", "type:b"], want: "次もチェック項目", ok: (b) => last(b, 2).every((x) => x.type === "checkListItem") && last(b)[0].text === "b" },
  { id: "t-enter-empty", steps: ["new:", "type:c", "press:Enter", "press:Enter", "type:d"], want: "空の項目で Enter しても項目のまま（Todo は項目だけ）", ok: (b) => last(b)[0].type === "checkListItem" && last(b)[0].text === "d" },
  { id: "t-tab", steps: ["new:", "type:e", "press:Enter", "press:Tab", "type:補足"], want: "Tab で補足行", ok: (b) => last(b)[0].type === "paragraph" && last(b)[0].depth === 1 && last(b)[0].text === "補足" },
  { id: "t-sub-enter", steps: ["new:", "type:f", "press:Enter", "press:Tab", "type:補足", "press:Enter", "type:g"], want: "補足行の次（補足行か項目）", ok: (b) => last(b)[0].text === "g" },
  { id: "t-shift-tab", steps: ["new:", "type:h", "press:Enter", "press:Tab", "type:補足", "press:Shift+Tab"], want: "Shift+Tab で補足行が項目に戻る", ok: (b) => last(b)[0].type === "checkListItem" && last(b)[0].depth === 0 },
  { id: "t-backspace-start", steps: ["new:", "type:i", "press:Enter", "type:j", "home:", "press:Backspace"], want: "行頭の Backspace で前の項目とつながる", ok: (b) => last(b)[0].text === "ij" },
  { id: "t-url", steps: ["new:", "type:https://example.com/t あと"], want: "URL がリンクに", ok: (b) => last(b)[0].marks.some((m) => m.startsWith("a:https://example.com/t")) },
  { id: "t-code-at-start", steps: ["new:", "type:const x", "home:", "type:``` "], want: "項目の文字が消えない", ok: (b) => last(b)[0].type === "checkListItem" && last(b)[0].text.includes("const x") },
  { id: "t-select-all", steps: ["new:", "type:k", "press:ControlOrMeta+A", "press:Backspace"], want: "⌘A と Backspace で全部消える（空の項目 1 つ）", ok: (b) => only(b).length === 1 && only(b)[0].text === "" },
];

/** A new, empty item at the Todo's end. */
async function newTodoItem(page, root) {
  await root.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.evaluate(() => getSelection()?.modify("move", "forward", "documentboundary"));
  const blocks = await read(root);
  if (blocks.at(-1)?.text !== "" || blocks.at(-1)?.type !== "checkListItem") await page.keyboard.press("Enter");
  // A 補足行 at the end: back out to an item.
  const now = await read(root);
  if (now.at(-1)?.type !== "checkListItem") await page.keyboard.press("Shift+Tab");
}

async function surfaceSetup(page, surface) {
  const root = page.locator('[contenteditable="true"]').first();
  if (surface === "note") {
    await openApp(page);
    // A note of its own for each case: no marks or blocks left from the one before.
    return {
      root,
      reset: async (id) => {
        await createNote(page, `記法 ${id}`);
        await root.click();
        return clear(page, root, "paragraph");
      },
    };
  }
  await page.goto(BASE + "/quick?window=1");
  if (surface === "quick") {
    await root.waitFor({ timeout: 30_000 });
    // A tab of its own for each case.
    return {
      root,
      reset: async () => {
        // The tabs have a most (20): the oldest closed first, so each case still has one of its own.
        const tabs = page.getByRole("tab");
        while ((await tabs.count()) >= 18) {
          await tabs.first().hover();
          await page.getByRole("button", { name: /のタブを閉じる$/ }).first().click();
          // Written in and not saved: asked about, and closed as it is.
          const discard = page.getByRole("alertdialog").getByRole("button", { name: "保存せずに閉じる" });
          await discard.waitFor({ timeout: 1500 }).catch(() => {});
          if (await discard.isVisible().catch(() => false)) await discard.click();
          await page.getByRole("alertdialog").waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
          await page.waitForTimeout(150);
        }
        await page.getByRole("button", { name: "新しいタブ" }).click();
        // The new tab's editor in place: empty (not the last tab's, still there).
        for (let i = 0; i < 40; i++) {
          const blocks = await read(root);
          if (blocks.length === 1 && blocks[0].text === "") break;
          await page.waitForTimeout(100);
        }
        await root.click();
        return clear(page, root, "paragraph");
      },
    };
  }
  await page.getByRole("button", { name: "Todo を開く" }).click();
  const todo = page.getByLabel("Todo", { exact: true });
  await todo.waitFor({ timeout: 30_000 });
  return { root: todo, reset: async () => true };
}

/** An empty line of `kind` to start from. */
async function clear(page, root, kind) {
  await root.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  for (let i = 0; i < 4; i++) {
    const blocks = await read(root);
    if (blocks.length === 1 && blocks[0].text === "" && blocks[0].type === kind) return true;
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
  }
  const blocks = await read(root);
  return blocks.length === 1 && blocks[0].text === "";
}

const menuOpen = (page) =>
  page.evaluate(() => {
    const menu = document.querySelector('.bn-suggestion-menu, [role="listbox"], .bn-grid-suggestion-menu');
    return !!menu && (menu.getBoundingClientRect().height ?? 0) > 0;
  });

const browser = await engine.launch();
const findings = [];
const composes = (c) => c.steps.some((step) => step.startsWith("ime:"));
for (const surface of surfaces) {
  const context = await browser.newContext({ ...VIEW, locale: "ja-JP" });
  const page = await context.newPage();
  const cdp = engine === chromium ? await context.newCDPSession(page) : null;
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await signUp(page);
  // The look chosen first (UX_LOOK), wherever the cases are then typed.
  if (LOOK) await openApp(page);
  const { root, reset } = await surfaceSetup(page, surface);
  if (surface === "todo") {
    for (const c of more ? [] : TODO_CASES) {
      if (onlyCases && !onlyCases.has(c.id)) continue;
      if (!cdp && composes(c)) continue;
      errors.length = 0;
      await newTodoItem(page, root);
      await play(page, cdp, c.steps.filter((step) => step !== "new:"));
      const blocks = await read(root);
      const ok = c.ok(blocks);
      const record = { surface, id: c.id, want: c.want, ok, got: brief(last(blocks, 3)), errors: [...errors] };
      if (!ok || errors.length) {
        record.shot = join(SHOTS, `notation-todo-${c.id}.png`);
        await page.screenshot({ path: record.shot });
      }
      findings.push(record);
      console.log(`${ok ? "ok " : "NG "} todo/${c.id}: ${brief(last(blocks, 3)).join(" | ")}${errors.length ? " ERR " + errors[0] : ""}`);
    }
    await context.close();
    continue;
  }
  for (const c of more ? MORE_CASES : CASES) {
    if (onlyCases && !onlyCases.has(c.id)) continue;
    if (c.surfaces && !c.surfaces.includes(surface)) continue;
    if (!cdp && composes(c)) continue;
    const clean = await reset(c.id);
    errors.length = 0;
    await play(page, cdp, c.steps);
    const blocks = await read(root);
    // Where the caret was left: in the editor, and in sight.
    const caret = c.menu ? null : await caretOf(root);
    let ok;
    let want = c.want;
    if (c.menu) {
      ok = await menuOpen(page);
      await page.keyboard.press("Escape");
    } else if (surface === "todo") {
      ok = TODO_OK(blocks);
      want = `Todo：チェック項目か補足行のまま（${c.want}）`;
    } else {
      ok = c.ok(blocks, caret);
    }
    let caretOk = true;
    if (more && !c.menu) caretOk = !!caret && caret.seen && (c.caret ? !!c.caret(caret, blocks) : true);
    const record = { surface, id: c.id, want, ok, soft: !!c.soft, clean, got: brief(blocks), errors: [...errors] };
    if (more) Object.assign(record, { caret, caretOk });
    if (!caretOk) {
      console.log(`CARET ${surface}/${c.id}: ${JSON.stringify(caret)}`);
      if (ok) {
        // Counted as a finding of its own: the line is right, the caret is not where it would be looked for.
        record.ok = false;
        record.want = `${want}（キャレットの位置）`;
        ok = false;
      }
    }
    if (!ok || errors.length) {
      const shot = join(SHOTS, `notation-${surface}-${c.id}.png`);
      await page.screenshot({ path: shot });
      record.shot = shot;
    }
    findings.push(record);
    console.log(`${ok ? "ok " : c.soft ? "~~ " : "NG "} ${surface}/${c.id}: ${brief(blocks).join(" | ")}${errors.length ? " ERR " + errors[0] : ""}`);
  }
  await context.close();
}
await browser.close();
const out =
  args.out ?? join(import.meta.dirname, `notations-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify(findings, null, 2));
console.log(`\n${findings.filter((f) => !f.ok && !f.soft).length} NG of ${findings.length}; ${out}`);
