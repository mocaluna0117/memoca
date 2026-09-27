"use client";

import { ConvexProviderWithAuth, type ConvexReactClient } from "convex/react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

/** The parts of the Better Auth client this needs: its session, and a Convex token. */
export type AuthClientForConvex = {
  useSession(): { data: { session?: { id: string } | null } | null; isPending: boolean };
  convex: {
    token(opts: { fetchOptions: { throw: false } }): Promise<{
      data?: { token?: string | null } | null;
      error?: { status: number } | null;
    }>;
  };
};

type FetchAccessToken = (opts?: { forceRefreshToken?: boolean }) => Promise<string | null>;

/** What an ask for a token came to: the token, or none and whether it may be had yet. */
type Answer = { token: string | null; missed: boolean };

/** The server-rendered token is good for the first page only: after that, one is fetched. */
let initialTokenUsed = false;

/** The wait before asking again, online, after a token could not be had: it doubles up to the longest. */
const FIRST_WAIT_MS = 2_000;
const LONGEST_WAIT_MS = 60_000;

/**
 * The hook Convex asks whether someone is signed in, and for their token:
 * @convex-dev/better-auth's own, with two things more.
 *
 * Convex asks for a new token before the old one runs out (every quarter of
 * an hour); when it gets none, it counts itself signed out and never asks
 * again while the session lasts, which no longer changes. Sync then stays
 * stopped until a reload, which the app no longer does when the network
 * returns. So a token that could not be had is asked for again, by a new way
 * of fetching it, which is what makes Convex sign in again: at once when the
 * network is back or the page back in view (and online); and, while online
 * and in view, after a wait of 2 s that doubles with each failure up to a
 * minute, since a server that failed, or a network that is there in name
 * only, sends no sign when it recovers. Refused because no one is signed in
 * (401, 403), it is not asked for again: that is the session's to see to.
 *
 * And the token Convex gets back when it does not ask for a new one is the
 * last one had. The library's hands back the token of the render its hook
 * was made in: the server-rendered one, however old.
 */
export function useBetterAuthForConvex(
  authClient: AuthClientForConvex,
  initialToken?: string | null,
) {
  const [cachedToken, setCachedToken] = useState<string | null>(
    initialTokenUsed ? null : (initialToken ?? null),
  );
  /**
   * The last token had, read when Convex asks. `cachedToken` in the hook
   * below never moves on from the render it was made in.
   */
  const lastToken = useRef(cachedToken);
  const pending = useRef<Promise<string | null> | null>(null);
  useEffect(() => {
    initialTokenUsed = true;
  }, []);

  return useMemo(
    () =>
      function useAuthFromBetterAuth() {
        const { data: session, isPending } = authClient.useSession();
        const sessionId = session?.session?.id;
        const [attempt, setAttempt] = useState(0);
        /** The last token asked for could not be had, but may be yet. */
        const missed = useRef(false);
        /** The try after a failure while online and in view: one at a time. */
        const later = useRef<ReturnType<typeof setTimeout>>(undefined);
        /** How long the next such try waits. */
        const wait = useRef(FIRST_WAIT_MS);
        /** Mounted: once not, nothing more is tried. */
        const live = useRef(false);

        const retry = useCallback(() => {
          // An ask still running settles it: a new way of fetching now would
          // make Convex throw away what that ask brings.
          if (!missed.current || !navigator.onLine || pending.current) return;
          missed.current = false;
          clearTimeout(later.current);
          later.current = undefined;
          setAttempt((count) => count + 1);
        }, []);

        useEffect(() => {
          live.current = true;
          const onVisible = () => {
            if (document.visibilityState === "visible") retry();
          };
          window.addEventListener("online", retry);
          document.addEventListener("visibilitychange", onVisible);
          return () => {
            live.current = false;
            clearTimeout(later.current);
            later.current = undefined;
            window.removeEventListener("online", retry);
            document.removeEventListener("visibilitychange", onVisible);
          };
        }, [retry]);

        useEffect(() => {
          if (!session && !isPending && lastToken.current) {
            lastToken.current = null;
            setCachedToken(null);
          }
        }, [session, isPending]);

        /** Takes in what the latest ask came to. */
        const settle = useCallback(
          (answer: Answer) => {
            lastToken.current = answer.token;
            setCachedToken(answer.token);
            missed.current = answer.missed;
            if (!answer.missed) {
              clearTimeout(later.current);
              later.current = undefined;
              wait.current = FIRST_WAIT_MS;
              return;
            }
            // Offline, or hidden, the network or the page coming back is the
            // sign to ask again. Online and in view, none may come: so a try
            // of its own, later each time the server still has none to give.
            if (!live.current || later.current) return;
            if (!navigator.onLine || document.visibilityState !== "visible") return;
            later.current = setTimeout(() => {
              later.current = undefined;
              if (document.visibilityState === "visible") retry();
            }, wait.current);
            wait.current = Math.min(wait.current * 2, LONGEST_WAIT_MS);
          },
          [retry],
        );

        const fetchAccessToken: FetchAccessToken = useCallback(
          async ({ forceRefreshToken = false } = {}) => {
            if (lastToken.current && !forceRefreshToken) return lastToken.current;
            if (!forceRefreshToken && pending.current) return pending.current;
            const asked: Promise<string | null> = authClient.convex
              .token({ fetchOptions: { throw: false } })
              .then(
                ({ data, error }): Answer => {
                  const token = data?.token || null;
                  // Refused, no one being signed in: asking again would be
                  // refused again. A server error, or a captive portal's page
                  // in place of the answer, may pass.
                  const signedOut = error?.status === 401 || error?.status === 403;
                  return { token, missed: !token && !signedOut };
                },
                // No network: better-fetch throws then, `throw: false` or not.
                (): Answer => ({ token: null, missed: true }),
              )
              .then((answer) => {
                // Asked again since, it is the newer ask that counts, as it
                // is for Convex.
                if (pending.current === asked) settle(answer);
                return answer.token;
              })
              .finally(() => {
                if (pending.current === asked) pending.current = null;
              });
            pending.current = asked;
            return asked;
          },
          // A new session, or another try: either makes Convex sign in again.
          // eslint-disable-next-line react-hooks/exhaustive-deps
          [sessionId, attempt],
        );

        return useMemo(
          () => ({
            isLoading: isPending && !cachedToken,
            isAuthenticated: Boolean(session?.session) || cachedToken !== null,
            fetchAccessToken,
          }),
          // eslint-disable-next-line react-hooks/exhaustive-deps
          [isPending, sessionId, fetchAccessToken, cachedToken],
        );
      },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [authClient],
  );
}

/** Convex, signed in with Better Auth: see {@link useBetterAuthForConvex}. */
export function ConvexWithBetterAuth({
  client,
  authClient,
  initialToken,
  children,
}: {
  client: ConvexReactClient;
  authClient: AuthClientForConvex;
  initialToken?: string | null;
  children: ReactNode;
}) {
  const useAuth = useBetterAuthForConvex(authClient, initialToken);
  return (
    <ConvexProviderWithAuth client={client} useAuth={useAuth}>
      {children}
    </ConvexProviderWithAuth>
  );
}
