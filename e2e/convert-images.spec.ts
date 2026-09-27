import { expect, type Page, test } from "@playwright/test";
import { createNote, editor, openApp, showList, signUp, waitForSynced } from "./helpers";
import { uploadsDrained } from "./image-helpers";
import { readTable } from "./local-db";

type Row = { attachmentId: string; mime: string | null; status: string };
type NoteRow = { title: string | null; lastUpdateSeq: number; refsThroughSeq?: number };

const TITLE = "前の版で貼った写真";
const DAY = 24 * 60 * 60 * 1000;

/** A photo-like image pasted into the open note, as a PNG file. */
async function pastePhoto(page: Page) {
  await editor(page).click();
  await editor(page).evaluate(async (target) => {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 600;
    const context = canvas.getContext("2d")!;
    const gradient = context.createLinearGradient(0, 0, 800, 600);
    gradient.addColorStop(0, "#1d4ed8");
    gradient.addColorStop(1, "#f59e0b");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 800, 600);
    const grain = context.getImageData(0, 0, 800, 600);
    for (let i = 0; i < grain.data.length; i += 4) {
      const shift = ((i * 2654435761) % 17) - 8;
      grain.data[i] = Math.max(0, Math.min(255, grain.data[i]! + shift));
    }
    context.putImageData(grain, 0, 0);
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((result) => resolve(result!), "image/png"),
    );
    const data = new DataTransfer();
    data.items.add(new File([blob], "photo.png", { type: "image/png" }));
    target.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
}

/** This device's rows for the files, polled until `ready` holds. */
async function filesOnceThey(page: Page, ready: (rows: Row[]) => boolean): Promise<Row[]> {
  let rows: Row[] = [];
  await expect
    .poll(
      async () => {
        rows = await readTable<Row>(page, "attachments");
        return ready(rows);
      },
      { timeout: 60_000, intervals: [1_000] },
    )
    .toBe(true);
  return rows;
}

/** The server's record of what the note uses has caught up with its latest change. */
async function reported(page: Page) {
  await expect
    .poll(
      async () => {
        const note = (await readTable<NoteRow>(page, "notes")).find((row) => row.title === TITLE);
        return (
          note !== undefined && note.lastUpdateSeq > 0 && note.refsThroughSeq === note.lastUpdateSeq
        );
      },
      // A report goes out on a sync pass at most every 20 seconds.
      { timeout: 90_000, intervals: [1_000] },
    )
    .toBe(true);
}

/** A date as the settings page writes one. */
const dateOn = (page: Page, at: number) =>
  page.evaluate(
    (when) =>
      new Date(when).toLocaleDateString("ja-JP", {
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
    at,
  );

test.describe("writing stored images again as WebP", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "one run is enough: the settings page is the same on a phone",
    );
  });

  test("an image stored before this device could write WebP is written again from settings, and its original goes", async ({
    page,
    context,
  }) => {
    test.slow();
    // As before S4 on Safari: a canvas that writes PNG when asked for WebP,
    // and no WebP encoder to turn to (its worker cannot start).
    await page.addInitScript(() => {
      const toBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
        return toBlob.call(this, callback, type === "image/webp" ? "image/png" : type, quality);
      };
      (window as unknown as { Worker: unknown }).Worker = class {
        constructor() {
          throw new Error("no worker here");
        }
      };
    });
    await signUp(page);
    await openApp(page);
    await createNote(page, TITLE);
    await pastePhoto(page);
    // Stored on the server, as an older version on Safari stored it.
    const [original] = await filesOnceThey(
      page,
      (rows) => rows.length === 1 && rows[0]!.status === "committed",
    );
    expect(["image/png", "image/jpeg"]).toContain(original!.mime);
    await uploadsDrained(page);
    await waitForSynced(page);
    await page.close();

    // This version, as it is now, in settings.
    const settings = await context.newPage();
    await settings.goto("/app/settings");
    const section = settings.getByRole("region", { name: "画像を WebP にし直す" });
    await expect(section).toContainText("PNG・JPEG の画像が 1 枚", { timeout: 20_000 });
    await section.getByRole("button", { name: "WebP にし直す" }).click();
    await expect(section).toContainText("1 枚を WebP にしました", { timeout: 60_000 });
    // Nothing is left to offer.
    await expect(section.getByRole("button", { name: "WebP にし直す" })).toHaveCount(0);

    // The copy is on the server, and the note shows it.
    const rows = await filesOnceThey(
      settings,
      (found) =>
        found.find((row) => row.attachmentId !== original!.attachmentId)?.status === "committed",
    );
    const copy = rows.find((row) => row.attachmentId !== original!.attachmentId)!;
    expect(copy.mime).toBe("image/webp");
    await settings.goto("/app");
    await showList(settings);
    await settings.getByText(TITLE).filter({ visible: true }).first().click();
    await expect(settings.locator('[data-content-type="image"]').first()).toHaveAttribute(
      "data-url",
      `memoca://att/${copy.attachmentId}`,
    );
    await waitForSynced(settings);

    // The server hears the note shows the copy, and the original goes unused:
    // to be deleted a week on, not thirty days.
    const before = Date.now();
    await reported(settings);
    const after = Date.now();
    await settings.goto("/app/settings");
    await settings.getByRole("button", { name: "更新", exact: true }).click();
    await expect(settings.getByText("使われなくなったファイル").first()).toBeVisible({
      timeout: 20_000,
    });
    const due = settings.getByText(/^1 件。.*以降、順に自動で削除されます$/).first();
    await expect(due).toBeVisible();
    const said = (await due.textContent()) ?? "";
    const expected = [
      await dateOn(settings, before + 7 * DAY),
      await dateOn(settings, after + 7 * DAY),
    ];
    expect(
      expected.some((date) => said.includes(date)),
      `${said} vs ${expected}`,
    ).toBe(true);
  });
});
