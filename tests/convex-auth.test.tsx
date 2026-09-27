import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type AuthClientForConvex,
  useBetterAuthForConvex,
} from "@/components/providers/convex-auth";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Fetch = (opts?: { forceRefreshToken?: boolean }) => Promise<string | null>;

let root: Root;
let host: HTMLDivElement;
/** Every way of fetching a token the hook has handed Convex, in order. */
let fetchers: Fetch[];
/** The tokens the server hands out, one per ask; null for an ask that fails. */
let tokens: (string | null)[];

const authClient: AuthClientForConvex = {
  useSession: () => ({ data: { session: { id: "session-1" } }, isPending: false }),
  convex: {
    token: async () => ({ data: { token: tokens.shift() ?? null } }),
  },
};

function Probe() {
  const useAuth = useBetterAuthForConvex(authClient, null);
  const { fetchAccessToken } = useAuth();
  if (fetchers.at(-1) !== fetchAccessToken) fetchers.push(fetchAccessToken);
  return null;
}

function setOnline(online: boolean) {
  Object.defineProperty(navigator, "onLine", { value: online, configurable: true });
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

beforeEach(async () => {
  fetchers = [];
  tokens = [];
  setOnline(true);
  setVisibility("visible");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Probe />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  setOnline(true);
  vi.restoreAllMocks();
});

const latest = () => fetchers.at(-1)!;

describe("the token Convex signs in with", () => {
  test("could not be had offline: asked for again, by a new way, once the network is back", async () => {
    tokens = [null, "token-2"];
    setOnline(false);
    await act(async () => expect(await latest()({ forceRefreshToken: true })).toBeNull());
    const before = fetchers.length;

    setOnline(true);
    await act(async () => window.dispatchEvent(new Event("online")));
    expect(fetchers.length).toBe(before + 1);
    await act(async () => expect(await latest()({ forceRefreshToken: true })).toBe("token-2"));
  });

  test("had, it is not asked for again when the network comes back", async () => {
    tokens = ["token-1"];
    await act(async () => expect(await latest()({ forceRefreshToken: true })).toBe("token-1"));
    const before = fetchers.length;
    await act(async () => window.dispatchEvent(new Event("online")));
    expect(fetchers.length).toBe(before);
  });

  test("could not be had: asked for again when the page is back in view, but not while still offline", async () => {
    tokens = [null, "token-2"];
    await act(async () => expect(await latest()({ forceRefreshToken: true })).toBeNull());
    const before = fetchers.length;

    setOnline(false);
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(fetchers.length).toBe(before);

    setOnline(true);
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(fetchers.length).toBe(before + 1);
  });

  test("asked for again once, however many signs of the network coming back arrive before it is", async () => {
    tokens = [null, "token-2"];
    await act(async () => expect(await latest()({ forceRefreshToken: true })).toBeNull());
    const before = fetchers.length;
    // One after the other, each on its own, and no token asked for in between.
    await act(async () => window.dispatchEvent(new Event("online")));
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => window.dispatchEvent(new Event("online")));
    expect(fetchers.length).toBe(before + 1);
  });
});
