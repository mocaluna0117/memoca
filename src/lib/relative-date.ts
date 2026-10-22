/**
 * Made once. toLocaleTimeString and toLocaleDateString make a formatter of
 * their own each time, which is slow, and a list is drawn again with every
 * write to the notes, each of its rows saying when: a note typed in made
 * this most of the list's time. These say the same.
 */
const TIME = new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric" });

/** When a note was changed (or made), as a row of the note list says it. */
export function relativeDate(at: number, now = Date.now()): string {
  const diff = now - at;
  const minute = 60_000;
  if (diff < minute) return "たった今";
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分前`;
  const date = new Date(at);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return TIME.format(date);
  return DAY.format(date);
}
