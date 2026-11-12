import { v } from "convex/values";

/** The app's looks a person chooses from (src/lib/style.ts STYLES, in the same order). */
export const styleValidator = v.union(
  v.literal("stylish"),
  v.literal("cute"),
  v.literal("natural"),
  v.literal("fresh"),
  v.literal("retro"),
  v.literal("wafu"),
  v.literal("pop"),
  v.literal("chic"),
  v.literal("terminal"),
);
