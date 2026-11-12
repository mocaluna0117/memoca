// Every notation, typed for real, where it can be typed: a note, a quick
// note's tab, and the Todo. Each case starts from an empty line, types (or,
// for Japanese, composes and commits as an input method does, through the
// browser's own composition events), presses its keys, and records the
// blocks it made: their kind, text, depth, marks. A case whose blocks are not
// what a person would expect is a finding, with a screenshot.
//
//   UX_BASE=http://localhost:3100 node scripts/ux-explore/notations.mjs [--only=note,quick,todo] [--case=id,...]
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
    for (const c of TODO_CASES) {
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
  for (const c of CASES) {
    if (onlyCases && !onlyCases.has(c.id)) continue;
    if (c.surfaces && !c.surfaces.includes(surface)) continue;
    if (!cdp && composes(c)) continue;
    const clean = await reset(c.id);
    errors.length = 0;
    await play(page, cdp, c.steps);
    const blocks = await read(root);
    let ok;
    let want = c.want;
    if (c.menu) {
      ok = await menuOpen(page);
      await page.keyboard.press("Escape");
    } else if (surface === "todo") {
      ok = TODO_OK(blocks);
      want = `Todo：チェック項目か補足行のまま（${c.want}）`;
    } else {
      ok = c.ok(blocks);
    }
    const record = { surface, id: c.id, want, ok, soft: !!c.soft, clean, got: brief(blocks), errors: [...errors] };
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
