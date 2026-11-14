import { expect, test } from "@playwright/test";
import { createNote, editor, openApp, signUp } from "./helpers";
import { createVaultInSettings } from "./vault-helpers";

test("the vault's password is worked into a key off the page: in a worker of its own", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "once is enough");
  const workers: string[] = [];
  page.on("worker", (worker) => workers.push(worker.url()));
  await signUp(page);
  await createVaultInSettings(page);
  await expect.poll(() => workers.some((url) => url.includes("/argon/"))).toBe(true);
});

test("a folder made with a note open, from the sidebar: the note stays open", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "the sidebar beside the note");
  await signUp(page);
  await openApp(page);
  await createNote(page, "書きかけ", "本文");
  const panel = page.locator("aside").first();
  await panel.getByRole("button", { name: "フォルダを追加" }).click();
  await expect(panel.getByText("新しいフォルダ").first()).toBeVisible();
  await expect(page).toHaveURL(/[?&]n=/);
  await expect(editor(page)).toContainText("本文");
});
