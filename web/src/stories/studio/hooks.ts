// Small hooks for the studio screens.
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { friendlyMessage } from "../../api/errors.ts";
import { useLoad } from "../../lib/hooks.ts";
import { storiesApi } from "../api/client.ts";
import type { Workspace } from "../api/types.ts";

// ---------- The remembered reference list (§45.36 E2) ----------

let refsVersion = 0;
const refsListeners = new Set<() => void>();

/**
 * Says the reference videos changed (an upload finished, an analysis started or ended, one was deleted): the studio's
 * remembered list from before is never shown again, so a new reference is in the next list Production reads, and a
 * list on screen now reads itself again (keeping what it shows, and what is ticked, meanwhile).
 */
export function referencesChanged(): void {
  refsVersion += 1;
  for (const fn of [...refsListeners]) fn();
}

/** The cache name of the studio's reference list (useLoad): a new one after every change. */
export function referencesCache(): string {
  return `st-s-refvids:${refsVersion}`;
}

/**
 * This workspace's reference videos for a studio page (§45.36 E2). The cache name is read once, when the page opens:
 * a change while it is open (a background upload finishing, a delete's undo running out) reads the list again in
 * place, never swapping to an empty name that would hide the list and drop the ticked references.
 */
export function useReferenceList(ws: string) {
  const [slot] = useState(referencesCache);
  const refs = useLoad(() => storiesApi().listReferences(ws), ws, slot);
  const reload = refs.reload;
  useEffect(() => {
    const again = () => void reload();
    refsListeners.add(again);
    return () => {
      refsListeners.delete(again);
    };
  }, [reload]);
  return refs;
}

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

/** One page of a list the API pages with `nextCursor` (CONTRACTS §45.5). */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * A list the API pages (the Production list, a Review group, the Library's Projects; CONTRACTS §45.34 "All projects"):
 * the first page loads like useLoad (and `reload` reads it again, as a poll does), and "Show more" adds the next pages
 * below it. An item on a later page that the first page now holds again is shown once, as the first page has it.
 */
export function usePaged<T>(load: (cursor?: string) => Promise<Page<T>>, key: string, cache: string, idOf: (t: T) => string) {
  const first = useLoad(() => load(), key, cache);
  const [extra, setExtra] = useState<{ key: string; items: T[]; cursor: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const mine = extra && extra.key === key ? extra : null;
  const items = useMemo(() => {
    if (!first.data) return null;
    const seen = new Set(first.data.items.map(idOf));
    return [...first.data.items, ...(mine?.items ?? []).filter((t) => !seen.has(idOf(t)))];
    // idOf is a plain getter
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first.data, mine]);
  const cursor = mine ? mine.cursor : (first.data?.nextCursor ?? null);

  const more = useCallback(async () => {
    if (!cursor || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const next = await loadRef.current(cursor);
      setExtra((e) => ({ key, items: [...(e && e.key === key ? e.items : []), ...next.items], cursor: next.nextCursor }));
    } catch (e) {
      setProblem(friendlyMessage(e));
    } finally {
      setBusy(false);
    }
  }, [cursor, busy, key]);

  return { data: items, error: first.error, missing: first.missing, reload: first.reload, hasMore: !!cursor, more, busy, problem };
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
