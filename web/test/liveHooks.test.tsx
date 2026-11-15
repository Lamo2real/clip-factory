import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveEvent } from "../src/api/types.ts";
import { startLive, stopLive, useLiveEvents, useLivePoll, useLiveStatus, type SocketLike } from "../src/lib/live.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let sockets: (SocketLike & { open(): void; drop(): void; push(d: unknown): void })[] = [];
function createSocket(): SocketLike {
  const s = {
    readyState: 0,
    onopen: null as SocketLike["onopen"],
    onmessage: null as SocketLike["onmessage"],
    onclose: null as SocketLike["onclose"],
    onerror: null as SocketLike["onerror"],
    send() {},
    close() {
      s.readyState = 3;
      s.onclose?.({});
    },
    open() {
      s.readyState = 1;
      s.onopen?.({});
    },
    drop() {
      s.readyState = 3;
      s.onclose?.({});
    },
    push(d: unknown) {
      s.onmessage?.({ data: JSON.stringify(d) });
    },
  };
  sockets.push(s);
  return s;
}

function Probe({ tick, onEvent, onResync }: { tick: () => Promise<unknown>; onEvent: (e: LiveEvent) => void; onResync: () => void }) {
  useLivePoll(tick, true, 3000);
  useLiveEvents(onEvent, onResync);
  return <span data-status={useLiveStatus()} />;
}

describe("live hooks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
  });
  afterEach(() => {
    stopLive();
    vi.useRealTimers();
  });

  it("polls at its own pace while disconnected, every 30 s while live, and fast again after a drop", async () => {
    const tick = vi.fn(async () => undefined);
    const onEvent = vi.fn();
    const onResync = vi.fn();
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<Probe tick={tick} onEvent={onEvent} onResync={onResync} />));

    // No connection at all (no wsUrl): the poll does all the work.
    await act(async () => vi.advanceTimersByTimeAsync(9000));
    expect(tick).toHaveBeenCalledTimes(3);
    tick.mockClear();

    await act(async () => {
      startLive({ url: "wss://x/live", token: async () => "t", createSocket, random: () => 0.5 });
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => sockets[0]!.open());
    expect(host.querySelector("span")!.dataset.status).toBe("live");
    expect(onResync).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(29_000));
    expect(tick).toHaveBeenCalledTimes(0);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(tick).toHaveBeenCalledTimes(1);

    // Live events reach the screen; an item too big to send means "fetch again".
    const ev = { type: "job", op: "delete", id: "J1" };
    await act(async () => sockets[0]!.push(ev));
    expect(onEvent).toHaveBeenCalledWith(ev);
    await act(async () => sockets[0]!.push({ type: "clip", op: "upsert", id: "C1", partial: true }));
    expect(onResync).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenCalledTimes(1);

    // Dropped: back to the quick poll straight away.
    tick.mockClear();
    await act(async () => sockets[0]!.drop());
    expect(host.querySelector("span")!.dataset.status).toBe("waiting");
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(tick).toHaveBeenCalledTimes(1);

    // Reconnected after 1 s: another resync, so nothing missed while down stays missed.
    await act(async () => sockets[1]!.open());
    expect(onResync).toHaveBeenCalledTimes(3);

    await act(async () => root.unmount());
  });

  it("stopLive (sign-out) closes the connection and the status goes off", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<Probe tick={async () => undefined} onEvent={() => undefined} onResync={() => undefined} />));
    await act(async () => {
      startLive({ url: "wss://x/live", token: async () => "t", createSocket });
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => sockets[0]!.open());
    expect(host.querySelector("span")!.dataset.status).toBe("live");
    await act(async () => stopLive());
    expect(sockets[0]!.readyState).toBe(3);
    expect(host.querySelector("span")!.dataset.status).toBe("off");
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(sockets).toHaveLength(1);
    await act(async () => root.unmount());
  });
});
