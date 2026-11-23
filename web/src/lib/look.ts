// Puts the background choice (§22) on the page: which backdrop to draw, and the <html> class and veil strength the
// CSS reads. Runs once before the first paint (main.tsx) and again whenever the choice or the system scheme changes.
import { useSyncExternalStore } from "react";
import { cantSelfUpdate, glassOf, isOldDesktopApp, lightPay, readDesktopVersion, readNativeGlass, resolveLook, type Look, type NativeGlass, type Scheme } from "./background.ts";
import { getPrefs, usePrefs, type Prefs } from "./prefs.ts";
import { setPageGlass } from "../app/shell.ts";

/** The desktop wrapper sets these before the page loads (desktop/src-tauri/src/init.js). */
type DesktopWindow = Window & {
  __CF_DESKTOP__?: unknown;
  __CF_GLASS__?: unknown;
  __CF_DESKTOP_VERSION__?: unknown;
  __CF_TITLEBAR__?: unknown;
};

export function nativeGlass(): NativeGlass {
  return typeof window === "undefined" ? "none" : readNativeGlass(window as DesktopWindow);
}

export function inDesktopApp(): boolean {
  return typeof window !== "undefined" && (window as DesktopWindow).__CF_DESKTOP__ === true;
}

/** A desktop app from before the see-through window (§12.6): it gets the "Update the app" see-through note. */
export function oldDesktopApp(): boolean {
  return typeof window !== "undefined" && isOldDesktopApp(window as DesktopWindow);
}

/** A desktop app that cannot update itself (no version named, §12.6): the page offers the new installer instead. */
export function desktopAppCantUpdate(): boolean {
  return typeof window !== "undefined" && cantSelfUpdate(window as DesktopWindow);
}

/** The desktop app's version (`1.<n>.0`), from apps that update themselves; null in a browser or an older app. */
export function desktopAppVersion(): string | null {
  return typeof window === "undefined" ? null : readDesktopVersion(window as DesktopWindow);
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
 * `data-backdrop` names what is drawn; `--backdrop-veil` is the tint over the whole backdrop (between the panels);
 * `--glass-brightness` is how much every pane's own backdrop-filter dims what it sees (`brightness()`, 1 in the
 * window look, where the desktop is behind the page); `--panel-veil` is the bottle-green tint every pane gets, enough
 * for AA over the lightest thing this look can show as the pane sees it, dimmed; `--plate-veil` is the tint under
 * words where nothing dims the backdrop (the title and line plates, controls straight on the page); `--light-pay` is
 * the green a pane carries on top of it so the ladder of light fits under the AA ceiling over everything this look
 * can show (`lightPay`, ADR-87: over a light backdrop a pane sits darker than the page, and every level above it is
 * brighter). All are worked out here at read time from what is saved, which is never rewritten. Reduced transparency
 * overrides the veils and the pay in glass.css (!important).
 */
export function applyLook(look: Look, root: HTMLElement = document.documentElement) {
  // (the class is the shell's: it is Clip Factory's wish, on the page whenever Clip Factory is, app/shell.ts)
  setPageGlass("clips", look.kind === "window", root);
  root.dataset.backdrop = look.kind;
  if (look.kind === "window") root.dataset.glass = look.glass;
  else delete root.dataset.glass;
  if (look.kind === "window" || look.kind === "frosted") root.dataset.strength = look.strength;
  else delete root.dataset.strength;
  const veil = look.kind === "window" || look.kind === "picture" || look.kind === "colours" ? look.pageVeil : null;
  if (veil === null) root.style.removeProperty("--backdrop-veil");
  else root.style.setProperty("--backdrop-veil", String(veil));
  const glass = glassOf(look);
  root.style.setProperty("--panel-veil", String(glass.panelVeil));
  root.style.setProperty("--plate-veil", String(glass.plateVeil));
  root.style.setProperty("--glass-brightness", String(glass.brightness));
  root.style.setProperty("--light-pay", String(lightPay({ ...look, ...glass })));
}

/**
 * The height (CSS px) of the desktop window's title bar band that lies over the page, or 0. On macOS the wrapper lays
 * its title bar over the page (the traffic lights float on the app's own glass) and says how tall it is in
 * `window.__CF_TITLEBAR__` (desktop/src-tauri/src/main.rs). Anything that is not a sane number counts as 0.
 */
export function titlebarHeight(w: { __CF_DESKTOP__?: unknown; __CF_TITLEBAR__?: unknown } | undefined = typeof window === "undefined" ? undefined : (window as DesktopWindow)): number {
  if (!w || w.__CF_DESKTOP__ !== true) return 0;
  const n = w.__CF_TITLEBAR__;
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 120 ? Math.round(n) : 0;
}

/**
 * `data-titlebar="overlay"` and `--titlebar-h` keep every column below the window's own buttons (§11.1): the shared
 * top line (`--top-line`, tokens.css) starts under the band, and an invisible strip there drags the window (App.tsx).
 */
export function applyTitlebar(height: number = titlebarHeight(), root: HTMLElement = document.documentElement) {
  if (height > 0) {
    root.dataset.titlebar = "overlay";
    root.style.setProperty("--titlebar-h", `${height}px`);
  } else {
    delete root.dataset.titlebar;
    root.style.removeProperty("--titlebar-h");
  }
}

/** Before React draws anything, so the desktop window never flashes an opaque page or a page under its buttons. */
export function applyLookNow() {
  applyTitlebar();
  applyLook(lookFor(getPrefs()));
}
