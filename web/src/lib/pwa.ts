// Service worker registration, the browser's "Install app" prompt, and whether Clip Factory is already installed.
import { useSyncExternalStore } from "react";
import { isMock } from "./config.ts";
import { installedHere, parseManifest, type DownloadManifest } from "./device.ts";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface InstallSnapshot {
  /** Running inside an installed copy, or installed here before: never offer "Get the app". */
  installed: boolean;
  /** The browser can show its own install prompt right now. */
  canPrompt: boolean;
}

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
let snapshot: InstallSnapshot = { installed: false, canPrompt: false };

function recompute() {
  const next = { installed: installedHere(), canPrompt: !!deferred };
  if (next.installed !== snapshot.installed || next.canPrompt !== snapshot.canPrompt) snapshot = next;
  listeners.forEach((fn) => fn());
}

function markInstalled() {
  try {
    localStorage.setItem("cf.installed", "1");
  } catch {
    // Private mode: the display-mode check still hides the card inside the installed app.
  }
}

let registration: Promise<ServiceWorkerRegistration | null> = Promise.resolve(null);

/** The service worker registration, once the page has loaded (null in dev and mock builds). */
export function swRegistration(): Promise<ServiceWorkerRegistration | null> {
  return registration;
}

export function initPwa() {
  snapshot = { installed: installedHere(), canPrompt: false };
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    recompute();
  });
  window.addEventListener("appinstalled", () => {
    markInstalled();
    deferred = null;
    recompute();
  });
  for (const q of ["(display-mode: standalone)", "(display-mode: window-controls-overlay)"]) {
    if (typeof matchMedia === "function") matchMedia(q).addEventListener?.("change", recompute);
  }
  // Only real builds get a worker: dev servers and the mock must never serve a stale cached shell.
  if ("serviceWorker" in navigator && import.meta.env.PROD && !isMock) {
    registration = new Promise((resolve) => {
      const go = () =>
        navigator.serviceWorker
          .register("/sw.js")
          .then(resolve)
          .catch((e) => {
            console.warn("service worker", e);
            resolve(null);
          });
      if (document.readyState === "complete") go();
      else window.addEventListener("load", go, { once: true });
    });
  }
}

/** Shows the browser's own install prompt. True when the owner accepted. */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const ev = deferred;
  await ev.prompt();
  const choice = await ev.userChoice;
  deferred = null;
  if (choice.outcome === "accepted") markInstalled();
  recompute();
  return choice.outcome === "accepted";
}

const DOWNLOADED_KEY = "cf.downloadStarted";

/**
 * Remembers, for this tab's session only, that a desktop download was started, so the "Downloading" hint stays.
 * It never marks the app installed: the download can be canceled or blocked (§12.1 sets cf.installed only after
 * the appinstalled event; inside the desktop wrapper __CF_DESKTOP__ / the user agent hides the offer).
 */
export function rememberDownloaded() {
  try {
    sessionStorage.setItem(DOWNLOADED_KEY, "1");
  } catch {
    // Private mode: the hint just shows until the screen is left.
  }
}

/** A desktop download was started earlier in this session. */
export function downloadStarted(): boolean {
  try {
    return sessionStorage.getItem(DOWNLOADED_KEY) === "1";
  } catch {
    return false;
  }
}

export function useInstall(): InstallSnapshot {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => snapshot,
    () => snapshot,
  );
}

// ---------- Which desktop files exist (/downloads/manifest.json, written by the deploy) ----------

/** What the mock build pretends the bucket holds: both desktop files, so every branch can be seen. */
export const MOCK_MANIFEST: DownloadManifest = {
  version: "mock",
  files: {
    mac: { path: "/downloads/Clip-Factory.dmg", size: 9_400_000 },
    windows: { path: "/downloads/Clip-Factory-Setup.exe", size: 6_100_000 },
  },
};

let manifest: Promise<DownloadManifest | null> | null = null;

export function loadDownloads(fetcher: typeof fetch = fetch): Promise<DownloadManifest | null> {
  if (isMock) return Promise.resolve(MOCK_MANIFEST);
  manifest ??= fetcher("/downloads/manifest.json", { cache: "no-store" })
    .then(async (r) => (r.ok ? parseManifest(await r.json()) : null))
    .catch(() => null);
  return manifest;
}

// ---------- "Not now" on the Home banner: hidden for 30 days ----------

const BANNER_KEY = "cf.getAppBanner";
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

export function bannerSnoozed(now = Date.now()): boolean {
  try {
    const at = Number(localStorage.getItem(BANNER_KEY) ?? 0);
    return at > 0 && now - at < THIRTY_DAYS;
  } catch {
    return false;
  }
}

export function snoozeBanner(now = Date.now()) {
  try {
    localStorage.setItem(BANNER_KEY, String(now));
  } catch {
    // Nothing to remember it in; the banner closes for this visit anyway.
  }
}
