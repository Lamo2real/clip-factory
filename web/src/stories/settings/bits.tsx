// Lamo Stories › Settings building blocks (docs/CONTRACTS.md §45.16.2, §45.29), styled by
// web/src/stories/styles/settings.css with Lamo Stories' own tokens: a card per setting, a pick-one bar on <Glide>
// (the owner's sliding highlight), a switch, a plain select, notes and chips, the star burst for a success, and the
// words and number formats the sections share. Builder F2 owns this folder. Click and deny sounds come from the app's
// global click handler (web/src/lib/sound.ts): a control that cannot be used is aria-disabled (it plays the deny
// sound), never `disabled` (that would swallow the click and its sound).
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Glide } from "../../components/Glide.tsx";
import { storiesBehind, storiesReduceMotion, storiesSound } from "../prefs.ts";
import type { Effort, ModelInfo, ProviderStatus } from "../api/types.ts";
import { EFFORT_LABEL, MODEL_STATUS_WORDS } from "../api/types.ts";

// ---------- Icons: Lamo Stories' chunky round strokes (no generic AI sparkle anywhere) ----------

const PATHS = {
  chip: "M8 4.5h8A3.5 3.5 0 0 1 19.5 8v8a3.5 3.5 0 0 1-3.5 3.5H8A3.5 3.5 0 0 1 4.5 16V8A3.5 3.5 0 0 1 8 4.5zM9.5 9.5h5v5h-5zM9 2v2.5M15 2v2.5M9 19.5V22M15 19.5V22M2 9h2.5M2 15h2.5M19.5 9H22M19.5 15H22",
  people: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.2A6.5 6.5 0 0 1 21.5 20",
  book: "M4.5 5.5A2 2 0 0 1 6.5 3.5h12v14h-12a2 2 0 0 0-2 2zM4.5 19.5a2 2 0 0 0 2 2h12v-4M8.5 7.5h6M8.5 11h4",
  note: "M6 3.5h9l4 4v13H6zM15 3.5v4h4M9 12h7M9 15.5h5",
  film: "M4 5.5h16v13H4zM4 9h16M4 15h16M8 5.5v13M16 5.5v13",
  box: "M4 8.5 12 4l8 4.5v7L12 20l-8-4.5zM4 8.5l8 4.5 8-4.5M12 13v7",
  plug: "M9 3v4M15 3v4M6.5 7h11v3.5a5.5 5.5 0 0 1-11 0zM12 16v5",
  check: "M5 12.5 9.5 17 19 7.5",
  alert: "M12 8.5v4.5M12 16.5h.01M10.3 4.4 2.9 17.4A2 2 0 0 0 4.6 20.4h14.8a2 2 0 0 0 1.7-3L13.7 4.4a2 2 0 0 0-3.4 0z",
  retry: "M4.5 12a7.5 7.5 0 1 0 2.3-5.4M4.5 4.5v4h4",
  plus: "M12 5v14M5 12h14",
  up: "M12 19V5M6 11l6-6 6 6",
  down: "M12 5v14M6 13l6 6 6-6",
  close: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  upload: "M12 16V4M7 8.5 12 4l4.5 4.5M5 15v4.5h14V15",
  pencil: "M4.5 19.5l1-4.5L15.5 5a2.1 2.1 0 0 1 3 3l-10 10zM13.5 7l3 3",
  trash: "M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5M14 11v5",
  clock: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 1 0 0-17zM12 7.5V12l3 2",
  key: "M14.5 9.5a4 4 0 1 1-8 0 4 4 0 0 1 8 0zM13.4 12.4 20 19M17 16l2-2M18.5 17.5l1.5-1.5",
  chevron: "M9 5.5l6.5 6.5L9 18.5",
  coin: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 1 0 0-17zM14.5 9a2.5 2 0 0 0-2.5-1.5c-1.4 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.9 2.5 2-1.1 2-2.5 2A2.5 2 0 0 1 9.5 15M12 6v1.5M12 16.5V18",
  brush: "M14 4.5l5.5 5.5-7 7-5.5-5.5zM7 11.5 4.5 14a3 3 0 0 0 4.2 4.2l2.5-2.5",
  sound: "M4.5 9.5h3l4.5-4v13l-4.5-4h-3zM16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11",
  ruler: "M4 15.5 15.5 4l4.5 4.5L8.5 20zM8 11.5l2 2M10.5 9l1.5 1.5M13 6.5l2 2",
} as const;

export type SIconName = keyof typeof PATHS;

export function SIcon({ name, size = 22 }: { name: SIconName; size?: number }) {
  return (
    <svg className="st-stg-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}

// ---------- A card for one setting: a smoky glass pane (.st-glass, the liquid-glass contract) ----------

export function SetCard({ title, icon, lede, actions, children, id, tone }: { title: string; icon: SIconName; lede?: ReactNode; actions?: ReactNode; children?: ReactNode; id?: string; tone?: Tone }) {
  const auto = useId();
  const head = `${id ?? auto}-h`;
  return (
    <section className={`st-glass st-stg-card${tone ? ` st-stg-card--${tone}` : ""}`} aria-labelledby={head} id={id}>
      <div className="st-stg-card__head">
        <span className={`st-stg-card__mark st-stg-card__mark--${tone ?? "sun"}`} aria-hidden="true">
          <SIcon name={icon} size={22} />
        </span>
        <div className="st-stg-card__titles">
          <h3 className="st-stg-card__title st-display" id={head}>
            {title}
          </h3>
          {lede ? <p className="st-stg-card__lede">{lede}</p> : null}
        </div>
        {actions ? <div className="st-stg-card__actions">{actions}</div> : null}
      </div>
      <SettingsCardProvider value={title}>{children}</SettingsCardProvider>
    </section>
  );
}

// ---------- Chips and notes ----------

export type Tone = "sun" | "coral" | "mint" | "sky";

export function Chip({ tone, children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`st-stg-chip${tone ? ` st-stg-chip--${tone}` : ""}`}>{children}</span>;
}

export function Note({ tone = "sky", icon, children, role }: { tone?: Tone; icon?: SIconName; children: ReactNode; role?: "alert" | "status" }) {
  return (
    <p className={`st-stg-note st-stg-note--${tone}`} role={role}>
      <SIcon name={icon ?? (tone === "coral" || tone === "sun" ? "alert" : "check")} size={20} />
      <span>{children}</span>
    </p>
  );
}

// ---------- Buttons ----------

export function Btn({
  main = false,
  quiet = false,
  danger = false,
  off,
  onClick,
  children,
  label,
  className = "",
  type = "button",
  small = false,
}: {
  main?: boolean;
  quiet?: boolean;
  danger?: boolean;
  /** Switched off: it stays clickable (the deny sound) but does nothing; the reason goes in the title. */
  off?: boolean | string;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
  label?: string;
  className?: string;
  type?: "button" | "submit";
  small?: boolean;
}) {
  const cls = ["st-btn", "st-stg-btn", main ? "st-btn--main st-stg-btn--main" : "", quiet ? "st-stg-btn--quiet" : "", danger ? "st-stg-btn--danger" : "", small ? "st-stg-btn--small" : "", className].filter(Boolean).join(" ");
  return (
    <button
      type={type}
      className={cls}
      aria-disabled={off ? true : undefined}
      aria-label={label}
      title={typeof off === "string" ? off : undefined}
      onClick={(e) => {
        if (off) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
    >
      {children}
    </button>
  );
}

// ---------- Pick one: a bar on <Glide> ----------

export interface PickOption<T extends string> {
  value: T;
  label: string;
  line?: ReactNode;
  chip?: ReactNode;
  /** Not offered: the option is shown (and says why) but cannot be picked. */
  off?: string;
}

/** A pick-one bar: the owner's sliding highlight behind the chosen option, one tap to choose, arrows to move. */
export function SetPick<T extends string>({
  label,
  value,
  options,
  onChange,
  stack = false,
  className = "",
}: {
  label: string;
  /** null: nothing chosen yet (the owner must pick) */
  value: T | null;
  options: PickOption<T>[];
  onChange: (v: T) => void;
  stack?: boolean;
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const usable = options.map((o, i) => (o.off ? -1 : i)).filter((i) => i >= 0);
  const current = options.findIndex((o) => o.value === value);
  const focusAt = current >= 0 ? current : (usable[0] ?? 0);
  const move = (e: KeyboardEvent<HTMLButtonElement>, from: number) => {
    const back = e.key === "ArrowLeft" || e.key === "ArrowUp";
    const fwd = e.key === "ArrowRight" || e.key === "ArrowDown";
    if (!back && !fwd) return;
    e.preventDefault();
    if (!usable.length) return;
    const at = usable.indexOf(from);
    const next = usable[(at + (fwd ? 1 : -1) + usable.length) % usable.length]!;
    refs.current[next]?.focus();
    onChange(options[next]!.value);
  };
  return (
    <div className={`st-stg-pick${stack ? " st-stg-pick--stack" : ""}${className ? ` ${className}` : ""}`} role="radiogroup" aria-label={label}>
      <Glide active=".st-stg-pick__opt.is-on" className="st-stg-glide" />
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-disabled={o.off ? true : undefined}
            tabIndex={i === focusAt ? 0 : -1}
            className={`st-stg-pick__opt${on ? " is-on" : ""}${o.off ? " is-off" : ""}`}
            onKeyDown={(e) => move(e, i)}
            onClick={() => {
              if (!o.off && !on) onChange(o.value);
            }}
          >
            <span className="st-stg-pick__top">
              <span className="st-stg-pick__label">{o.label}</span>
              {o.chip ? <span className="st-stg-pick__chip">{o.chip}</span> : null}
            </span>
            {o.line || o.off ? <span className="st-stg-pick__line">{o.off ?? o.line}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

// ---------- A switch ----------

export function SetSwitch({ checked, onChange, label, description, off, name }: { checked: boolean; onChange: (next: boolean) => void; label: string; description?: ReactNode; off?: string; /** the switch's own name when the visible label is short ("On") */ name?: string }) {
  const id = useId();
  return (
    <div className="st-stg-switchrow">
      <div className="st-stg-switchrow__text">
        <span className="st-stg-switchrow__label" id={`${id}-l`}>
          {label}
        </span>
        {description ? (
          <span className="st-stg-switchrow__desc" id={`${id}-d`}>
            {description}
          </span>
        ) : null}
      </div>
      {/* The shared orange toggle (.st-toggle from the figures: a 48 × 28 track, the white knob), with its On or Off
          word beside it inside the same target. */}
      <button
        type="button"
        role="switch"
        className="st-toggle st-stg-switch"
        aria-checked={checked}
        aria-label={name}
        aria-labelledby={name ? undefined : `${id}-l`}
        aria-describedby={description ? `${id}-d` : undefined}
        aria-disabled={off ? true : undefined}
        title={off}
        onClick={() => {
          if (!off) onChange(!checked);
        }}
      >
        <span className="st-stg-switch__word" aria-hidden="true">
          {checked ? "On" : "Off"}
        </span>
        <span className="st-toggle__track" aria-hidden="true">
          <span className="st-toggle__knob" />
        </span>
      </button>
    </div>
  );
}

// ---------- A plain select (for the long per-row lists; pick-one bars use SetPick) ----------

export function SetSelect({
  label,
  value,
  options,
  onChange,
  hideLabel = false,
  off,
  invalid = false,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  hideLabel?: boolean;
  off?: string;
  invalid?: boolean;
}) {
  const id = useId();
  return (
    <span className={`st-stg-selectbox${hideLabel ? " st-stg-selectbox--bare" : ""}`}>
      <label className={hideLabel ? "sr-only" : "st-stg-label"} htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className={`st-stg-select${invalid ? " is-invalid" : ""}`}
        value={value}
        aria-disabled={off ? true : undefined}
        aria-invalid={invalid || undefined}
        title={off}
        onChange={(e) => {
          if (!off) onChange(e.target.value);
        }}
        onMouseDown={(e) => {
          if (off) e.preventDefault();
        }}
        onKeyDown={(e) => {
          if (off && e.key !== "Tab") e.preventDefault();
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

// ---------- The bar under a section's head: its one-line note and the Saved mark ----------

/** Where the bar is drawn: inside the section head's plate (screens/Settings.tsx), so the words above the first card
 *  are one plate. Without one (a section on its own) the bar keeps its own plate where it stands. */
const SectionBarAt = createContext<HTMLElement | null>(null);
export const SectionBarSlot = SectionBarAt.Provider;

export function SectionBar({ children }: { children: ReactNode }) {
  const slot = useContext(SectionBarAt);
  return slot ? createPortal(<div className="st-stg-bar">{children}</div>, slot) : <div className="st-stg-bar st-plate">{children}</div>;
}

// ---------- A short "Saved" mark ----------

export function useSaved(): { saved: boolean; flash: () => void } {
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const flash = useCallback(() => {
    setSaved(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaved(false), 1800);
  }, []);
  return { saved, flash };
}

export function SavedMark({ saved, busy = false }: { saved: boolean; busy?: boolean }) {
  return (
    <span className={`st-stg-saved${saved ? " is-on" : ""}${busy ? " is-busy" : ""}`} role="status" aria-live="polite">
      {busy ? "Saving…" : saved ? (
        <>
          <SIcon name="check" size={18} />
          Saved
        </>
      ) : null}
    </span>
  );
}

/** An eased progress bar (never a bare spinner). `value` null: waiting, with a gentle sweep. */
export function Progress({ value, label }: { value: number | null; label: string }) {
  const pct = value === null ? null : Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="st-stg-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
      <span className={`st-stg-progress__fill${pct === null ? " is-waiting" : ""}`} style={pct === null ? undefined : { width: `${pct}%` }} />
    </div>
  );
}

// ---------- A success: a burst of stars and the cheer ----------

/** The warm palette's (glass-tokens.css): the orange accent, amber, coral, mint, sky and cream. */
const STAR_COLOURS = ["#FF8A3D", "#FFB766", "#FF7F6A", "#6FD9A4", "#7CC6E6", "#FFF3E4"];

/** A short star burst from the element that was tapped (or the middle of the page), with the success cheer. */
export function cheer(from?: Element | null): void {
  storiesSound("success");
  if (storiesBehind() || storiesReduceMotion() || typeof document === "undefined") return;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext?.("2d");
  if (!ctx) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = window.innerWidth;
  const H = window.innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.className = "confetti st-stg-burst";
  canvas.setAttribute("aria-hidden", "true");
  document.body.appendChild(canvas);
  ctx.scale(dpr, dpr);
  const r = from?.getBoundingClientRect();
  const ox = r ? r.left + r.width / 2 : W / 2;
  const oy = r ? r.top + r.height / 2 : H / 3;
  const stars = Array.from({ length: 36 }, (_, i) => {
    const a = (i / 36) * Math.PI * 2 + Math.random() * 0.3;
    const v = 3 + Math.random() * 5;
    return { x: ox, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 2, r: 4 + Math.random() * 4, spin: Math.random() * Math.PI, color: STAR_COLOURS[i % STAR_COLOURS.length]! };
  });
  const start = performance.now();
  const LIFE = 1200;
  const tick = (now: number) => {
    const t = now - start;
    ctx.clearRect(0, 0, W, H);
    for (const s of stars) {
      s.vy += 0.15;
      s.vx *= 0.985;
      s.x += s.vx;
      s.y += s.vy;
      s.spin += 0.08;
      ctx.globalAlpha = Math.max(0, 1 - t / LIFE);
      ctx.fillStyle = s.color;
      ctx.beginPath();
      for (let k = 0; k < 10; k++) {
        const rad = k % 2 === 0 ? s.r : s.r * 0.45;
        const ang = s.spin + (k * Math.PI) / 5;
        ctx.lineTo(s.x + Math.cos(ang) * rad, s.y + Math.sin(ang) * rad);
      }
      ctx.closePath();
      ctx.fill();
    }
    if (t < LIFE) requestAnimationFrame(tick);
    else canvas.remove();
  };
  requestAnimationFrame(tick);
}

// ---------- Empty states: a little character, never a blank box ----------

export function Buddy({ mood = "wave", size = 96 }: { mood?: "wave" | "think" | "sleepy"; size?: number }) {
  // Its colours come from settings.css (.st-stg-buddy__*), in the warm palette's tokens.
  return (
    <svg className={`st-stg-buddy st-stg-buddy--${mood}`} width={size} height={size} viewBox="0 0 120 120" aria-hidden="true" focusable="false">
      <ellipse className="st-stg-buddy__shadow" cx="60" cy="110" rx="28" ry="5" opacity="0.45" />
      <path className="st-stg-buddy__body" d="M60 20c19 0 30 17 30 42s-11 42-30 42-30-17-30-42 11-42 30-42z" />
      {mood === "sleepy" ? (
        <path className="st-stg-buddy__line" d="M45 56q5 4 10 0M65 56q5 4 10 0" strokeWidth="3.2" strokeLinecap="round" fill="none" />
      ) : (
        <>
          <ellipse className="st-stg-buddy__eye" cx="50" cy="55" rx="5" ry="6.5" />
          <ellipse className="st-stg-buddy__eye" cx="70" cy="55" rx="5" ry="6.5" />
          <circle className="st-stg-buddy__shine" cx="52" cy="52.5" r="1.7" />
          <circle className="st-stg-buddy__shine" cx="72" cy="52.5" r="1.7" />
        </>
      )}
      <circle className="st-stg-buddy__cheek" cx="42" cy="67" r="4.5" opacity="0.5" />
      <circle className="st-stg-buddy__cheek" cx="78" cy="67" r="4.5" opacity="0.5" />
      {mood === "think" ? (
        <path className="st-stg-buddy__line" d="M53 73h14" strokeWidth="3.4" strokeLinecap="round" />
      ) : (
        <path className="st-stg-buddy__line" d="M50 69q10 10 20 0" strokeWidth="3.4" strokeLinecap="round" fill="none" />
      )}
      <path className={`st-stg-buddy__limb${mood === "wave" ? " st-stg-buddy__arm" : ""}`} d="M88 66 102 50" strokeWidth="9" strokeLinecap="round" />
      <path className="st-stg-buddy__limb" d="M32 70 22 84" strokeWidth="9" strokeLinecap="round" />
    </svg>
  );
}

export function Empty({ title, children, mood = "wave", action }: { title: string; children?: ReactNode; mood?: "wave" | "think" | "sleepy"; action?: ReactNode }) {
  return (
    <div className="st-stg-empty">
      <Buddy mood={mood} size={88} />
      <p className="st-stg-empty__title">{title}</p>
      {children ? <p className="st-stg-empty__text">{children}</p> : null}
      {action ? <div className="st-stg-empty__action">{action}</div> : null}
    </div>
  );
}

export function Loading({ label = "Getting it ready…" }: { label?: string }) {
  return (
    <div className="st-stg-loading" role="status">
      <Buddy mood="think" size={64} />
      <span>{label}</span>
    </div>
  );
}

export function Failed({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="st-stg-failed" role="alert">
      <p>{message}</p>
      {onRetry ? (
        <Btn main onClick={onRetry}>
          <SIcon name="retry" size={20} />
          Try again
        </Btn>
      ) : null}
    </div>
  );
}

// ---------- Words ----------

/** The Settings page on screen, by the name sentences use for it ("AI", "Video", …); null outside Settings. */
export type SettingsPageName = "AI" | "Agents" | "Skills" | "Memory" | "Video" | "Storage";
const SettingsPage = createContext<SettingsPageName | null>(null);
export const SettingsPageProvider = SettingsPage.Provider;
/** The card (its title) a sentence shows in, for onThisPage's "above" and "below"; SetCard gives it. */
const SettingsCard = createContext<string | null>(null);
export const SettingsCardProvider = SettingsCard.Provider;

const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Each Settings page's cards from top to bottom (their titles), so a sentence can say "above" or "below". */
const CARDS: Partial<Record<SettingsPageName, readonly string[]>> = {
  AI: ["Default model", "Default effort", "Add a model", "Each agent and each task", "Usage and cost, last 30 days", "Prices", "Providers"],
  Video: ["Video maker", "Picture maker", "Sound maker", "Shape and size", "Usual length", "Quality", "Words and music", "Use and costs, last 30 days", "Prices and keys"],
};
/** A model's own row (inside Add a model), as the place a sentence shows in. */
export const ITS_ROW = "its row";
/** The parts a sentence may name after the page ("Settings › Video › Picture maker"), and the card each is in. */
const NAMED: Partial<Record<SettingsPageName, Record<string, string>>> = {
  AI: { [ITS_ROW]: "Add a model", "Add a model": "Add a model", "Check models": "Default model" },
  Video: { "Picture maker": "Picture maker", "Video maker": "Video maker", "Nova Reel": "Video maker", "Sound maker": "Sound maker" },
};
/** What a sentence points at when it names no part, by the words just before the page ("the task … in Settings › AI"). */
const POINTED: Partial<Record<SettingsPageName, [RegExp, string][]>> = {
  AI: [
    [/\bthe task\b[^.!?]*$/, "Each agent and each task"],
    [/\bthe default model$/, "Default model"],
    [/\bCheck models$/, "Default model"],
  ],
  Video: [[/\bBuilt-in animation$/, "Video maker"]],
};
const PAGE_WORDS: Record<SettingsPageName, string> = { AI: "AI", Agents: "Agents", Skills: "Skills", Memory: "Memory", Video: "Video", Storage: "Storage(?: and production)?" };

/**
 * A sentence shown on the page it sends the owner to, without the trip (§45.36 E17). `from` is the card the sentence
 * shows in (ITS_ROW: a model's own row). The place it points at is said "above" or "below" from there, "this row"
 * inside the row it means, "here" inside the card it names; when either is not known, the part's name alone, or
 * `word` ("on this page"). On Settings › Video, "Pick Built-in animation in Settings › Video, or finish its setup." in
 * the Video maker card reads "Pick Built-in animation above, or finish its setup."; on Settings › AI, "Tap Edit on its
 * row in Lamo Stories › Settings › AI and turn off …" reads "Tap Edit on its row below and turn off …" in Default
 * model and "Tap Edit on this row and turn off …" in the row itself. Any other page's name stays as it is.
 */
export function onThisPage(text: string, page: SettingsPageName | null, from: string | null = null, word = "on this page"): string {
  if (!page || !text) return text;
  const named = NAMED[page] ?? {};
  const names = Object.keys(named).map(escape).join("|");
  // Only a part's own name is taken after the page, never the rest of the sentence ("› Picture maker to use it").
  const part = names ? `(?:\\s*›\\s*(${names})(?![A-Za-z]))?` : "()";
  const re = new RegExp(`(\\bits row)?\\s+(?:in|on)\\s+(?:Lamo Stories\\s*›\\s*)?Settings\\s*›\\s*${PAGE_WORDS[page]}(?![A-Za-z])${part}`, "g");
  const order = CARDS[page] ?? [];
  const place = (card: string | null) => (card === ITS_ROW ? order.indexOf("Add a model") : card ? order.indexOf(card) : -1);
  const at = place(from);
  return text.replace(re, (_all: string, row: string | undefined, name: string | undefined, offset: number) => {
    // "on its row in Settings › AI" said in that row: "on this row".
    if (row && from === ITS_ROW) return "this row";
    const target = row ? ITS_ROW : (name ?? POINTED[page]?.find(([pattern]) => pattern.test(text.slice(0, offset)))?.[1] ?? null);
    if (name === ITS_ROW && from === ITS_ROW) return " in this row";
    // Said in the very card it names: "Pick it here".
    if (name && name === from) return " here";
    const to = place(target && target !== ITS_ROW ? (named[target] ?? target) : target);
    const way = at < 0 || to < 0 ? null : to > at ? "below" : "above";
    if (row) return way ? `${row} ${way}` : row;
    if (name) return way ? ` in ${name} ${way}` : ` in ${name}`;
    return ` ${way ?? word}`;
  });
}

/** onThisPage for the Settings page on screen, said from the card it shows in (`from`, else the card around it). */
export function useOnThisPage(from?: string): (text: string, word?: string) => string {
  const page = useContext(SettingsPage);
  const card = useContext(SettingsCard);
  const at = from ?? card;
  return useCallback((text: string, word?: string) => onThisPage(text, page, at, word), [page, at]);
}

/** A model's state: the one set of words every screen uses (MODEL_STATUS_WORDS, §45.36 E17), with its tone. */
export const MODEL_STATUS: Record<ModelInfo["status"], { label: string; tone: Tone }> = {
  ok: { label: MODEL_STATUS_WORDS.ok, tone: "mint" },
  not_checked: { label: MODEL_STATUS_WORDS.not_checked, tone: "sky" },
  denied: { label: MODEL_STATUS_WORDS.denied, tone: "coral" },
  not_found: { label: MODEL_STATUS_WORDS.not_found, tone: "coral" },
  error: { label: MODEL_STATUS_WORDS.error, tone: "sun" },
};

export const PROVIDER_STATE: Record<ProviderStatus["state"], { label: string; tone: Tone }> = {
  on: { label: "Working", tone: "mint" },
  off: { label: "Off", tone: "sky" },
  needs_setup: { label: "Not ready yet", tone: "sun" },
  unavailable: { label: "Not available yet", tone: "coral" },
};

/**
 * Who makes a model and who runs it (§45.35 D8): "Anthropic on Amazon Bedrock", "Mistral on Amazon Bedrock"; just the
 * one name while they are the same (an older model list named Amazon Bedrock as the maker too).
 */
export function madeBy(m: Pick<ModelInfo, "provider" | "host">): string {
  const maker = m.provider.trim();
  const host = m.host?.trim() ?? "";
  if (!host || host.toLowerCase() === maker.toLowerCase()) return maker || host;
  return maker ? `${maker} on ${host}` : host;
}

/** A model's status in a few words, for the end of a select option ("Claude Fable 5.1 · no access"). */
export function statusSuffix(m: ModelInfo): string {
  return m.status === "ok" ? "" : ` · ${MODEL_STATUS[m.status].label.toLowerCase()}`;
}

export function effortWord(e: Effort | null | undefined): string {
  return e ? EFFORT_LABEL[e] : "its own level";
}

/** "Claude Fable 5.1 isn't available right now: …" when the last call was refused; null when it worked or was never tried. */
export function refusedLine(m: ModelInfo | undefined): string | null {
  if (!m || m.status === "ok" || m.status === "not_checked") return null;
  return `${m.label} said no last time: ${m.statusLine} Work that uses it stops and tells you; it never switches to another model by itself.`;
}

// ---------- Numbers ----------

export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function money(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: n > 0 && n < 0.1 ? 3 : 2 }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

export function sizeText(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return n ? `${n} bytes` : "nothing";
}

export function whenText(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "";
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return d === 1 ? "yesterday" : `${d} days ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function dayLabel(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}
