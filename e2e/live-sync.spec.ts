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
});
