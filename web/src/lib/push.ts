// Notifications on this device (docs/CONTRACTS.md §32): can it get them, are they on, and turning them on or off.
//
// iPhone and iPad get Web Push only inside the app added to the Home Screen (iOS 16.4+), never in a Safari tab, and
// only after a tap. So `pushState` says "needs-install" there, and `turnOn` must be called straight from a tap:
// it asks for permission before anything else is awaited (Safari forgets the tap after the first await).
import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "../api/index.ts";
import type { PushSubscriptionBody } from "../api/types.ts";
import { currentOs, installedHere, type DeviceOs } from "./device.ts";
import { swRegistration } from "./pwa.ts";

export type PushState =
  /** This browser has no Web Push (an old browser, or the Mac app before it learns notifications, §32.7). */
  | "unsupported"
  /** iPhone or iPad in a Safari tab: add Clip Factory to the Home Screen first. */
  | "needs-install"
  /** The owner said no before: only the device's own settings can undo it. */
  | "blocked"
  /** Can ask: show "Turn on". */
  | "off"
  /** This device gets notifications. */
  | "on";

export interface PushEnv {
  os: DeviceOs;
  installed: boolean;
  hasNotification: boolean;
  hasPushManager: boolean;
  hasServiceWorker: boolean;
  permission: NotificationPermission | "unknown";
  subscribed: boolean;
}

/** What the Notifications page shows, from what this device can do. Pure, so every case is tested. */
export function pushState(env: PushEnv): PushState {
  const ios = env.os === "ios";
  // In a Safari tab on iPhone there is no Notification and no PushManager at all: installing is the only way.
  if (ios && !env.installed) return "needs-install";
  if (!env.hasNotification || !env.hasPushManager || !env.hasServiceWorker) return "unsupported";
  if (env.permission === "denied") return "blocked";
  if (env.permission === "granted" && env.subscribed) return "on";
  return "off";
}

/** The device name the server stores (one of a fixed list). */
export function deviceLabel(os: DeviceOs, userAgent: string): string {
  if (os === "ios") return /iPad/i.test(userAgent) || (/Macintosh/i.test(userAgent) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1) ? "iPad" : "iPhone";
  const names: Partial<Record<DeviceOs, string>> = { mac: "Mac", windows: "Windows", android: "Android", linux: "Linux", chromeos: "Chromebook" };
  return names[os] ?? "This device";
}

/** Where to turn notifications back on after "Don't Allow", in this device's words. */
export function blockedHelp(os: DeviceOs): string {
  if (os === "ios") return "Notifications are off for Clip Factory. Turn them on in Settings > Notifications > Clip Factory.";
  return "Notifications are off for Clip Factory. Turn them on in your browser's settings for this site, then come back.";
}

/** base64url → bytes, for `applicationServerKey`. */
export function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const b64 = (key + "=".repeat((4 - (key.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const DEVICE_KEY = "cf.pushDevice";

/** This device's id: made once, kept in localStorage (a new one only means one more row on the server). */
export function deviceId(storage: Pick<Storage, "getItem" | "setItem"> | null = safeStorage()): string {
  const saved = storage?.getItem(DEVICE_KEY);
  if (saved && /^[A-Za-z0-9_-]{8,64}$/.test(saved)) return saved;
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const id = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  try {
    storage?.setItem(DEVICE_KEY, id);
  } catch {
    // Private mode: a new id next time, which is harmless.
  }
  return id;
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  const own = await swRegistration();
  if (own) return own;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

/** What this device can do right now. */
export async function readEnv(): Promise<PushEnv> {
  const hasNotification = typeof Notification !== "undefined";
  const hasPushManager = typeof window !== "undefined" && "PushManager" in window;
  const hasServiceWorker = typeof navigator !== "undefined" && "serviceWorker" in navigator;
  let subscribed = false;
  if (hasPushManager && hasServiceWorker) {
    try {
      subscribed = !!(await (await registration())?.pushManager.getSubscription());
    } catch {
      subscribed = false;
    }
  }
  return {
    os: currentOs(),
    installed: installedHere(),
    hasNotification,
    hasPushManager,
    hasServiceWorker,
    permission: hasNotification ? Notification.permission : "unknown",
    subscribed,
  };
}

// ---------- One shared state for every screen that shows it ----------

let state: PushState | null = null;
const listeners = new Set<() => void>();

function publish(next: PushState) {
  state = next;
  listeners.forEach((fn) => fn());
}

export async function refreshPushState(): Promise<PushState> {
  const next = pushState(await readEnv());
  publish(next);
  return next;
}

/** The current state (null while it is being read). */
export function usePushState(): PushState | null {
  const value = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
    () => state,
  );
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (asked) return;
    setAsked(true);
    void refreshPushState();
  }, [asked]);
  return value;
}

export type TurnOnResult = "on" | "blocked" | "dismissed" | "unsupported" | "not-ready";

/**
 * Turns notifications on. Call it straight from a tap: permission is asked first, while the tap still counts.
 * "not-ready" is the server's 503 (no key yet); other failures throw for the caller's toast.
 */
export async function turnOn(): Promise<TurnOnResult> {
  if (typeof Notification === "undefined") return "unsupported";
  const asking = Notification.requestPermission();
  const key = api()
    .pushKey()
    .then((k) => ({ ok: true as const, k }))
    .catch((e: unknown) => ({ ok: false as const, e }));
  const permission = await asking;
  if (permission !== "granted") {
    publish(permission === "denied" ? "blocked" : "off");
    return permission === "denied" ? "blocked" : "dismissed";
  }
  const got = await key;
  if (!got.ok) {
    if ((got.e as { status?: number })?.status === 503) return "not-ready";
    throw got.e;
  }
  const reg = await registration();
  if (!reg) return "unsupported";
  const existing = await reg.pushManager.getSubscription();
  const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(got.k) }));
  const json = sub.toJSON();
  const body: PushSubscriptionBody = {
    endpoint: sub.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
    deviceLabel: deviceLabel(currentOs(), typeof navigator === "undefined" ? "" : navigator.userAgent),
  };
  await api().savePushDevice(deviceId(), body);
  publish("on");
  return "on";
}

/** Turns notifications off on this device: the browser forgets the subscription and so does the server. */
export async function turnOff(): Promise<void> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  await api().deletePushDevice(deviceId());
  await sub?.unsubscribe().catch(() => false);
  publish("off");
}

// ---------- "Get told when clips are ready" on the job page: once, until turned on or "Not now" ----------

const CARD_KEY = "cf.notifyCard";

export function notifyCardHidden(): boolean {
  try {
    return localStorage.getItem(CARD_KEY) === "1";
  } catch {
    return false;
  }
}

export function hideNotifyCard() {
  try {
    localStorage.setItem(CARD_KEY, "1");
  } catch {
    // Nothing to remember it in: it comes back next visit, which is fine.
  }
}
