// Per-device preferences. Sound and motion also live in the owner's Settings on the server; the copy here makes
// them apply instantly on start. The background picture never leaves the device.
import { useSyncExternalStore } from "react";

export interface Prefs {
  soundEnabled: boolean;
  reduceMotion: boolean;
  sidebarCollapsed: boolean;
  background: string | null;
}

const KEY = "cf.prefs";
const BG_KEY = "cf.background";
const DEFAULTS: Prefs = { soundEnabled: true, reduceMotion: false, sidebarCollapsed: false, background: null };

function read(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>;
    return {
      soundEnabled: raw.soundEnabled ?? DEFAULTS.soundEnabled,
      reduceMotion: raw.reduceMotion ?? DEFAULTS.reduceMotion,
      sidebarCollapsed: raw.sidebarCollapsed ?? DEFAULTS.sidebarCollapsed,
      background: localStorage.getItem(BG_KEY),
    };
  } catch {
    return DEFAULTS;
  }
}

let state: Prefs = typeof window === "undefined" ? DEFAULTS : read();
const listeners = new Set<() => void>();

export function getPrefs(): Prefs {
  return state;
}

/** Updates preferences; returns false when the background picture did not fit in this device's storage. */
export function setPrefs(patch: Partial<Prefs>): boolean {
  state = { ...state, ...patch };
  let stored = true;
  try {
    const { background, ...rest } = state;
    localStorage.setItem(KEY, JSON.stringify(rest));
    if ("background" in patch) {
      if (background) localStorage.setItem(BG_KEY, background);
      else localStorage.removeItem(BG_KEY);
    }
  } catch {
    stored = false;
  }
  for (const fn of listeners) fn();
  return stored;
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
    () => DEFAULTS,
  );
}

export function prefersReducedMotion(): boolean {
  if (state.reduceMotion) return true;
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Shrinks a picked photo to at most 1920 px on its long side as a JPEG data URL, small enough for localStorage.
 */
export async function shrinkImage(file: File, max = 1920, quality = 0.82): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", quality);
}
