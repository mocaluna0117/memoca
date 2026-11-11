import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono, Klee_One, Zen_Kaku_Gothic_Antique, Zen_Maru_Gothic } from "next/font/google";
import { SerwistProvider } from "@serwist/turbopack/react";
import { CachePages } from "@/components/providers/cache-pages";
import { AppProviders } from "@/components/providers/app-providers";
import { getToken } from "@/lib/auth/server";
import { NONCE_HEADER } from "@/lib/csp";
import { t } from "@/lib/i18n/ja";
import { STYLE_SCRIPT } from "@/lib/style";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
// The looks' own letters (src/lib/style.ts): not preloaded, and fetched by
// the browser only for a page drawn in that look, a slice of the font at a
// time for the characters on it.
const zenMaru = Zen_Maru_Gothic({
  variable: "--font-zen-maru",
  weight: ["400", "700"],
  preload: false,
  display: "swap",
});
const zenKaku = Zen_Kaku_Gothic_Antique({
  variable: "--font-zen-kaku",
  weight: ["400", "700"],
  preload: false,
  display: "swap",
});
const klee = Klee_One({ variable: "--font-klee", weight: ["400", "600"], preload: false, display: "swap" });

export const metadata: Metadata = {
  title: { default: t.app.name, template: `%s · ${t.app.name}` },
  description: t.app.description,
  applicationName: t.app.name,
  appleWebApp: { capable: true, title: t.app.name, statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const initialToken = await getToken();
  const nonce = (await headers()).get(NONCE_HEADER) ?? undefined;
  return (
    <html
      lang="ja"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${zenMaru.variable} ${zenKaku.variable} ${klee.variable} h-full antialiased`}
    >
      <head>
        {/* The look the device keeps, on before the page is first drawn. */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: STYLE_SCRIPT }} />
      </head>
      <body className="bg-background text-foreground flex min-h-full flex-col overscroll-y-none">
        {/* Not reloaded when the network returns: sync picks up by itself, and a
            reload would throw away what was being typed, a draft included. */}
        {/* Pages moved to within the app kept for offline once each, by
            CachePages: not Serwist's cacheOnNavigation, which fetched the
            workspace again at each note opened (see cache-pages.tsx). */}
        <SerwistProvider swUrl="/serwist/sw.js" cacheOnNavigation={false} reloadOnOnline={false}>
          <CachePages />
          <AppProviders initialToken={initialToken} nonce={nonce}>{children}</AppProviders>
        </SerwistProvider>
      </body>
    </html>
  );
}
