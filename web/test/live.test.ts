import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKOFF_S,
  HIDDEN_PAUSE_MS,
  LiveConnection,
  PING_MS,
  RECYCLE_MS,
  STABLE_MS,
  backoffDelay,
  parseLiveMessage,
  pollInterval,
  type LiveSignal,
  type SocketLike,
} from "../src/lib/live.ts";

class TestSocket implements SocketLike {
  static all: TestSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  constructor(readonly url: string) {
    TestSocket.all.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  /** The server accepts the connection. */
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  /** The server (or the network) drops it. */
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
  message(data: unknown) {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }
}

class FakeDoc extends EventTarget {
  hidden = false;
  setHidden(h: boolean) {
    this.hidden = h;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

const last = () => TestSocket.all.at(-1)!;
const flush = () => vi.advanceTimersByTimeAsync(0);

function setup(over: Partial<ConstructorParameters<typeof LiveConnection>[0]> = {}) {
  let n = 0;
  const token = vi.fn(async (_fresh: boolean) => `tok/${++n}+=`);
  const doc = new FakeDoc();
  const win = new EventTarget();
  const conn = new LiveConnection({
    url: "wss://abc.execute-api.eu-north-1.amazonaws.com/live",
    token,
    createSocket: (u) => new TestSocket(u),
    random: () => 0.5, // no jitter: exact delays
    doc,
    win: win as unknown as Window,
    ...over,
  });
  const signals: LiveSignal[] = [];
  conn.subscribe((s) => signals.push(s));
  return { conn, token, doc, win, signals };
}

beforeEach(() => {
  vi.useFakeTimers();
  TestSocket.all = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe("backoffDelay", () => {
  it("follows 1, 2, 4, 8, 16, 30 s and then stays at 30 s", () => {
    const delays = Array.from({ length: 9 }, (_, i) => backoffDelay(i, () => 0.5));
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]);
    expect(BACKOFF_S).toEqual([1, 2, 4, 8, 16, 30]);
  });

  it("adds at most 20 % jitter either way", () => {
    expect(backoffDelay(0, () => 0)).toBe(800);
    expect(backoffDelay(0, () => 1)).toBe(1200);
    expect(backoffDelay(5, () => 0)).toBe(24000);
    expect(backoffDelay(5, () => 0.999999)).toBe(36000);
  });
});

describe("LiveConnection", () => {
  it("connects with the access token in the query string and goes live on open", async () => {
    const { conn, token, signals } = setup();
    conn.start();
    expect(conn.status).toBe("connecting");
    await flush();
    expect(token).toHaveBeenCalledWith(false);
    expect(last().url).toBe("wss://abc.execute-api.eu-north-1.amazonaws.com/live?token=tok%2F1%2B%3D");
    last().open();
    expect(conn.status).toBe("live");
    expect(signals).toEqual([{ kind: "resync" }]);
    conn.stop();
  });

  it("reconnects with the backoff sequence and a fresh token on every attempt", async () => {
    const { conn, token } = setup();
    conn.start();
    await flush();
    const waits = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    for (const [i, wait] of waits.entries()) {
      last().drop(); // refused before it opened (e.g. 401)
      expect(conn.status).toBe("waiting");
      const before = TestSocket.all.length;
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(TestSocket.all.length, `attempt ${i + 1} too early`).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(TestSocket.all.length, `attempt ${i + 1} on time`).toBe(before + 1);
      // A refused connection means the token may be stale: every retry asks for a forced refresh.
      expect(token).toHaveBeenLastCalledWith(true);
    }
    expect(token).toHaveBeenCalledTimes(waits.length + 1);
    // Each attempt carried its own token.
    expect(new Set(TestSocket.all.map((s) => s.url)).size).toBe(TestSocket.all.length);
    conn.stop();
  });

  it("starts the backoff again from 1 s after staying connected for 60 s", async () => {
    const { conn, token } = setup();
    conn.start();
    await flush();
    last().drop();
    await vi.advanceTimersByTimeAsync(1000);
    last().drop();
    await vi.advanceTimersByTimeAsync(2000);
    last().open();
    expect(token).toHaveBeenLastCalledWith(true);
    await vi.advanceTimersByTimeAsync(STABLE_MS);
    last().drop();
    const before = TestSocket.all.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(TestSocket.all.length).toBe(before + 1);
    // It had been open, so the token was fine: no forced refresh this time.
    expect(token).toHaveBeenLastCalledWith(false);
    conn.stop();
  });

  it("a drop before 60 s keeps climbing the backoff", async () => {
    const { conn } = setup();
    conn.start();
    await flush();
    last().drop();
    await vi.advanceTimersByTimeAsync(1000);
    last().open();
    await vi.advanceTimersByTimeAsync(STABLE_MS - 1000);
    last().drop();
    const before = TestSocket.all.length;
    await vi.advanceTimersByTimeAsync(1999);
    expect(TestSocket.all.length).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(TestSocket.all.length).toBe(before + 1);
    conn.stop();
  });

  it("pings every 5 minutes while open", async () => {
    const { conn } = setup();
    conn.start();
    await flush();
    last().open();
    await vi.advanceTimersByTimeAsync(PING_MS - 1);
    expect(last().sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(last().sent).toEqual(['{"action":"ping"}']);
    await vi.advanceTimersByTimeAsync(PING_MS);
    expect(last().sent).toHaveLength(2);
    conn.stop();
  });

  it("reconnects on its own after 110 minutes, before the 2-hour cap", async () => {
    const { conn, token, signals } = setup();
    conn.start();
    await flush();
    const first = last();
    first.open();
    await vi.advanceTimersByTimeAsync(RECYCLE_MS - 1);
    expect(TestSocket.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.closed).toBe(true);
    expect(TestSocket.all).toHaveLength(2);
    expect(token).toHaveBeenCalledTimes(2);
    last().open();
    expect(conn.status).toBe("live");
    // Each reconnect asks the screens to fetch again.
    expect(signals.filter((s) => s.kind === "resync")).toHaveLength(2);
    conn.stop();
  });

  it("pauses after 5 minutes in the background and resumes when visible", async () => {
    const { conn, doc } = setup();
    conn.start();
    await flush();
    last().open();
    doc.setHidden(true);
    await vi.advanceTimersByTimeAsync(HIDDEN_PAUSE_MS - 1);
    expect(conn.status).toBe("live");
    await vi.advanceTimersByTimeAsync(1);
    expect(conn.status).toBe("paused");
    expect(last().closed).toBe(true);
    // Nothing reconnects while hidden.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(TestSocket.all).toHaveLength(1);
    doc.setHidden(false);
    await flush();
    expect(TestSocket.all).toHaveLength(2);
    last().open();
    expect(conn.status).toBe("live");
    conn.stop();
  });

  it("a short trip to the background keeps the connection", async () => {
    const { conn, doc } = setup();
    conn.start();
    await flush();
    last().open();
    doc.setHidden(true);
    await vi.advanceTimersByTimeAsync(60_000);
    doc.setHidden(false);
    await vi.advanceTimersByTimeAsync(HIDDEN_PAUSE_MS);
    expect(conn.status).toBe("live");
    expect(TestSocket.all).toHaveLength(1);
    conn.stop();
  });

  it("coming back online skips the rest of the wait", async () => {
    const { conn, win } = setup();
    conn.start();
    await flush();
    for (let i = 0; i < 5; i++) {
      last().drop();
      await vi.advanceTimersByTimeAsync(backoffDelay(i, () => 0.5));
    }
    last().drop(); // now waiting 30 s
    const before = TestSocket.all.length;
    win.dispatchEvent(new Event("online"));
    await flush();
    expect(TestSocket.all.length).toBe(before + 1);
    conn.stop();
  });

  it("stop() closes the socket for good", async () => {
    const { conn } = setup();
    conn.start();
    await flush();
    last().open();
    conn.stop();
    expect(last().closed).toBe(true);
    expect(conn.status).toBe("off");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(TestSocket.all).toHaveLength(1);
  });

  it("a token that arrives after stop() opens nothing", async () => {
    let release: (t: string) => void = () => undefined;
    const { conn } = setup({ token: () => new Promise<string>((r) => (release = r)) });
    conn.start();
    conn.stop();
    release("late");
    await flush();
    expect(TestSocket.all).toHaveLength(0);
  });

  it("stays off when nobody is signed in", async () => {
    const { conn } = setup({ token: async () => null });
    conn.start();
    await flush();
    expect(TestSocket.all).toHaveLength(0);
    expect(conn.status).toBe("off");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(TestSocket.all).toHaveLength(0);
  });

  it("a token refresh that fails (offline) is retried with the backoff", async () => {
    let calls = 0;
    const { conn } = setup({
      token: async () => {
        calls++;
        if (calls === 1) throw new Error("offline");
        return "t";
      },
    });
    conn.start();
    await flush();
    expect(conn.status).toBe("waiting");
    await vi.advanceTimersByTimeAsync(1000);
    expect(TestSocket.all).toHaveLength(1);
    conn.stop();
  });

  it("without a WebSocket URL it never connects (polling only)", async () => {
    const { conn, token } = setup({ url: undefined });
    conn.start();
    await flush();
    expect(token).not.toHaveBeenCalled();
    expect(TestSocket.all).toHaveLength(0);
    expect(conn.status).toBe("off");
  });

  it("passes events on and ignores pongs, errors and junk", async () => {
    const { conn, signals } = setup();
    conn.start();
    await flush();
    last().open();
    signals.length = 0;
    last().message({ type: "pong", at: "2026-11-15T10:00:00Z" });
    last().message({ type: "error", code: "bad_request" });
    last().message("not json");
    last().message({ type: "job", op: "delete", id: "J1" });
    expect(signals).toEqual([{ kind: "event", event: { type: "job", op: "delete", id: "J1" } }]);
    conn.stop();
  });
});

describe("parseLiveMessage", () => {
  it("reads upserts, deletes and partial upserts", () => {
    const item = { learningId: "L1", text: "x", createdAt: "2026-11-15T10:00:00Z", postIds: [] };
    expect(parseLiveMessage(JSON.stringify({ type: "learning", op: "upsert", id: "L1", item }))).toEqual({
      type: "learning",
      op: "upsert",
      id: "L1",
      item,
    });
    expect(parseLiveMessage(JSON.stringify({ type: "clip", op: "upsert", id: "C1", partial: true }))).toEqual({
      type: "clip",
      op: "upsert",
      id: "C1",
      partial: true,
    });
    expect(parseLiveMessage(JSON.stringify({ type: "post", op: "delete", id: "P1" }))).toEqual({ type: "post", op: "delete", id: "P1" });
  });

  it("drops anything it does not understand", () => {
    for (const bad of [
      42,
      "",
      "null",
      JSON.stringify({ type: "conn", op: "upsert", id: "x", item: {} }),
      JSON.stringify({ type: "job", op: "upsert", id: "x" }),
      JSON.stringify({ type: "job", op: "replace", id: "x", item: {} }),
      JSON.stringify({ type: "job", op: "delete" }),
    ])
      expect(parseLiveMessage(bad)).toBeNull();
  });
});

describe("pollInterval", () => {
  it("runs the polls at their own pace while disconnected and every 30 s while live", () => {
    expect(pollInterval("off", 3000)).toBe(3000);
    expect(pollInterval("waiting", 3000)).toBe(3000);
    expect(pollInterval("connecting", 10_000)).toBe(10_000);
    expect(pollInterval("paused", 3000)).toBe(3000);
    expect(pollInterval("live", 3000)).toBe(30_000);
    expect(pollInterval("live", 10_000)).toBe(30_000);
    expect(pollInterval("live", 60_000)).toBe(60_000);
  });
});
