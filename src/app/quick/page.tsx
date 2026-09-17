import { Suspense } from "react";
import { QuickCapture } from "@/components/notes/quick-capture";

export default function QuickPage() {
  return (
    <Suspense fallback={null}>
      <QuickCapture />
    </Suspense>
  );
}
