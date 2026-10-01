import { expect, type Page, test } from "@playwright/test";
import { NEWS } from "../src/lib/news";
import { folderPanel, openApp, signUp } from "./helpers";

/** An entry's heading by its title: from its start, the 新着 badge after it or not. */
const titled = (title: string) => new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

/** The お知らせ link, in the sidebar or (on a phone) the drawer, from the notes page. */
async function newsLink(page: Page) {
  return (await folderPanel(page)).getByRole("link", { name: /お知らせ/ });
}

test("お知らせ: nothing new to a new account; those since the last seen, marked until seen", async ({
  page,
}, testInfo) => {
  const phone = testInfo.project.name === "mobile";
  await signUp(page);
  await openApp(page);
  // A new account: what came before it is not news to it.
  if (phone)
    await expect(
      page.getByRole("button", { name: "メニューを開く", exact: true }).first(),
    ).toBeVisible();
  await expect(await newsLink(page)).not.toContainText("未読");

  // Seen up to an older one on this device: the two after it are new.
  await page.evaluate((id) => localStorage.setItem("memoca:news-seen", id), NEWS[2]!.id);
  await page.reload();
  await expect(page.getByRole("heading", { name: "すべてのメモ" }).first()).toBeVisible({
    timeout: 25_000,
  });
  if (phone) {
    await expect(
      page.getByRole("button", { name: "メニューを開く（お知らせ 未読 2 件）" }).first(),
    ).toBeVisible();
  }
  const link = await newsLink(page);
  await expect(link).toContainText("未読 2 件");
  await link.click();

  const heading = page.getByRole("heading", { name: "お知らせ", level: 1 }).last();
  await expect(heading).toBeVisible();
  await expect(page.getByText("新着")).toHaveCount(2);
  await expect(page.getByRole("heading", { name: titled(NEWS[1]!.title) })).toContainText("新着");
  await expect(page.getByRole("heading", { name: titled(NEWS[2]!.title) })).not.toContainText(
    "新着",
  );

  // Seen: no longer marked, here or after a reload.
  await page.reload();
  await expect(heading).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText("新着")).toHaveCount(0);
  if (phone) {
    // The menu, from this page's own button: nothing marked there either.
    const menu = page.getByRole("button", { name: /メニューを開く/ }).first();
    await expect(menu).toHaveAccessibleName("メニューを開く");
    await menu.click();
    const drawer = page.locator('[role="dialog"][data-state="open"]');
    await expect(drawer.getByRole("link", { name: /お知らせ/ })).not.toContainText("未読");
  } else {
    await expect(await newsLink(page)).not.toContainText("未読");
  }
});
