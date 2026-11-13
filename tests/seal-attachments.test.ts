import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { prepareVault, vault } from "@/lib/crypto/vault";
import { sealAttachments } from "@/lib/vault/actions";
import { fakeConvex } from "./helpers/fake-convex";
import { FAST_ARGON } from "./helpers/seed";

beforeEach(async () => {
  (await prepareVault("パスワード", FAST_ARGON)).adopt();
});

afterEach(() => {
  vault.lock();
  vi.unstubAllGlobals();
});

const FILE = { attachmentId: "a1", name: "写真.png", mime: "image/png" };
const server = () =>
  fakeConvex({
    "attachments:urls": () => ({ a1: "https://files.example/a1" }),
    "notes:snapshotUploadUrl": () => "https://files.example/upload",
  });

test("a file the storage answers for with an error is not sealed in the error's place: the lock stops", async () => {
  // The answer's body (an error page) was read as the file, sealed and
  // swapped in, and the server then deleted the file itself.
  const fetched = vi.fn(async (url: string) =>
    url.endsWith("/upload")
      ? new Response(JSON.stringify({ storageId: "st-1" }), { status: 200 })
      : new Response("Service Unavailable", { status: 503 }),
  );
  vi.stubGlobal("fetch", fetched);
  const fake = server();
  await expect(sealAttachments(fake.client, [FILE])).rejects.toThrow(/503/);
  // Nothing uploaded in its place.
  expect(fetched.mock.calls.map(([url]) => url)).toEqual(["https://files.example/a1"]);
});

test("a file whose storage is gone (404) is left out, as before", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("Not Found", { status: 404 })));
  const fake = server();
  expect(await sealAttachments(fake.client, [FILE])).toEqual([]);
});
