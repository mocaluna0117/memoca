import { withSerwist } from "@serwist/turbopack";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typedRoutes: false,
};

export default withSerwist(nextConfig);
