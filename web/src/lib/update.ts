// "A new version is ready": checks /version.json, finds a waiting service worker, and runs the Reload
// progress (docs/CONTRACTS.md §12.2). The maths at the top is pure so it can be unit-tested.
import { useSyncExternalStore } from "react";
import { isMock } from "./config.ts";
import { swRegistration } from "./pwa.ts";

/** Baked in at build time (vite.config.ts): VITE_APP_VERSION, else the git short sha, else "dev". */
export const APP_VERSION: string = import.meta.env.VITE_APP_VERSION || "dev";

// ---------- Pure helpers ----------

/**
 * Same build? Short shas can come out at different lengths (7 from one tool, 12 from another), so a sha that
 * starts with the other counts as equal. Anything else compares exactly.
 */
export function sameVersion(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return x === y;
  if (x === y) return true;
  const sha = /^[0-9a-f]{7,40}$/;
  if (sha.test(x) && sha.test(y)) return x.startsWith(y) || y.startsWith(x);
  return false;
}

/** Whether `remote` is a different deploy than the running one. A "dev" build never asks to update. */
export function isNewer(current: string, remote: string | null | undefined): boolean {
  if (!remote || !remote.trim()) return false;
  if (!current || current === "dev") return false;
  return !sameVersion(current, remote);
}

export interface VersionInfo {
  version: string;
  builtAt: string | null;
  areas: string[];
}

const MAX_AREAS = 3;

/** One area label: 1–3 short words, no sentences. Returns null for anything else. */
export function cleanArea(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\s+/g, " ").trim().replace(/[.!?:;,]+$/, "");
  if (!text || text.length > 28) return null;
  if (text.split(" ").length > 3) return null;
  if (!/^[\p{L}\p{N}][\p{L}\p{N} '&/+-]*$/u.test(text)) return null;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Parses /version.json. Bad or missing areas become ["Improvements"]; a missing version gives null. */
export function parseVersionInfo(body: unknown): VersionInfo | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { version?: unknown; builtAt?: unknown; areas?: unknown };
  if (typeof b.version !== "string" || !b.version.trim()) return null;
  const seen = new Set<string>();
  const areas: string[] = [];
  for (const a of Array.isArray(b.areas) ? b.areas : []) {
    const clean = cleanArea(a);
    if (clean && !seen.has(clean.toLowerCase())) {
      seen.add(clean.toLowerCase());
      areas.push(clean);
    }
    if (areas.length === MAX_AREAS) break;
  }
  return {
    version: b.version.trim(),
    builtAt: typeof b.builtAt === "string" ? b.builtAt : null,
    areas: areas.length ? areas : ["Improvements"],
  };
}

/**
 * The area label for a changed file, from web/areas.json (`{"web/src/screens/settings": "Settings"}`).
 * The longest matching prefix wins; null when nothing matches.
 */
export function areaForPath(path: string, map: Record<string, string>): string | null {
  const p = path.replace(/^\.?\//, "");
  let best: string | null = null;
  let bestLen = -1;
  for (const [prefix, label] of Object.entries(map)) {
    if (prefix.startsWith("$")) continue;
    if (p === prefix || p.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)) {
      if (prefix.length > bestLen) {
        best = label;
        bestLen = prefix.length;
      }
    }
  }
  return best;
}

/** The areas for a list of changed files: unique, in order of first appearance, at most three. */
export function areasForPaths(paths: string[], map: Record<string, string>): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const a = areaForPath(p, map);
    if (a && !out.includes(a)) out.push(a);
    if (out.length === MAX_AREAS) break;
  }
  return out.length ? out : ["Improvements"];
}

/** Slow start, fast middle, slow end. */
export function easeInOutCubic(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export const PROGRESS = {
  /** The quick first stretch: 0 → 75 % in 0.8 s. */
  rushTo: 0.75,
  rushMs: 800,
  /** While the new version installs, creep slowly towards (never past) 92 %. */
  creepTo: 0.92,
  creepMs: 2600,
  /** Once ready, ease the rest of the way. */
  finishMs: 520,
  /** Give up waiting and reload anyway. */
  capMs: 10_000,
} as const;

/**
 * Where the bar is `elapsed` ms after Reload was pressed. `readyAt` is when the new version finished installing
 * (null while still waiting). Returns 0..1, and never moves backwards.
 */
export function progressAt(elapsed: number, readyAt: number | null): number {
  const { rushTo, rushMs, creepTo, creepMs, finishMs, capMs } = PROGRESS;
  const before = (t: number) =>
    t <= rushMs ? rushTo * easeInOutCubic(t / rushMs) : rushTo + (creepTo - rushTo) * (1 - Math.exp(-(t - rushMs) / creepMs));
  const done = readyAt === null ? (elapsed >= capMs ? capMs : null) : Math.max(readyAt, rushMs);
  if (done === null || elapsed <= done) return Math.min(before(elapsed), 1);
  const from = before(done);
  return Math.min(1, from + (1 - from) * easeInOutCubic((elapsed - done) / finishMs));
}

/** When the bar reaches 100 %. */
export function finishedAt(readyAt: number | null): number {
  const done = readyAt === null ? PROGRESS.capMs : Math.max(readyAt, PROGRESS.rushMs);
  return Math.min(done, PROGRESS.capMs) + PROGRESS.finishMs;
}

// ---------- The live store ----------

export interface UpdateState {
  /** A newer version exists; the bar is shown unless dismissed. */
  available: VersionInfo | null;
  dismissed: boolean;
}

let state: UpdateState = { available: null, dismissed: false };
const listeners = new Set<() => void>();
function set(patch: Partial<UpdateState>) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}

export function useUpdate(): UpdateState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
    () => state,
  );
}

/** "Later": hide the bar until the next check finds the update again. */
export function dismissUpdate() {
  set({ dismissed: true });
}

const RELOADED_KEY = "cf.updatedTo";
const FAKE_AREAS = ["Settings", "Profile picture"];

type FakeFlag = boolean | string[] | undefined;
declare global {
  interface Window {
    /** Mock and dev builds only: pretend a new version is out (true, or a list of areas). */
    __cfFakeUpdate?: FakeFlag;
    /** Runs an update check now (used by tests). */
    __cfCheckForUpdate?: () => Promise<UpdateCheck>;
  }
}

/** A fake update is only possible in mock and dev builds, via ?update=1 or window.__cfFakeUpdate. */
function fakeUpdate(): VersionInfo | null {
  if (!isMock && !import.meta.env.DEV) return null;
  const flag = window.__cfFakeUpdate;
  const param = new URLSearchParams(location.search).get("update");
  if (!flag && param !== "1") return null;
  try {
    if (sessionStorage.getItem(RELOADED_KEY) === "fake") return null;
  } catch {
    // ignore
  }
  return { version: "fake-next", builtAt: new Date().toISOString(), areas: Array.isArray(flag) && flag.length ? flag : FAKE_AREAS };
}

/** After a reload for version X, do not offer X again in this tab if the server still serves the old build. */
function justReloadedFor(version: string): boolean {
  try {
    const v = sessionStorage.getItem(RELOADED_KEY);
    return !!v && sameVersion(v, version);
  } catch {
    return false;
  }
}

/** Shows the bar for `info`. Exported for tests. */
export function offerUpdate(info: VersionInfo) {
  // Same build found again (a periodic check, or the new service worker finishing its install during Reload):
  // keep the object the bar already holds, so a running Reload is not restarted from 0 %.
  if (state.available && sameVersion(state.available.version, info.version)) {
    if (state.dismissed) set({ dismissed: false });
    return;
  }
  // A fresh check un-dismisses: "Later" lasts until the next check.
  set({ available: info, dismissed: false });
}

/** The current store value, outside React (tests). */
export function updateState(): UpdateState {
  return state;
}

/** What one check found: a newer build (the bar shows), this build is the newest, or the check itself failed. */
export type UpdateCheck = "newer" | "current" | "failed";

let checking: Promise<UpdateCheck> | null = null;

/** Fetches /version.json and shows the bar when it names a different build. Never throws: a failed check says "failed". */
export function checkForUpdate(fetcher: typeof fetch = fetch): Promise<UpdateCheck> {
  const fake = fakeUpdate();
  if (fake) {
    offerUpdate(fake);
    return Promise.resolve("newer");
  }
  // A test build never asks to update: it is always the newest one.
  if (APP_VERSION === "dev") return Promise.resolve("current");
  checking ??= (async (): Promise<UpdateCheck> => {
    try {
      const res = await fetcher(`/version.json?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) return "failed";
      const info = parseVersionInfo(await res.json());
      // A file without a version is not an answer.
      if (!info) return "failed";
      if (isNewer(APP_VERSION, info.version) && !justReloadedFor(info.version)) {
        offerUpdate(info);
        return "newer";
      }
      return "current";
    } catch {
      // Offline or the file is missing: try again on the next check.
      return "failed";
    } finally {
      checking = null;
    }
  })();
  return checking;
}

const FIVE_MINUTES = 5 * 60 * 1000;
let started = false;

/** Checks on load, every 5 minutes, when the app comes back into view, and when a new service worker waits. */
export function startUpdateChecks() {
  if (started || typeof window === "undefined") return;
  started = true;
  window.__cfCheckForUpdate = () => checkForUpdate();
  void checkForUpdate();
  setInterval(() => {
    if (document.visibilityState === "visible") void checkForUpdate();
  }, FIVE_MINUTES);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkForUpdate();
  });
  void swRegistration().then((reg) => {
    if (!reg) return;
    if (reg.waiting && navigator.serviceWorker.controller) void checkForUpdate();
    reg.addEventListener("updatefound", () => {
      const sw = reg.installing;
      sw?.addEventListener("statechange", () => {
        if (sw.state === "installed" && navigator.serviceWorker.controller) void checkForUpdate();
      });
    });
  });
}

// ---------- Applying the update ----------

function wait(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** Waits for a service worker to reach `installed` (or give up). */
function installed(sw: ServiceWorker, ms: number): Promise<void> {
  if (sw.state === "installed" || sw.state === "activated") return Promise.resolve();
  return Promise.race([
    new Promise<void>((resolve) => sw.addEventListener("statechange", () => sw.state !== "installing" && resolve())),
    wait(ms),
  ]);
}

/**
 * Gets the new version ready: tells a waiting service worker to take over (SKIP_WAITING) and waits for it,
 * then warms the fresh page. Resolves when it is safe to reload; never rejects. The caller reloads.
 */
export async function prepareUpdate(budgetMs = PROGRESS.capMs - 1500): Promise<void> {
  const deadline = Date.now() + budgetMs;
  const left = () => Math.max(0, deadline - Date.now());
  try {
    const reg = await Promise.race([swRegistration(), wait(1500).then(() => null)]);
    if (reg && navigator.serviceWorker.controller) {
      await reg.update().catch(() => undefined);
      if (reg.installing) await installed(reg.installing, left());
      const waiting = reg.waiting;
      if (waiting) {
        const took = new Promise<void>((resolve) =>
          navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }),
        );
        waiting.postMessage({ type: "SKIP_WAITING" });
        await Promise.race([took, wait(left())]);
      }
    }
    // Fetch the new page shell so the reload is instant.
    await Promise.race([fetch("/", { cache: "reload" }).catch(() => undefined), wait(Math.min(2500, left()))]);
  } catch {
    // Whatever failed, a plain reload still gets the new version from the network.
  }
}

/** Reloads into the new version, remembering it so a stale server cannot cause a loop. */
export function reloadInto(info: VersionInfo) {
  try {
    sessionStorage.setItem(RELOADED_KEY, info.version === "fake-next" ? "fake" : info.version);
  } catch {
    // ignore
  }
  if (info.version === "fake-next") {
    const url = new URL(location.href);
    url.searchParams.delete("update");
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
    window.__cfFakeUpdate = undefined;
  }
  location.reload();
}
