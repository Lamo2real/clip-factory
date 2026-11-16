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

/** Loads once on mount (and when `key` changes). Errors become a sentence for the screen to show. */
export function useLoad<T>(load: () => Promise<T>, key: string = ""): Loaded<T> {
  const [data, setState] = useState<T | null>(null);
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
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, key]);

  const setData = useCallback((fn: (prev: T | null) => T | null) => setState((p) => fn(p)), []);
  return { data, error, missing, loading, reload, setData };
}

/**
 * Calls `tick` every `interval` ms while `active`, pausing while the app is hidden. Failures back off
 * (3 s, 6 s, 12 s … up to 30 s) so a flaky connection is not hammered; one success resets the pace.
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
        wait = Math.min(30_000, wait * 2);
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
