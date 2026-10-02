// The window of the installed app, driven through tauri-driver (WebDriver)
// on Windows (CI, .github/workflows/desktop.yml): it loads Memoca's site,
// which takes it for the Windows shell, and shows the shell's sign-in.
// Usage: node e2e/window.mjs <path to Memoca.exe>, with tauri-driver on 4444.
import { Builder, By, until } from "selenium-webdriver";

const application = process.argv[2];
if (!application) throw new Error("usage: node e2e/window.mjs <Memoca.exe>");

const driver = await new Builder()
  .usingServer("http://127.0.0.1:4444/")
  .withCapabilities({ browserName: "wry", "tauri:options": { application } })
  .build();

const check = (ok, what) => {
  if (!ok) throw new Error(`not so: ${what}`);
  console.log(`ok: ${what}`);
};

try {
  await driver.wait(
    async () => (await driver.getCurrentUrl()).startsWith("https://memoca-app.vercel.app/"),
    60_000,
  );
  check(true, "the window loads Memoca's site");
  await driver.wait(until.elementLocated(By.xpath("//*[contains(., 'ブラウザでログイン')]")), 60_000);
  check(true, "signed out, it shows the shell's sign-in (ブラウザでログイン)");
  const url = await driver.getCurrentUrl();
  check(new URL(url).pathname === "/sign-in", `on /sign-in (${url})`);
  const agent = await driver.executeScript("return navigator.userAgent");
  check(/MemocaShell\/\S+ \(windows\)/.test(agent), `it says it is the Windows shell (${agent})`);
  const platform = await driver.executeScript("return window.memocaShell && window.memocaShell.platform");
  check(platform === "windows", "the page is given the shell's bridge, for Windows");
  const keys = await driver.executeScript(
    "return typeof window.memocaShell.hide === 'function' && typeof window.memocaShell.beginSignIn === 'function'",
  );
  check(keys === true, "the bridge has its commands");
} finally {
  await driver.quit();
}
