// The action motion system (docs/CONTRACTS.md §20): one small animation on a button's glyph that shows what a tap
// just did (the plane flies, the plus pops, the bin tips). Decoration only: the button's handler always runs first,
// in the same click, and nothing ever waits for the motion. The keyframes live in styles/motion.css.
import { useCallback, useEffect, useRef, useState } from "react";
import type { IconName } from "../components/Icon.tsx";
import { prefersReducedMotion } from "./prefs.ts";
import { sounds } from "./sounds.ts";

export type ActionKind =
  | "send" | "keep" | "add" | "remove" | "delete" | "throw" | "clear" | "save" | "tick"
  | "upload" | "download" | "copy" | "paste" | "refresh" | "retry" | "undo"
  | "connect" | "disconnect" | "check" | "star" | "play" | "stop" | "next" | "prev"
  | "toggle" | "blink" | "nudge";

export type ActPhase = "idle" | "play" | "fade" | "fail" | "fail-fade" | "rewind";
export interface ActState {
  shot: number;
  phase: ActPhase;
}
export type ActEvent = "play" | "fail" | "rewind" | "end";

/** The send flight (§19), the one grandfathered exception to the token table. Re-exported by PaperPlane.tsx. */
export const SEND_FLIGHT_MS = 520;
export const SEND_RETURN_MS = 240;
/** The reduced-motion send fade: `--send-fade` in styles/motion.css and the fly-fade rules in fly.css (test/sendMotion.test.ts). */
export const SEND_FADE_MS = 300;

/** The action tokens, mirrored from styles/motion.css `:root` (a unit test keeps them in step). */
export const ACT_TOKENS = {
  "--act-press": 180,
  "--act-short": 360,
  "--act-mid": 480,
  "--act-long": 600,
  "--act-fail": 320,
  "--act-rewind": 360,
  "--act-fade": 240,
} as const;

export const ACT_FAIL_MS = ACT_TOKENS["--act-fail"];
export const ACT_REWIND_MS = ACT_TOKENS["--act-rewind"];
export const ACT_FADE_MS = ACT_TOKENS["--act-fade"];

/** How long each kind's full motion runs, end to end (§20.3). */
export const ACT_MS: Record<ActionKind, number> = {
  send: SEND_FLIGHT_MS + SEND_RETURN_MS,
  keep: 480,
  add: 360,
  remove: 300,
  delete: 480,
  throw: 520,
  clear: 300,
  save: 480,
  tick: 300,
  upload: 480,
  download: 480,
  copy: 360,
  paste: 360,
  refresh: 600,
  retry: 560,
  undo: 420,
  connect: 480,
  disconnect: 420,
  check: 600,
  star: 520,
  play: 480,
  stop: 420,
  next: 360,
  prev: 360,
  toggle: 180,
  blink: 180,
  nudge: 240,
};

/** The glyph a Button with `act` and no `icon` shows, so there is something to move. Send uses the paper plane. */
export const ACT_ICON: Partial<Record<ActionKind, IconName>> = {
  keep: "heart",
  add: "plus",
  remove: "minus",
  delete: "trash",
  throw: "trash",
  clear: "x",
  save: "check",
  tick: "check",
  upload: "upload",
  download: "download",
  copy: "copy",
  paste: "paste",
  refresh: "retry",
  retry: "retry",
  undo: "undo",
  connect: "link",
  disconnect: "logout",
  check: "checkCircle",
  star: "star",
  play: "volume",
  stop: "stop",
  next: "chevronRight",
  prev: "chevronLeft",
  blink: "eye",
  nudge: "chevronRight",
};

export const ACT_KINDS = Object.keys(ACT_MS) as ActionKind[];

/**
 * The pure state machine behind useAction. Every play, fail and rewind bumps `shot` so the glyph restarts from rest;
 * `reduced` turns play into fade, fail into fail-fade and rewind into fade (no movement at all).
 */
export function nextAct(s: ActState, e: ActEvent, reduced: boolean): ActState {
  switch (e) {
    case "play":
      return { shot: s.shot + 1, phase: reduced ? "fade" : "play" };
    case "fail":
      return { shot: s.shot + 1, phase: reduced ? "fail-fade" : "fail" };
    case "rewind":
      return { shot: s.shot + 1, phase: reduced ? "fade" : "rewind" };
    case "end":
      return s.phase === "idle" ? s : { shot: s.shot, phase: "idle" };
  }
}

/** How long a phase lasts before it returns to idle. */
export function phaseMs(kind: ActionKind, phase: ActPhase): number {
  switch (phase) {
    case "play":
      return ACT_MS[kind];
    case "fade":
      return kind === "send" ? SEND_FADE_MS : ACT_FADE_MS;
    case "fail":
      return ACT_FAIL_MS;
    case "fail-fade":
      return ACT_FADE_MS;
    case "rewind":
      return ACT_REWIND_MS;
    case "idle":
      return 0;
  }
}

export interface ActionHandle extends ActState {
  kind: ActionKind;
  /** Starts (or restarts) the motion. Never throws. */
  play(): void;
  /** The shared failure (§20.5): back to rest, a gentle vermilion shake, and the deny sound unless `sound: false`. */
  fail(opts?: { sound?: boolean }): void;
  /** Plays the motion backwards (§20.7), for Undo. */
  rewind(): void;
  /**
   * How many events (play, fail, rewind) this handle has had. Button reads it around the click handler: when the
   * handler already played, failed or rewound the handle itself, Button does not play over it (a refused Keep shakes).
   */
  events?(): number;
}

/**
 * One button's motion. Reads reduced motion (the setting or the OS) at each event, so the switch applies to the very
 * next tap. One timer per handle, cleared on every new event and on unmount: at most one animation at a time.
 */
export function useAction(kind: ActionKind): ActionHandle {
  const [state, setState] = useState<ActState>({ shot: 0, phase: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const count = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);

  const fire = useCallback((e: Exclude<ActEvent, "end">) => {
    count.current++;
    try {
      const reduced = prefersReducedMotion();
      // Worked out here, not inside the updater, so the timer matches the phase even under StrictMode.
      const phase = nextAct({ shot: 0, phase: "idle" }, e, reduced).phase;
      clearTimeout(timer.current);
      setState((s) => ({ shot: s.shot + 1, phase }));
      timer.current = setTimeout(() => setState((s) => nextAct(s, "end", reduced)), phaseMs(kind, phase));
    } catch {
      // Motion is decoration: it never breaks a tap.
    }
  }, [kind]);

  const play = useCallback(() => fire("play"), [fire]);
  const rewind = useCallback(() => fire("rewind"), [fire]);
  const fail = useCallback(
    (opts?: { sound?: boolean }) => {
      fire("fail");
      if (opts?.sound !== false) {
        try {
          sounds.play("deny");
        } catch {
          // No audio: the shake still says it.
        }
      }
    },
    [fire],
  );

  const events = useCallback(() => count.current, []);

  return { kind, shot: state.shot, phase: state.phase, play, fail, rewind, events };
}

/** Calls `onFail` when a click handler's result says the action failed: a promise that rejects or resolves to false. */
export function watchResult(result: unknown, onFail: () => void): void {
  if (!result || typeof (result as { then?: unknown }).then !== "function") return;
  (result as PromiseLike<unknown>).then(
    (v) => {
      if (v === false) onFail();
    },
    () => onFail(),
  );
}
