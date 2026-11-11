import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import { SerwistProvider } from "@serwist/turbopack/react";
import { CachePages } from "@/components/providers/cache-pages";
import { AppProviders } from "@/components/providers/app-providers";
import { getToken } from "@/lib/auth/server";
import { NONCE_HEADER } from "@/lib/csp";
import { t } from "@/lib/i18n/ja";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

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
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
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
