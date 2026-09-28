import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  getSessionFromCtx,
  sessionMiddleware,
} from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { constantTimeEqual, generateRandomString } from "better-auth/crypto";

/**
 * Signing the desktop shell in (docs/STORAGE-AND-DESKTOP.md, D1). Google
 * turns away a sign-in inside an app's own window, so it is done in the
 * browser, which hands the shell a code; the shell's window trades it for a
 * session of its own.
 *
 * The code is tied to the shell that asked, as PKCE (RFC 7636, for apps as
 * RFC 8252 has them) ties an authorisation code to its app. The shell makes a secret (the verifier)
 * that never leaves it, and sends the browser only its hash (the challenge).
 * The code is made for that challenge, and taken only with the verifier: one
 * passed on to anyone else signs nothing in, and a code made for someone
 * else, pasted into the shell, is turned away.
 *
 * The session is the shell's own: signing out in the browser leaves the
 * shell signed in, and the other way round. So a code is made only for a
 * browser signed in just now: a session long open (on a computer left
 * unlocked, say) cannot be turned into one that outlives it without Google
 * being asked again.
 */

/** How long a code is good for. */
export const CODE_TTL_MS = 3 * 60 * 1000;

/** How recently the browser must have signed in to make a code (src/lib/auth/handoff.ts says the same). */
export const FRESH_MS = 10 * 60 * 1000;

/** A code as it is made: 32 of letters and digits. */
export const CODE = /^[A-Za-z0-9]{32}$/;

/** A challenge, or a verifier, as the shell makes them: 32 bytes (a SHA-256 hash, or random) as base64url. */
export const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/** SHA-256 of a text, as base64url without padding: a challenge from its verifier. */
export async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Where a code waits to be taken: under its hash, so the database holds no code. */
const identifier = async (code: string) => `desktop-sign-in:${await sha256(code)}`;

type Waiting = { userId: string; challenge: string };

/** One reason for all refusals, so a guess learns nothing of why. */
const refused = () => new APIError("BAD_REQUEST", { message: "Invalid code" });

export const desktopSignIn = () =>
  ({
    id: "memoca-desktop-sign-in",
    endpoints: {
      /**
       * In the browser, signed in: a code for the shell whose challenge this
       * is, good for one sign-in, for three minutes.
       */
      desktopSignInCode: createAuthEndpoint(
        "/desktop/code",
        { method: "POST", use: [sessionMiddleware] },
        async (ctx) => {
          const challenge = (ctx.body as { challenge?: unknown } | undefined)?.challenge;
          if (typeof challenge !== "string" || !CHALLENGE.test(challenge)) {
            throw new APIError("BAD_REQUEST", { message: "Invalid challenge" });
          }
          const since = new Date(ctx.context.session.session.createdAt).getTime();
          if (!(Date.now() - since < FRESH_MS)) {
            throw new APIError("FORBIDDEN", { message: "Sign in again", code: "SIGN_IN_AGAIN" });
          }
          const code = generateRandomString(32, "a-z", "A-Z", "0-9");
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: await identifier(code),
            value: JSON.stringify({
              userId: ctx.context.session.user.id,
              challenge,
            } satisfies Waiting),
            expiresAt: new Date(Date.now() + CODE_TTL_MS),
          });
          return ctx.json({ code });
        },
      ),

      /**
       * In the shell's window: the code, and the verifier it was made for,
       * for a session of the shell's own. The code goes at the first try,
       * right or wrong. Asked for from Memoca's pages only: with no cookie
       * to send, Better Auth would not look where a request came from, and
       * another site could sign a browser in to an account of its choosing.
       * A session the window had already goes, taken over by the new one.
       */
      desktopSignInExchange: createAuthEndpoint(
        "/desktop/exchange",
        { method: "POST" },
        async (ctx) => {
          const origin = ctx.headers?.get("origin");
          if (!origin || !ctx.context.isTrustedOrigin(origin)) throw refused();
          const { code, verifier } = (ctx.body ?? {}) as { code?: unknown; verifier?: unknown };
          if (typeof code !== "string" || !CODE.test(code)) throw refused();
          if (typeof verifier !== "string" || !CHALLENGE.test(verifier)) throw refused();
          const waiting = await ctx.context.internalAdapter.consumeVerificationValue(
            await identifier(code),
          );
          if (!waiting) throw refused();
          let made: Waiting;
          try {
            made = JSON.parse(waiting.value) as Waiting;
          } catch {
            throw refused();
          }
          if (!constantTimeEqual(await sha256(verifier), made.challenge)) throw refused();
          const user = await ctx.context.internalAdapter.findUserById(made.userId);
          if (!user) throw refused();
          const before = await getSessionFromCtx(ctx).catch(() => null);
          const session = await ctx.context.internalAdapter.createSession(user.id);
          await setSessionCookie(ctx, { session, user });
          if (before) await ctx.context.internalAdapter.deleteSession(before.session.token);
          return ctx.json({ signedIn: true });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;
