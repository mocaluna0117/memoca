import { describe, expect, test, vi } from "vitest";
import { downloadFile, nameFor, sharesFiles } from "@/lib/media/open-file";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
/** An iPad asked for the site as a phone's: no "Macintosh" in it. */
const IPAD = "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0";
const APP = "https://memoca.test";
const OWN = `blob:${APP}/5f1c`;
const REMOTE = "https://example.convex.cloud/api/storage/abc";

type Fake = {
  here: Window & typeof globalThis;
  fetched: [string, RequestInit | undefined][];
  saved: { href: string; download: string; rel: string }[];
  shared: File[];
  opened: unknown[][];
  timers: number[];
  revoked: string[];
};

/**
 * A window of the app on the given device, whose fetch answers with the
 * given body and type (or `fails`), and whose share sheet, where there is
 * one, does as `share` says.
 */
function fake({
  userAgent = MAC,
  touchPoints = 0,
  body = "%PDF",
  type = "application/pdf",
  status = 200,
  fails = false,
  share,
  canShare = () => true,
  active,
}: {
  userAgent?: string;
  touchPoints?: number;
  body?: string;
  type?: string;
  status?: number;
  fails?: boolean;
  share?: (file: File) => Promise<void>;
  canShare?: () => boolean;
  active?: boolean;
} = {}): Fake {
  const f: Omit<Fake, "here"> = {
    fetched: [],
    saved: [],
    shared: [],
    opened: [],
    timers: [],
    revoked: [],
  };
  const here = {
    location: { href: `${APP}/app`, origin: APP },
    fetch: vi.fn(async (url: string, init?: RequestInit) => {
      f.fetched.push([url, init]);
      if (fails) throw new TypeError("unreachable");
      return { ok: status < 400, status, blob: async () => new Blob([body], { type }) };
    }),
    open: (...args: unknown[]) => f.opened.push(args),
    navigator: {
      userAgent,
      maxTouchPoints: touchPoints,
      ...(active === undefined ? {} : { userActivation: { isActive: active } }),
      ...(share
        ? {
            canShare,
            share: async ({ files }: { files: File[] }) => {
              f.shared.push(...files);
              await share(files[0]!);
            },
          }
        : {}),
    },
    document: {
      createElement: () => {
        const link = {
          href: "",
          download: "",
          rel: "",
          click: () => f.saved.push({ href: link.href, download: link.download, rel: link.rel }),
          remove: () => undefined,
        };
        return link;
      },
      body: { append: () => undefined },
    },
    URL: {
      createObjectURL: () => `blob:${APP}/made-here`,
      revokeObjectURL: (url: string) => f.revoked.push(url),
    },
    setTimeout: (run: () => void, ms: number) => {
      f.timers.push(ms);
      run();
    },
  } as unknown as Window & typeof globalThis;
  return { here, ...f };
}

const iphone = (options: Parameters<typeof fake>[0] = {}) =>
  fake({ userAgent: IPHONE, touchPoints: 5, share: async () => undefined, ...options });

describe("what hands files on through the share sheet", () => {
  test("an iPhone, and an iPad however it says it is one; not a Mac, nor Android", () => {
    expect(sharesFiles(IPHONE, 5)).toBe(true);
    expect(sharesFiles(IPAD, 5)).toBe(true);
    expect(sharesFiles(MAC, 5)).toBe(true);
    expect(sharesFiles(MAC, 0)).toBe(false);
    expect(sharesFiles(ANDROID, 5)).toBe(false);
  });
});

describe("the name a file is saved under", () => {
  test("its own, with the extension of what it is", () => {
    expect(nameFor("見積書.pdf", "application/pdf")).toBe("見積書.pdf");
    expect(nameFor("景色.png", "image/webp")).toBe("景色.webp");
    expect(nameFor("写真.JPEG", "image/jpeg")).toBe("写真.JPEG");
    expect(nameFor("v1.2 の資料", "application/pdf")).toBe("v1.2 の資料.pdf");
    expect(nameFor("", "image/png")).toBe("file.png");
    expect(nameFor("  ", "application/octet-stream")).toBe("file");
    // A type not shown as it is keeps its name as it is.
    expect(nameFor("page.html", "application/octet-stream")).toBe("page.html");
  });
});

describe("the download button", () => {
  test("on an iPhone, hands a locked note's file to the share sheet under its name", async () => {
    const f = iphone();
    expect(await downloadFile(OWN, "見積書.pdf", f.here)).toEqual({ kind: "done" });
    expect(f.shared).toHaveLength(1);
    expect(f.shared[0]!.name).toBe("見積書.pdf");
    expect(f.shared[0]!.type).toBe("application/pdf");
    expect(await f.shared[0]!.text()).toBe("%PDF");
    expect(f.saved).toEqual([]);
    expect(f.opened).toEqual([]);
  });

  test("on an iPhone, hands a file stored readable on the server to the share sheet too", async () => {
    const f = iphone({ type: "image/webp", body: "RIFF" });
    await downloadFile(REMOTE, "景色.png", f.here);
    expect(f.shared.map((file) => [file.name, file.type])).toEqual([["景色.webp", "image/webp"]]);
    expect(f.saved).toEqual([]);
  });

  test("on an iPhone, the sheet put away without choosing is the end of it", async () => {
    const f = iphone({
      share: async () => {
        throw new DOMException("put away", "AbortError");
      },
    });
    expect(await downloadFile(OWN, "見積書.pdf", f.here)).toEqual({ kind: "done" });
    expect(f.saved).toEqual([]);
  });

  test("on an iPhone, a file ready too long after the press is offered again, to hand on at a press of its own", async () => {
    for (const f of [
      // Known before asking.
      iphone({ active: false }),
      // Or told by the sheet.
      iphone({
        share: async () => {
          throw new DOMException("no activation", "NotAllowedError");
        },
      }),
    ]) {
      const opened = await downloadFile(OWN, "見積書.pdf", f.here);
      expect(opened.kind).toBe("ready");
      expect(f.saved).toEqual([]);
      f.shared.length = 0;
      (f.here.navigator as unknown as { share: unknown }).share = async ({
        files,
      }: {
        files: File[];
      }) => {
        f.shared.push(...files);
      };
      if (opened.kind === "ready") await opened.share();
      expect(f.shared.map((file) => file.name)).toEqual(["見積書.pdf"]);
      expect(f.saved).toEqual([]);
    }
  });

  test("on an iPhone, the file offered again is saved if the sheet turns it away, and not if put away", async () => {
    for (const [reason, saved] of [
      ["InvalidStateError", 1],
      ["AbortError", 0],
    ] as const) {
      const f = iphone({ active: false });
      const opened = await downloadFile(OWN, "見積書.pdf", f.here);
      (f.here.navigator as unknown as { share: unknown }).share = async () => {
        throw new DOMException("no", reason);
      };
      if (opened.kind === "ready") await opened.share();
      expect(f.saved, reason).toHaveLength(saved);
    }
  });

  test("on an iPhone, a sheet that will not take the file saves it instead", async () => {
    const f = iphone({ canShare: () => false });
    await downloadFile(OWN, "見積書.pdf", f.here);
    expect(f.shared).toEqual([]);
    expect(f.saved).toEqual([{ href: OWN, download: "見積書.pdf", rel: "noopener" }]);
  });

  test("on a computer or Android, saves a locked note's file under its name, from the URL it has", async () => {
    for (const [userAgent, touchPoints] of [
      [MAC, 0],
      [ANDROID, 5],
    ] as const) {
      const f = fake({ userAgent, touchPoints, share: async () => undefined });
      await downloadFile(OWN, "見積書.pdf", f.here);
      expect(f.shared, userAgent).toEqual([]);
      expect(f.saved, userAgent).toEqual([{ href: OWN, download: "見積書.pdf", rel: "noopener" }]);
      // Not this function's to revoke: the note still shows it.
      expect(f.revoked).toEqual([]);
    }
  });

  test("saves a file from a server under its name, through a URL of its own that goes a minute on", async () => {
    const f = fake({ type: "image/webp" });
    await downloadFile(REMOTE, "景色.webp", f.here);
    expect(f.saved).toEqual([
      { href: `blob:${APP}/made-here`, download: "景色.webp", rel: "noopener" },
    ]);
    expect(f.timers).toEqual([60_000]);
    expect(f.revoked).toEqual([`blob:${APP}/made-here`]);
    expect(f.opened).toEqual([]);
  });

  test("asks a server for a file with no cookies and no Referer", async () => {
    const f = fake();
    await downloadFile(REMOTE, "見積書.pdf", f.here);
    expect(f.fetched).toEqual([[REMOTE, { credentials: "omit", referrerPolicy: "no-referrer" }]]);
  });

  test("a web page from a server is saved as bytes, never with a type this tab would run", async () => {
    for (const type of ["text/html", "image/svg+xml", "application/xhtml+xml", ""]) {
      const f = iphone({ type, body: "<script>alert(1)</script>" });
      await downloadFile("https://evil.example/cat.png", "photo.html", f.here);
      expect(f.shared[0]!.type, type).toBe("application/octet-stream");
      expect(f.shared[0]!.name).toBe("photo.html");
    }
  });

  test("a file from a server this tab may not read opens where it is, with no hold on this window", async () => {
    for (const f of [fake({ fails: true }), fake({ status: 404 })]) {
      expect(await downloadFile(REMOTE, "写真.webp", f.here)).toEqual({ kind: "done" });
      expect(f.opened).toEqual([[REMOTE, "_blank", "noopener,noreferrer"]]);
      expect(f.saved).toEqual([]);
    }
  });

  test("a file of this tab's own that has gone is never opened as a page", async () => {
    const f = fake({ fails: true });
    expect(await downloadFile(OWN, "見積書.pdf", f.here)).toEqual({ kind: "unavailable" });
    expect(f.opened).toEqual([]);
    expect(f.saved).toEqual([]);
  });

  test("anything but a file's address opens nothing", async () => {
    for (const href of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "memoca://att/0190",
      "blob:https://evil.example/5f1c",
      "http://[::1",
    ]) {
      const f = fake();
      expect(await downloadFile(href, "x", f.here), href).toEqual({ kind: "unavailable" });
      expect(f.fetched, href).toEqual([]);
      expect(f.opened, href).toEqual([]);
      expect(f.saved, href).toEqual([]);
    }
  });

  test("a press while one is under way, its address still on its way, is let go", async () => {
    const f = fake();
    let resolve!: (href: string) => void;
    const first = downloadFile(new Promise<string>((done) => (resolve = done)), "a.pdf", f.here);
    expect(await downloadFile(OWN, "b.pdf", f.here)).toEqual({ kind: "done" });
    resolve(OWN);
    await first;
    expect(f.saved.map((saved) => saved.download)).toEqual(["a.pdf"]);
    // And the next press after it is not.
    await downloadFile(OWN, "c.pdf", f.here);
    expect(f.saved.map((saved) => saved.download)).toEqual(["a.pdf", "c.pdf"]);
  });

  test("an address that could not be looked up lets the next press through", async () => {
    const f = fake();
    await expect(
      downloadFile(Promise.reject(new Error("vault closed")), "a", f.here),
    ).rejects.toThrow();
    await downloadFile(OWN, "b.pdf", f.here);
    expect(f.saved).toHaveLength(1);
  });
});
