// The orange toggle (a switch): orange track and white knob when on, a deep well when off.
import { cx } from "./cx.ts";

export interface GlassToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** its name for screen readers and the hover title */
  label: string;
  className?: string;
  id?: string;
}

export function GlassToggle({ checked, onChange, label, className, id }: GlassToggleProps) {
  return (
    <button type="button" role="switch" id={id} aria-checked={checked} aria-label={label} title={label} className={cx("st-toggle", className)} onClick={() => onChange(!checked)}>
      <span className="st-toggle__track" aria-hidden="true">
        <span className="st-toggle__knob" />
      </span>
    </button>
  );
}
