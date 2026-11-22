// Your bank on the web (docs/CONTRACTS.md §40.5): the shared GET /v1/getpaid/bank store, read again (debounced 1 s)
// on live `bank` events, on the window coming back while a connect is waiting, and after each of his own changes;
// the first-read call, sent once. While BANK_READING is off ({ on: false }), on an API from before it (404) and
// while it can't be read, every screen keeps today's words (BANK_TEXT). Money is only ever formatted (§25, §40.5.9).
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { api } from "../api/index.ts";
import { ApiError, friendlyMessage } from "../api/errors.ts";
import type { BankAsk, BankView } from "../api/types.ts";
import { onLiveSignal } from "./live.ts";

/** How long live news waits before GET /v1/getpaid/bank is read again (a run writes many items at once). */
export const BANK_DEBOUNCE_MS = 1000;

export type BankLoad =
  | { state: "loading"; view: null }
  /** `{ on: false }` (BANK_READING off) or 404 (an API from before §40.5): today's words, nothing else. */
  | { state: "off"; view: null }
  | { state: "error"; view: BankView | null; error: string }
  | { state: "ok"; view: BankView };

let snapshot: BankLoad = { state: "loading", view: null };
/** Bumped by resetBank: an answer to a read from before it (another user, a test) is dropped. */
let generation = 0;
/**
 * Bumped by each of his own changes (putBank, patchBank): a read that was already on its way when he changed
 * something answers with the view from before it, so that answer is dropped and read again (the last word is fresh).
 */
let writes = 0;
let started = false;
let inFlight: Promise<void> | null = null;
let again = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let unlisten: (() => void) | null = null;
let unfocus: (() => void) | null = null;
const listeners = new Set<() => void>();
/** When this page sent a connect (memory only, §40.5.2): coming back to the window reads the view again. */
let connectSentAt: string | null = null;
/** The first reads already asked for (one per connect), so the call is sent once. */
const firstSent = new Set<string>();

function set(next: BankLoad) {
  snapshot = next;
  for (const fn of listeners) fn();
}

/** Reads GET /v1/getpaid/bank (one call at a time; one asked for meanwhile runs once after it). */
export function reloadBank(): Promise<void> {
  if (inFlight) {
    again = true;
    return inFlight;
  }
  const mine = generation;
  const wrote = writes;
  inFlight = (async () => {
    try {
      const view = await api().getBank();
      if (mine !== generation) return;
      // He changed something while this read was on its way: its view is older than his, so read once more.
      if (wrote !== writes) again = true;
      else set(view.on ? { state: "ok", view } : { state: "off", view: null });
    } catch (e) {
      if (mine !== generation) return;
      if (wrote !== writes) again = true;
      else if (e instanceof ApiError && e.status === 404) set({ state: "off", view: null });
      else set({ state: "error", view: snapshot.view, error: friendlyMessage(e) });
    } finally {
      if (mine === generation) inFlight = null;
      if (again && mine === generation) {
        again = false;
        void reloadBank();
      }
    }
  })();
  return inFlight;
}

/** GET /v1/getpaid/bank again in a moment (once, however many events arrive). */
export function scheduleBank(ms = BANK_DEBOUNCE_MS): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void reloadBank();
  }, ms);
}

function ensureStarted() {
  if (started) return;
  started = true;
  void reloadBank();
  unlisten = onLiveSignal((s) => {
    if (s.kind === "resync" || s.event.type === "bank") scheduleBank();
  });
  if (typeof window !== "undefined") {
    const back = () => {
      if (connectSentAt && (document.visibilityState === undefined || document.visibilityState === "visible")) scheduleBank(0);
    };
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    unfocus = () => {
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }
}

/** Puts the server's answer in the store (every bank route answers with the whole view). */
export function putBank(view: BankView): void {
  if (!view.on) return;
  writes++;
  set({ state: "ok", view });
}

/** A newer copy straight away (an answer's card leaving at once), before the server's answer. */
export function patchBank(fn: (v: BankView) => BankView): void {
  if (!snapshot.view) return;
  writes++;
  set({ ...snapshot, view: fn(snapshot.view) } as BankLoad);
}

/** The store as it is now (tests, and code outside React). */
export const bankNow = (): BankLoad => snapshot;

/** Forgets everything (sign-out, tests). */
export function resetBank(): void {
  generation++;
  unlisten?.();
  unlisten = null;
  unfocus?.();
  unfocus = null;
  if (timer) clearTimeout(timer);
  timer = null;
  started = false;
  inFlight = null;
  again = false;
  connectSentAt = null;
  firstSent.clear();
  undone.clear();
  snapshot = { state: "loading", view: null };
  for (const fn of listeners) fn();
}

/** GET /v1/getpaid/bank, shared by the Your bank card, the bank page, each place page and Money. */
export function useBank(): BankLoad & { reload: () => Promise<void> } {
  const state = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      ensureStarted();
      return () => listeners.delete(fn);
    },
    () => snapshot,
    () => snapshot,
  );
  const reload = useCallback(() => reloadBank(), []);
  return { ...state, reload };
}

/** The view, only while Your bank is on and read; null keeps today's words (BANK_TEXT). */
export function bankView(load: BankLoad): BankView | null {
  return load.state === "ok" || load.state === "error" ? load.view : null;
}

// ---------- Connect, and the first read ----------

/** A connect was sent from this page (memory only): coming back to the window, or a `bank` event, reads the view. */
export function markConnectSent(at = new Date().toISOString()): void {
  connectSentAt = at;
}
export const connectSent = (): string | null => connectSentAt;
export function clearConnectSent(): void {
  connectSentAt = null;
}

/**
 * Asks for the first read once (POST /v1/getpaid/bank/check {"first": true}, §40.5.5): when the page shows
 * bank_connected, or hears of a new link still waiting for its first read. `key` names that connect, so the call is
 * sent once however often the page draws it. The API lets only one through per link anyway.
 */
export function sendFirstRead(key: string): boolean {
  if (firstSent.has(key)) return false;
  firstSent.add(key);
  const mine = generation;
  void api()
    .bankCheckNow(true)
    .then((v) => mine === generation && putBank(v))
    .catch(() => undefined);
  return true;
}

// ---------- An answer's Undo puts the question back as it was ----------

/**
 * The questions he answered with a place and then undid (memory only, this tab). The server's `not_this` brings a
 * row back with no suggestion (§40.5.8), so the card would ask a harder question than the one he answered. Until he
 * answers again, the card shows the question as it was: the same words and the same green yes, which then sends
 * `place` with that suggestion (the row has none of its own any more).
 */
const undone = new Map<string, BankAsk>();
export function rememberUndone(ask: BankAsk): void {
  undone.set(ask.depositId, ask);
}
export function forgetUndone(depositId: string): void {
  undone.delete(depositId);
}
/** The question as he first saw it, while the server's copy of it has no suggestion. */
export function asItWas(ask: BankAsk): BankAsk {
  const was = undone.get(ask.depositId);
  if (!was || ask.suggested || ask.kind !== "place" || !was.suggested) return ask;
  return { ...ask, suggested: was.suggested, title: was.title, line: was.line, ...(was.yesLabel ? { yesLabel: was.yesLabel } : {}) };
}

/** Every bank this view knows of (not stopped), for "Already here" and the reconnect. */
export function liveLinks(view: BankView): BankView["links"] {
  return view.links.filter((l) => l.status !== "stopped");
}

// ---------- Changes that wait for an Undo (Stop reading, Forget my bank, an answer's "Saved. Undo") ----------

export interface Held {
  /** Aborted when the change was sent early (the page closing, hidden, or left): the toast then goes quietly. */
  signal: AbortSignal;
  /** The toast ran out: send it now (once). */
  send: () => void;
  /** Undo: never send it. */
  drop: () => void;
  /** Send it now and take its toast away quietly (a newer answer's toast takes its place). */
  flush: () => void;
}

/**
 * Holds changes while their 8 s Undo runs (§40.5.2). Each is sent when its toast ends, or at once (the calls use
 * fetch with keepalive) on `pagehide`, on `visibilitychange` to hidden, or when this page goes (a route change).
 * Undo works only while the page stays open.
 */
export function useHeld(): (run: () => void) => Held {
  const pending = useRef(new Map<number, { run: () => void; abort: AbortController }>());
  const next = useRef(1);
  useEffect(() => {
    const flush = () => {
      for (const [key, p] of Array.from(pending.current)) {
        pending.current.delete(key);
        p.abort.abort();
        p.run();
      }
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hidden);
      flush();
    };
  }, []);
  return useCallback((run: () => void): Held => {
    const key = next.current++;
    const abort = new AbortController();
    pending.current.set(key, { run, abort });
    return {
      signal: abort.signal,
      send: () => {
        if (!pending.current.delete(key)) return;
        run();
      },
      drop: () => {
        pending.current.delete(key);
      },
      flush: () => {
        if (!pending.current.delete(key)) return;
        abort.abort();
        run();
      },
    };
  }, []);
}
