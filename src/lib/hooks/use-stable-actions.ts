"use client";

import { useLayoutEffect, useRef, useState } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any function at all
type Actions = Record<string, (...args: any[]) => any>;

/**
 * The same functions from one render to the next, each calling the one of its
 * name given in the latest render that was put on the screen.
 *
 * For the handlers a list gives each of its rows: made afresh in every render
 * (they close over what the list holds), they would draw every row again, a
 * memoized one too, whenever the list is drawn. These keep each row's props
 * the same, and still act on what the list holds when they are called: from
 * an event or an effect, the list as it is on the screen. Called while a row
 * renders (for its menu), it is the list as it was last put on the screen,
 * which a row drawn along with the list in the same render does not see yet.
 */
export function useStableActions<T extends Actions>(actions: T): T {
  const latest = useRef(actions);
  useLayoutEffect(() => {
    latest.current = actions;
  });
  const [stable] = useState(
    // Each reads the ref when it is called, not while this renders.
    // eslint-disable-next-line react-hooks/refs
    () =>
      Object.fromEntries(
        Object.keys(actions).map((name) => [
          name,
          (...args: unknown[]) => latest.current[name]!(...args),
        ]),
      ) as T,
  );
  return stable;
}
