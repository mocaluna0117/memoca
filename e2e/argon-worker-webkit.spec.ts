import { expect, test } from "@playwright/test";
import { createNote, editor, openApp, signUp, waitForSynced } from "./helpers";
import { createVaultInSettings, enterVaultPassword } from "./vault-helpers";

/** The Mac desktop app's engine (WebKit), where the vault's key is worked out in a worker too. */
test.use({ browserName: "webkit" });

test("in WebKit, the vault made, a note locked and opened again with the password", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the Mac desktop app's engine");
  test.slow();
  const workers: string[] = [];
  page.on("worker", (worker) => workers.push(worker.url()));
  await signUp(page);
  await createVaultInSettings(page);
  await expect.poll(() => workers.some((url) => url.includes("/argon/"))).toBe(true);
  await openApp(page);
  await createNote(page, "ロックするメモ", "秘密の本文");
  await waitForSynced(page);
  await page.getByRole("button", { name: "メモの操作" }).click();
  await page.getByRole("menuitem", { name: "ロックする", exact: true }).click();
  await enterVaultPassword(page, "ロックする");
  await expect(page.getByText("メモをロックしました")).toBeVisible({ timeout: 30_000 });
  await openApp(page);
  await page.getByText("ロックされたメモ").filter({ visible: true }).first().click();
  await page.getByRole("button", { name: "金庫を開く", exact: true }).filter({ visible: true }).first().click();
  await enterVaultPassword(page, "開く");
  await expect(editor(page)).toContainText("秘密の本文", { timeout: 15_000 });
});
