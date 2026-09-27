import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * Pages only the desktop shell's sign-in passes through: kept out of search
 * results, and named to no other site as where a request came from.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function DesktopLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-5 py-16 text-center">
      {children}
    </main>
  );
}
