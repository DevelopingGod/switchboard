"use client";

import * as React from "react";

/** Shell-level actions any component can trigger (palette, shortcuts sheet). */
export interface ShellActions {
  openPalette: () => void;
  openShortcuts: () => void;
}

export const ShellContext = React.createContext<ShellActions>({ openPalette: () => {}, openShortcuts: () => {} });
export const useShell = () => React.useContext(ShellContext);
