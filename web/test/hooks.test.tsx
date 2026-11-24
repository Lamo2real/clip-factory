import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetLoaded, patchLoaded, useLoad, usePoll } from "../src/lib/hooks.ts";

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

describe("useLoad remembers a page's last result (docs/CONTRACTS.md §20.16)", () => {
  function Shows({ load, cache, k = "", seen }: { load: () => Promise<string>; cache?: string; k?: string; seen: (string | null)[] }) {
    const { data } = useLoad(load, k, cache);
    seen.push(data);
    return null;
  }
  const visit = async (props: Parameters<typeof Shows>[0]) => {
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Shows {...props} />));
    return root;
  };
  beforeEach(() => forgetLoaded());

  it("a page visited before shows its last data from the first render, then refreshes it", async () => {
    let answer = "first";
    const load = () => Promise.resolve(answer);
    const one: (string | null)[] = [];
    (await visit({ load, cache: "jobs", seen: one })).unmount();
    expect(one[0]).toBeNull();
    expect(one.at(-1)).toBe("first");

    answer = "second";
    const two: (string | null)[] = [];
    (await visit({ load, cache: "jobs", seen: two })).unmount();
    expect(two[0]).toBe("first");
    expect(two.at(-1)).toBe("second");
  });

  it("keeps each key apart, remembers nothing without a cache name, and forgets everything on sign-out", async () => {
    const load = () => Promise.resolve("a");
    (await visit({ load, cache: "review", k: "job-1", seen: [] })).unmount();
    const other: (string | null)[] = [];
    (await visit({ load, cache: "review", k: "job-2", seen: other })).unmount();
    expect(other[0]).toBeNull();
    (await visit({ load, seen: [] })).unmount();
    const plain: (string | null)[] = [];
    (await visit({ load, seen: plain })).unmount();
    expect(plain[0]).toBeNull();
    forgetLoaded();
    const after: (string | null)[] = [];
    (await visit({ load, cache: "review", k: "job-1", seen: after })).unmount();
    expect(after[0]).toBeNull();
  });

  it("patchLoaded changes every remembered result of one cache name, even after its page is gone", async () => {
    // Review's caption save lands after the page was left: coming back must show the saved words (bug hunt, 23 Nov).
    const load = () => new Promise<string>(() => undefined);
    for (const k of ["", "job-1"]) {
      const root = createRoot(document.createElement("div"));
      await act(async () => root.render(<Shows load={() => Promise.resolve("old")} cache="review" k={k} seen={[]} />));
      root.unmount();
    }
    (await visit({ load: () => Promise.resolve("jobs"), cache: "jobs", seen: [] })).unmount();
    patchLoaded<string>("review", (prev) => `${prev} + saved`);
    for (const k of ["", "job-1"]) {
      const seen: (string | null)[] = [];
      (await visit({ load, cache: "review", k, seen })).unmount();
      expect(seen[0]).toBe("old + saved");
    }
    // Another cache name is left alone, and nothing is made up for a cache never loaded.
    const jobs: (string | null)[] = [];
    (await visit({ load, cache: "jobs", seen: jobs })).unmount();
    expect(jobs[0]).toBe("jobs");
    patchLoaded<string>("library", () => "made up");
    const library: (string | null)[] = [];
    (await visit({ load, cache: "library", seen: library })).unmount();
    expect(library[0]).toBeNull();
  });
});
