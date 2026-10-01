import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { createNote, openApp, showList, signIn, signUp, waitForSynced } from "./helpers";

/** A note only the last account on the device had. */
const THEIRS = "前の人だけのメモ";

/** From the next page on, remembers whether the page ever showed `text`, even for a moment. */
async function watchFor(context: BrowserContext, text: string) {
  await context.addInitScript((needle) => {
    const here = window as unknown as { sawIt?: boolean };
    const look = () => {
      if (document.documentElement?.textContent?.includes(needle)) here.sawIt = true;
    };
    new MutationObserver(look).observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }, text);
}

const sawIt = (page: Page) =>
  page.evaluate(() => (window as unknown as { sawIt?: boolean }).sawIt ?? false);

/** An account with a note of its own, left on this browser with its session run out. */
async function leaveNotesBehind(page: Page, context: BrowserContext) {
  await signUp(page);
  await openApp(page);
  await createNote(page, THEIRS);
  await waitForSynced(page);
  // Not signed out of, which would wipe the device: the session just ends.
  await context.clearCookies();
}

test.describe("another account signing in on the same browser", () => {
  test("someone new never sees the last account's notes, and starts with their own", async ({
    page,
    context,
  }) => {
    await leaveNotesBehind(page, context);
    await watchFor(context, THEIRS);

    await signUp(page);
    await openApp(page);
    await showList(page);
    // Settled on the new account's own, empty, notes.
    await expect(
      page.getByText("まだメモがありません").filter({ visible: true }).first(),
    ).toBeVisible();
    expect(await sawIt(page)).toBe(false);
  });

  test("an account of someone else's never sees them either, not even while the server answers", async ({
    page,
    context,
    browser,
  }) => {
    // The other account, made and set up elsewhere.
    const elsewhere = await browser.newContext({
      baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3100",
      viewport: page.viewportSize(),
    });
    const theirPage = await elsewhere.newPage();
    const email = await signUp(theirPage);
    await openApp(theirPage);
    await elsewhere.close();

    await leaveNotesBehind(page, context);
    await watchFor(context, THEIRS);

    await signIn(page, email);
    await openApp(page);
    await showList(page);
    await expect(
      page.getByText("まだメモがありません").filter({ visible: true }).first(),
    ).toBeVisible();
    expect(await sawIt(page)).toBe(false);
  });
});
