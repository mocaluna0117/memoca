import { expect, type Page, test } from "@playwright/test";
import { createNote, openApp, signUp, waitForSynced } from "./helpers";
import { pasteImage } from "./image-helpers";
import { createVaultInSettings } from "./vault-helpers";

/** Every Content-Security-Policy violation on the page, from the start of each load. */
async function recordViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const w = window as unknown as { __violations: string[] };
    w.__violations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      w.__violations.push(
        `${event.effectiveDirective} ${event.blockedURI} ${event.sourceFile}:${event.lineNumber}`,
      );
    });
  });
  const seen: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /Content Security Policy/i.test(message.text())) {
      seen.push(message.text());
    }
  });
  return async () => [
    ...seen,
    ...(await page.evaluate(() => (window as unknown as { __violations: string[] }).__violations)),
  ];
}

test("the site works under its Content-Security-Policy, with nothing of its own blocked", async ({
  page,
}) => {
  test.slow();
  const violations = await recordViolations(page);

  const response = await page.goto("/sign-in");
  expect(response?.headers()["content-security-policy"]).toContain("'strict-dynamic'");

  await signUp(page);
  await openApp(page);
  // The theme's own inline script ran: it sets the class before React does.
  await expect(page.locator("html")).toHaveClass(/light|dark/);

  await createNote(page, "ポリシーのメモ", "本文");
  // Encoded to WebP in a worker.
  await pasteImage(page);
  await waitForSynced(page);

  // Argon2id, in WebAssembly.
  await createVaultInSettings(page);
  await page.goto("/app/news");
  await page.goto("/app/search");

  expect(await violations()).toEqual([]);
});
