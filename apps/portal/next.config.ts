import type { NextConfig } from "next";

// cacheComponents (scaffold default) is off: the portal is a client-driven shell with no
// server data yet, and Activity-preserved hidden routes would keep palette/popover state alive.
const nextConfig: NextConfig = {
  cacheComponents: false,
  partialPrefetching: false,
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
