// White rounded-square − and + around a value. Never disabled (a tap at the end says no with the deny sound,
// through onLimit); the value is read out when it changes.
import { cx } from "./cx.ts";

export interface StepperProps {
  value: number;
  onChange: (next: number) => void;
  /** what it sets ("Scenes at a time") */
  label: string;
  min?: number;
  max?: number;
  step?: number;
  /** how the value is shown ("3 scenes") */
  format?: (n: number) => string;
  /** a tap past min or max (play the deny sound here) */
  onLimit?: () => void;
  decreaseLabel?: string;
  increaseLabel?: string;
  className?: string;
}

export function Stepper({ value, onChange, label, min = -Infinity, max = Infinity, step = 1, format = String, onLimit, decreaseLabel = "Less", increaseLabel = "More", className }: StepperProps) {
  const go = (dir: -1 | 1) => {
    const next = value + dir * step;
    if (next < min || next > max) {
      onLimit?.();
      return;
    }
    onChange(next);
  };
  return (
    <div className={cx("st-stepper", className)} role="group" aria-label={label}>
      <button type="button" className="st-stepper__btn" aria-label={`${decreaseLabel}: ${label}`} aria-disabled={value - step < min ? true : undefined} onClick={() => go(-1)}>
        <span aria-hidden="true">−</span>
      </button>
      <output className="st-stepper__value" aria-live="polite">
        {format(value)}
      </output>
      <button type="button" className="st-stepper__btn" aria-label={`${increaseLabel}: ${label}`} aria-disabled={value + step > max ? true : undefined} onClick={() => go(1)}>
        <span aria-hidden="true">+</span>
      </button>
    </div>
  );
}
