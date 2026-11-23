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
  /** The class of the app that raised it (its ToastScope's `className`): Funded Clips' st-toast gives it its type. */
  className?: string;
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

type SayTone = "success" | "error" | "info";

/** A toast an app raised while it was not on screen, kept until it is (ToastScope, useToastWhen). */
interface Held {
  tone: SayTone;
  text: string;
  options: ToastOptions | undefined;
  /** When it was put aside (its own time on screen counts from here). */
  at: number;
  /** Its app is on screen now. */
  onScreen: () => boolean;
  /** Its app's own error sound when it shows (none: the provider's, or none at all when `quiet`). */
  onError?: () => void;
  /** Told the toast's id once it shows (its scope then takes it along if the app goes behind again). */
  shown?: (id: number, at: number) => void;
  /** Its app's class on the toast (ToastScope's `className`). */
  className?: string;
}

/** The provider's own handle for the apps' scopes: a toast's id, whether it is still up, and the toasts put aside. */
interface ToastHost {
  push(tone: SayTone, text: string, options?: ToastOptions, className?: string): number;
  /** An undo toast with its app's class on it. */
  undo(text: string, options: UndoOptions, className?: string): void;
  alive(id: number): boolean;
  dismiss(id: number): void;
  hold(h: Held): void;
  /** Shows every toast put aside whose app is on screen now, unless it waited longer than its own time on screen. */
  drain(): void;
}

const HostCtx = createContext<ToastHost | null>(null);

const lifeOf = (tone: ToastTone, options?: ToastOptions) => options?.ms ?? (tone === "error" ? 7000 : 4200);

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
    (tone: ToastTone, text: string, ms?: number, group?: string, icon?: IconName, quiet = false, className?: string): number => {
      const id = next.current++;
      const life = ms ?? (tone === "error" ? 7000 : 4200);
      setItems((all) => {
        // Never drop an undo toast that is still counting down: it holds a decision.
        const keep = all.filter((t) => t.tone === "undo" || (t.text !== text && (!group || t.group !== group)));
        const old = keep.filter((t) => t.tone !== "undo").slice(-2);
        const undos = keep.filter((t) => t.tone === "undo");
        const item: ToastItem = { id, tone, text, ms: life, ...(group ? { group } : {}), ...(icon ? { icon } : {}), ...(className ? { className } : {}) };
        return [...undos, ...old, item].sort((a, b) => a.id - b.id);
      });
      if (tone === "error" && !quiet) onErrorRef.current?.();
      if (tone !== "undo") setTimeout(() => dismiss(id), life);
      return id;
    },
    [dismiss],
  );

  const startUndo = useCallback(
    (text: string, options: UndoOptions, className?: string) => {
      const ms = options.ms ?? UNDO_MS;
      const id = push("undo", text, ms, undefined, options.icon, false, className);
      pending.current.set(id, { ...options, timer: setTimeout(() => commit(id), ms) });
      const signal = options.signal;
      if (signal?.aborted) drop(id);
      else signal?.addEventListener("abort", () => drop(id), { once: true });
    },
    [push, commit, drop],
  );

  const api = useMemo<Toaster>(
    () => ({
      success: (t, o) => void push("success", t, o?.ms, o?.group, undefined, o?.quiet),
      error: (t, o) => void push("error", t, o?.ms, o?.group, undefined, o?.quiet),
      info: (t, o) => void push("info", t, o?.ms, o?.group, undefined, o?.quiet),
      undo: (t, options) => startUndo(t, options),
    }),
    [push, startUndo],
  );

  // The toasts on screen now, for a scope asking whether one of its own is still up (an effect, after the render).
  const up = useRef<ToastItem[]>(items);
  useLayoutEffect(() => {
    up.current = items;
  }, [items]);
  const held = useRef<Held[]>([]);
  const host = useMemo<ToastHost>(
    () => ({
      push: (tone, text, o, className) => push(tone, text, o?.ms, o?.group, undefined, o?.quiet, className),
      undo: startUndo,
      alive: (id) => up.current.some((t) => t.id === id),
      dismiss,
      hold: (h) => void held.current.push(h),
      drain: () => {
        const now = Date.now();
        const wait: Held[] = [];
        for (const h of held.current.splice(0)) {
          if (!h.onScreen()) wait.push(h);
          else if (now - h.at < lifeOf(h.tone, h.options)) {
            const id = push(h.tone, h.text, h.options?.ms, h.options?.group, undefined, h.options?.quiet || !!h.onError, h.className);
            h.shown?.(id, now);
            if (h.tone === "error" && !h.options?.quiet) h.onError?.();
          }
        }
        held.current.push(...wait);
      },
    }),
    [push, dismiss, startUndo],
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
      <div key={t.id} className={`toast toast--${t.tone} glass${t.className ? ` ${t.className}` : ""}`}>
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
      <HostCtx.Provider value={host}>{children}</HostCtx.Provider>
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

function useHost(): ToastHost {
  const h = useContext(HostCtx);
  if (!h) throw new Error("useToast outside ToastProvider");
  return h;
}

/**
 * One app's toasts while the shell hosts two (Clip Factory and Lamo Stories, docs/CONTRACTS.md §45.38): a toast its
 * app raises while it is hidden (a request that finished behind the other app) waits until that app is on screen
 * again, and is dropped when it is older by then than its own time on screen; the app's own error sound plays instead
 * of the shell's. A toast of its own still up when the app goes behind the other one leaves the screen with it, and
 * comes back for the rest of its time if the app is back by then. Undo toasts go through at once and stay: they come
 * from the owner's own tap and hold a decision. Toasts the shell itself raises (outside both apps) stay with the
 * ToastProvider, global. `className` goes on every toast the app raises, undo ones too: the shell draws them all in
 * its own box, outside the app, so this is how an app's own type reaches its toasts (Funded Clips' st-toast: its
 * smaller-text font, docs/CONTRACTS.md §45.39), while every other toast keeps the shell's.
 */
export function ToastScope({
  active,
  onScreen,
  onError,
  className,
  children,
}: {
  active: boolean;
  onScreen: () => boolean;
  onError: () => void;
  className?: string;
  children: ReactNode;
}) {
  const host = useHost();
  const live = useRef({ onScreen, onError, className });
  live.current = { onScreen, onError, className };
  /** Its own toasts it put up, by id: when, and what (to put one aside if the app goes behind while it is up). */
  const mine = useRef(new Map<number, { at: number; tone: SayTone; text: string; options: ToastOptions | undefined }>());
  const api = useMemo<Toaster>(() => {
    const shown = () => live.current.onScreen();
    const sound = () => live.current.onError();
    /** One of its own is up now: remembered (and the ones whose time is over forgotten). */
    const keep = (tone: SayTone, text: string, options: ToastOptions | undefined) => (id: number, at: number) => {
      for (const [old, t] of mine.current) if (at - t.at >= lifeOf(t.tone, t.options)) mine.current.delete(old);
      mine.current.set(id, { at, tone, text, options });
    };
    const say =
      (tone: SayTone) =>
      (text: string, options?: ToastOptions): void => {
        const className = live.current.className;
        if (!shown()) {
          host.hold({ tone, text, options, at: Date.now(), onScreen: shown, onError: sound, shown: keep(tone, text, options), className });
          return;
        }
        keep(tone, text, options)(host.push(tone, text, { ...options, quiet: true }, className), Date.now());
        if (tone === "error" && !options?.quiet) sound();
      };
    return { success: say("success"), error: say("error"), info: say("info"), undo: (text, options) => host.undo(text, options, live.current.className) };
  }, [host]);
  useEffect(() => {
    // Back on screen: what waited shows now, unless it would already have gone.
    if (active) {
      host.drain();
      return;
    }
    // Gone behind the other app: its toasts still up go with it (their sound has played: they come back quiet).
    const now = Date.now();
    for (const [id, t] of mine.current) {
      if (!host.alive(id)) continue;
      host.dismiss(id);
      const left = lifeOf(t.tone, t.options) - (now - t.at);
      if (left <= 0) continue;
      const options = { ...t.options, ms: left, quiet: true };
      host.hold({
        tone: t.tone,
        text: t.text,
        options,
        at: now,
        onScreen: () => live.current.onScreen(),
        shown: (back, at) => mine.current.set(back, { at, tone: t.tone, text: t.text, options }),
        className: live.current.className,
      });
    }
    mine.current.clear();
  }, [active, host]);
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

/**
 * A toaster for an app's code that sits outside its pane (Clip Factory's session, above both apps): while
 * `onScreen()` is false its toasts wait, as a ToastScope's do, and show once that app's scope is on screen again.
 * While `onScreen()` is true (always, while Lamo Stories is switched off) it is exactly useToast().
 */
export function useToastWhen(onScreen: () => boolean): Toaster {
  const root = useToast();
  const host = useHost();
  const live = useRef(onScreen);
  live.current = onScreen;
  return useMemo<Toaster>(() => {
    const shown = () => live.current();
    const say =
      (tone: SayTone) =>
      (text: string, options?: ToastOptions): void => {
        if (shown()) root[tone](text, options);
        else host.hold({ tone, text, options, at: Date.now(), onScreen: shown });
      };
    return { success: say("success"), error: say("error"), info: say("info"), undo: (text, options) => root.undo(text, options) };
  }, [root, host]);
}
