import { describe, expect, test, vi } from "vitest";
import { newBuildOut } from "@/lib/build";

/** A window whose server says it is of `build`, or fails as `fails` says. */
function asking(answer: () => Promise<unknown>) {
  const fetch = vi.fn(answer);
  return { here: { fetch } as unknown as Window, fetch };
}
const says = (build: unknown) => async () => ({ ok: true, json: async () => ({ build }) });

describe("a newer build of the site", () => {
  test("is one the server says is out, other than this page's", async () => {
    const { here, fetch } = asking(says("b2"));
    expect(await newBuildOut("b1", here)).toBe(true);
    expect(fetch).toHaveBeenCalledWith("/api/build", { cache: "no-store" });
    expect(await newBuildOut("b2", asking(says("b2")).here)).toBe(false);
  });

  test("is never one made here, on either side", async () => {
    const { here, fetch } = asking(says("b2"));
    expect(await newBuildOut("dev", here)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(await newBuildOut("b1", asking(says("dev")).here)).toBe(false);
  });

  test("is not known when the server cannot be asked, or says nothing of it", async () => {
    for (const answer of [
      async () => {
        throw new TypeError("offline");
      },
      async () => ({ ok: false, json: async () => ({ build: "b2" }) }),
      says(undefined),
      says(42),
      async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError("not JSON");
        },
      }),
    ]) {
      expect(await newBuildOut("b1", asking(answer).here)).toBe(false);
    }
  });
});
