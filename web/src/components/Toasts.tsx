import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon.tsx";

export type ToastTone = "success" | "error" | "info" | "undo";
interface ToastItem {
  id: number;
  tone: ToastTone;
  text: string;
  ms: number;
  /** A toast with a group replaces the one before it in that group instead of stacking under it. */
  group?: string;
  /** An undo toast's own picture (the bin by default). */
  icon?: IconName;
}

export interface ToastOptions {
  /** One toast per group on screen: a new one replaces the last (for example, practice taps on "Try it"). */
  group?: string;
  /** How long it stays (default 4.2 s, or 7 s for an error). */
  ms?: number;
  /** No error sound from the provider (a ToastScope plays its own app's). */
  quiet?: boolean;
}

export interface UndoOptions {
  /** Runs if the owner taps Undo in time. */
  onUndo: () => void;
  /** Runs when the time is up (or the page is closing): this is where the real delete happens. */
  onCommit: () => void;
  /** How long Undo stays available. */
  ms?: number;
  /** Aborting it takes the toast away quietly, running neither `onUndo` nor `onCommit` (nothing is left to undo). */
  signal?: AbortSignal;
  /** The picture beside the words: the bin by default; an undo of an addition shows what was added (§44). */
  icon?: IconName;
}

export interface Toaster {
  success(text: string, options?: ToastOptions): void;
  error(text: string, options?: ToastOptions): void;
  info(text: string, options?: ToastOptions): void;
  /** "Thrown away. Undo": the action only really happens after `ms` (8 s) unless Undo is tapped. */
  undo(text: string, options: UndoOptions): void;
}

export const UNDO_MS = 8000;

const Ctx = createContext<Toaster | null>(null);

/** A screen's pinned main button (phones, §38.1): the toasts never sit on it. */
export const PINNED_MAIN = ".cr-pin";

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Where the toasts' bottom edge goes (px from the window's bottom) so they never cover a pinned main button: null to
 * stay in their own place, else just above the highest pinned button they would touch. `toasts` is their box in
 * their own place; `pins` are the pinned buttons' boxes on screen.
 */
export function toastLift(toasts: Box, pins: readonly Box[], viewportHeight: number, gap = 10): number | null {
  const height = toasts.bottom - toasts.top;
  if (height <= 0) return null;
  const solid = pins.filter((p) => p.bottom > p.top && p.right > p.left);
  let at = toasts;
  let lift: number | null = null;
  // Above the button they touch; if that lands on another one, above that one too.
  for (let i = 0; i <= solid.length; i++) {
    const hit = solid.filter((p) => p.top < at.bottom && p.bottom > at.top && p.left < at.right && p.right > at.left);
    if (!hit.length) return lift;
    const top = Math.min(...hit.map((p) => p.top));
    // No room above it (a button high on the screen): the toasts keep their own place.
    if (top - gap - height < 0) return null;
    lift = Math.round(viewportHeight - top + gap);
    at = { ...at, top: top - gap - height, bottom: top - gap };
  }
  return lift;
}

export function useToast(): Toaster {
  const t = useContext(Ctx);
  if (!t) throw new Error("useToast outside ToastProvider");
  return t;
}

/** Toasts live in two live regions: polite for news, assertive for errors. `onError` plays the deny sound. */
export function ToastProvider({ children, onError }: { children: ReactNode; onError?: () => void }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  // Undo toasts that have not been decided yet: id → what to run.
  const pending = useRef(new Map<number, UndoOptions & { timer: ReturnType<typeof setTimeout> }>());

  const dismiss = useCallback((id: number) => setItems((all) => all.filter((t) => t.id !== id)), []);

  const commit = useCallback(
    (id: number) => {
      const p = pending.current.get(id);
      if (!p) return;
      pending.current.delete(id);
      clearTimeout(p.timer);
      dismiss(id);
      p.onCommit();
    },
    [dismiss],
  );

  const undo = useCallback(
    (id: number) => {
      const p = pending.current.get(id);
      if (!p) return;
      pending.current.delete(id);
      clearTimeout(p.timer);
      dismiss(id);
      p.onUndo();
    },
    [dismiss],
  );

  // Nothing left to decide (the signal was aborted): the toast goes, and neither Undo nor the real action runs.
  const drop = useCallback(
    (id: number) => {
      const p = pending.current.get(id);
      if (!p) return;
      pending.current.delete(id);
      clearTimeout(p.timer);
      dismiss(id);
    },
    [dismiss],
  );

  // Closing the tab inside the Undo window still carries out what the owner asked for.
  useEffect(() => {
    const flush = () => {
      for (const id of Array.from(pending.current.keys())) commit(id);
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [commit]);

  const push = useCallback(
    (tone: ToastTone, text: string, ms?: number, group?: string, icon?: IconName, quiet = false): number => {
      const id = next.current++;
      const life = ms ?? (tone === "error" ? 7000 : 4200);
      setItems((all) => {
        // Never drop an undo toast that is still counting down: it holds a decision.
        const keep = all.filter((t) => t.tone === "undo" || (t.text !== text && (!group || t.group !== group)));
        const old = keep.filter((t) => t.tone !== "undo").slice(-2);
        const undos = keep.filter((t) => t.tone === "undo");
        const item: ToastItem = { id, tone, text, ms: life, ...(group ? { group } : {}), ...(icon ? { icon } : {}) };
        return [...undos, ...old, item].sort((a, b) => a.id - b.id);
      });
      if (tone === "error" && !quiet) onErrorRef.current?.();
      if (tone !== "undo") setTimeout(() => dismiss(id), life);
      return id;
    },
    [dismiss],
  );

  const api = useMemo<Toaster>(
    () => ({
      success: (t, o) => void push("success", t, o?.ms, o?.group, undefined, o?.quiet),
      error: (t, o) => void push("error", t, o?.ms, o?.group, undefined, o?.quiet),
      info: (t, o) => void push("info", t, o?.ms, o?.group, undefined, o?.quiet),
      undo: (t, options) => {
        const ms = options.ms ?? UNDO_MS;
        const id = push("undo", t, ms, undefined, options.icon);
        pending.current.set(id, { ...options, timer: setTimeout(() => commit(id), ms) });
        const signal = options.signal;
        if (signal?.aborted) drop(id);
        else signal?.addEventListener("abort", () => drop(id), { once: true });
      },
    }),
    [push, commit, drop],
  );

  // Phones: a toast never covers the screen's pinned main button ("You're in!" over Make clips for this campaign):
  // while toasts show, they rise just above it whenever they would touch it, and come back down when it moves away.
  const box = useRef<HTMLDivElement>(null);
  const shown = items.length > 0;
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !shown) return;
    let frame = 0;
    const place = () => {
      frame = 0;
      el.style.removeProperty("bottom");
      const pins = [...document.querySelectorAll<HTMLElement>(PINNED_MAIN)].filter((p) => p.childElementCount > 0).map((p) => p.getBoundingClientRect());
      if (!pins.length) return;
      const lift = toastLift(el.getBoundingClientRect(), pins, window.innerHeight);
      if (lift !== null) el.style.bottom = `${lift}px`;
    };
    const later = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };
    place();
    window.addEventListener("scroll", later, { passive: true });
    window.addEventListener("resize", later);
    // A pinned button drawn after the toast (a portal filled on the next render) or a toast that grows moves it too.
    const watch = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(later);
    watch?.observe(el);
    const drawn = typeof MutationObserver === "undefined" ? null : new MutationObserver(later);
    drawn?.observe(document.body, { childList: true, subtree: true });
    return () => {
      window.removeEventListener("scroll", later);
      window.removeEventListener("resize", later);
      watch?.disconnect();
      drawn?.disconnect();
      if (frame) cancelAnimationFrame(frame);
      el.style.removeProperty("bottom");
    };
  }, [shown, items]);

  const icon = (t: ToastItem) =>
    t.icon ?? (t.tone === "error" ? "alert" : t.tone === "success" ? "checkCircle" : t.tone === "undo" ? "trash" : "info");

  const render = (filter: (t: ToastItem) => boolean) =>
    items.filter(filter).map((t) => (
      <div key={t.id} className={`toast toast--${t.tone} glass`}>
        <Icon name={icon(t)} />
        <p className="toast__text">{t.text}</p>
        {t.tone === "undo" ? (
          <>
            <button type="button" className="toast__undo" onClick={() => undo(t.id)}>
              <Icon name="undo" size={18} />
              <span>Undo</span>
            </button>
            <span className="toast__timer" style={{ animationDuration: `${t.ms}ms` }} aria-hidden="true" />
          </>
        ) : (
          <button type="button" className="toast__close" aria-label="Close message" onClick={() => dismiss(t.id)}>
            <Icon name="x" size={18} />
          </button>
        )}
      </div>
    ));

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" ref={box}>
        <div aria-live="polite" className="toasts__group">
          {render((t) => t.tone !== "error")}
        </div>
        <div aria-live="assertive" className="toasts__group">
          {render((t) => t.tone === "error")}
        </div>
      </div>
    </Ctx.Provider>
  );
}

type Said = { tone: "success" | "error" | "info"; text: string; options: ToastOptions | undefined; at: number };

/**
 * One app's toasts while the shell hosts two (Clip Factory and Lamo Stories, docs/CONTRACTS.md §45.37): a toast its
 * app raises while it is hidden (a request that finished behind the other app) waits until that app is on screen
 * again, and is dropped when it is older by then than its own time on screen; the app's own error sound plays instead
 * of the shell's. Undo toasts go through at once: they come from the owner's own tap and hold a decision. Toasts the
 * shell itself raises (outside both apps) stay with the ToastProvider, global.
 */
export function ToastScope({ active, onScreen, onError, children }: { active: boolean; onScreen: () => boolean; onError: () => void; children: ReactNode }) {
  const parent = useToast();
  const held = useRef<Said[]>([]);
  const live = useRef({ onScreen, onError });
  live.current = { onScreen, onError };
  const api = useMemo<Toaster>(() => {
    const say =
      (tone: Said["tone"]) =>
      (text: string, options?: ToastOptions): void => {
        if (!live.current.onScreen()) {
          held.current.push({ tone, text, options, at: Date.now() });
          return;
        }
        parent[tone](text, { ...options, quiet: true });
        if (tone === "error") live.current.onError();
      };
    return { success: say("success"), error: say("error"), info: say("info"), undo: (text, options) => parent.undo(text, options) };
  }, [parent]);
  // Back on screen: what waited shows now, unless it would already have gone.
  useEffect(() => {
    if (!active) return;
    const now = Date.now();
    for (const h of held.current.splice(0)) {
      const life = h.options?.ms ?? (h.tone === "error" ? 7000 : 4200);
      if (now - h.at < life) api[h.tone](h.text, h.options);
    }
  }, [active, api]);
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
