import { createSerwistRoute } from "@serwist/turbopack";

/**
 * Builds and serves the service worker. A fresh revision on every build is what
 * makes an existing installation pick up a new version.
 */
export const { dynamic, dynamicParams, revalidate, generateStaticParams, GET } =
  createSerwistRoute({
    swSrc: "src/app/sw.ts",
    useNativeEsbuild: true,
    additionalPrecacheEntries: [
      { url: "/offline", revision: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev" },
    ],
  });
