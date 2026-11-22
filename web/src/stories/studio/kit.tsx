// The studio screens' small building blocks (docs/CONTRACTS.md §45.16.2): pick-one bars on <Glide> (the owner's
// sliding highlight), colour swatches, fields with counters, switches, sliders, chips, a modal sheet and the eased
// progress bar. Styled by web/src/stories/styles/studio.css. Sounds come from the app's global click handler: a
// switched-off control carries aria-disabled (so it plays the deny sound) and ignores the tap.
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Glide } from "../../components/Glide.tsx";
import { trapTab } from "../../components/Sheet.tsx";
import { centerOf, starBurst } from "../ui.tsx";
import { storiesSound } from "../prefs.ts";

export interface PickOption<T extends string> {
  value: T;
  label: string;
  /** One plain line under the label (big buttons). */
  line?: string;
  /** A small picture before the label. */
  art?: ReactNode;
}

/**
 * A pick-one bar: one radio per choice, the chosen one under the sliding highlight. `big` draws the choices as big
 * buttons (the four categories); `value` "" means nothing is chosen yet.
 */
export function Pick<T extends string>({
  label,
  value,
  options,
  onChange,
  big = false,
  hideLabel = false,
  className = "",
}: {
  label: string;
  value: T | "";
  options: PickOption<T>[];
  onChange: (v: T) => void;
  big?: boolean;
  hideLabel?: boolean;
  className?: string;
}) {
  const name = useId();
  return (
    <div className={`st-s-field${className ? ` ${className}` : ""}`}>
      <span className={hideLabel ? "st-s-sr" : "st-s-field__label"} id={`${name}-l`}>
        {label}
      </span>
      <div className={`st-s-pick${big ? " st-s-pick--big" : ""}`} role="radiogroup" aria-labelledby={`${name}-l`}>
        <Glide active=".st-s-pick__opt.is-on" />
        {options.map((o) => (
          <label key={o.value} className={`st-s-pick__opt${o.value === value ? " is-on" : ""}`}>
            <input type="radio" className="st-s-sr" name={name} value={o.value} checked={o.value === value} onChange={() => onChange(o.value)} />
            {o.art ? <span className="st-s-pick__art">{o.art}</span> : null}
            <span className="st-s-pick__text">
              <span className="st-s-pick__label">{o.label}</span>
              {o.line ? <span className="st-s-pick__line">{o.line}</span> : null}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

/** A pick-one row of colour swatches (skin, hair, outfit). Each swatch says its colour's name to screen readers. */
export function Swatches({
  label,
  value,
  colors,
  onChange,
}: {
  label: string;
  value: string;
  colors: { hex: string; name: string }[];
  onChange: (hex: string) => void;
}) {
  const name = useId();
  return (
    <div className="st-s-field">
      <span className="st-s-field__label" id={`${name}-l`}>
        {label}
      </span>
      <div className="st-s-swatches" role="radiogroup" aria-labelledby={`${name}-l`}>
        <Glide active=".st-s-swatch.is-on" />
        {colors.map((c) => (
          <label key={c.hex} className={`st-s-swatch${c.hex.toLowerCase() === value.toLowerCase() ? " is-on" : ""}`} title={c.name}>
            <input type="radio" className="st-s-sr" name={name} value={c.hex} checked={c.hex.toLowerCase() === value.toLowerCase()} onChange={() => onChange(c.hex)} />
            <span className="st-s-swatch__dot" style={{ background: c.hex }} aria-hidden="true" />
            <span className="st-s-sr">{c.name}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

/** A one-line text box with its label, a counter near the limit and a plain problem line. */
export function TextField({
  label,
  value,
  onChange,
  max,
  placeholder,
  problem,
  hint,
  multiline = false,
  rows = 3,
  id: given,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  max: number;
  placeholder?: string;
  problem?: string | null;
  hint?: string;
  multiline?: boolean;
  rows?: number;
  id?: string;
}) {
  const own = useId();
  const id = given ?? own;
  const over = value.length > max;
  const near = value.length >= max * 0.8;
  const describedBy = [problem || over ? `${id}-p` : "", hint ? `${id}-h` : "", near ? `${id}-c` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`st-s-field${problem || over ? " is-bad" : ""}`}>
      <label className="st-s-field__label" htmlFor={id}>
        {label}
      </label>
      {multiline ? (
        <textarea
          id={id}
          className="st-s-input st-s-input--area"
          rows={rows}
          value={value}
          placeholder={placeholder}
          aria-invalid={over || !!problem || undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          id={id}
          className="st-s-input"
          value={value}
          placeholder={placeholder}
          aria-invalid={over || !!problem || undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {hint ? (
        <span className="st-s-field__hint" id={`${id}-h`}>
          {hint}
        </span>
      ) : null}
      {near ? (
        <span className={`st-s-field__count${over ? " is-over" : ""}`} id={`${id}-c`}>
          {value.length} / {max}
        </span>
      ) : null}
      {problem || over ? (
        <span className="st-s-field__problem" id={`${id}-p`} role="alert">
          {problem ?? `That is ${value.length - max} letters too long.`}
        </span>
      ) : null}
    </div>
  );
}

/** An on/off switch with its words. */
export function Switch({
  label,
  checked,
  onChange,
  line,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  line?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="st-s-switch-row">
      <span className="st-s-switch-row__text">
        <span className="st-s-switch-row__label" id={`${id}-l`}>
          {label}
        </span>
        {line ? (
          <span className="st-s-switch-row__line" id={`${id}-d`}>
            {line}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        role="switch"
        className="st-s-switch"
        aria-checked={checked}
        aria-labelledby={`${id}-l`}
        aria-describedby={line ? `${id}-d` : undefined}
        aria-disabled={disabled || undefined}
        onClick={() => {
          if (!disabled) onChange(!checked);
        }}
      >
        <span className="st-s-switch__thumb" />
      </button>
    </div>
  );
}

/** A slider with its label and the value in words. */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  words,
  marks,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
  /** The value as the owner reads it ("45 seconds"). */
  words: string;
  /** A highlighted part of the track, e.g. the best length (30 to 60 s). */
  marks?: { from: number; to: number; label: string };
}) {
  const id = useId();
  const pct = (n: number) => ((n - min) / (max - min)) * 100;
  return (
    <div className="st-s-field st-s-slider">
      <span className="st-s-slider__top">
        <label className="st-s-field__label" htmlFor={id}>
          {label}
        </label>
        <output className="st-s-slider__value" htmlFor={id}>
          {words}
        </output>
      </span>
      <span className="st-s-slider__track">
        {marks ? (
          <span className="st-s-slider__mark" style={{ left: `${pct(marks.from)}%`, width: `${pct(marks.to) - pct(marks.from)}%` }} aria-hidden="true" />
        ) : null}
        <input
          id={id}
          type="range"
          className="st-s-range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-valuetext={words}
          aria-describedby={marks ? `${id}-m` : undefined}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </span>
      {marks ? (
        <span className="st-s-field__hint" id={`${id}-m`}>
          {marks.label}
        </span>
      ) : null}
    </div>
  );
}

/** A chip that turns on and off (several can be on: faces, noises, traits). */
export function Chip({
  on,
  onToggle,
  children,
  locked = false,
  lockedWhy,
}: {
  on: boolean;
  onToggle: () => void;
  children: ReactNode;
  /** Shown on but cannot be turned off (neutral is every character's face). */
  locked?: boolean;
  lockedWhy?: string;
}) {
  return (
    <button
      type="button"
      className={`st-s-chipbtn${on ? " is-on" : ""}`}
      aria-pressed={on}
      aria-disabled={locked || undefined}
      title={locked ? lockedWhy : undefined}
      onClick={() => {
        if (!locked) onToggle();
      }}
    >
      <span className="st-s-chipbtn__tick" aria-hidden="true">
        {on ? "✓" : "+"}
      </span>
      {children}
    </button>
  );
}

/** A small coloured status word. */
export function Tag({ tone = "plain", children }: { tone?: "sun" | "coral" | "mint" | "sky" | "plain"; children: ReactNode }) {
  return <span className={`st-s-tag st-s-tag--${tone}`}>{children}</span>;
}

/** The eased progress bar (fast in the middle, slow at the start and the end). */
export function ProgressBar({ value, label }: { value: number; label: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <span className="st-s-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <span className="st-s-progress__fill" style={{ width: `${pct}%` }} />
    </span>
  );
}

/** A turning circle for a short wait, with its words. */
export function Busy({ children }: { children: ReactNode }) {
  return (
    <p className="st-s-busy" role="status">
      <span className="st-s-busy__dot" aria-hidden="true" />
      {children}
    </p>
  );
}

/** A plain message: bad news is read out at once. */
export function Notice({ tone = "info", children, action }: { tone?: "info" | "bad" | "good"; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`st-s-notice st-s-notice--${tone}`} role={tone === "bad" ? "alert" : "status"}>
      <div className="st-s-notice__text">{children}</div>
      {action ? <div className="st-s-notice__action">{action}</div> : null}
    </div>
  );
}

/** Where a sheet is drawn: inside the Lamo Stories shell (its tokens and look), else on the page. */
function sheetHost(): HTMLElement {
  return (document.querySelector(".stories-app") as HTMLElement | null) ?? document.body;
}

/**
 * A modal sheet in the studio's look: focus moves in and comes back, Tab stays inside, Escape or a tap outside
 * closes it (the safe answer). Its buttons sit at the bottom right (on phones, at the bottom of the screen).
 */
export function StSheet({
  title,
  onClose,
  children,
  actions,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    box.current?.focus({ preventScroll: true });
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  function keys(e: KeyboardEvent<HTMLDivElement>) {
    // A sheet opened from this one is drawn elsewhere on the page but its keys still reach this one through React:
    // they are that sheet's own (its Tab stays in it).
    if (!box.current?.contains(e.target as Node)) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      closeRef.current();
      return;
    }
    trapTab(e, box.current);
  }

  return createPortal(
    <div className="st-s-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={box}
        className={`st-s-sheet${wide ? " st-s-sheet--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        tabIndex={-1}
        onKeyDown={keys}
      >
        <header className="st-s-sheet__head">
          <h2 className="st-s-sheet__title" id={`${id}-t`}>
            {title}
          </h2>
          <button type="button" className="st-s-iconbtn" aria-label="Close" onClick={onClose}>
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="st-s-sheet__body">{children}</div>
        {actions ? <footer className="st-s-sheet__actions">{actions}</footer> : null}
      </div>
    </div>,
    sheetHost(),
  );
}

/** A celebration: Lamo Stories' confetti from the button and the success cheer (it answers the owner's own tap). */
export function celebrate(from?: Element | null, amount = 110): void {
  starBurst(centerOf(from ?? null), amount);
  storiesSound("success");
}
