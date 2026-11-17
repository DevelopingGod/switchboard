"use client";

import { useSyncExternalStore } from "react";

export type ThemePref = "system" | "light" | "dark";
export type Mode = "simple" | "pro";
export type Density = "comfortable" | "compact";
/** "system" follows prefers-reduced-motion; "reduce" turns every animation off regardless. */
export type MotionPref = "system" | "reduce";

export interface Prefs {
  theme: ThemePref;
  mode: Mode;
  density: Density;
  /** Force opaque surfaces (same code path as prefers-reduced-transparency). */
  solid: boolean;
  /** Use the optional bitmap sky instead of the CSS gradient sky. */
  skyImage: boolean;
  name: string;
  motion: MotionPref;
  /** Soft periwinkle glow that follows the pointer (desktop, fine pointer, motion allowed). */
  ambientCursor: boolean;
  /** Chat thread sidebar collapsed (⌘B). */
  sidebarCollapsed: boolean;
}

export const defaultPrefs: Prefs = {
  theme: "system",
  mode: "simple",
  density: "comfortable",
  solid: false,
  skyImage: false,
  name: "",
  motion: "system",
  ambientCursor: true,
  sidebarCollapsed: false,
};

const KEY = "switchboard.prefs.v1";
const listeners = new Set<() => void>();
let current: Prefs = defaultPrefs;
let loaded = false;

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaultPrefs, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    /* storage blocked: fall back to defaults */
  }
  return defaultPrefs;
}

export function resolveTheme(theme: ThemePref): "light" | "dark" {
  if (theme !== "system") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Mirrors prefs onto <html> so CSS can react without React. */
export function applyPrefs(p: Prefs) {
  const el = document.documentElement;
  el.dataset.theme = resolveTheme(p.theme);
  el.dataset.density = p.density;
  el.dataset.mode = p.mode;
  el.dataset.surfaces = p.solid ? "solid" : "glass";
  el.dataset.sky = p.skyImage ? "image" : "css";
  el.dataset.motion = p.motion === "reduce" ? "reduce" : "system";
  el.dataset.cursor = p.ambientCursor ? "on" : "off";
  el.dataset.sidebar = p.sidebarCollapsed ? "collapsed" : "open";
}

function getSnapshot(): Prefs {
  if (!loaded) {
    current = load();
    loaded = true;
  }
  return current;
}

export function setPrefs(patch: Partial<Prefs>) {
  current = { ...getSnapshot(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* ignore */
  }
  applyPrefs(current);
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onScheme = () => {
    if (getSnapshot().theme === "system") applyPrefs(getSnapshot());
    cb();
  };
  mq.addEventListener("change", onScheme);
  return () => {
    listeners.delete(cb);
    mq.removeEventListener("change", onScheme);
  };
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribe, getSnapshot, () => defaultPrefs);
}

/**
 * Inline, pre-paint script (kept in sync with applyPrefs). Also accepts test-only URL overrides:
 * ?theme=dark|light &density=compact &solid=1 &sky=image &mode=pro &motion=reduce &cursor=off
 */
export const noFlashScript = `(function(){try{
var d=document.documentElement,p={};
try{p=JSON.parse(localStorage.getItem("${KEY}")||"{}")}catch(e){}
var q=new URLSearchParams(location.search);
var th=q.get("theme")||p.theme||"system";
if(th==="system")th=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";
d.dataset.theme=th;
d.dataset.density=q.get("density")||p.density||"comfortable";
d.dataset.mode=q.get("mode")||p.mode||"simple";
d.dataset.surfaces=(q.get("solid")==="1"||p.solid)?"solid":"glass";
d.dataset.sky=(q.get("sky")==="image"||p.skyImage)?"image":"css";
d.dataset.motion=(q.get("motion")||p.motion)==="reduce"?"reduce":"system";
d.dataset.cursor=(q.get("cursor")==="off"||p.ambientCursor===false)?"off":"on";
d.dataset.sidebar=p.sidebarCollapsed?"collapsed":"open";
}catch(e){}})();`;
