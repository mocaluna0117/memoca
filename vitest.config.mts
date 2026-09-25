import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname,
      // The vault and sync code import generated Convex references directly.
      "@convex": new URL("./convex", import.meta.url).pathname,
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "jsdom",
          include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
          setupFiles: ["./tests/setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "convex",
          environment: "edge-runtime",
          include: ["convex/**/*.test.ts"],
          // convex-test loads function modules on first use, and the first
          // call into one that pulls in Better Auth can take several seconds
          // on a busy machine. The default 5 s turned that into failures.
          testTimeout: 20_000,
          server: { deps: { inline: ["convex-test"] } },
        },
      },
    ],
  },
});
