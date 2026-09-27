import { describe, expect, test } from "vitest";
import { tokenSubject } from "@/lib/auth/subject";

/** A token shaped as Convex's are, its signature not checked here. */
const token = (payload: unknown) =>
  ["eyJhbGciOiJSUzI1NiJ9", Buffer.from(JSON.stringify(payload)).toString("base64url"), "sig"].join(
    ".",
  );

describe("tokenSubject", () => {
  test("reads the account a token is for", () => {
    expect(tokenSubject(token({ sub: "k57abc", iss: "https://x.convex.site" }))).toBe("k57abc");
    // Whatever else the token says, a name in Japanese included.
    expect(tokenSubject(token({ sub: "k57abc", name: "木村" }))).toBe("k57abc");
  });

  test("no token, or not one, says nobody", () => {
    for (const value of [null, undefined, "", "abc", "a.b.c", token({}), token({ sub: 7 })]) {
      expect(tokenSubject(value), String(value)).toBeNull();
    }
  });
});
