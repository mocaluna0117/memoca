import { expect, type Page, test } from "@playwright/test";
import { createNote, editor, openApp, signIn, signUp, waitForSynced } from "./helpers";

/** How soon a change has to show elsewhere: the editor's half second, the send, and the push back. */
const SOON = 4_000;

/** Types at the end of the note's body. */
async function typeAtEnd(page: Page, text: string) {
  await editor(page).click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  await page.keyboard.type(text);
}

test.describe("a note open in two places", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "typed on a computer's keyboard");
  });

  test("in two windows on one device: what is typed in either shows in the other at once", async ({
    page,
    context,
  }) => {
    await signUp(page);
    await openApp(page);
    await createNote(page, "二つの窓");
    await typeAtEnd(page, "はじめ");
    await waitForSynced(page);

    // The second window does not sync itself: the first one does.
    const second = await context.newPage();
    await second.goto(page.url());
    await expect(editor(second)).toContainText("はじめ", { timeout: 20_000 });

    await typeAtEnd(second, "二つ目の窓から");
    await expect(editor(page)).toContainText("二つ目の窓から", { timeout: SOON });

    await typeAtEnd(page, "一つ目の窓から");
    await expect(editor(second)).toContainText("一つ目の窓から", { timeout: SOON });
  });

  test("on two devices: what is typed on one shows on the other within seconds, again and again", async ({
    page,
    context,
  }) => {
    const email = await signUp(page);
    await openApp(page);
    await createNote(page, "二つの端末");
    await typeAtEnd(page, "はじめ");
    await waitForSynced(page);

    const fresh = await context.browser()!.newContext({
      baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100",
      viewport: page.viewportSize(),
    });
    const other = await fresh.newPage();
    await signIn(other, email);
    await other.goto(page.url());
    await expect(editor(other)).toContainText("はじめ", { timeout: 30_000 });

    // Each one as soon as the one before: none waits behind what came before it.
    for (let round = 1; round <= 4; round += 1) {
      await typeAtEnd(page, `こちら${round}`);
      await expect(editor(other)).toContainText(`こちら${round}`, { timeout: SOON });
      await typeAtEnd(other, `あちら${round}`);
      await expect(editor(page)).toContainText(`あちら${round}`, { timeout: SOON });
    }
    await fresh.close();
  });

  test("a long note edited at its end, in its middle and at its start: each reaches the other device as it is", async ({
    page,
    context,
  }) => {
    test.slow();
    const email = await signUp(page);
    await openApp(page);
    await createNote(page, "長い文書");
    await editor(page).click();
    // Three hundred lines, pasted as a page would hand them over.
    await editor(page).evaluate((target) => {
      const html = Array.from({ length: 300 }, (_, i) => `<p>${i + 1} 行目</p>`).join("");
      const data = new DataTransfer();
      data.setData("text/html", html);
      target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(editor(page).locator(".bn-inline-content", { hasText: /^300 行目$/ })).toHaveCount(1);
    await waitForSynced(page);

    const fresh = await context.browser()!.newContext({
      baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100",
      viewport: page.viewportSize(),
    });
    const other = await fresh.newPage();
    await signIn(other, email);
    await other.goto(page.url());
    await expect(editor(other)).toContainText("300 行目", { timeout: 30_000 });

    /** Each block, its kind and its text, in order. */
    const outline = (where: Page) =>
      editor(where).evaluate((root) =>
        [...root.querySelectorAll(".bn-block-content")].map(
          (block) =>
            `${(block as HTMLElement).dataset.contentType}:${block.querySelector(".bn-inline-content")?.textContent ?? ""}`,
        ),
      );
    const line = (where: Page, text: string) =>
      editor(where).locator(".bn-inline-content", { hasText: new RegExp(`^${text}$`) });

    // At its end.
    await typeAtEnd(page, "末尾に足した");
    await expect(editor(other)).toContainText("末尾に足した", { timeout: SOON });

    // In its middle: a line made a list, its text as it was.
    await line(page, "150 行目").click();
    // To the line's start (a Mac's Home scrolls the page instead).
    await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowLeft" : "Home");
    await page.keyboard.type("- ");
    await expect(editor(page).locator('[data-content-type="bulletListItem"]')).toHaveText("150 行目");
    await expect(editor(other).locator('[data-content-type="bulletListItem"]')).toHaveText("150 行目", {
      timeout: SOON,
    });

    // At its start.
    await editor(page).click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
    await page.keyboard.type("先頭に足した");
    await expect(editor(other).locator(".bn-inline-content").first()).toContainText("先頭に足した", {
      timeout: SOON,
    });

    // All of it the same on both, and on the other again as it is read back from storage.
    await expect.poll(() => outline(other), { timeout: SOON }).toEqual(await outline(page));
    await other.reload();
    await expect(editor(other)).toContainText("末尾に足した", { timeout: 30_000 });
    await expect.poll(() => outline(other), { timeout: SOON }).toEqual(await outline(page));
    await fresh.close();
  });
});
