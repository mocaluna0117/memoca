import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { formatBytes } from "@/lib/bytes";
import { t } from "@/lib/i18n/ja";
import type { ConvertReport, Found } from "@/lib/media/convert-images";

const h = vi.hoisted(() => ({
  find: vi.fn(),
  convert: vi.fn(),
  online: true,
  unlocked: false,
  fetchBodies: vi.fn(async () => undefined),
  kick: vi.fn(),
  /** The one client, as Convex's provider gives it. */
  client: {},
}));
vi.mock("@/lib/media/convert-images", () => ({
  findConvertible: h.find,
  convertImages: h.convert,
}));
vi.mock("convex/react", () => ({ useConvex: () => h.client }));
vi.mock("@/components/providers/sync-provider", () => ({
  useSync: () => ({ engine: () => ({ fetchBodies: h.fetchBodies, kick: h.kick }) }),
}));
vi.mock("@/lib/hooks/use-online", () => ({ useOnline: () => h.online }));
vi.mock("@/lib/hooks/use-decrypted", () => ({ useVaultUnlocked: () => h.unlocked }));

import { ConvertImages } from "@/components/settings/convert-images";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ALLOWANCE = { quotaBytes: 100, usedBytes: 0, reservedBytes: 0 };
const two: Found = {
  files: [
    {
      attachmentId: "a",
      noteId: "n",
      bytes: 1_000_000,
      mime: "image/png",
      name: "a.png",
      locked: false,
      usedBy: ["n"],
    },
    {
      attachmentId: "b",
      noteId: "n",
      bytes: 500_000,
      mime: "image/png",
      name: "b.png",
      locked: false,
      usedBy: ["n"],
    },
  ],
  bytes: 1_500_000,
  waitingForVault: 0,
};
const none: Found = { files: [], bytes: 0, waitingForVault: 0 };

let root: Root;
let host: HTMLDivElement;

const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
const text = () => host.textContent ?? "";
const button = (name: string) =>
  Array.from(host.querySelectorAll("button")).find((found) => found.textContent === name);

async function show() {
  await act(async () => root.render(<ConvertImages allowance={ALLOWANCE} />));
  await settle();
}

beforeEach(() => {
  h.find.mockReset().mockResolvedValue(two);
  h.convert.mockReset();
  h.fetchBodies.mockClear();
  h.kick.mockClear();
  h.online = true;
  h.unlocked = false;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("writing stored images again as WebP, in settings", () => {
  test("says how many there are and their size, runs, shows how far it has come, and how it went", async () => {
    let finish!: (report: ConvertReport) => void;
    h.convert.mockImplementation(
      (opts: { onProgress: (p: object) => void }) =>
        new Promise<ConvertReport>((resolve) => {
          opts.onProgress({
            total: 2,
            done: 1,
            converted: 1,
            kept: 0,
            failed: 0,
            before: 1,
            after: 1,
          });
          finish = resolve;
        }),
    );
    await show();
    expect(text()).toContain(t.convert.found(2, formatBytes(1_500_000)));

    await act(async () => button(t.convert.start)!.click());
    expect(h.convert).toHaveBeenCalledWith(
      expect.objectContaining({ files: two.files, allowance: ALLOWANCE }),
    );
    expect(text()).toContain(t.convert.progress(1, 2));
    expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("1");
    expect(button(t.convert.start)).toBeUndefined();

    h.find.mockResolvedValue(none);
    await act(async () =>
      finish({
        total: 2,
        done: 2,
        converted: 2,
        kept: 0,
        failed: 0,
        before: 1_500_000,
        after: 300_000,
        stopped: null,
      }),
    );
    await settle();
    expect(text()).toContain(t.convert.done(2, formatBytes(1_500_000), formatBytes(300_000)));
    // Looked for again: nothing left to offer.
    expect(h.find).toHaveBeenCalledTimes(2);
    expect(button(t.convert.start)).toBeUndefined();
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
  });

  test("止める stops the run", async () => {
    let signal!: AbortSignal;
    h.convert.mockImplementation(
      (opts: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          signal = opts.signal;
          signal.addEventListener("abort", () =>
            resolve({
              total: 2,
              done: 1,
              converted: 1,
              kept: 0,
              failed: 0,
              before: 1,
              after: 1,
              stopped: "cancelled",
            }),
          );
        }),
    );
    await show();
    await act(async () => button(t.convert.start)!.click());
    await act(async () => button(t.convert.stop)!.click());
    await settle();
    expect(signal.aborted).toBe(true);
    expect(text()).toContain(t.convert.cancelled);
  });

  test("hands the sync engine's fetching of bodies to the run", async () => {
    h.convert.mockResolvedValue({
      total: 0,
      done: 0,
      converted: 0,
      kept: 0,
      failed: 0,
      before: 0,
      after: 0,
      stopped: null,
    });
    await show();
    await act(async () => button(t.convert.start)!.click());
    const { fetchBodies } = h.convert.mock.calls[0]![0] as {
      fetchBodies: (ids: string[]) => Promise<void>;
    };
    await fetchBodies(["n"]);
    expect(h.fetchBodies).toHaveBeenCalledWith(["n"]);
  });

  test("reads the account's figures as they are at each image, not as they were at the start", async () => {
    let opts!: { allowance: typeof ALLOWANCE };
    h.convert.mockImplementation((given: typeof opts) => {
      opts = given;
      return new Promise(() => {});
    });
    await show();
    await act(async () => button(t.convert.start)!.click());
    const later = { ...ALLOWANCE, usedBytes: 90 };
    await act(async () => root.render(<ConvertImages allowance={later} />));
    expect(opts.allowance).toEqual(later);
  });

  test("has the sync engine send each copy at once", async () => {
    h.convert.mockImplementation(async (given: { send: () => void }) => {
      given.send();
      return {
        total: 0,
        done: 0,
        converted: 0,
        kept: 0,
        failed: 0,
        before: 0,
        after: 0,
        stopped: null,
      };
    });
    await show();
    await act(async () => button(t.convert.start)!.click());
    expect(h.kick).toHaveBeenCalledWith(0);
  });

  test("says how far it has come without reading it out at each image, and asks to be left open", async () => {
    h.convert.mockImplementation(
      (given: { onProgress: (p: object) => void }) =>
        new Promise(() => {
          given.onProgress({
            total: 2,
            done: 1,
            converted: 1,
            kept: 0,
            failed: 0,
            before: 1,
            after: 1,
          });
        }),
    );
    await show();
    await act(async () => button(t.convert.start)!.click());
    expect(text()).toContain(t.convert.progress(1, 2));
    expect(text()).toContain(t.convert.keepOpen);
    expect(host.querySelector('[role="status"]')?.textContent).not.toContain(
      t.convert.progress(1, 2),
    );
    expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuetext")).toBe(
      t.convert.progress(1, 2),
    );
  });

  test("止める says it is stopping, until the image under way is done", async () => {
    h.convert.mockImplementation(() => new Promise(() => {}));
    await show();
    await act(async () => button(t.convert.start)!.click());
    await act(async () => button(t.convert.stop)!.click());
    const stopping = button(t.convert.stopping)!;
    expect(stopping.disabled).toBe(true);
  });

  test("offers nothing found before a run once it is over, until it has looked again", async () => {
    h.convert.mockResolvedValue({
      total: 2,
      done: 2,
      converted: 2,
      kept: 0,
      failed: 0,
      before: 2,
      after: 1,
      stopped: null,
    });
    await show();
    h.find.mockImplementation(() => new Promise(() => {}));
    await act(async () => button(t.convert.start)!.click());
    await settle();
    expect(text()).toContain(t.convert.looking);
    expect(text()).not.toContain(t.convert.found(2, formatBytes(1_500_000)));
    expect(button(t.convert.start)).toBeUndefined();
  });

  test("a run that fails outright says so, and can be tried again", async () => {
    h.convert.mockRejectedValue(new Error("boom"));
    await show();
    await act(async () => button(t.convert.start)!.click());
    await settle();
    expect(text()).toContain(t.convert.runFailed);
    expect(button(t.convert.start)).toBeDefined();
  });

  test("offline, it cannot run", async () => {
    h.online = false;
    await show();
    expect(text()).toContain(t.convert.offline);
    expect(button(t.convert.start)).toBeUndefined();
  });

  test("with nothing to convert, says so; with locked notes' files, says the vault is needed", async () => {
    h.find.mockResolvedValue(none);
    await show();
    expect(text()).toContain(t.convert.none);

    h.find.mockResolvedValue({ ...none, waitingForVault: 3 });
    h.unlocked = true;
    await show();
    expect(text()).toContain(t.convert.waitingForVault(3));
    expect(text()).not.toContain(t.convert.none);
  });

  test("a look that fails says so", async () => {
    h.find.mockRejectedValue(new Error("offline"));
    await show();
    expect(text()).toContain(t.convert.lookFailed);
  });

  test("how a run stopped is said in plain words", async () => {
    for (const [stopped, line] of [
      ["quota", t.convert.quota],
      ["offline", t.convert.stoppedOffline],
      ["unsent", t.convert.unsent],
    ] as const) {
      h.convert.mockResolvedValueOnce({
        total: 2,
        done: 1,
        converted: 0,
        kept: 1,
        failed: 1,
        before: 0,
        after: 0,
        stopped,
      });
      await show();
      await act(async () => button(t.convert.start)!.click());
      await settle();
      expect(text(), stopped).toContain(line);
      expect(text()).toContain(t.convert.kept(1));
      expect(text()).toContain(t.convert.failed(1));
      await act(async () => root.unmount());
      root = createRoot(host);
    }
  });
});
