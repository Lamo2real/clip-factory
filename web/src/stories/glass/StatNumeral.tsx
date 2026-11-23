// A big light-weight numeral with a small unit, for the Dashboard's stats (videos made, posts, views).
import type { ReactNode } from "react";
import { cx } from "./cx.ts";

export interface StatNumeralProps {
  value: number | string;
  /** the small unit beside it ("%", "k", "videos") */
  unit?: string;
  /** what it counts, under it */
  label: ReactNode;
  /** a short warm line under the label ("+3 this week") */
  hint?: ReactNode;
  className?: string;
}

/** 1234 → "1,234"; strings are shown as they are. */
export function formatStat(value: number | string): string {
  return typeof value === "number" ? value.toLocaleString("en-GB") : value;
}

export function StatNumeral({ value, unit, label, hint, className }: StatNumeralProps) {
  return (
    <div className={cx("st-stat", className)}>
      <span className="st-stat__value">
        <span className="st-stat__num">{formatStat(value)}</span>
        {unit ? <span className="st-stat__unit">{unit}</span> : null}
      </span>
      <span className="st-stat__label">{label}</span>
      {hint ? <span className="st-stat__hint">{hint}</span> : null}
    </div>
  );
}
