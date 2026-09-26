import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ALLOWED_MIME } from "@convex/lib/constants";
import { db, resetLocalData } from "@/lib/db";
import {
  QuotaError,
  UPLOADABLE_FILE_TYPES,
  UnsupportedFileError,
  prepareUpload,
} from "@/lib/media/attachments";
import { UPLOADABLE_IMAGE_TYPES, UnsupportedImageError } from "@/lib/media/compress";
import { forgetWebpSupport } from "@/lib/media/webp-encoder";

/**
 * jsdom has no canvas: this one writes WebP of `written` bytes (a number, or
 * worked out from the width written) for an image of `size`, which `decodes`
 * says can be read.
 */
let written: number | ((width: number) => number);
let decodes: boolean;
let size: { width: number; height: number };

beforeEach(async () => {
  await resetLocalData();
  forgetWebpSupport();
  written = 100;
  decodes = true;
  size = { width: 400, height: 300 };
  vi.stubGlobal("createImageBitmap", async () => {
    if (!decodes) throw new DOMException("The source image could not be decoded.");
    return { ...size, close() {} };
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({
    drawImage() {},
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4).fill(255),
    }),
  })) as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
    this: HTMLCanvasElement,
    callback,
    type,
  ) {
    const bytes = typeof written === "number" ? written : written(this.width);
    callback(new Blob([new Uint8Array(bytes)], { type: type ?? "image/png" }));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const me = (over: Partial<{ usedBytes: number; quotaBytes: number }> = {}) => ({
  quotaBytes: 10_000,
  usedBytes: 0,
  reservedBytes: 0,
  limits: { maxImageBytes: 1_000, maxVideoBytes: 5_000 },
  ...over,
});
const file = (type: string, size: number, name = "a") => new File([new Uint8Array(size)], name, { type });

describe("getting a file ready to add", () => {
  test("an image comes back compressed, when it fits", async () => {
    const prepared = await prepareUpload(file("image/png", 5_000), me());
    expect(prepared).toMatchObject({ mime: "image/webp", width: 400, height: 300 });
    expect(prepared.blob.size).toBe(100);
  });

  test("one that would not fit what the account has left is refused", async () => {
    const refusal = await prepareUpload(file("image/png", 5_000), me({ usedBytes: 9_950 })).catch((e) => e);
    expect(refusal).toBeInstanceOf(QuotaError);
    expect(refusal).toMatchObject({ message: "quotaExceeded" });
  });

  test("counts what is still waiting to go up, but not what the server has already reserved", async () => {
    const waiting = (attachmentId: string, reserved: boolean) => ({
      attachmentId,
      noteId: "n1",
      blob: { size: 9_950, type: "video/mp4" } as unknown as Blob,
      mime: "video/mp4",
      name: "a.mp4",
      width: null,
      height: null,
      category: "video" as const,
      locked: false,
      reserved,
      createdAt: 0,
    });
    // Reserved: in the server's own figures already.
    await db().pendingUploads.put(waiting("sent", true));
    expect((await prepareUpload(file("image/png", 5_000), me())).mime).toBe("image/webp");
    // Not yet: only this device knows it is coming.
    await db().pendingUploads.put(waiting("queued", false));
    await expect(prepareUpload(file("image/png", 5_000), me())).rejects.toMatchObject({
      message: "quotaExceeded",
    });
  });

  test("an image over the limit for one image is made smaller to fit it, not turned away", async () => {
    size = { width: 4000, height: 3000 };
    // 2048 wide comes to 6144 bytes; 1600 wide to 4800.
    written = (width) => width * 3;
    const prepared = await prepareUpload(file("image/jpeg", 20_000), {
      ...me(),
      limits: { maxImageBytes: 5_000, maxVideoBytes: 50_000 },
    });
    expect(prepared).toMatchObject({ width: 1600, height: 1200 });
  });

  test("an image still over the limit for one image says what the limit is", async () => {
    written = 2_000;
    const refusal = await prepareUpload(file("image/png", 5_000), me()).catch((e) => e);
    expect(refusal).toMatchObject({ message: "tooLarge", limit: 1_000, kind: "image" });
  });

  test("a video is held to the limit for videos, as it is", async () => {
    const small = file("video/mp4", 4_000);
    expect((await prepareUpload(small, me())).blob).toBe(small);
    const refusal = await prepareUpload(file("video/mp4", 6_000), me()).catch((e) => e);
    expect(refusal).toMatchObject({ message: "tooLarge", limit: 5_000, kind: "video" });
  });

  test("a HEIC photo this browser cannot read is refused, even one that arrives with no type", async () => {
    decodes = false;
    await expect(prepareUpload(file("image/heic", 500), me())).rejects.toBeInstanceOf(UnsupportedImageError);
    await expect(prepareUpload(file("", 500, "IMG_0001.HEIC"), me())).rejects.toBeInstanceOf(
      UnsupportedImageError,
    );
  });

  test("a file of a type the server does not take is refused in an ordinary note", async () => {
    await expect(prepareUpload(file("application/pdf", 500), me())).rejects.toBeInstanceOf(UnsupportedFileError);
    await expect(prepareUpload(file("audio/mpeg", 500), me())).rejects.toBeInstanceOf(UnsupportedFileError);
    // One of no known type, the server takes.
    const unknown = file("", 500, "memo.bin");
    expect((await prepareUpload(unknown, me())).blob).toBe(unknown);
  });

  test("a locked note takes any file, and an image it cannot read as it is: both go up encrypted", async () => {
    const pdf = file("application/pdf", 500);
    expect((await prepareUpload(pdf, me(), { locked: true })).blob).toBe(pdf);
    decodes = false;
    const svg = file("image/svg+xml", 500);
    expect(await prepareUpload(svg, me(), { locked: true })).toMatchObject({ blob: svg, mime: "image/svg+xml" });
  });

  test("with no account figures yet, only the image itself is checked", async () => {
    written = 50_000;
    expect((await prepareUpload(file("image/png", 60_000), null)).mime).toBe("image/webp");
  });
});

test("the types an upload can end up as are the ones the server takes", () => {
  expect([...UPLOADABLE_IMAGE_TYPES, ...UPLOADABLE_FILE_TYPES].sort()).toEqual([...ALLOWED_MIME].sort());
});
