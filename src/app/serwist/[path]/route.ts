import { createSerwistRoute } from "@serwist/turbopack";

/**
 * Builds and serves the service worker. A fresh revision on every build is what
 * makes an existing installation pick up a new version.
 */
export const { dynamic, dynamicParams, revalidate, generateStaticParams, GET } =
  createSerwistRoute({
    swSrc: "src/app/sw.ts",
    useNativeEsbuild: true,
    // The reading dictionary is ~11 MB across a dozen files. Precaching even
    // the smaller ones would make installing the app a multi-megabyte download
    // for everyone, including people who never search in kana, and it slowed
    // the service worker's install enough to delay taking control. The runtime
    // rule in sw.ts caches them on first fetch instead.
    // The WebP encoder (about 300 KB) is only for browsers whose canvas cannot
    // write WebP, and cached by a runtime rule on first use too.
    // So is pdf.js's (about 6 MB), for notes with a PDF.
    globIgnores: ["**/kuromoji/**", "**/webp/**", "**/pdfjs/**"],
    additionalPrecacheEntries: [
      { url: "/offline", revision: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev" },
    ],
    // Which build the worker is of, for a page it takes over to compare with its own.
    esbuildOptions: {
      define: { MEMOCA_BUILD: JSON.stringify(process.env.VERCEL_GIT_COMMIT_SHA ?? "dev") },
    },
  });
