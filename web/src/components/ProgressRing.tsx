// A round progress ring (sage on a pale track) with words in the middle: the posting setup's "2 of 5 ready" and
// each platform's progress (docs/CONTRACTS.md §17.1). It fills with a short ease unless motion is reduced (CSS).
import type { ReactNode } from "react";

export function ProgressRing({
  value,
  size = 64,
  stroke = 7,
  label,
  children,
  className = "",
}: {
  /** 0..1 */
  value: number;
  size?: number;
  stroke?: number;
  /** What the ring means, read out by screen readers ("YouTube: 7 of 12 steps done"). */
  label: string;
  children?: ReactNode;
  className?: string;
}) {
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const full = v >= 1;
  return (
    <span
      className={`ring${full ? " is-full" : ""} ${className}`}
      style={{ inlineSize: size, blockSize: size }}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
      data-full={full || undefined}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false">
        <circle className="ring__track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
        <circle
          className="ring__fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      {children ? <span className="ring__text">{children}</span> : null}
    </span>
  );
}
