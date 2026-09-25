"use client";

import { Dialog as DrawerPrimitive } from "radix-ui";
import type { ReactNode, Ref } from "react";
import type { DrawerSwipe } from "@/lib/hooks/use-drawer-swipe";

/**
 * The folder panel on a phone: a dialog from the left edge that a finger can
 * pull open and push shut.
 *
 * Built on the dialog primitives rather than Sheet because the finger, not a
 * CSS animation, decides where it is. It is only in the DOM while it is open
 * or on its way out, so whatever looks for an open dialog still finds one.
 */
export function FolderDrawer({
  drawer,
  containerRef,
  children,
}: {
  drawer: DrawerSwipe;
  /** The panel's own element, for menus that must stay inside its focus trap. */
  containerRef: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  const {
    open,
    mounted,
    show,
    hide,
    shadeRef,
    overlayRef,
    contentRef,
    onOpenAutoFocus,
    onCloseAutoFocus,
  } = drawer;
  return (
    <DrawerPrimitive.Root open={open} onOpenChange={(next) => (next ? show() : hide())}>
      {mounted ? (
        <DrawerPrimitive.Portal forceMount>
          {/* The dimming, which fades with the drawer. Only drawn, never
              touched. No backdrop blur: it would be redrawn on every frame of
              a swipe. */}
          <div
            ref={shadeRef}
            aria-hidden
            data-slot="drawer-shade"
            className="pointer-events-none fixed inset-0 z-50 bg-black/25"
          />
          {/* Takes the tap and the swipe beside the drawer and holds the page
              still, only while it is open: the moment it starts to close, the
              page underneath can be tapped, scrolled and swiped again. */}
          {open ? (
            <DrawerPrimitive.Overlay
              ref={overlayRef}
              data-slot="drawer-overlay"
              className="fixed inset-0 z-50"
            />
          ) : null}
          <DrawerPrimitive.Content
            ref={contentRef}
            data-slot="drawer-content"
            className="fixed inset-y-0 left-0 z-50 flex w-[min(85vw,20rem)] flex-col border-r bg-popover text-sm text-popover-foreground shadow-lg outline-none"
            // On its way out it lets touches through to the page, as above.
            style={open ? undefined : { pointerEvents: "none" }}
            onOpenAutoFocus={onOpenAutoFocus}
            onCloseAutoFocus={onCloseAutoFocus}
            onEscapeKeyDown={(event) => {
              // Escape that cancels a rename, or an IME conversion, is not a
              // request to close the whole drawer.
              const target = event.target as HTMLElement | null;
              if (event.isComposing || target?.closest("[data-inline-rename]")) {
                event.preventDefault();
              }
            }}
          >
            <DrawerPrimitive.Title className="sr-only">メニュー</DrawerPrimitive.Title>
            <div
              ref={containerRef}
              className="h-full"
              style={{
                paddingTop: "env(safe-area-inset-top, 0px)",
                paddingBottom: "env(safe-area-inset-bottom, 0px)",
              }}
            >
              {children}
            </div>
          </DrawerPrimitive.Content>
        </DrawerPrimitive.Portal>
      ) : null}
    </DrawerPrimitive.Root>
  );
}
