/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as attachments from "../attachments.js";
import type * as auth from "../auth.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as lib_constants from "../lib/constants.js";
import type * as lib_hlc from "../lib/hlc.js";
import type * as lib_ops from "../lib/ops.js";
import type * as lib_seq from "../lib/seq.js";
import type * as lib_user from "../lib/user.js";
import type * as notes from "../notes.js";
import type * as sync from "../sync.js";
import type * as trash from "../trash.js";
import type * as users from "../users.js";
import type * as vault from "../vault.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  attachments: typeof attachments;
  auth: typeof auth;
  crons: typeof crons;
  http: typeof http;
  "lib/constants": typeof lib_constants;
  "lib/hlc": typeof lib_hlc;
  "lib/ops": typeof lib_ops;
  "lib/seq": typeof lib_seq;
  "lib/user": typeof lib_user;
  notes: typeof notes;
  sync: typeof sync;
  trash: typeof trash;
  users: typeof users;
  vault: typeof vault;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
};
