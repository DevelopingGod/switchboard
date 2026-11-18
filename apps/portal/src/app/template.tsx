"use client";

import * as React from "react";

// Set after the first page has mounted: only client-side navigations animate, so the first paint
// (and LCP) is never delayed by an entrance animation.
let navigated = false;

/** Page transition (M1.5): opacity + 6 px rise, `--d-enter` with `--ease-out`; off under reduced motion. */
export default function Template({ children }: { children: React.ReactNode }) {
  const [animate] = React.useState(() => navigated);
  React.useEffect(() => {
    navigated = true;
  }, []);
  return <div className={animate ? "page-enter" : undefined}>{children}</div>;
}
