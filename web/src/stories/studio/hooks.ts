// Small hooks for the studio screens.
import { useEffect, useRef, useState, type RefObject } from "react";
import { storiesApi } from "../api/client.ts";
import type { Workspace } from "../api/types.ts";

/** The width an element has to draw in (a 9:16 player or preview fits it), following resizes. */
export function useWidth<T extends HTMLElement>(fallback: number): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      if (w > 0) setWidth(w);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** This workspace's settings (default length, captions, music, AI pictures); null until loaded or when it fails. */
export function useWorkspace(ws: string): Workspace | null {
  const [w, setW] = useState<Workspace | null>(null);
  useEffect(() => {
    let live = true;
    storiesApi()
      .getWorkspace(ws)
      .then((x) => live && setW(x))
      .catch(() => live && setW(null));
    return () => {
      live = false;
    };
  }, [ws]);
  return w;
}

/**
 * The same script object for as long as its contents do not change, so a poll that brings the same storyboard again
 * does not restart the live previews drawn from it.
 */
export function useSameScript<T>(script: T | null): T | null {
  const last = useRef<{ json: string; value: T | null }>({ json: "null", value: null });
  const json = script === null ? "null" : JSON.stringify(script);
  if (json !== last.current.json) last.current = { json, value: script };
  return last.current.value;
}
