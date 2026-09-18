import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { DEFAULTS } from "./constants";

export type AnyCtx = QueryCtx | MutationCtx;

/**
 * The signed-in person's app row, or null when signed out or not provisioned.
 *
 * The row is found by the identity's `subject`, which is the Better Auth user
 * id. Convex has already verified the JWT that carried it, so this can index
 * straight into the app's own table; going through the auth component instead
 * would add two component queries to every request for no extra safety.
 *
 * `subject` is only unique *within* an issuer, though, so the issuer is pinned
 * to the one this deployment expects. Without that, adding a second sign-in
 * provider later would silently make the lookup unsafe: a provider whose
 * subject is user-chosen (a self-hosted server, or one mapping `sub` to a
 * username) would let someone register the victim's id and land on their row,
 * with full read and write access to their notes.
 *
 * Pinning fails safe. A token from an unexpected issuer is refused outright
 * rather than matched against someone else, so adding a provider requires
 * extending this check on purpose.
 */
export async function getUser(ctx: AnyCtx): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;

  // Better Auth issues its tokens from this deployment's own site URL, which
  // the platform always provides. It is absent only under convex-test, where
  // there is no second provider to confuse this with.
  const expectedIssuer = process.env.CONVEX_SITE_URL;
  if (expectedIssuer && identity.issuer !== expectedIssuer) return null;

  return await ctx.db
    .query("users")
    .withIndex("by_authId", (q) => q.eq("authId", identity.subject))
    .unique();
}

export async function requireUser(ctx: AnyCtx): Promise<Doc<"users">> {
  const user = await getUser(ctx);
  if (!user) {
    throw new ConvexError({
      code: "UNAUTHENTICATED",
      message: "サインインが必要です。",
    });
  }
  return user;
}

/**
 * Whether an address is named in the deployment's ADMIN_EMAILS.
 *
 * Read per request, not at module load, so changing the variable takes effect
 * on the next call.
 */
export function isAdminEmail(email: string): boolean {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
}

/**
 * Admin access is the stored role OR a current match against ADMIN_EMAILS.
 *
 * The stored role is written once, when the account is created, so on its own
 * it would lock the operator out of their own admin screen whenever they set
 * the variable after signing in, with no way back except editing the database.
 * Checking the environment every time keeps setting the variable sufficient.
 */
export function hasAdminAccess(user: Doc<"users">): boolean {
  return user.role === "admin" || isAdminEmail(user.email);
}

export async function requireAdmin(ctx: AnyCtx): Promise<Doc<"users">> {
  const user = await requireUser(ctx);
  if (!hasAdminAccess(user)) {
    throw new ConvexError({ code: "FORBIDDEN", message: "管理者のみ実行できます。" });
  }
  return user;
}

/** The single config row, created on first read with the built-in defaults. */
export async function getConfig(ctx: AnyCtx) {
  const row = await ctx.db
    .query("appConfig")
    .withIndex("by_key", (q) => q.eq("key", "global"))
    .unique();
  return (
    row ?? {
      key: "global" as const,
      signupOpen: DEFAULTS.signupOpen,
      maxUsers: DEFAULTS.maxUsers,
      userCount: 0,
      defaultQuotaBytes: DEFAULTS.defaultQuotaBytes,
      maxImageBytes: DEFAULTS.maxImageBytes,
      maxVideoBytes: DEFAULTS.maxVideoBytes,
    }
  );
}
