import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth/minimal";
import { oneTimeToken } from "better-auth/plugins/one-time-token";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import authConfig from "./auth.config";

const siteUrl = process.env.SITE_URL ?? "http://localhost:3000";

/**
 * Email and password exist only so local development and the end-to-end tests
 * can sign in without a Google OAuth client. It is off unless the deployment
 * explicitly opts in, and production never does.
 */
const allowPasswordAuth = process.env.ALLOW_PASSWORD_AUTH === "true";

/**
 * Signing the desktop shell in (docs/STORAGE-AND-DESKTOP.md, D0) is off
 * unless the deployment opts in, as development and the end-to-end tests do,
 * until the desktop app itself exists. The token it hands over is exchanged
 * for the browser's own session, not one of its own, and nothing ties it to
 * the shell that asked: a page persuading someone to pass the code on would
 * sign another in as them. Before production turns it on, D1 gives the
 * shell a session of its own, bound to a secret only the shell holds.
 */
export const allowDesktopSignIn = () => process.env.ALLOW_DESKTOP_SIGN_IN === "true";

export const authComponent = createClient<DataModel>(components.betterAuth);

/**
 * Google is the only sign-in method: sending mail (for password resets and
 * one-time codes) needs a verified sending domain, which this deployment does
 * not have yet. Adding email/password later is a config change here plus a
 * mail provider — no data migration.
 */
export const createAuth = (ctx: GenericCtx<DataModel>) =>
  betterAuth({
    baseURL: siteUrl,
    database: authComponent.adapter(ctx),
    ...(allowPasswordAuth
      ? { emailAndPassword: { enabled: true, requireEmailVerification: false } }
      : {}),
    socialProviders: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID ?? "",
        clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      },
    },
    account: {
      accountLinking: { enabled: true, trustedProviders: ["google"] },
    },
    user: {
      // Lets someone remove their account from the settings screen. App data is
      // purged separately by users.deleteAccount before this runs.
      deleteUser: { enabled: true },
    },
    plugins: [
      convex({ authConfig }),
      // Signing the desktop shell in: Google turns away a sign-in inside an
      // app's own window, so it is done in the browser, and the session is
      // handed over as a token the shell's window exchanges. Good for one
      // exchange, for three minutes, and kept only as a hash.
      ...(allowDesktopSignIn() ? [oneTimeToken({ expiresIn: 3, storeToken: "hashed" })] : []),
    ],
  });
