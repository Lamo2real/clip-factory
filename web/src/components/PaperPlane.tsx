// The paper plane send button, and the small "fly off" motion system behind it (styles/fly.css).
//
// Any button can reuse the motion: call useLaunch(), call launch() when the thing really happens, and wrap the
// button's glyph in <Flight {...flight}>. The glyph lifts, tilts and flies off along --fly-x / --fly-y with a soft
// fading trail (FLIGHT_MS, ease-out), then a fresh one fades back in (RETURN_MS). With reduced motion it only fades.
// The motion is decoration: whatever the button does happens straight away, never after the animation.
import { useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type Ref } from "react";
import { prefersReducedMotion } from "../lib/prefs.ts";

export const FLIGHT_MS = 520;
export const RETURN_MS = 240;
/** The reduced-motion stand-in: a short fade of the same glyph. */
export const FADE_MS = 300;

/** "fly": the full flight. "fade": reduced motion. null: at rest. */
export type FlightMode = "fly" | "fade";

export interface FlightState {
  /** Bumped on every launch, so a second tap restarts the motion from the start. */
  shot: number;
  mode: FlightMode | null;
}

/** Starts the motion and puts the glyph back at rest when it is over. */
export function useLaunch(): FlightState & { launch: () => void } {
  const [state, setState] = useState<FlightState>({ shot: 0, mode: null });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const launch = useCallback(() => {
    const mode: FlightMode = prefersReducedMotion() ? "fade" : "fly";
    clearTimeout(timer.current);
    setState((s) => ({ shot: s.shot + 1, mode }));
    timer.current = setTimeout(() => setState((s) => ({ ...s, mode: null })), mode === "fly" ? FLIGHT_MS + RETURN_MS : FADE_MS);
  }, []);
  return { ...state, launch };
}

/** Wraps a glyph in the motion. Purely visual (aria-hidden): the button keeps its own name. */
export function Flight({ shot, mode, children }: FlightState & { children: ReactNode }) {
  const cls = mode === "fly" ? " is-flying" : mode === "fade" ? " is-fading" : "";
  return (
    <span className={`fly${cls}`} aria-hidden="true">
      {/* A new key restarts the CSS animation when it is launched again mid-flight. */}
      <span className="fly__item" key={shot}>
        {children}
      </span>
      {mode === "fly" ? <span className="fly__trail" key={`trail-${shot}`} /> : null}
    </span>
  );
}

/** A paper plane on the 24 px icon grid, in the same round 1.8 px strokes as Icon. */
export function PaperPlaneIcon({ size = 22 }: { size?: number }) {
  return (
    <svg
      className="icon paper-plane"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M20.5 3.5 3.6 10.4c-.6.2-.6 1 0 1.3l6.2 2.5 2.5 6.2c.3.6 1.1.6 1.3 0L20.5 3.5Z" />
      <path d="M20.5 3.5 9.8 14.2" />
    </svg>
  );
}

export interface PaperPlaneButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "disabled" | "children"> {
  flight: FlightState;
  /** aria-disabled, so it stays focusable and a tap on it plays the "deny" sound. */
  disabled?: boolean;
  /** Tomato when it is the screen's one main action, sage otherwise. */
  tone?: "primary" | "sage";
  ref?: Ref<HTMLButtonElement>;
}

/** An icon-only send button (44 px tap target): just the plane, named by its aria-label ("Send" by default). */
export function PaperPlaneButton({ flight, disabled = false, tone = "primary", className = "", onClick, type = "button", ...rest }: PaperPlaneButtonProps) {
  return (
    <button
      type={type}
      aria-label="Send"
      {...rest}
      className={`btn btn--sm fly-btn ${tone === "primary" ? "btn--primary" : "btn--glass fly-btn--sage"} ${className}`}
      aria-disabled={disabled || undefined}
      onClick={(e) => {
        if (disabled) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
    >
      <Flight shot={flight.shot} mode={flight.mode}>
        <PaperPlaneIcon />
      </Flight>
    </button>
  );
}
