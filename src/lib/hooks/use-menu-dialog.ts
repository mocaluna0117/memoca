"use client";

import { useRef } from "react";

/**
 * For menu items that open a dialog.
 *
 * A closing menu puts focus back on its trigger. When the chosen item opens a
 * dialog, that pulls focus out of the dialog's field, so typing goes nowhere
 * and Enter does nothing. Items that open a dialog go through `openDialog`,
 * and the menu content takes `onCloseAutoFocus`, which then skips the return.
 */
export function useMenuDialog() {
  const opening = useRef(false);
  return {
    openDialog: (open: () => void) => {
      opening.current = true;
      open();
    },
    onCloseAutoFocus: (event: Event) => {
      if (!opening.current) return;
      opening.current = false;
      event.preventDefault();
    },
  };
}
