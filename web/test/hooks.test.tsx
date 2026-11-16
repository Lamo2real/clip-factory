import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePoll } from "../src/lib/hooks.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Poller({ tick, interval = 1000 }: { tick: () => Promise<unknown>; interval?: number }) {
  usePoll(tick, true, interval);
  return null;
}

let visibility: DocumentVisibilityState = "visible";
const setVisibility = (v: DocumentVisibilityState) => {
  visibility = v;
  document.dispatchEvent(new Event("visibilitychange"));
};

describe("usePoll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps a single chain when the app is hidden and shown while a tick is in flight", async () => {
    let release: () => void = () => undefined;
    const tick = vi.fn(() => new Promise<void>((r) => (release = r)));
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<Poller tick={tick} />));

    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(tick).toHaveBeenCalledTimes(1);

    // The request is frozen in the background; switching apps back and forth must not start another chain.
    for (let i = 0; i < 3; i++) {
      setVisibility("hidden");
      setVisibility("visible");
    }
    expect(tick).toHaveBeenCalledTimes(1);

    await act(async () => release());
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(tick).toHaveBeenCalledTimes(2);
    await act(async () => release());

    // Exactly one tick per interval from here on.
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(tick).toHaveBeenCalledTimes(3);
    await act(async () => release());
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(tick).toHaveBeenCalledTimes(4);

    // Coming back while idle polls straight away, still as one chain.
    await act(async () => release());
    setVisibility("hidden");
    setVisibility("visible");
    expect(tick).toHaveBeenCalledTimes(5);
    await act(async () => release());
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(tick).toHaveBeenCalledTimes(6);

    await act(async () => root.unmount());
    await act(async () => release());
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(tick).toHaveBeenCalledTimes(6);
  });

  it("never checks faster than its interval after a failure (a 60 s poll backs off to 120 s, not 30 s)", async () => {
    const tick = vi.fn(() => Promise.reject(new Error("offline")));
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<Poller tick={tick} interval={60_000} />));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(tick).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(tick).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(tick).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
  });
});
