"use client";

import { TriangleAlert } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { type Unsent, unsentLines } from "@/lib/sync/unsent";

/** What is said of what only this device has, signing out. */
export function UnsentText({ unsent }: { unsent: Unsent }) {
  return (
    <>
      <span className="block">この端末にしかない内容があります。</span>
      <span className="my-2 block">
        {unsentLines(unsent).map((line) => (
          <span key={line} className="block">
            ・{line}
          </span>
        ))}
      </span>
      <span className="block">
        ログアウトすると、これらはこの端末から消え、どこにも残りません。インターネットにつないで右上が「同期済み」になってから（即席メモは保存してから）、ログアウトしてください。
      </span>
    </>
  );
}

/** Asked before signing out with something only this device has: kept (the default), or let go of. */
export function UnsentDialog({
  unsent,
  onConfirm,
  onCancel,
}: {
  /** What there is; null while nothing is asked. */
  unsent: Unsent | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog open={unsent !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <TriangleAlert className="text-destructive size-5" aria-hidden />
            まだ送っていない内容があります
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="text-muted-foreground text-sm">{unsent ? <UnsentText unsent={unsent} /> : null}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel autoFocus>ログアウトしない</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            消えてもよいのでログアウト
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
