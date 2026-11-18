// Puts the background choice (§22) on the page: which backdrop to draw, and the <html> class and veil strength the
// CSS reads. Runs once before the first paint (main.tsx) and again whenever the choice or the system scheme changes.
import { useSyncExternalStore } from "react";
import { readNativeGlass, resolveLook, type Look, type NativeGlass, type Scheme } from "./background.ts";
import { getPrefs, usePrefs, type Prefs } from "./prefs.ts";

/** The desktop wrapper sets these before the page loads (desktop/src-tauri/src/init.js). */
type DesktopWindow = Window & { __CF_DESKTOP__?: unknown; __CF_GLASS__?: unknown };

export function nativeGlass(): NativeGlass {
  return typeof window === "undefined" ? "none" : readNativeGlass(window as DesktopWindow);
}

export function inDesktopApp(): boolean {
  return typeof window !== "undefined" && (window as DesktopWindow).__CF_DESKTOP__ === true;
}

const DARK = "(prefers-color-scheme: dark)";
function scheme(): Scheme {
  return typeof matchMedia === "function" && matchMedia(DARK).matches ? "dark" : "light";
}
function useScheme(): Scheme {
  return useSyncExternalStore(
    (fn) => {
      if (typeof matchMedia !== "function") return () => undefined;
      const mq = matchMedia(DARK);
      mq.addEventListener("change", fn);
      return () => mq.removeEventListener("change", fn);
    },
    scheme,
    () => "light" as const,
  );
}

export function lookFor(prefs: Prefs, s: Scheme = scheme(), glass: NativeGlass = nativeGlass()): Look {
  return resolveLook({
    mode: prefs.backgroundMode,
    picture: prefs.background,
    colours: prefs.backgroundColours,
    strength: prefs.glassStrength,
    glass,
    scheme: s,
  });
}

/** The current look, following the prefs and the system's light or dark setting. */
export function useLook(): Look {
  const prefs = usePrefs();
  const s = useScheme();
  return lookFor(prefs, s);
}

/**
 * `html.see-through` makes the page itself transparent so the desktop window's glass shows (§22.3);
 * `data-backdrop` names what is drawn; `--backdrop-veil` is the tint over the whole backdrop (between the panels in
 * see-through); `--panel-veil` is the bottle-green tint every panel gets (and every piece of loose text in the
 * window and picture looks), enough for AA over the lightest thing behind.
 */
export function applyLook(look: Look, root: HTMLElement = document.documentElement) {
  root.classList.toggle("see-through", look.kind === "window");
  root.dataset.backdrop = look.kind;
  if (look.kind === "window") root.dataset.glass = look.glass;
  else delete root.dataset.glass;
  if (look.kind === "window" || look.kind === "frosted") root.dataset.strength = look.strength;
  else delete root.dataset.strength;
  const veil = look.kind === "window" || look.kind === "picture" ? look.pageVeil : look.kind === "colours" ? look.veil : null;
  if (veil === null) root.style.removeProperty("--backdrop-veil");
  else root.style.setProperty("--backdrop-veil", String(veil));
  // Everywhere else the panels keep the floor in tokens.css (PANEL_VEIL_FLOOR): the page owns that backdrop.
  if (look.kind === "window" || look.kind === "picture") root.style.setProperty("--panel-veil", String(look.panelVeil));
  else root.style.removeProperty("--panel-veil");
}

/** Before React draws anything, so the desktop window never flashes an opaque page. */
export function applyLookNow() {
  applyLook(lookFor(getPrefs()));
}
