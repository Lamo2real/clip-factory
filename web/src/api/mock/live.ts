// Mock mode's stand-in for the WebSocket API: a fake socket fed by the in-memory store, so live progress can be seen
// (npm run dev:mock) and tested (Playwright) with nothing leaving the machine. Only bundled into mock builds.
import type { SocketLike } from "../../lib/live.ts";
import type { LiveEvent } from "../types.ts";

type Listener = (ev: LiveEvent) => void;

/** Shared between the mock API (which publishes every change) and the fake sockets (which deliver them). */
export const mockLive = {
  listeners: new Set<Listener>(),
  /** Ask's fake worker (api/mock/ask.ts) streams raw messages to one connection id. */
  raw: new Map<string, (msg: unknown) => void>(),
  sockets: new Set<FakeSocket>(),
  /** Set by the mock API: moves running jobs along and publishes what changed. */
  tick: (() => undefined) as () => void,
  publish(ev: LiveEvent) {
    for (const fn of this.listeners) fn(ev);
  },
};

/** Test knobs, reachable as window.__cfMockLive. */
export interface MockLiveControls {
  /** How many sockets are open right now. */
  open(): number;
  /** The server drops every connection (the app should quietly reconnect). */
  drop(): void;
  /** Moves the newest running job one step forward and pushes it (progress frozen under automation otherwise). */
  advance(): void;
  /** Turns the fake WebSocket API off (new connections are refused) or back on. */
  setAvailable(on: boolean): void;
  /** Pushes the next scripted live status line (§31) of the newest running job; `at` picks a line of the script. */
  line(at?: number): void;
}

let available = true;

export class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  private readonly listener: Listener = (ev) => {
    if (this.readyState !== 1) return;
    const data = JSON.stringify(ev);
    setTimeout(() => this.onmessage?.({ data }), 0);
  };
  private ticker: ReturnType<typeof setInterval> | undefined;
  private static count = 0;
  /** Like API Gateway's connectionId, learned with {"action":"whoami"} (§28.5). */
  readonly connectionId = `mockconn${++FakeSocket.count}=`;

  constructor(url: string) {
    const token = new URL(url, "http://mock").searchParams.get("token");
    setTimeout(() => {
      // Like the real authorizer: no token or no API → the connection is refused before it opens.
      if (!token || !available) return this.finish(1006);
      this.readyState = 1;
      mockLive.sockets.add(this);
      mockLive.listeners.add(this.listener);
      mockLive.raw.set(this.connectionId, (msg) => {
        if (this.readyState === 1) setTimeout(() => this.onmessage?.({ data: JSON.stringify(msg) }), 0);
      });
      // Moves running jobs along about once a second while someone is listening (skipped under automation).
      this.ticker = setInterval(() => mockLive.tick(), 1000);
      this.onopen?.({});
    }, 40);
  }

  send(data: string) {
    if (this.readyState !== 1) return;
    let action: unknown;
    try {
      action = (JSON.parse(data) as { action?: unknown }).action;
    } catch {
      action = null;
    }
    const reply =
      action === "ping"
        ? { type: "pong", at: new Date().toISOString() }
        : action === "whoami"
          ? { type: "whoami", connectionId: this.connectionId }
          : { type: "error", code: "bad_request" };
    setTimeout(() => this.onmessage?.({ data: JSON.stringify(reply) }), 0);
  }

  close() {
    this.finish(1000);
  }

  /** The server side closes the connection. */
  finish(code: number) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    clearInterval(this.ticker);
    mockLive.sockets.delete(this);
    mockLive.listeners.delete(this.listener);
    mockLive.raw.delete(this.connectionId);
    setTimeout(() => this.onclose?.({ code }), 0);
  }
}

export function createMockSocket(url: string): SocketLike {
  return new FakeSocket(url);
}

export function installMockLiveControls(advance: () => void, line: (at?: number) => void = () => undefined): void {
  if (typeof window === "undefined") return;
  const controls: MockLiveControls = {
    open: () => mockLive.sockets.size,
    drop: () => {
      for (const s of Array.from(mockLive.sockets)) s.finish(1006);
    },
    advance,
    line,
    setAvailable: (on) => {
      available = on;
    },
  };
  (window as unknown as { __cfMockLive?: MockLiveControls }).__cfMockLive = controls;
}
