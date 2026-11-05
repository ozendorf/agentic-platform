import type { NextConfig } from "next";

// Everything here is live operational data (runs, approvals, events), so the app is
// rendered per request. Cache Components is disabled on purpose.
const nextConfig: NextConfig = {
  cacheComponents: false,
  serverExternalPackages: ["@temporalio/client", "postgres"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
