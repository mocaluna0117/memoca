"use client";

import { ConvexProviderWithAuth, type ConvexReactClient } from "convex/react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

/** The parts of the Better Auth client this needs: its session, and a Convex token. */
export type AuthClientForConvex = {
  useSession(): { data: { session?: { id: string } | null } | null; isPending: boolean };
  convex: {
    token(opts: {
      fetchOptions: { throw: false };
    }): Promise<{ data?: { token?: string | null } | null }>;
  };
};

type FetchAccessToken = (opts?: { forceRefreshToken?: boolean }) => Promise<string | null>;

/** The server-rendered token is good for the first page only: after that, one is fetched. */
let initialTokenUsed = false;

/**
 * The hook Convex asks whether someone is signed in, and for their token:
 * @convex-dev/better-auth's own, with one thing more. Convex asks for a new
 * token before the old one runs out (every quarter of an hour); asked with
 * no network, it gets none, counts itself signed out, and never asks again
 * while the session lasts, which no longer changes. Sync then stays stopped
 * after the network returns, until a reload, which the app no longer does
 * then. So a token that could not be had is asked for again once the
 * network is back, or the page back in view: a new way of fetching it is
 * what makes Convex sign in again.
 */
export function useBetterAuthForConvex(
  authClient: AuthClientForConvex,
  initialToken?: string | null,
) {
  const [cachedToken, setCachedToken] = useState<string | null>(
    initialTokenUsed ? null : (initialToken ?? null),
  );
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
        /** The last token asked for could not be had. */
        const missed = useRef(false);

        useEffect(() => {
          const retry = () => {
            if (!missed.current || !navigator.onLine) return;
            missed.current = false;
            setAttempt((count) => count + 1);
          };
          const onVisible = () => {
            if (document.visibilityState === "visible") retry();
          };
          window.addEventListener("online", retry);
          document.addEventListener("visibilitychange", onVisible);
          return () => {
            window.removeEventListener("online", retry);
            document.removeEventListener("visibilitychange", onVisible);
          };
        }, []);

        useEffect(() => {
          if (!session && !isPending && cachedToken) setCachedToken(null);
        }, [session, isPending]);

        const fetchAccessToken: FetchAccessToken = useCallback(
          async ({ forceRefreshToken = false } = {}) => {
            if (cachedToken && !forceRefreshToken) return cachedToken;
            if (!forceRefreshToken && pending.current) return pending.current;
            pending.current = authClient.convex
              .token({ fetchOptions: { throw: false } })
              .then(
                ({ data }) => data?.token || null,
                () => null,
              )
              .then((token) => {
                missed.current = token === null;
                setCachedToken(token);
                return token;
              })
              .finally(() => {
                pending.current = null;
              });
            return pending.current;
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
