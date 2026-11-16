import {
  useId,
  useState,
  type AnchorHTMLAttributes,
  type Ref,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { ACT_ICON, useAction, watchResult, type ActionHandle, type ActionKind } from "../lib/motion.ts";
import { Glide } from "./Glide.tsx";
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

/** A paper plane on the 24 px icon grid, in the same round 1.8 px strokes as Icon (the `send` glyph, §19). */
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

/** What ActGlyph needs from a handle (PaperPlane's Flight passes its own). */
export type ActGlyphState = Pick<ActionHandle, "kind" | "shot" | "phase">;

/**
 * Wraps a glyph in its action motion (docs/CONTRACTS.md §20.2): aria-hidden and pointer-events: none, so the
 * button keeps its own name and a second tap still hits the button. The inner element is keyed by `shot`, so a new
 * play restarts the motion instead of queuing one. `look="fly"` is the paper plane's original DOM (§19).
 */
export function ActGlyph({ act, children, look = "act" }: { act: ActGlyphState; children: ReactNode; look?: "act" | "fly" }) {
  if (look === "fly") {
    const flying = act.phase === "play";
    const cls = flying ? " is-flying" : act.phase === "fade" ? " is-fading" : "";
    return (
      <span className={`fly${cls}`} aria-hidden="true">
        <span className="fly__item" key={act.shot}>
          {children}
        </span>
        {flying ? <span className="fly__trail" key={`trail-${act.shot}`} /> : null}
      </span>
    );
  }
  return (
    <span className={`act act--${act.kind} is-${act.phase}`} aria-hidden="true">
      <span className="act__item" key={act.shot}>
        {children}
      </span>
      {act.kind === "send" && act.phase === "play" ? <span className="act__trail" key={`trail-${act.shot}`} /> : null}
    </span>
  );
}

/** The glyph a button with `act` shows: its own icon, else the kind's default (the plane for send). */
function actGlyph(kind: ActionKind, icon: IconName | undefined, size: number) {
  const name = icon ?? ACT_ICON[kind];
  if (name) return <Icon name={name} size={size} />;
  return kind === "send" ? <PaperPlaneIcon size={size} /> : null;
}

/**
 * The label, or for `toggle` (which moves the words, not a glyph, §20.3) the label in its bump wrapper. The words stay
 * readable to screen readers: this wrapper is not aria-hidden.
 */
function actLabel(handle: ActionHandle | null, children: ReactNode) {
  if (!children) return null;
  if (handle?.kind !== "toggle") return <span className="btn__label">{children}</span>;
  return (
    <span className={`btn__label act act--toggle act--text is-${handle.phase}`}>
      <span className="act__item" key={handle.shot}>
        {children}
      </span>
    </span>
  );
}

/** `act="keep"` (Button makes its own handle) or a handle from useAction when the screen calls fail() / rewind(). */
export type ActProp = ActionKind | ActionHandle;

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "disabled" | "onClick"> {
  variant?: Variant;
  size?: Size;
  icon?: IconName;
  iconAfter?: IconName;
  loading?: boolean;
  /** Rendered as aria-disabled so the button stays focusable, explains itself, and plays the "deny" sound. */
  disabled?: boolean;
  block?: boolean;
  ref?: Ref<HTMLButtonElement>;
  /**
   * The action motion (§20). The handler runs first; the motion starts in the same tick. A handler that returns a
   * promise which rejects or resolves to false plays the failure instead.
   */
  act?: ActProp;
  /** May return a promise: rejecting or resolving to false plays `act`'s failure (§20.5). */
  onClick?: (e: MouseEvent<HTMLButtonElement>) => unknown;
  /**
   * false: the tap does not play `act` (the screen plays it later, e.g. when a picked file arrives or a keep really
   * starts). The glyph, `data-act` and the failure on a rejected promise stay.
   */
  playOnClick?: boolean;
}

/** Button's and LinkButton's motion: a handle from `act`, or none. Always calls the hook (hooks never vary). */
function useActProp(act: ActProp | undefined): ActionHandle | null {
  const own = useAction(typeof act === "string" ? act : "toggle");
  if (!act) return null;
  return typeof act === "string" ? own : act;
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
  act,
  playOnClick = true,
  type = "button",
  ...rest
}: ButtonProps) {
  const off = disabled || loading;
  const handle = useActProp(act);
  const px = size === "sm" ? 18 : 20;
  // The spinner waits for the current motion to end, so a quick request does not cut it off (a picture, not the action).
  const spin = loading && (!handle || handle.phase === "idle");
  const glyph = handle ? actGlyph(handle.kind, icon, px) : icon ? <Icon name={icon} size={px} /> : null;
  return (
    <button
      type={type}
      className={`btn btn--${variant} btn--${size}${block ? " btn--block" : ""}${loading ? " is-loading" : ""} ${className}`}
      aria-disabled={off || undefined}
      aria-busy={loading || undefined}
      data-act={handle?.kind}
      onClick={(e) => {
        if (off) {
          e.preventDefault();
          return;
        }
        ripple(e);
        // §20.4: the action first, synchronously; the motion after it in the same tick; nothing waits.
        let result: unknown;
        const before = handle?.events?.();
        try {
          result = onClick?.(e);
        } catch (err) {
          handle?.fail();
          throw err;
        }
        if (handle) {
          // A handler that already played, failed or rewound the handle itself wins (a refused Keep only shakes).
          if (playOnClick && handle.events?.() === before) handle.play();
          watchResult(result, () => handle.fail());
        }
      }}
      {...rest}
    >
      {spin ? <span className="spinner" aria-hidden="true" /> : handle && glyph && handle.kind !== "toggle" ? <ActGlyph act={handle}>{glyph}</ActGlyph> : glyph}
      {actLabel(handle, children)}
      {iconAfter && !loading ? <Icon name={iconAfter} size={px} /> : null}
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
  act,
  onClick,
  ...rest
}: {
  href: string;
  variant?: Variant;
  size?: Size;
  icon?: IconName;
  iconAfter?: IconName;
  children?: ReactNode;
  /** The action motion (§20), played after the link's own click (which may navigate straight away). */
  act?: ActProp;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const handle = useActProp(act);
  const px = size === "sm" ? 18 : 20;
  const glyph = handle ? actGlyph(handle.kind, icon, px) : icon ? <Icon name={icon} size={px} /> : null;
  return (
    <A
      href={href}
      className={`btn btn--${variant} btn--${size} ${className}`}
      data-act={handle?.kind}
      onClick={(e) => {
        ripple(e);
        onClick?.(e);
        handle?.play();
      }}
      {...rest}
    >
      {handle && glyph && handle.kind !== "toggle" ? <ActGlyph act={handle}>{glyph}</ActGlyph> : glyph}
      {actLabel(handle, children)}
      {iconAfter ? <Icon name={iconAfter} size={px} /> : null}
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
        data-help-dodge=""
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
  /** `help` puts a data-help anchor on the option (Ask Clip Factory spotlights it, docs/CONTRACTS.md §19.8). */
  options: { value: T; label: string; help?: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  const name = useId();
  // §20.11: the newly chosen option's label bumps (`toggle`). The label stays readable: it is not aria-hidden.
  const bump = useAction("toggle");
  return (
    <div className="segmented" role="radiogroup" aria-label={label} data-help-dodge="">
      <Glide active=".segmented__opt.is-on" />
      {options.map((o) => (
        <label key={o.value} className={`segmented__opt${o.value === value ? " is-on" : ""}`} data-help={o.help}>
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={o.value === value}
            onChange={() => {
              onChange(o.value);
              bump.play();
            }}
          />
          {o.value === value ? (
            <span className={`act act--toggle act--text is-${bump.phase}`}>
              <span className="act__item" key={bump.shot}>
                {o.label}
              </span>
            </span>
          ) : (
            <span>{o.label}</span>
          )}
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
  const fewer = useAction("remove");
  const more = useAction("add");
  // The number bumps the way it moved (§20.11). A new key restarts the one-shot CSS animation; none on first render.
  const [bump, setBump] = useState<{ n: number; dir: "up" | "down" } | null>(null);
  const step = (dir: "up" | "down") => {
    const atEdge = dir === "up" ? value >= max : value <= min;
    if (atEdge) return;
    onChange(dir === "up" ? value + 1 : value - 1);
    (dir === "up" ? more : fewer).play();
    setBump((b) => ({ n: (b?.n ?? 0) + 1, dir }));
  };
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button
        type="button"
        className="stepper__btn"
        aria-label={`Fewer: ${label}`}
        aria-disabled={value <= min || undefined}
        data-act="remove"
        onClick={() => step("down")}
      >
        <ActGlyph act={fewer}>
          <Icon name="minus" size={18} />
        </ActGlyph>
      </button>
      <output className="stepper__value" aria-live="polite">
        <span className={bump ? `stepper__num is-${bump.dir}` : "stepper__num"} key={bump?.n ?? 0}>
          {value}
        </span>
      </output>
      <button
        type="button"
        className="stepper__btn"
        aria-label={`More: ${label}`}
        aria-disabled={value >= max || undefined}
        data-act="add"
        onClick={() => step("up")}
      >
        <ActGlyph act={more}>
          <Icon name="plus" size={18} />
        </ActGlyph>
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
        <Button size="sm" icon="retry" act="retry" onClick={onRetry}>
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
