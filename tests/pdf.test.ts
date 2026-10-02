import { describe, expect, test } from "vitest";
import { looksLikePdf } from "@/lib/media/pdf";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("telling a PDF by its bytes", () => {
  test("one starting %PDF- is, and one with a little before it too", () => {
    expect(looksLikePdf(bytes("%PDF-1.7\n%âãÏÓ\n1 0 obj"))).toBe(true);
    expect(looksLikePdf(bytes(`${" ".repeat(200)}%PDF-1.4`))).toBe(true);
  });

  test("anything else is not, nor one whose %PDF- is past its first kilobyte", () => {
    expect(looksLikePdf(new Uint8Array(4096).fill(7))).toBe(false);
    expect(looksLikePdf(bytes("PK\u0003\u0004 a zip named .pdf"))).toBe(false);
    expect(looksLikePdf(bytes(`${"x".repeat(2000)}%PDF-1.4`))).toBe(false);
  });
});
