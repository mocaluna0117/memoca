/**
 * The account a Convex token was issued for (its `sub`, the auth user's id,
 * which the server gives as a profile's userKey), read without checking the
 * token: a hint for deciding what of the device's data to show, never a
 * proof of who someone is.
 */
export function tokenSubject(token: string | null | undefined): string | null {
  const payload = token?.split(".")[1];
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const text = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
    const { sub } = JSON.parse(text) as { sub?: unknown };
    return typeof sub === "string" && sub !== "" ? sub : null;
  } catch {
    return null;
  }
}
