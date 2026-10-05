/** The request header the proxy hands a page's nonce over in, for its own inline scripts. */
export const NONCE_HEADER = "x-nonce";

/**
 * The Content-Security-Policy every page is served with.
 *
 * What it is for is scripts: only Next's own, which carry this request's
 * nonce, and what they load ('strict-dynamic'), run; not a script tag or an
 * inline handler that got into a page some other way. That matters most in
 * the desktop app, where any script on the site may call its commands, the
 * vault's device unlock among them (desktop/src-tauri/capabilities).
 *
 * Where a page connects to, and what it shows, are left alone: Convex, the
 * desktop app's own channel (ipc:), files from storage, embedded videos and
 * blob: copies all go on as they did.
 */
export function contentSecurityPolicy(nonce: string, dev = false): string {
  return [
    // WebAssembly: Argon2id for the vault's password, and WebP encoding.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ""}`,
    // Search readings, image encoding and PDF pages, from the site's own files.
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** A fresh nonce, one per request. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
