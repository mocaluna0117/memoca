"use client";

import { usePathname } from "next/navigation";
import { FileText, Search, Settings, Zap } from "lucide-react";
import type { Ref } from "react";
import { ViewLink } from "@/components/shell/view-link";
import { useKeyboard } from "@/lib/hooks/use-keyboard-inset";
import { t } from "@/lib/i18n/ja";
import { cn } from "@/lib/utils";

const items = [
  { href: "/app", label: t.nav.home, icon: FileText },
  { href: "/app/search", label: t.nav.search, icon: Search },
  { href: "/quick", label: t.nav.quick, icon: Zap, accent: true },
  { href: "/app/settings", label: t.nav.settings, icon: Settings },
];

/**
 * Bottom bar for phones. Padded for the home indicator on iOS.
 *
 * Out of sight while the on-screen keyboard is up, as an app's own bar is
 * under its keyboard. Pinned to the window's foot, it came out over the
 * keyboard on iOS once a note was scrolled to its end (what is seen moved
 * down the window, to its foot): taking the little room typing leaves, and
 * covering the block bar, which sits there on the keyboard.
 */
export function MobileNav({ ref }: { ref?: Ref<HTMLElement> }) {
  const pathname = usePathname();
  const typing = useKeyboard().height > 0;
  return (
    <nav
      ref={ref}
      data-mobile-nav
      hidden={typing}
      className="bg-background/95 supports-[backdrop-filter]:bg-background/80 fixed inset-x-0 bottom-0 z-40 border-t backdrop-blur md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <ul className="grid grid-cols-4">
        {items.map(({ href, label, icon: Icon, accent }) => {
          const active = href === "/app" ? pathname === "/app" : pathname.startsWith(href);
          return (
            <li key={href}>
              <ViewLink
                href={href}
                data-guide={href === "/quick" ? "open-quick" : undefined}
                className={cn(
                  "flex flex-col items-center gap-0.5 py-2 text-[11px]",
                  active ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <Icon
                  className={cn("size-5", accent && "text-primary")}
                  aria-hidden
                />
                {label}
              </ViewLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
