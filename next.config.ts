import { withSerwist } from "@serwist/turbopack";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typedRoutes: false,
  // The build the page's scripts are of, as the service worker's (serwist/[path]/route.ts).
  env: { MEMOCA_BUILD: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev" },
};

export default withSerwist(nextConfig);
