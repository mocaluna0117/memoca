import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  type AuthClientForConvex,
  useBetterAuthForConvex,
} from "@/components/providers/convex-auth";

// The server-rendered token counts for the first mount only, which the
// module remembers: so this has a file, and a module, of its own.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Fetch = (opts?: { forceRefreshToken?: boolean }) => Promise<string | null>;

let root: Root;
let host: HTMLDivElement;
/** Every way of fetching a token the hook has handed Convex, in order. */
let fetchers: Fetch[];
/** The tokens the server hands out, one per ask. */
let tokens: string[];

const authClient: AuthClientForConvex = {
  useSession: () => ({ data: { session: { id: "session-1" } }, isPending: false }),
  convex: {
    token: async () => ({ data: { token: tokens.shift() ?? null } }),
  },
};

function Probe() {
  const useAuth = useBetterAuthForConvex(authClient, "page-token");
  const { fetchAccessToken } = useAuth();
  if (fetchers.at(-1) !== fetchAccessToken) fetchers.push(fetchAccessToken);
  return null;
}

beforeEach(() => {
  fetchers = [];
  tokens = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test("the page's token is what Convex gets when it does not ask for a new one, until a newer one is had", async () => {
  await act(async () => root.render(<Probe />));
  const latest = () => fetchers.at(-1)!;
  await act(async () => expect(await latest()()).toBe("page-token"));

  tokens = ["token-1"];
  await act(async () => expect(await latest()({ forceRefreshToken: true })).toBe("token-1"));
  await act(async () => expect(await latest()()).toBe("token-1"));
});
