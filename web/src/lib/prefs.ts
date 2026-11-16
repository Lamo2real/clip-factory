// Per-device preferences. Sound (on/off and which click and error sound) and motion also live in the owner's
// Settings on the server; the copy here makes them apply instantly on start. The background picture and the
// Settings folder panel's open/closed trees never leave the device.
import { useSyncExternalStore } from "react";
import { DEFAULT_CLICK_SOUND, DEFAULT_ERROR_SOUND, isSoundId } from "./soundCatalog.ts";

export interface Prefs {
  soundEnabled: boolean;
  /** Click sound 1..30 (docs/CONTRACTS.md §15.3). */
  clickSound: number;
  /** Error sound 1..30. */
  errorSound: number;
  reduceMotion: boolean;
  sidebarCollapsed: boolean;
  /** Trees the owner folded shut in the Settings folder panel (wide screens). */
  closedTrees: string[];
  /** False until the folder panel has been seen once; a first visit opens only the current tree. */
  foldersSet: boolean;
  background: string | null;
}

const KEY = "cf.prefs";
const BG_KEY = "cf.background";
const DEFAULTS: Prefs = {
  soundEnabled: true,
  clickSound: DEFAULT_CLICK_SOUND,
  errorSound: DEFAULT_ERROR_SOUND,
  reduceMotion: false,
  sidebarCollapsed: false,
  closedTrees: [],
  foldersSet: false,
  background: null,
};

function read(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>;
    return {
      soundEnabled: raw.soundEnabled ?? DEFAULTS.soundEnabled,
      clickSound: isSoundId(raw.clickSound) ? raw.clickSound : DEFAULTS.clickSound,
      errorSound: isSoundId(raw.errorSound) ? raw.errorSound : DEFAULTS.errorSound,
      reduceMotion: raw.reduceMotion ?? DEFAULTS.reduceMotion,
      sidebarCollapsed: raw.sidebarCollapsed ?? DEFAULTS.sidebarCollapsed,
      closedTrees: Array.isArray(raw.closedTrees) ? raw.closedTrees.filter((t): t is string => typeof t === "string") : [],
      // Someone who already folded a tree shut has made their choice.
      foldersSet: raw.foldersSet === true || (Array.isArray(raw.closedTrees) && raw.closedTrees.length > 0),
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
