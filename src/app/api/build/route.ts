/**
 * Which build of the site is out (src/lib/build.ts): the desktop shell's
 * quick note, loaded once and kept, asks it as it is put away, to load a
 * new one out of sight.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { build: process.env.MEMOCA_BUILD ?? "dev" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
