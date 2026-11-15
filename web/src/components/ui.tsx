import {
  useId,
  type AnchorHTMLAttributes,
  type Ref,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { navigate } from "../lib/router.ts";
import { Icon, type IconName } from "./Icon.tsx";

type Variant = "primary" | "glass" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

/** Sets the ripple origin for the CSS ripple and restarts it. Visual only; the sound comes from the click. */
function ripple(e: MouseEvent<HTMLElement>) {
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  const x = e.clientX ? e.clientX - r.left : r.width / 2;
  const y = e.clientY ? e.clientY - r.top : r.height / 2;
  el.style.setProperty("--rx", `${x}px`);
  el.style.setProperty("--ry", `${y}px`);
  el.classList.remove("is-rippling");
  void el.offsetWidth;
  el.classList.add("is-rippling");
}

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "disabled"> {
  variant?: Variant;
  size?: Size;
  icon?: IconName;
  iconAfter?: IconName;
  loading?: boolean;
  /** Rendered as aria-disabled so the button stays focusable, explains itself, and plays the "deny" sound. */
  disabled?: boolean;
  block?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = "glass",
  size = "md",
  icon,
  iconAfter,
  loading = false,
  disabled = false,
  block = false,
  className = "",
  children,
  onClick,
  type = "button",
  ...rest
}: ButtonProps) {
  const off = disabled || loading;
  return (
    <button
      type={type}
      className={`btn btn--${variant} btn--${size}${block ? " btn--block" : ""}${loading ? " is-loading" : ""} ${className}`}
      aria-disabled={off || undefined}
      aria-busy={loading || undefined}
      onClick={(e) => {
        if (off) {
          e.preventDefault();
          return;
        }
        ripple(e);
        onClick?.(e);
      }}
      {...rest}
    >
      {loading ? <span className="spinner" aria-hidden="true" /> : icon ? <Icon name={icon} size={size === "sm" ? 18 : 20} /> : null}
      {children ? <span className="btn__label">{children}</span> : null}
      {iconAfter && !loading ? <Icon name={iconAfter} size={size === "sm" ? 18 : 20} /> : null}
    </button>
  );
}

/** An in-app link: same-origin paths go through the router (with the page transition). */
export function A({ href, children, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        if (!href.startsWith("/")) return;
        e.preventDefault();
        navigate(href);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

export function LinkButton({
  href,
  variant = "glass",
  size = "md",
  icon,
  iconAfter,
  children,
  className = "",
  ...rest
}: { href: string; variant?: Variant; size?: Size; icon?: IconName; iconAfter?: IconName; children?: ReactNode } & Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
>) {
  return (
    <A href={href} className={`btn btn--${variant} btn--${size} ${className}`} onClick={ripple} {...rest}>
      {icon ? <Icon name={icon} size={size === "sm" ? 18 : 20} /> : null}
      {children ? <span className="btn__label">{children}</span> : null}
      {iconAfter ? <Icon name={iconAfter} size={size === "sm" ? 18 : 20} /> : null}
    </A>
  );
}

/** A word with the hand-drawn tomato underline from the brand. */
export function Swash({ children }: { children: ReactNode }) {
  return (
    <span className="swash">
      {children}
      <svg className="swash__line" viewBox="0 0 200 18" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <path d="M3 12.5C40 5.5 92 3.6 135 6.2c22 1.3 42 3.6 62 7.3" />
      </svg>
    </span>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="toggle-row">
      <div className="toggle-row__text">
        <span className="toggle-row__label" id={`${id}-l`}>
          {label}
        </span>
        {description ? (
          <span className="toggle-row__desc" id={`${id}-d`}>
            {description}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-l`}
        aria-describedby={description ? `${id}-d` : undefined}
        aria-disabled={disabled || undefined}
        onClick={() => {
          if (!disabled) onChange(!checked);
        }}
      >
        <span className="switch__thumb" />
      </button>
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  const name = useId();
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label key={o.value} className={`segmented__opt${o.value === value ? " is-on" : ""}`}>
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={o.value === value}
            onChange={() => onChange(o.value)}
          />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

export function Stepper({
  value,
  min,
  max,
  onChange,
  label,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  label: string;
}) {
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button
        type="button"
        className="stepper__btn"
        aria-label={`Fewer: ${label}`}
        aria-disabled={value <= min || undefined}
        onClick={() => value > min && onChange(value - 1)}
      >
        <Icon name="minus" size={18} />
      </button>
      <output className="stepper__value" aria-live="polite">
        {value}
      </output>
      <button
        type="button"
        className="stepper__btn"
        aria-label={`More: ${label}`}
        aria-disabled={value >= max || undefined}
        onClick={() => value < max && onChange(value + 1)}
      >
        <Icon name="plus" size={18} />
      </button>
    </div>
  );
}

export function Progress({ value, label, tone = "tomato" }: { value: number; label: string; tone?: "tomato" | "sage" }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div
      className={`progress progress--${tone}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <span className="progress__fill" style={{ inlineSize: `${pct}%` }} />
    </div>
  );
}

export type Tone = "neutral" | "sage" | "tomato" | "ink" | "warn";

export function Pill({ tone = "neutral", icon, children }: { tone?: Tone; icon?: IconName; children: ReactNode }) {
  return (
    <span className={`pill pill--${tone}`}>
      {icon ? <Icon name={icon} size={15} /> : null}
      <span className="pill__text">{children}</span>
    </span>
  );
}

export function Skeleton({ className = "", style }: { className?: string; style?: CSSProperties }) {
  return <span className={`skeleton ${className}`} style={style} aria-hidden="true" />;
}

export function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty glass">
      <span className="empty__icon">
        <Icon name={icon} size={26} />
      </span>
      <h3 className="empty__title">{title}</h3>
      {children ? <p className="empty__text">{children}</p> : null}
      {action ? <div className="empty__action">{action}</div> : null}
    </div>
  );
}

export function ErrorPanel({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-panel glass" role="alert">
      <Icon name="alert" />
      <p className="error-panel__text">{message}</p>
      {onRetry ? (
        <Button size="sm" icon="retry" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function PageHeader({ title, lede, actions }: { title: ReactNode; lede?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div className="page-head__text">
        <h1 className="page-head__title">{title}</h1>
        {lede ? <p className="page-head__lede">{lede}</p> : null}
      </div>
      {actions ? <div className="page-head__actions">{actions}</div> : null}
    </header>
  );
}
