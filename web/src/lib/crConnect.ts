// Connect Content Rewards (docs/CONTRACTS.md §38.3, §38.15). Content Rewards only sends its sign-in back to
// http://127.0.0.1, so only the Mac app can finish it: its window has `window.__CF_CR_CONNECT__` (a tiny one-time
// door on the computer). This page asks the API for the sign-in address, has the app open it in the browser, waits
// for the door's answer and posts the one-time code to the API at once (Content Rewards' code lives 60 seconds).
// The page never sees a token; the browser never calls Content Rewards.
import type { Api, CrConnectResult, CrConnection } from "../api/types.ts";
import { friendlyMessage } from "../api/errors.ts";
import { cantSelfUpdate } from "./background.ts";

/** What the door says (cr_connect_result): `status`, never `state` (§38.19). */
export interface CrDoorResult {
  status: "none" | "waiting" | "done" | "error" | "expired";
  code?: string;
  state?: string;
  iss?: string;
  error?: string;
  errorDescription?: string;
}

/** The Mac app's four commands (desktop/src-tauri/src/init.js, version 1). Errors carry `{ code }`. */
export interface CrBridge {
  version: 1;
  listen(): Promise<{ port: number; expiresAt: string }>;
  open(url: string): Promise<unknown>;
  result(): Promise<CrDoorResult>;
  cancel(): Promise<unknown>;
}

type Win = { __CF_CR_CONNECT__?: Partial<CrBridge>; __CF_DESKTOP__?: unknown; __CF_GLASS__?: unknown; __CF_DESKTOP_VERSION__?: unknown };
const win = (): Win | undefined => (typeof window === "undefined" ? undefined : (window as unknown as Win));

/** The app's bridge, or null (a browser, or an app from before §38.15). */
export function crBridge(w: Win | undefined = win()): CrBridge | null {
  const b = w?.__CF_CR_CONNECT__;
  if (!b || b.version !== 1) return null;
  return [b.listen, b.open, b.result, b.cancel].every((f) => typeof f === "function") ? (b as CrBridge) : null;
}

/** A phone or a touch tablet: Connect waits for the Mac (§38.3). */
export function isTouchDevice(): boolean {
  if (typeof navigator === "undefined" || typeof matchMedia === "undefined") return false;
  return (navigator.maxTouchPoints ?? 0) > 0 && matchMedia("(pointer: coarse)").matches;
}

export type ConnectPlace = "bridge" | "phone" | "browser" | "old_app" | "old_app_cant_update";

/** Where this page runs, for step 3's words (§38.3). */
export function connectPlace(w: Win | undefined = win(), touch = isTouchDevice()): ConnectPlace {
  if (crBridge(w)) return "bridge";
  if (w?.__CF_DESKTOP__) return cantSelfUpdate(w) ? "old_app_cant_update" : "old_app";
  return touch ? "phone" : "browser";
}

/** Step 3's lines for each place (the bridge's are the guide's own `say`). */
export const PLACE_WORDS: Record<Exclude<ConnectPlace, "bridge">, string[]> = {
  phone: ["Do this step on your Mac. Open Clip Factory there, then Settings, Set up posting, Content Rewards."],
  browser: ["Connect works in the Clip Factory app on your Mac.", "Already have it? Open it, then come back to this page in the app."],
  old_app: ["Update the Clip Factory app first.", "Quit it (press Command and Q), then open it again.", "When it asks, tap Restart now."],
  old_app_cant_update: ["This copy can't update itself. Tap Get the app, install the new one, then open it."],
};

/** A command error's code (`{ code }` from the app, or a plain string). */
export function bridgeError(e: unknown): string {
  if (typeof e === "string") return e;
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "error";
}

export type ConnectOutcome =
  | { kind: "result"; result: CrConnectResult; connection?: CrConnection }
  /** The app says this computer can't run the door (Windows): the page shows the browser words instead. */
  | { kind: "unsupported" }
  /** Cancel, or the page went away. */
  | { kind: "canceled" }
  /** The API refused before the sign-in opened: its sentence. */
  | { kind: "failed"; message: string };

export interface ConnectDeps {
  api: Pick<Api, "crConnect" | "crConnectFinish">;
  bridge: CrBridge;
  signal: AbortSignal;
  /** Called once the browser has the sign-in page. */
  onOpened?: () => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Polls the door every 500 ms (§38.15) for up to 5 minutes. */
export const POLL_MS = 500;
export const WAIT_MS = 5 * 60_000;

/** One Connect, start to finish. Never throws. */
export async function runConnect({ api, bridge, signal, onOpened, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }: ConnectDeps): Promise<ConnectOutcome> {
  let port: number;
  try {
    ({ port } = await bridge.listen());
  } catch (e) {
    const code = bridgeError(e);
    if (code === "unsupported") return { kind: "unsupported" };
    if (code === "busy") return { kind: "result", result: "busy" };
    return { kind: "result", result: code === "no_port" ? "no_port" : "error" };
  }
  const stop = async (): Promise<ConnectOutcome> => {
    await bridge.cancel().catch(() => undefined);
    return { kind: "canceled" };
  };
  if (signal.aborted) return stop();
  let authorizeUrl: string;
  try {
    ({ authorizeUrl } = await api.crConnect(port));
  } catch (e) {
    await bridge.cancel().catch(() => undefined);
    return { kind: "failed", message: friendlyMessage(e) };
  }
  if (signal.aborted) return stop();
  try {
    await bridge.open(authorizeUrl);
  } catch (e) {
    await bridge.cancel().catch(() => undefined);
    return { kind: "result", result: bridgeError(e) === "no_port" ? "no_port" : "error" };
  }
  onOpened?.();
  const until = now() + WAIT_MS;
  while (now() < until) {
    if (signal.aborted) return stop();
    let door: CrDoorResult;
    try {
      door = await bridge.result();
    } catch {
      return { kind: "result", result: "error" };
    }
    if (signal.aborted) return stop();
    if (door.status === "expired") return { kind: "result", result: "expired" };
    if (door.status === "done" && door.state && door.code) return finish({ state: door.state, code: door.code, ...(door.iss ? { iss: door.iss } : {}) });
    if (door.status === "error" && door.state)
      return finish({ state: door.state, error: door.error ?? "error", ...(door.errorDescription ? { errorDescription: door.errorDescription } : {}) });
    if (door.status === "done" || door.status === "error") return { kind: "result", result: "error" };
    await sleep(POLL_MS);
  }
  await bridge.cancel().catch(() => undefined);
  return { kind: "result", result: "expired" };

  async function finish(body: Parameters<Api["crConnectFinish"]>[0]): Promise<ConnectOutcome> {
    try {
      const out = await api.crConnectFinish(body);
      return { kind: "result", result: out.result, connection: out.connection };
    } catch (e) {
      return { kind: "failed", message: friendlyMessage(e) };
    }
  }
}
