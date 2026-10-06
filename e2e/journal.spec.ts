import { expect, test } from "@playwright/test";
import { editor, folderPanel, openApp, signUp, waitForSynced } from "./helpers";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const now = new Date();
const TODAY = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日（${WEEKDAYS[now.getDay()]}）`;

test("今日のメモ opens today's note, made once, in the folder of the days' notes", async ({
  page,
}) => {
  await signUp(page);
  await openApp(page);
  const panel = await folderPanel(page);
  await panel.getByRole("button", { name: "今日のメモ" }).click();
  await expect(page.getByLabel("メモのタイトル")).toHaveValue(TODAY);
  await expect(page.getByRole("navigation", { name: "日付のメモ" })).toBeVisible();
  await editor(page).click();
  await page.keyboard.type("きょうの作業");
  await waitForSynced(page);

  // Again, from anywhere: the same note, not another.
  await page.goto("/app");
  await (await folderPanel(page)).getByRole("button", { name: "今日のメモ" }).click();
  await expect(page.getByLabel("メモのタイトル")).toHaveValue(TODAY);
  await expect(editor(page)).toContainText("きょうの作業");
  const panelAgain = await folderPanel(page);
  await expect(panelAgain.getByText("日記", { exact: true })).toBeVisible();
});
