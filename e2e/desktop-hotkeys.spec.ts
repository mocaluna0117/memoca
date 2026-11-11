import { expect, test } from "@playwright/test";
import { signUp } from "./helpers";

test.describe("the desktop app's hotkeys, in the settings page", () => {
  test("recorded from the keys pressed and kept by the app, at once; opened at them from the app's menu", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "the desktop app's window, with a keyboard");
    await signUp(page);
    // Memoca's own window, as the app makes it (0.4.11 on): its hotkeys a
    // stand-in that keeps what it is given, and says what it was asked.
    await page.addInitScript(() => {
      const asked = window as unknown as { __asked: string[] };
      asked.__asked = [];
      let kept = { quick: "CmdOrCtrl+M", app: "CmdOrCtrl+K", quickDefault: "CmdOrCtrl+Shift+M", appDefault: "CmdOrCtrl+Shift+M" };
      Object.defineProperty(window, "memocaShell", {
        value: {
          platform: "macos",
          hide() {},
          openExternal() {},
          hotkeys: {
            get: async () => kept,
            set: async (which: "quick" | "app", keys: string) => {
              asked.__asked.push(`set ${which} ${keys}`);
              if (keys === "CmdOrCtrl+Alt+T") throw "taken";
              kept = { ...kept, [which]: keys };
              return kept;
            },
            recording: async (on: boolean) => {
              asked.__asked.push(`recording ${on}`);
            },
          },
        },
      });
    });
    const asked = () => page.evaluate(() => (window as unknown as { __asked: string[] }).__asked);

    // As the app's menu opens it: at the hotkeys.
    await page.goto("/app/settings#hotkeys");
    const section = page.locator("#hotkeys");
    await expect(section.getByRole("heading", { name: "デスクトップ版のホットキー" })).toBeInViewport();
    const quick = section.getByLabel("即席メモを出す・隠すのホットキー");
    await expect(quick).toHaveText("⌘M");

    await section.getByRole("button", { name: "変更" }).first().click();
    await expect(section.getByText("キーを押してください")).toBeVisible();
    await page.keyboard.press("Meta+Shift+J");
    await expect(quick).toHaveText("⇧⌘J");
    expect(await asked()).toEqual(["recording true", "recording false", "set quick CmdOrCtrl+Shift+J"]);

    // Another app's keys: said so, and kept as they were.
    await section.getByRole("button", { name: "変更" }).nth(1).click();
    await page.keyboard.press("Meta+Alt+KeyT");
    await expect(section.getByRole("alert")).toContainText("ほかのアプリが使っているキー");
    await expect(section.getByLabel("Memoca 全体のウィンドウを開く・隠すのホットキー")).toHaveText("⌘K");

    // Back to the default.
    await section.getByRole("button", { name: "元に戻す" }).first().click();
    await expect(quick).toHaveText("⇧⌘M");
  });

  test("not in a browser", async ({ page }) => {
    await signUp(page);
    await page.goto("/app/settings");
    await expect(page.getByRole("heading", { name: "外観" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "デスクトップ版のホットキー" })).toHaveCount(0);
  });
});
