import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type AuthClientForConvex,
  useBetterAuthForConvex,
} from "@/components/providers/convex-auth";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Fetch = (opts?: { forceRefreshToken?: boolean }) => Promise<string | null>;
/**
 * What the server answers an ask with: a token; null, for an ask that fails;
 * an Error, thrown as better-fetch does when there is no network; or the
 * status the server refuses with.
 */
type Answer = string | null | Error | number;

let root: Root;
let host: HTMLDivElement;
/** Every way of fetching a token the hook has handed Convex, in order. */
let fetchers: Fetch[];
/** The server's answers, one per ask; one that takes a while waits in a promise. */
let answers: (Answer | Promise<Answer>)[];
/** Whether the session has someone signed in. */
let signedIn: boolean;

const authClient: AuthClientForConvex = {
  useSession: () => ({
    data: signedIn ? { session: { id: "session-1" } } : null,
    isPending: false,
  }),
  convex: {
    token: async () => {
      const answer = await (answers.shift() ?? null);
      if (answer instanceof Error) throw answer;
      if (typeof answer === "number") return { data: null, error: { status: answer } };
      return { data: { token: answer } };
    },
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

/** An answer the test gives when it chooses, for an ask still running meanwhile. */
function slow() {
  let give!: (answer: Answer) => void;
  const answer = new Promise<Answer>((resolve) => (give = resolve));
  return { answer, give };
}

beforeEach(async () => {
  fetchers = [];
  answers = [];
  signedIn = true;
  setOnline(true);
  setVisibility("visible");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Probe />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  setOnline(true);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const latest = () => fetchers.at(-1)!;

/** Lets time pass. */
async function pass(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("the token Convex signs in with", () => {
  test("could not be had offline: asked for again, by a new way, once the network is back", async () => {
    answers = [null, "token-2"];
    setOnline(false);
    await act(async () => expect(await latest()({ forceRefreshToken: true })).toBeNull());
    const before = fetchers.length;

    setOnline(true);
    await act(async () => window.dispatchEvent(new Event("online")));
    expect(fetchers.length).toBe(before + 1);
    await act(async () => expect(await latest()({ forceRefreshToken: true })).toBe("token-2"));
  });

  test("could not be had offline, the fetch throwing: the same, and nothing tried until then", async () => {
    answers = [new TypeError("Failed to fetch"), "token-2"];
    setOnline(false);
    await act(async () => expect(await latest()({ forceRefreshToken: true })).toBeNull());
    const before = fetchers.length;
    expect(vi.getTimerCount()).toBe(0);

    setOnline(true);
    await act(async () => window.dispatchEvent(new Event("online")));
    expect(fetchers.length).toBe(before + 1);
    await act(async () => expect(await latest()({ forceRefreshToken: true })).toBe("token-2"));
  });

  test("had, it is not asked for again when the network comes back", async () => {
    answers = ["token-1"];
    await act(async () => expect(await latest()({ forceRefreshToken: true })).toBe("token-1"));
    const before = fetchers.length;
    await act(async () => window.dispatchEvent(new Event("online")));
    expect(fetchers.length).toBe(before);
  });

  test("had, then signed out: not handed back when Convex does not ask for a new one", async () => {
    answers = ["token-1", 401];
    await act(async () => expect(await latest()({ forceRefreshToken: true })).toBe("token-1"));
    signedIn = false;
    await act(async () => root.render(<Probe />));
    await act(async () => expect(await latest()()).toBeNull());
  });

  test("could not be had: asked for again when the page is back in view, but not while still offline", async () => {
    answers = [null, "token-2"];
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
    answers = [null, "token-2"];
    await act(async () => expect(await latest()({ forceRefreshToken: true })).toBeNull());
    const before = fetchers.length;
    // One after the other, each on its own, and no token asked for in between.
    await act(async () => window.dispatchEvent(new Event("online")));
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => window.dispatchEvent(new Event("online")));
    expect(fetchers.length).toBe(before + 1);
  });

  test("could not be had while online and in view: asked for again after 2 s, twice as long each time up to a minute, and after 2 s again once had", async () => {
    // A server error, a network that drops the ask, a page in place of the answer.
    const failures: Answer[] = [503, new TypeError("Failed to fetch"), null];
    const failThenWait = async (answer: Answer, ms: number) => {
      answers = [answer];
      await act(async () => expect(await latest()({ forceRefreshToken: true })).toBeNull());
      const before = fetchers.length;
      await pass(ms - 1);
      expect(fetchers.length).toBe(before);
      await pass(1);
      expect(fetchers.length).toBe(before + 1);
    };
    const waits = [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];
    for (const [i, ms] of waits.entries()) await failThenWait(failures[i % failures.length], ms);

    answers = ["token-1"];
    await act(async () => expect(await latest()({ forceRefreshToken: true })).toBe("token-1"));
    await failThenWait(null, 2_000);
  });

  test("could not be had, the network coming back while it was asked for: asked for again a little later", async () => {
    const answer = slow();
    answers = [answer.answer, "token-2"];
    let asked!: Promise<string | null>;
    await act(async () => {
      asked = latest()({ forceRefreshToken: true });
    });
    const before = fetchers.length;
    await act(async () => window.dispatchEvent(new Event("online")));
    await act(async () => {
      answer.give(null);
      expect(await asked).toBeNull();
    });
    expect(fetchers.length).toBe(before);

    await pass(2_000);
    expect(fetchers.length).toBe(before + 1);
    await act(async () => expect(await latest()({ forceRefreshToken: true })).toBe("token-2"));
  });

  test("could not be had twice over, as when Convex asks and at once asks again: one try waits", async () => {
    answers = [null, null];
    await act(async () => expect(await latest()()).toBeNull());
    await act(async () => expect(await latest()({ forceRefreshToken: true })).toBeNull());
    expect(vi.getTimerCount()).toBe(1);
    const before = fetchers.length;
    await pass(2_000);
    expect(fetchers.length).toBe(before + 1);
  });

  test("could not be had, and asked for again by Convex meanwhile: that ask is left to finish, and failing too, it waits its turn", async () => {
    const answer = slow();
    answers = [null, answer.answer];
    await act(async () => expect(await latest()()).toBeNull());
    // Convex asks again at once, and this ask takes longer than the first wait.
    let asked!: Promise<string | null>;
    await act(async () => {
      asked = latest()({ forceRefreshToken: true });
    });
    const before = fetchers.length;
    await pass(2_000);
    await act(async () => window.dispatchEvent(new Event("online")));
    expect(fetchers.length).toBe(before);

    await act(async () => {
      answer.give(null);
      expect(await asked).toBeNull();
    });
    await pass(4_000);
    expect(fetchers.length).toBe(before + 1);
  });

  test("asked for again before the first answer came: that answer, come last and failed, changes nothing", async () => {
    const first = slow();
    answers = [first.answer, "token-2"];
    let asked!: Promise<string | null>;
    await act(async () => {
      asked = latest()({ forceRefreshToken: true });
    });
    await act(async () => expect(await latest()({ forceRefreshToken: true })).toBe("token-2"));
    await act(async () => {
      first.give(null);
      expect(await asked).toBeNull();
    });
    const before = fetchers.length;
    await pass(60_000);
    expect(fetchers.length).toBe(before);
    await act(async () => expect(await latest()()).toBe("token-2"));
  });

  test("asked for again before the first answer came: an ask after that answer waits on the newer one", async () => {
    const first = slow();
    const second = slow();
    answers = [first.answer, second.answer, "token-3"];
    await act(async () => {
      void latest()({ forceRefreshToken: true });
      void latest()({ forceRefreshToken: true });
    });
    await act(async () => first.give("token-1"));
    let asked!: Promise<string | null>;
    await act(async () => {
      asked = latest()();
    });
    await act(async () => {
      second.give("token-2");
      expect(await asked).toBe("token-2");
    });
  });

  test("could not be had with the page hidden, or hidden when the try came: asked for again once the page is back in view", async () => {
    answers = [null, null];
    setVisibility("hidden");
    await act(async () => expect(await latest()({ forceRefreshToken: true })).toBeNull());
    let before = fetchers.length;
    expect(vi.getTimerCount()).toBe(0);
    setVisibility("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(fetchers.length).toBe(before + 1);

    await act(async () => expect(await latest()({ forceRefreshToken: true })).toBeNull());
    before = fetchers.length;
    setVisibility("hidden");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await pass(60_000);
    expect(fetchers.length).toBe(before);
    setVisibility("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(fetchers.length).toBe(before + 1);
  });

  test.each([401, 403])(
    "refused (%i), no one being signed in: not asked for again, which is the session's to see to",
    async (status) => {
      answers = [status];
      await act(async () => expect(await latest()({ forceRefreshToken: true })).toBeNull());
      const before = fetchers.length;
      await pass(120_000);
      await act(async () => window.dispatchEvent(new Event("online")));
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
      expect(fetchers.length).toBe(before);
    },
  );

  test("unmounted, nothing more is tried, even for an ask that fails after", async () => {
    const answer = slow();
    answers = [null, answer.answer];
    await act(async () => expect(await latest()({ forceRefreshToken: true })).toBeNull());
    let asked!: Promise<string | null>;
    await act(async () => {
      asked = latest()({ forceRefreshToken: true });
    });
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      answer.give(null);
      expect(await asked).toBeNull();
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
