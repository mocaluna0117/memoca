import type { MetadataRoute } from "next";
import { t } from "@/lib/i18n/ja";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: t.app.name,
    short_name: t.app.name,
    description: t.app.description,
    id: "/app",
    start_url: "/app",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    lang: "ja",
    dir: "ltr",
    categories: ["productivity", "utilities"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      {
        src: "/icons/maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    shortcuts: [
      { name: t.nav.quick, short_name: t.nav.quick, url: "/quick" },
      { name: t.nav.search, short_name: t.nav.search, url: "/app/search" },
    ],
    // Android turns this into a target in the system share sheet. iOS has no
    // equivalent, so the settings screen explains the Shortcuts route instead.
    share_target: {
      action: "/quick",
      method: "GET",
      params: { title: "title", text: "text", url: "url" },
    },
  };
}
