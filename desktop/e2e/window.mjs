// A window of the installed app, on Windows (CI, .github/workflows/
// desktop.yml): the quick note's, or Memoca's own (app_window.rs). It loads
// Memoca's site, which takes it for the Windows shell, and shows the
// shell's sign-in, on the way to the quick note or the notes. Driven
// through its WebView2's debugging port, as Playwright drives WebView2
// apps: the app started with
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>.
// Usage: node e2e/window.mjs [port, 9222 if none] [quick (if none) | app]
import { chromium } from "playwright-core";

const port = process.argv[2] ?? "9222";
const which = process.argv[3] ?? "quick";
const ORIGIN = "https://memoca-app.vercel.app/";
/** The page a window is for, signed in: where its sign-in goes on to. */
const FOR = { quick: "/quick", app: "/app" }[which];
if (!FOR) throw new Error(`no window "${which}"`);

/** Where a page is on its way to: itself, or past signing in. */
const goingTo = (address) => {
  const url = new URL(address);
  return url.pathname === "/sign-in" ? new URL(url.searchParams.get("next") ?? "/", url).pathname : url.pathname;
};

const check = (ok, what) => {
  if (!ok) throw new Error(`not so: ${what}`);
  console.log(`ok: ${what}`);
};

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
try {
  // The window's one page, once it is there and on the site.
  let page;
  for (const until = Date.now() + 60_000; !page && Date.now() < until; ) {
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((each) => each.url().startsWith(ORIGIN) && goingTo(each.url()) === FOR);
    if (!page) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  check(page, `the ${which} window loads Memoca's site, for ${FOR}`);

  await page.getByText("ブラウザでログイン").first().waitFor({ timeout: 60_000 });
  check(true, "signed out, it shows the shell's sign-in (ブラウザでログイン)");
  check(new URL(page.url()).pathname === "/sign-in", `on /sign-in (${page.url()})`);

  const agent = await page.evaluate(() => navigator.userAgent);
  check(/MemocaShell\/\S+ \(windows\)/.test(agent), `it says it is the Windows shell (${agent})`);
  const platform = await page.evaluate(() => window.memocaShell?.platform);
  check(platform === "windows", "the page is given the shell's bridge, for Windows");
  const commands = await page.evaluate(() =>
    ["hide", "openExternal", "openApp", "showQuick", "showApp", "copyImages", "beginSignIn", "completeSignIn", "takeSignIn"].filter(
      (name) => typeof window.memocaShell?.[name] !== "function",
    ),
  );
  check(commands.length === 0, `the bridge has its commands${commands.length ? ` (not ${commands})` : ""}`);

  if (which === "quick") {
    // What the page asks of the app answers, and the app goes on answering:
    // Memoca's own window made from the quick note's 「Memoca を開く」 once
    // stopped the whole app on Windows (0.4.1).
    const ask = (command) =>
      page.evaluate(async (command) => {
        try {
          await Promise.race([
            window.__TAURI_INTERNALS__.invoke(command),
            new Promise((_, reject) => setTimeout(() => reject(new Error("no answer in 10 s")), 10_000)),
          ]);
          return "answered";
        } catch (error) {
          return String(error?.message ?? error);
        }
      }, command);
    for (const command of ["show_quick", "hide", "show_app"]) {
      const said = await ask(command);
      check(said === "answered", `${command} answers (${said})`);
    }
    let made;
    for (const until = Date.now() + 60_000; !made && Date.now() < until; ) {
      made = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((each) => each.url().startsWith(ORIGIN) && goingTo(each.url()) === "/app");
      if (!made) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    check(made, "show_app makes Memoca's own window, and it loads the site, for /app");
    for (const command of ["show_quick", "hide"]) {
      const said = await ask(command);
      check(said === "answered", `${command} still answers, after (${said})`);
    }
  }
} finally {
  // Leaves the app running: connected to, not started by, this.
  await browser.close();
}
