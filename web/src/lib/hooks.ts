import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, friendlyMessage } from "../api/errors.ts";

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  /** The last load failed because the thing is gone (404): trying again cannot help. */
  missing: boolean;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (fn: (prev: T | null) => T | null) => void;
}

/**
 * The last result of each cached load (`useLoad`'s `cache` name + key), kept for the life of the page. A page the
 * owner comes back to shows what it showed last at once and refreshes it in the background, so a page change never
 * passes through an empty, see-through skeleton (docs/CONTRACTS.md §20.16). Emptied on sign-out.
 */
const lastLoaded = new Map<string, unknown>();

/** Forgets every remembered result (sign-out, and between tests). */
export function forgetLoaded(): void {
  lastLoaded.clear();
}

/**
 * Loads once on mount (and when `key` changes). Errors become a sentence for the screen to show. With `cache`, the
 * last result for the same name and key shows at once while the load runs again.
 */
export function useLoad<T>(load: () => Promise<T>, key: string = "", cache?: string): Loaded<T> {
  const slot = cache === undefined ? null : `${cache}\u0000${key}`;
  const slotRef = useRef(slot);
  slotRef.current = slot;
  const remembered = (at: string | null) => (at !== null && lastLoaded.has(at) ? (lastLoaded.get(at) as T) : null);
  const [data, setRaw] = useState<T | null>(() => remembered(slot));
  const setState = useCallback((next: T | null | ((prev: T | null) => T | null)) => {
    setRaw((prev) => {
      const value = typeof next === "function" ? (next as (prev: T | null) => T | null)(prev) : next;
      const at = slotRef.current;
      if (at !== null) {
        if (value === null) lastLoaded.delete(at);
        else lastLoaded.set(at, value);
      }
      return value;
    });
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const value = await loadRef.current();
      if (mine === seq.current) {
        setState(value);
        setError(null);
        setMissing(false);
      }
    } catch (e) {
      if (mine === seq.current) {
        setError(friendlyMessage(e));
        setMissing(e instanceof ApiError && e.code === "not_found");
      }
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [setState]);

  // A new key shows that key's remembered result (or nothing) until its own load lands, never the old key's.
  const shownSlot = useRef(slot);
  if (shownSlot.current !== slot) {
    shownSlot.current = slot;
    if (slot !== null) setRaw(remembered(slot));
  }

  useEffect(() => {
    void reload();
  }, [reload, key]);

  const setData = useCallback((fn: (prev: T | null) => T | null) => setState((p) => fn(p)), [setState]);
  return { data, error, missing, loading, reload, setData };
}

/** True once `on` has stayed true for `ms` (a state that normally passes in a moment only counts when it lasts). */
export function useHeld(on: boolean, ms: number): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!on) return;
    const timer = setTimeout(() => setHeld(true), ms);
    return () => {
      clearTimeout(timer);
      setHeld(false);
    };
  }, [on, ms]);
  return on && held;
}

/**
 * Calls `tick` every `interval` ms while `active`, pausing while the app is hidden. Failures back off
 * (doubling, up to 30 s or four intervals, never faster than `interval`) so a flaky connection is not hammered;
 * one success resets the pace.
 */
export function usePoll(tick: () => Promise<unknown>, active: boolean, interval = 3000): void {
  const tickRef = useRef(tick);
  tickRef.current = tick;

  useEffect(() => {
    if (!active) return;
    let wait = interval;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    // Only one chain may ever run: a tick still in flight (e.g. a fetch iOS froze in the background) reschedules
    // itself when it finishes, so coming back to the app must not start a second one.
    let inFlight = false;

    const schedule = () => {
      clearTimeout(timer);
      timer = undefined;
      if (!stopped) timer = setTimeout(run, wait);
    };
    const run = async () => {
      timer = undefined;
      if (stopped || inFlight) return;
      if (document.visibilityState === "hidden") return schedule();
      inFlight = true;
      try {
        await tickRef.current();
        wait = interval;
      } catch {
        // Back off after a failure, but never check more often than the normal interval.
        wait = Math.min(Math.max(30_000, interval * 4), wait * 2);
      } finally {
        inFlight = false;
      }
      schedule();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && !inFlight && !stopped) {
        clearTimeout(timer);
        void run();
      }
    };
    schedule();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, interval]);
}

/** Matches a media query and follows changes. */
export function useMedia(query: string): boolean {
  const get = () => typeof matchMedia === "function" && matchMedia(query).matches;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setMatches(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}
