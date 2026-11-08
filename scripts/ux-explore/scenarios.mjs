// Each scenario drives one flow and records what it saw. `run.step` never
// throws: a failure is a finding. Scenarios list the devices they apply to.
import {
  BASE, caretIn, createNote, editor, natural, noteImages, outline, pasteData,
  pastePicture, perfCollect, perfReset, raiseKeyboard, readTable, showList, swipe,
} from "./lib.mjs";

const ALL = ["desktop", "pixel7"];
const sleep = (page, ms) => page.waitForTimeout(ms);
const activeIsEditor = (page) =>
  page.evaluate(() => document.activeElement?.getAttribute("contenteditable") === "true");

export const scenarios = [
  {
    name: "numbered-lists",
    devices: ALL,
    async run(page, run) {
      await createNote(page, "番号付き");
      await editor(page).click();
      await page.keyboard.type("1. いち");
      await page.keyboard.press("Enter");
      await page.keyboard.type("に");
      await run.step("ascii-1-dot", "numberedListItem ×2", () => outline(page), (o) => o.filter((l) => l.startsWith("numberedListItem")).length === 2);
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      await page.keyboard.type("１．ぜんかく");
      await run.step("fullwidth-1", "変換されない（現状）か、番号付きになる（目標）", () => outline(page));
      await page.keyboard.press("Enter");
      await page.keyboard.type("1。まる");
      await run.step("1-maru", "番号付きになる（目標）", () => outline(page));
      await page.keyboard.press("Enter");
      await page.keyboard.type("5. ご");
      await run.step("start-5", "start=5 の番号付き", () => outline(page), (o) => o.some((l) => l.includes("ご") && l.includes("numbered")));
    },
  },
  {
    name: "checklists",
    devices: ALL,
    async run(page, run) {
      await createNote(page, "チェック");
      await editor(page).click();
      await page.keyboard.type("[] 買い物");
      await run.step("make", "checkListItem:買い物", () => outline(page), (o) => o.some((l) => l.startsWith("checkListItem:買い物")));
      const box = editor(page).locator('input[type="checkbox"]').first();
      await box.click();
      await run.step("check", "box=true", () => outline(page), (o) => o.some((l) => l.includes("box=true")));
      await caretIn(page, "買い物", 0);
      await page.keyboard.press("Enter");
      await run.step("enter-at-start", "空の未チェック項目が上、買い物はチェック済みのまま", () => outline(page), (o) => {
        const items = o.filter((l) => l.startsWith("checkListItem"));
        return items.length === 2 && items[0].includes("box=false") && items[1].includes("買い物") && items[1].includes("box=true");
      });
      await caretIn(page, "買い物");
      await page.keyboard.press("Enter");
      await page.keyboard.type("次");
      await run.step("enter-at-end", "新しい項目は未チェック", () => outline(page), (o) => o.some((l) => l.includes("次") && l.includes("box=false")));
      await caretIn(page, "次", 0);
      await page.keyboard.press("Backspace");
      await run.step("backspace-at-start", "段落に戻る（BlockNote 既定）", () => outline(page));
      await page.keyboard.type("「」 かぎ");
      await run.step("kagi-brackets", "「」+空白→チェックリスト（目標）", () => outline(page));
    },
  },
  {
    name: "nesting",
    devices: ALL,
    async run(page, run) {
      await createNote(page, "ネスト");
      await editor(page).click();
      await page.keyboard.type("- いち");
      await page.keyboard.press("Enter");
      await page.keyboard.type("に");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      await page.keyboard.type("さん");
      await page.keyboard.press("Tab");
      await run.step("two-levels", "に が 1 段、さん が 2 段", () => outline(page), (o) => o.some((l) => l.startsWith("  bulletListItem:に")) && o.some((l) => l.startsWith("    bulletListItem:さん")));
      await page.keyboard.press("Tab");
      await run.step("tab-cannot-nest-further", "フォーカスがエディタに残る", () => activeIsEditor(page), (v) => v === true);
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Shift+Tab");
      await run.step("shift-tab-twice", "さん がトップに戻る", () => outline(page), (o) => o.some((l) => l.startsWith("bulletListItem:さん")));
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      await run.step("double-enter-leaves-list", "空の項目で Enter → 段落", () => outline(page), (o) => o.at(-1)?.startsWith("paragraph:"));
      await page.keyboard.type("ー 全角ダッシュ");
      await run.step("ime-dash", "ー+空白→箇条書き（目標）", () => outline(page));
    },
  },
  {
    name: "toggle-with-lists",
    devices: ALL,
    async run(page, run) {
      await createNote(page, "トグル");
      await editor(page).click();
      await page.keyboard.type("/折りたたみリスト");
      await sleep(page, 400);
      await page.keyboard.press("Enter");
      await page.keyboard.type("見出し");
      await page.keyboard.press("Enter");
      await page.keyboard.type("- 中の項目");
      await page.keyboard.press("Enter");
      await page.keyboard.type("二つ目");
      await run.step("list-inside", "toggle の中に bulletListItem ×2", () => outline(page), (o) => o.filter((l) => l.includes("bulletListItem")).length === 2);
      const wrapper = editor(page).locator(".bn-toggle-wrapper").first();
      if ((await wrapper.getAttribute("data-show-children")) === "true") {
        await editor(page).locator(".bn-toggle-button").first().click();
      }
      await run.step("closed", "中身が隠れる", () => wrapper.getAttribute("data-show-children"), (v) => v === "false");
      await caretIn(page, "見出し", 0);
      await page.keyboard.press("Backspace");
      await run.step("backspace-at-toggle-start", "閉じたトグルの行頭 Backspace：段落化しない（目標）", () => outline(page));
    },
  },
  {
    name: "markdown-paste-plain",
    devices: ALL,
    async run(page, run) {
      await createNote(page, "MD貼り付け");
      await editor(page).click();
      await pasteData(page, { "text/plain": "# 見出し\n\n- 一\n- 二\n\n1. いち\n2. に\n\n```\nconst a = 1;\n```\n\n> 引用" });
      await sleep(page, 500);
      await run.step("outline", "Markdown が解釈されるか（仕様確認）", () => outline(page));
    },
  },
  {
    name: "code-block-and-url",
    devices: ALL,
    async run(page, run) {
      await createNote(page, "コードとURL");
      await editor(page).click();
      await page.keyboard.type("/コード");
      await sleep(page, 400);
      await run.step("slash-menu", "コードブロックの候補が出る", () => page.locator(".bn-suggestion-menu, [role=listbox]").first().innerText().catch(() => "no menu"), (t) => /コード/.test(String(t)));
      await page.keyboard.press("Enter");
      await page.keyboard.type("const x = 1;");
      await page.keyboard.press("Enter");
      await page.keyboard.type("x += 1;");
      await run.step("code-block", "codeBlock に 2 行", () => outline(page), (o) => o.some((l) => l.startsWith("codeBlock")));
      // In a line of text (a code block keeps an address as code).
      await createNote(page, "URL");
      await editor(page).click();
      await page.keyboard.type("参考 ");
      await pasteData(page, { "text/plain": "https://example.com/path" });
      await sleep(page, 300);
      await run.step("pasted-url", "リンクになる", () => editor(page).locator('a[href^="https://example.com"]').count(), (n) => n > 0);
      await page.keyboard.press("Enter");
      await page.keyboard.type("資料はこちら");
      for (let i = 0; i < 3; i += 1) await page.keyboard.press("Shift+ArrowLeft");
      // As a person pastes: after the selection has been taken in.
      await sleep(page, 150);
      const selected = await page.evaluate(() => getSelection()?.toString());
      await pasteData(page, { "text/plain": "https://example.com/doc" });
      await sleep(page, 300);
      await run.step("pasted-url-over-selection", "選んだ「こちら」がリンクになる", async () => ({ selected, link: await editor(page).locator('a[href="https://example.com/doc"]').innerText().catch(() => "") }), (r) => r.link === "こちら");
    },
  },
  {
    name: "note-links",
    devices: ALL,
    async run(page, run) {
      await createNote(page, "リンク先");
      await createNote(page, "リンク元");
      await editor(page).click();
      await page.keyboard.type("[[リンク");
      await sleep(page, 500);
      await run.step("menu", "候補に リンク先 が出る", () => page.locator("[role=listbox], .bn-suggestion-menu").first().innerText().catch(() => "no menu"), (t) => /リンク先/.test(String(t)));
      await page.keyboard.press("Enter");
      await sleep(page, 300);
      await run.step("inserted", "リンク先 へのリンクが入る", () => editor(page).locator("a").first().innerText().catch(() => ""), (t) => /リンク先/.test(String(t)));
    },
  },
  {
    name: "global-search",
    devices: ALL,
    async run(page, run) {
      await createNote(page, "検索対象A", "ここに きりん がいます");
      await createNote(page, "検索対象B", "ぞう と きりん");
      await sleep(page, 1500);
      await page.goto(BASE + "/app/search");
      const field = page.getByRole("textbox", { name: "検索", exact: true }).first();
      await field.waitFor({ timeout: 10_000 });
      await field.fill("きりん");
      await sleep(page, 1200);
      await run.step("results", "2 件、本文の一致が強調される", async () => {
        const text = await page.locator("main").innerText();
        const marks = await page.locator("main mark").count();
        return { marks, hasA: text.includes("検索対象A"), hasB: text.includes("検索対象B") };
      }, (r) => r.hasA && r.hasB);
      await field.fill("キリン");
      await sleep(page, 1200);
      await run.step("katakana", "カタカナでも同じ 2 件", async () => {
        const text = await page.locator("main").innerText();
        return { hasA: text.includes("検索対象A"), hasB: text.includes("検索対象B") };
      }, (r) => r.hasA && r.hasB);
    },
  },
  {
    name: "trash-nested-folders",
    devices: ["desktop"],
    async run(page, run) {
      const aside = page.locator("aside");
      await aside.getByRole("button", { name: "フォルダを追加" }).click();
      await aside.getByRole("button", { name: "新しいフォルダ の操作" }).first().click();
      await page.getByRole("menuitem", { name: "名前を変更" }).click();
      const field = page.getByRole("dialog").getByRole("textbox");
      await field.fill("親");
      await field.press("Enter");
      await aside.getByRole("button", { name: "親 の操作" }).click();
      await page.getByRole("menuitem", { name: "サブフォルダを追加" }).click();
      await sleep(page, 500);
      await aside.getByRole("button", { name: "新しいフォルダ の操作" }).first().click();
      await page.getByRole("menuitem", { name: "名前を変更" }).click();
      const field2 = page.getByRole("dialog").getByRole("textbox");
      await field2.fill("子");
      await field2.press("Enter");
      await aside.getByRole("button", { name: "子 に新しいメモ" }).click();
      await page.getByLabel("メモのタイトル").fill("子のメモ");
      await sleep(page, 1200);
      await aside.getByRole("button", { name: "親 の操作" }).click();
      const items = await page.getByRole("menu").innerText();
      await run.step("folder-menu", "削除（ゴミ箱へ）がある", () => items);
      await page.getByRole("menuitem", { name: /削除|ゴミ箱/ }).first().click();
      const confirm = page.getByRole("dialog").getByRole("button", { name: /削除|ゴミ箱/ });
      if (await confirm.isVisible().catch(() => false)) await confirm.click();
      await sleep(page, 800);
      await run.step("tree-after-trash", "親も子も消える", () => aside.locator("[data-folder-row]").allInnerTexts(), (rows) => !rows.some((r) => /親|子/.test(r)));
      await page.goto(BASE + "/app/trash");
      await sleep(page, 800);
      await run.step("trash-page", "親・子・子のメモ が見える", () => page.locator("main").innerText(), (t) => /親/.test(t));
      await page.getByRole("button", { name: "復元" }).first().click();
      await sleep(page, 800);
      await run.step("after-restore", "復元後のゴミ箱の中身", () => page.locator("main").innerText());
      await page.goto(BASE + "/app");
      await sleep(page, 800);
      await run.step("tree-after-restore", "親が戻る（子も中に）", () => page.locator("aside [data-folder-row]").allInnerTexts(), (rows) => rows.some((r) => /親/.test(r)));
      await page.goto(BASE + "/app/trash");
      await sleep(page, 500);
      const empty = page.getByRole("button", { name: "ゴミ箱を空にする" });
      await run.step("empty-button", "空にするボタンの状態", () => empty.isVisible().then((v) => (v ? empty.isDisabled().then((d) => (d ? "disabled" : "enabled")) : "hidden")));
    },
  },
  {
    name: "dark-mode",
    devices: ALL,
    async run(page, run) {
      await page.goto(BASE + "/app/settings");
      const combo = page.getByRole("combobox").filter({ hasText: /端末の設定|ライト|ダーク/ }).first();
      await combo.waitFor({ timeout: 10_000 });
      await combo.click();
      const options = await page.getByRole("option").allInnerTexts();
      await run.step("options", "ライト/ダーク/システム", () => options);
      await page.getByRole("option", { name: /ダーク|dark/i }).first().click();
      await sleep(page, 400);
      await run.step("html-class", "html.dark が付く", () => page.evaluate(() => [document.documentElement.className, getComputedStyle(document.body).backgroundColor]), (v) => /dark/.test(v[0]));
      await page.goto(BASE + "/app");
      await sleep(page, 800);
      await createNote(page, "ダークで書く", "文字は読めるか");
      await run.step("editor-dark", "エディタの文字色と背景のコントラスト", () => editor(page).evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el).backgroundColor]));
      await page.goto(BASE + "/app/settings");
      await page.getByRole("combobox").filter({ hasText: /ダーク/ }).first().click();
      await page.getByRole("option", { name: /端末の設定/ }).first().click();
    },
  },
  {
    name: "templates-journal-history",
    devices: ["desktop"],
    async run(page, run) {
      await page.getByRole("button", { name: "テンプレートから作成" }).first().click();
      await sleep(page, 500);
      await run.step("picker", "テンプレートの候補（議事録・日記）", () => page.getByRole("dialog").innerText().catch(() => "no dialog"), (t) => /議事録|日記/.test(String(t)));
      await page.getByRole("dialog").getByRole("button", { name: /議事録/ }).first().click().catch(() => page.getByRole("dialog").getByText(/議事録/).first().click());
      await sleep(page, 1500);
      await run.step("from-template", "議事録の本文が入る", () => outline(page), (o) => o.length > 1);
      await page.locator("aside").getByRole("button", { name: "今日のメモ" }).click();
      await sleep(page, 1200);
      await run.step("journal", "日付のメモのナビが出る", () => page.getByRole("navigation", { name: "日付のメモ" }).isVisible(), (v) => v === true);
      await editor(page).click();
      await page.keyboard.type("一つ目の版");
      await sleep(page, 1500);
      await page.getByRole("button", { name: "メモの操作" }).click();
      await page.getByRole("menuitem", { name: "変更履歴" }).click();
      await sleep(page, 800);
      await run.step("history", "版の一覧（新しいメモは 0〜1 件）", () => page.getByRole("list", { name: "残っている版" }).innerText().catch(() => "no list"));
      await page.keyboard.press("Escape");
    },
  },
  {
    name: "quota-bar",
    devices: ALL,
    async run(page, run) {
      await run.step("bar", "容量の表示（使用量/上限）", async () => {
        const texts = await page.locator("aside, [role=dialog]").allInnerTexts();
        const hit = texts.join("\n").split("\n").filter((l) => /[KMG]?B/.test(l));
        return hit;
      });
      await page.goto(BASE + "/app/settings");
      await sleep(page, 800);
      await run.step("settings-usage", "設定の容量欄", () => page.locator("main").innerText().then((t) => t.split("\n").filter((l) => /容量|[KMG]B/.test(l))));
    },
  },
  {
    name: "typing-latency",
    devices: ALL,
    cpuSlow: 4,
    async run(page, run) {
      await createNote(page, "長いメモ");
      await editor(page).click();
      const html = Array.from({ length: 300 }, (_, i) => `<p>${i + 1} 行目のテキストです。少し長めの文章で、折り返しが起きる程度の長さにしておきます。</p>`).join("");
      await pasteData(page, { "text/html": html });
      await sleep(page, 2000);
      await run.step("lines", "300 行入る", () => outline(page).then((o) => o.length), (n) => n >= 300);
      await page.keyboard.press("Control+End");
      await page.keyboard.press("End");
      await sleep(page, 1500);
      await perfReset(page);
      const text = "入力の遅延を測ります。日本語の文章を二百文字ほど打ちます。".repeat(8).slice(0, 200);
      await page.keyboard.type(text, { delay: 30 });
      await sleep(page, 1500);
      await run.step("perf", "p95 < 50ms、longtask 少なめ", () => perfCollect(page));
    },
  },
  {
    name: "paste-perf",
    devices: ALL,
    cpuSlow: 4,
    async run(page, run) {
      const rounds = [];
      for (let round = 0; round < 3; round += 1) {
        await createNote(page, `大きな写真 ${round + 1}`);
        await editor(page).click();
        // The picture made first, apart from what is measured.
        await editor(page).evaluate(async () => {
          const canvas = document.createElement("canvas");
          canvas.width = 4000;
          canvas.height = 3000;
          const context = canvas.getContext("2d");
          const gradient = context.createLinearGradient(0, 0, 4000, 3000);
          gradient.addColorStop(0, "#1d4ed8");
          gradient.addColorStop(1, "#f59e0b");
          context.fillStyle = gradient;
          context.fillRect(0, 0, 4000, 3000);
          const grain = context.getImageData(0, 0, 4000, 3000);
          for (let i = 0; i < grain.data.length; i += 4) grain.data[i] = Math.max(0, Math.min(255, grain.data[i] + (Math.imul(i, 2654435761) >>> 28) - 8));
          context.putImageData(grain, 0, 0);
          const blob = await new Promise((resolve) => canvas.toBlob((made) => resolve(made), "image/png"));
          window.__photo = new File([blob], "写真.png", { type: "image/png" });
        });
        await sleep(page, 1500);
        await perfReset(page);
        const started = Date.now();
        await editor(page).evaluate((target) => {
          const data = new DataTransfer();
          data.items.add(window.__photo);
          target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
        });
        const image = noteImages(page).last();
        const deadline = Date.now() + 40_000;
        let size = null;
        while (Date.now() < deadline) {
          size = await natural(image).catch(() => null);
          if (size && size.w === 2048) break;
          await sleep(page, 100);
        }
        const shownMs = Date.now() - started;
        while (Date.now() < deadline) {
          if ((await readTable(page, "pendingUploads")).length === 0) break;
          await sleep(page, 200);
        }
        const uploadedMs = Date.now() - started;
        await sleep(page, 500);
        rounds.push({ shownMs, uploadedMs, size, ...(await perfCollect(page)) });
      }
      const median = (key) => [...rounds].map((r) => r[key]).sort((a, b) => a - b)[1];
      await run.step("perf", "貼り付けから縮小画像が見えるまで・メインスレッドの停止（3 回の中央値）", async () => ({
        shownMs: median("shownMs"),
        uploadedMs: median("uploadedMs"),
        longtaskTotalMs: median("longtaskTotalMs"),
        longtaskMaxMs: median("longtaskMaxMs"),
        longtasks: median("longtasks"),
        offscreen: await page.evaluate(() => typeof OffscreenCanvas),
        rounds,
      }));
    },
  },
  {
    name: "mobile-image-paste",
    devices: ["pixel7"],
    async run(page, run) {
      await createNote(page, "スマホ画像");
      await pastePicture(page, { width: 1200, height: 900, kind: "screen", name: "画面.png" });
      const image = noteImages(page).last();
      await image.waitFor({ timeout: 20_000 });
      await run.step("shown", "画像が表示される", () => natural(image), (s) => s.w > 0);
      await run.step("fits", "画像が画面幅に収まる", async () => {
        const box = await image.boundingBox();
        return { box, viewport: page.viewportSize() };
      }, (r) => r.box && r.box.x >= 0 && r.box.x + r.box.width <= r.viewport.width + 1);
    },
  },
  {
    name: "mobile-keyboard-long-note",
    devices: ["pixel7"],
    async run(page, run) {
      await createNote(page, "長いメモとキーボード");
      await editor(page).click();
      const html = Array.from({ length: 80 }, (_, i) => `<p>${i + 1} 行目</p>`).join("");
      await pasteData(page, { "text/html": html });
      await sleep(page, 1500);
      await page.keyboard.press("Control+End");
      await editor(page).locator(".bn-block-content").last().click();
      await raiseKeyboard(page, 300);
      await sleep(page, 600);
      await page.keyboard.type("打つ");
      await sleep(page, 400);
      await run.step("caret-visible", "キャレットがキーボードの上に見える", async () => {
        return page.evaluate(() => {
          const sel = getSelection();
          const rect = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
          const vv = window.visualViewport;
          const header = document.querySelector("header")?.getBoundingClientRect() ?? null;
          return { caret: rect ? { top: rect.top, bottom: rect.bottom } : null, visible: { top: vv.offsetTop, bottom: vv.offsetTop + vv.height }, header: header ? { top: header.top, bottom: header.bottom } : null, scrollY: window.scrollY };
        });
      }, (r) => r.caret && r.caret.bottom <= r.visible.bottom && r.caret.top >= r.visible.top);
      await run.step("toolbar", "電話バー（ブロックの操作）が見える", () => page.getByRole("toolbar").filter({ visible: true }).allInnerTexts());
    },
  },
  {
    name: "drawer-and-phone-bar",
    devices: ["pixel7"],
    async run(page, run) {
      await showList(page);
      const { height } = page.viewportSize();
      await swipe(page, { x: 4, y: height / 2 }, { x: 260, y: height / 2 });
      await sleep(page, 600);
      await run.step("drawer-open", "フォルダのドロワーが開く", () => page.locator('[role="dialog"][data-state="open"]').count(), (n) => n > 0);
      await page.keyboard.press("Escape");
      await sleep(page, 400);
      await createNote(page, "電話バー");
      await editor(page).click();
      await raiseKeyboard(page, 300);
      await sleep(page, 500);
      const bar = page.getByRole("toolbar").filter({ visible: true }).first();
      await run.step("bar-buttons", "箇条書き・番号・チェック・字下げ の並び", () => bar.getByRole("button").allInnerTexts().catch(() => []).then(async (t) => ({ texts: t, labels: await bar.getByRole("button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label"))) })));
      const bullet = bar.getByRole("button", { name: /箇条書き/ }).first();
      if (await bullet.isVisible().catch(() => false)) {
        await page.keyboard.type("項目");
        await bullet.click();
        await run.step("bullet-from-bar", "箇条書きになる", () => outline(page), (o) => o.some((l) => l.startsWith("bulletListItem:項目")));
      }
    },
  },
];
