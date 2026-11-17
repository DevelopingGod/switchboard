import type { NextConfig } from "next";

// cacheComponents stays off (re-evaluated in M1b, now that server data exists). Every router read is
// live per request (key status, CLI state, wizard progress), so nothing is cacheable and the only
// gain would be a prerendered shell. Turning it on needs `dynamic` removed from the install-log route,
// a <Suspense> shell on `/` and `/welcome`, and the first-run redirect moved into streamed content (it
// could no longer send a real HTTP redirect). It also keeps hidden routes alive (Activity), which
// preserves palette/popover state. Lighthouse is already 99 on every screen, so it isn't worth it yet;
// revisit if a screen gets slow or the router moves off-box. Data loaders call `connection()` so the
// pages are never prerendered with build-time data.
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
