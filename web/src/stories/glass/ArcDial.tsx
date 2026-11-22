// An arc with a white knob at the value (the Setup progress ring, the studio's render progress). It is a progress
// bar to assistive tech (role="progressbar" with its value and words); the arc itself is decorative.
import type { ReactNode } from "react";
import { cx } from "./cx.ts";

export interface ArcDialProps {
  value: number;
  /** the value at a full arc (1 by default; 5 for five steps) */
  max?: number;
  /** what it shows ("Setup", "Making the video") */
  label: string;
  /** the value in words ("3 of 5 steps done"); a percentage when left out */
  valueText?: string;
  /** px; the --st-dial token (168) when left out */
  size?: number;
  /** how far round the arc goes, in degrees (240 by default: open at the bottom) */
  sweep?: number;
  /** what sits in the middle (a numeral, a word); the value as a percentage when left out */
  children?: ReactNode;
  className?: string;
}

const R = 42;

/** 0..1, safe for any input. */
export function dialFraction(value: number, max = 1): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(1, Math.max(0, value / max));
}

/** Where the knob sits for this fraction, in the 100 × 100 view box (0° is three o'clock, clockwise). */
export function knobAt(fraction: number, sweep = 240): { x: number; y: number } {
  const start = 90 + (360 - sweep) / 2;
  const a = ((start + sweep * fraction) * Math.PI) / 180;
  return { x: Math.round((50 + R * Math.cos(a)) * 100) / 100, y: Math.round((50 + R * Math.sin(a)) * 100) / 100 };
}

export function ArcDial({ value, max = 1, label, valueText, size, sweep = 240, children, className }: ArcDialProps) {
  const f = dialFraction(value, max);
  const pct = Math.round(f * 100);
  const start = 90 + (360 - sweep) / 2;
  const knob = knobAt(f, sweep);
  const style = size ? ({ "--st-dial-size": `${size}px` } as Record<string, string>) : undefined;
  return (
    <div
      className={cx("st-dial", className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(max, Math.max(0, value))}
      aria-valuetext={valueText ?? `${pct}%`}
      style={style}
    >
      <svg className="st-dial__svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        <circle className="st-dial__groove" cx="50" cy="50" r={R} pathLength={360} strokeDasharray={`${sweep} 360`} transform={`rotate(${start} 50 50)`} />
        <circle className="st-dial__arc" cx="50" cy="50" r={R} pathLength={360} strokeDasharray={`${sweep * f} 360`} transform={`rotate(${start} 50 50)`} />
        <circle className="st-dial__knob" cx={knob.x} cy={knob.y} r="6" />
      </svg>
      <div className="st-dial__centre">{children ?? <span className="st-dial__value">{pct}%</span>}</div>
    </div>
  );
}
