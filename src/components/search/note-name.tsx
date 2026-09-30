import { STAND_IN_CLASS, noteName } from "@/lib/note-name";
import type { SearchHit } from "@/lib/search/engine";
import { cn } from "@/lib/utils";

/** A found note's name: its title, or its first line standing in for one, set apart. */
export function NoteName({ hit, className }: { hit: SearchHit; className?: string }) {
  const name = noteName(hit.title, hit.standIn);
  return <span className={cn(className, name.standIn && STAND_IN_CLASS)}>{name.text}</span>;
}
