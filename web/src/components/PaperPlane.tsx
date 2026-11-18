// The paper plane send button (§19), on the shared action motion system (lib/motion.ts, docs/CONTRACTS.md §20).
//
// useLaunch() is the `send` kind of useAction with the names the help panel already uses: call launch() when the
// thing really happens and wrap the glyph in <Flight {...flight}>. The glyph lifts, tilts and flies off along
// --fly-x / --fly-y with a soft fading trail (FLIGHT_MS, ease-out), then a fresh one fades back in (RETURN_MS). With
// reduced motion it only fades. The motion is decoration: whatever the button does happens straight away.
import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { SEND_FADE_MS, SEND_FLIGHT_MS, SEND_RETURN_MS, useAction, type ActPhase } from "../lib/motion.ts";
import { ActGlyph, PaperPlaneIcon } from "./ui.tsx";

export { PaperPlaneIcon };

export const FLIGHT_MS = SEND_FLIGHT_MS;
export const RETURN_MS = SEND_RETURN_MS;
/** The reduced-motion stand-in: a short fade of the same glyph. */
export const FADE_MS = SEND_FADE_MS;

/** "fly": the full flight. "fade": reduced motion. null: at rest. */
export type FlightMode = "fly" | "fade";

export interface FlightState {
  /** Bumped on every launch, so a second tap restarts the motion from the start. */
  shot: number;
  mode: FlightMode | null;
}

/** Starts the motion and puts the glyph back at rest when it is over: a thin alias of useAction("send"). */
export function useLaunch(): FlightState & { launch: () => void } {
  const send = useAction("send");
  const mode: FlightMode | null = send.phase === "play" ? "fly" : send.phase === "fade" ? "fade" : null;
  return { shot: send.shot, mode, launch: send.play };
}

/** Wraps a glyph in the flight. Purely visual (aria-hidden): the button keeps its own name. */
export function Flight({ shot, mode, children }: FlightState & { children: ReactNode }) {
  const phase: ActPhase = mode === "fly" ? "play" : mode === "fade" ? "fade" : "idle";
  return (
    <ActGlyph act={{ kind: "send", shot, phase }} look="fly">
      {children}
    </ActGlyph>
  );
}

export interface PaperPlaneButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "disabled" | "children"> {
  flight: FlightState;
  /** aria-disabled, so it stays focusable and a tap on it plays the "deny" sound. */
  disabled?: boolean;
  /** `primary` when it is the screen's one main action, `action` otherwise. Both are the vermilion CTA. */
  tone?: "primary" | "action";
  ref?: Ref<HTMLButtonElement>;
}

/** An icon-only send button (44 px tap target): just the plane, named by its aria-label ("Send" by default). */
export function PaperPlaneButton({ flight, disabled = false, tone = "primary", className = "", onClick, type = "button", ...rest }: PaperPlaneButtonProps) {
  return (
    <button
      type={type}
      aria-label="Send"
      {...rest}
      className={`btn btn--sm fly-btn btn--${tone} ${className}`}
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
