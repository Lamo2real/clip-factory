// Live updates over the WebSocket API (docs/CONTRACTS.md §14.2). One shared connection for the signed-in app:
// the server pushes one message per changed job, clip, post or learning, and the screens fold them into what they
// show. Polling stays as the fallback and slows to every 30 seconds while the connection is up. A dropped connection
// is never an error for the owner: it quietly reconnects, and the screens refetch what they show when it is back.
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { LiveEvent, LiveItemType } from "../api/types.ts";
import { usePoll } from "./hooks.ts";

/** Seconds between reconnect attempts: 1, 2, 4, 8, 16, then 30 for good (each ±20 %). */
export const BACKOFF_S = [1, 2, 4, 8, 16, 30] as const;
/** A connection that stayed up this long counts as healthy: the next drop starts the backoff from 1 s again. */
export const STABLE_MS = 60_000;
/** Keepalive: API Gateway closes a WebSocket after 10 idle minutes. */
export const PING_MS = 5 * 60_000;
/** API Gateway ends every connection after 2 hours; reconnect a little before, on our own terms. */
export const RECYCLE_MS = 110 * 60_000;
/** Hidden for longer than this (app in the background): close the socket until the app is visible again. */
export const HIDDEN_PAUSE_MS = 5 * 60_000;
/** How often the existing polls run while the connection is up. */
export const LIVE_POLL_MS = 30_000;

export type LiveStatus = "off" | "connecting" | "live" | "waiting" | "paused";

/** What a screen hears: one changed item, or "fetch again" (after a reconnect, or an item too big to send). */
export type LiveSignal = { kind: "event"; event: LiveEvent } | { kind: "resync" };

/** The part of the browser WebSocket the connection uses (the mock and the tests provide their own). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface LiveOptions {
  /** `wss://…/live` from /config.json. Absent: the connection stays off and the polls do all the work. */
  url: string | undefined;
  /** A valid access token (fresh=true forces a refresh), or null when nobody is signed in any more. */
  token: (fresh: boolean) => Promise<string | null>;
  createSocket?: (url: string) => SocketLike;
  random?: () => number;
  now?: () => number;
  /** Visibility and online/offline events (the tests pass their own). */
  doc?: Pick<Document, "addEventListener" | "removeEventListener"> & { readonly hidden: boolean };
  win?: Pick<Window, "addEventListener" | "removeEventListener">;
}

/** Wait before reconnect attempt number `attempt` (0-based), with ±20 % jitter so many tabs do not stampede. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = BACKOFF_S[Math.min(Math.max(attempt, 0), BACKOFF_S.length - 1)]! * 1000;
  return Math.round(base * (0.8 + 0.4 * random()));
}

const TYPES: readonly LiveItemType[] = ["job", "clip", "post", "learning", "week"];

/** Reads one server message. Pongs, errors and anything malformed give null (they change nothing on screen). */
export function parseLiveMessage(data: unknown): LiveEvent | null {
  if (typeof data !== "string") return null;
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  if (!TYPES.includes(m.type as LiveItemType) || typeof m.id !== "string" || !m.id) return null;
  if (m.op === "delete") return { type: m.type as LiveItemType, op: "delete", id: m.id };
  if (m.op !== "upsert") return null;
  if (m.partial === true) return { type: m.type as LiveItemType, op: "upsert", id: m.id, partial: true };
  if (!m.item || typeof m.item !== "object") return null;
  return msg as LiveEvent;
}

const OPEN = 1;

export class LiveConnection {
  status: LiveStatus = "off";
  private readonly opts: Required<Omit<LiveOptions, "url" | "doc" | "win">> & Pick<LiveOptions, "url" | "doc" | "win">;
  private readonly signalListeners = new Set<(s: LiveSignal) => void>();
  private readonly statusListeners = new Set<(s: LiveStatus) => void>();
  private socket: SocketLike | null = null;
  private attempt = 0;
  private freshToken = false;
  private started = false;
  private stopped = false;
  private paused = false;
  /** Bumped by every connect, so a token that arrives after stop() or a newer connect is dropped. */
  private gen = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  private recycleTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: LiveOptions) {
    this.opts = {
      createSocket: (u) => new WebSocket(u) as unknown as SocketLike,
      random: Math.random,
      now: Date.now,
      doc: typeof document === "undefined" ? undefined : document,
      win: typeof window === "undefined" ? undefined : window,
      ...options,
    };
  }

  subscribe(fn: (s: LiveSignal) => void): () => void {
    this.signalListeners.add(fn);
    return () => this.signalListeners.delete(fn);
  }

  onStatus(fn: (s: LiveStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    if (!this.opts.url) return; // No WebSocket API configured: polling only.
    this.opts.doc?.addEventListener("visibilitychange", this.onVisibility);
    this.opts.win?.addEventListener("online", this.onOnline);
    if (this.opts.doc?.hidden) this.onVisibility();
    void this.connect();
  }

  /** Sign-out or leaving the app: close for good. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.gen++;
    this.clearTimers();
    clearTimeout(this.hiddenTimer);
    this.drop();
    this.opts.doc?.removeEventListener("visibilitychange", this.onVisibility);
    this.opts.win?.removeEventListener("online", this.onOnline);
    this.setStatus("off");
  }

  private setStatus(s: LiveStatus) {
    if (s === this.status) return;
    this.status = s;
    for (const fn of this.statusListeners) fn(s);
  }

  private signal(s: LiveSignal) {
    for (const fn of this.signalListeners) {
      try {
        fn(s);
      } catch (e) {
        console.error(e);
      }
    }
  }

  private clearTimers() {
    clearTimeout(this.retryTimer);
    clearTimeout(this.stableTimer);
    clearTimeout(this.recycleTimer);
    clearInterval(this.pingTimer);
    this.retryTimer = this.stableTimer = this.recycleTimer = this.pingTimer = undefined;
  }

  /** Closes the current socket without its close handler scheduling a reconnect. */
  private drop() {
    const s = this.socket;
    this.socket = null;
    if (!s) return;
    s.onopen = s.onmessage = s.onclose = s.onerror = null;
    try {
      s.close(1000, "bye");
    } catch {
      /* already closed */
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.paused) return;
    this.clearTimers();
    this.drop();
    const mine = ++this.gen;
    this.setStatus("connecting");
    let token: string | null;
    try {
      token = await this.opts.token(this.freshToken);
    } catch {
      // Offline or Cognito is slow: try again later, the stored sign-in is still there.
      if (mine === this.gen) this.retry();
      return;
    }
    if (mine !== this.gen || this.stopped || this.paused) return;
    if (!token) {
      // Nobody is signed in any more; the app shows the sign-in screen and stops this connection.
      this.setStatus("off");
      return;
    }
    let socket: SocketLike;
    try {
      socket = this.opts.createSocket(`${this.opts.url}?token=${encodeURIComponent(token)}`);
    } catch {
      this.retry();
      return;
    }
    this.socket = socket;
    let opened = false;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      opened = true;
      this.freshToken = false;
      this.setStatus("live");
      this.stableTimer = setTimeout(() => (this.attempt = 0), STABLE_MS);
      this.pingTimer = setInterval(() => this.ping(), PING_MS);
      this.recycleTimer = setTimeout(() => {
        this.attempt = 0;
        void this.connect();
      }, RECYCLE_MS);
      // Anything that changed while the socket was down was missed: the screens fetch again.
      this.signal({ kind: "resync" });
    };
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      const event = parseLiveMessage(ev.data);
      if (event) this.signal({ kind: "event", event });
    };
    socket.onerror = () => undefined; // A close always follows; it decides what happens next.
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearTimers();
      if (this.stopped || this.paused) return;
      // Closed before it ever opened: most likely the token was refused (401), so the next try forces a fresh one.
      if (!opened) this.freshToken = true;
      this.retry();
    };
  }

  private retry() {
    if (this.stopped || this.paused) return;
    clearTimeout(this.retryTimer);
    this.setStatus("waiting");
    const wait = backoffDelay(this.attempt, this.opts.random);
    this.attempt++;
    this.retryTimer = setTimeout(() => void this.connect(), wait);
  }

  private ping() {
    const s = this.socket;
    if (!s || s.readyState !== OPEN) return;
    try {
      s.send(JSON.stringify({ action: "ping" }));
    } catch {
      /* the close handler deals with a dead socket */
    }
  }

  private readonly onVisibility = () => {
    if (this.stopped) return;
    if (this.opts.doc?.hidden) {
      clearTimeout(this.hiddenTimer);
      this.hiddenTimer = setTimeout(() => this.pause(), HIDDEN_PAUSE_MS);
      return;
    }
    clearTimeout(this.hiddenTimer);
    this.hiddenTimer = undefined;
    if (this.paused) {
      this.paused = false;
      this.attempt = 0;
      void this.connect();
    }
  };

  private pause() {
    if (this.stopped || this.paused) return;
    this.paused = true;
    this.gen++;
    this.clearTimers();
    this.drop();
    this.setStatus("paused");
  }

  /** Back online while waiting out a backoff: no need to wait any longer. */
  private readonly onOnline = () => {
    if (this.status === "waiting" && !this.paused && !this.stopped) void this.connect();
  };
}

// ---------- The app's one connection, and the React side ----------

let current: LiveConnection | null = null;
const hubSignals = new Set<(s: LiveSignal) => void>();
const hubStatus = new Set<() => void>();
let unhook: (() => void) | null = null;

/** Starts the shared connection for the signed-in app (replacing any earlier one). */
export function startLive(options: LiveOptions): LiveConnection {
  stopLive();
  const conn = new LiveConnection(options);
  const offSignal = conn.subscribe((s) => {
    for (const fn of hubSignals) fn(s);
  });
  const offStatus = conn.onStatus(() => {
    for (const fn of hubStatus) fn();
  });
  unhook = () => {
    offSignal();
    offStatus();
  };
  current = conn;
  conn.start();
  for (const fn of hubStatus) fn();
  return conn;
}

/** Sign-out: close the shared connection. */
export function stopLive(): void {
  const conn = current;
  current = null;
  conn?.stop();
  unhook?.();
  unhook = null;
  for (const fn of hubStatus) fn();
}

export function liveStatus(): LiveStatus {
  return current?.status ?? "off";
}

/** Follows the shared connection's status ("live" while the socket is open). */
export function useLiveStatus(): LiveStatus {
  return useSyncExternalStore(
    (fn) => {
      hubStatus.add(fn);
      return () => hubStatus.delete(fn);
    },
    liveStatus,
    () => "off" as LiveStatus,
  );
}

/**
 * Hears every live event and every "fetch again" while the calling screen is on screen.
 * The handlers may change between renders; the latest ones are always used.
 */
export function useLiveEvents(onEvent: (e: LiveEvent) => void, onResync: () => void): void {
  const ref = useRef({ onEvent, onResync });
  ref.current = { onEvent, onResync };
  useEffect(() => {
    const fn = (s: LiveSignal) => {
      if (s.kind === "resync") ref.current.onResync();
      else if (s.event.partial) ref.current.onResync();
      else ref.current.onEvent(s.event);
    };
    hubSignals.add(fn);
    return () => {
      hubSignals.delete(fn);
    };
  }, []);
}

/** The poll interval to use: as asked while disconnected, at most every 30 s while live. */
export function pollInterval(status: LiveStatus, interval: number): number {
  return status === "live" ? Math.max(LIVE_POLL_MS, interval) : interval;
}

/** usePoll that slows down to every 30 seconds while the live connection is up (polling is only the fallback). */
export function useLivePoll(tick: () => Promise<unknown>, active: boolean, interval = 3000): void {
  usePoll(tick, active, pollInterval(useLiveStatus(), interval));
}
