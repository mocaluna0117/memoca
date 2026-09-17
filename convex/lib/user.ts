import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { authComponent } from "../auth";
import { DEFAULTS } from "./constants";

export type AnyCtx = QueryCtx | MutationCtx;

/** The signed-in person's app row, or null when signed out or not provisioned. */
export async function getUser(ctx: AnyCtx): Promise<Doc<"users"> | null> {
  const authUser = await authComponent.safeGetAuthUser(ctx);
  if (!authUser) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_authId", (q) => q.eq("authId", authUser._id as string))
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

export async function requireAdmin(ctx: AnyCtx): Promise<Doc<"users">> {
  const user = await requireUser(ctx);
  if (user.role !== "admin") {
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
