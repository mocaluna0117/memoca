import type { Metadata } from "next";
import { Suspense } from "react";
import { QuickCapture } from "@/components/notes/quick-capture";
import { t } from "@/lib/i18n/ja";

export const metadata: Metadata = { title: t.nav.quick };

export default function QuickPage() {
  return (
    <Suspense fallback={null}>
      <QuickCapture />
    </Suspense>
  );
}
