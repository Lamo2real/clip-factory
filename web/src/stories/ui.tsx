// Lamo Stories building blocks (docs/CONTRACTS.md §45.16.2), styled by web/src/stories/styles/st-parts.css and
// st-controls.css on the liquid-glass recipe (styles/GLASS-CONTRACT.md): buttons, glass cards, chips, a pick-one bar on
// <Glide>, the orange switch, the Lamo Stories icons, the character-shaped empty states, the star burst for a success,
// and the shared dashboard poll behind the Needs you bar. The shell builder owns this file; the screens use these
// pieces and add screen-level ones in their own files. Click and deny sounds come from the app's global
// click handler (web/src/lib/sound.ts): nothing here plays a tap sound itself. Every sound and calm-motion check here
// follows Lamo Stories' own device preferences (stories/prefs.ts: storiesSound, storiesReduceMotion).
import { Component, useEffect, useId, useState, useSyncExternalStore, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ErrorInfo, type ReactNode } from "react";
import { friendlyMessage } from "../api/errors.ts";
import { A } from "../components/ui.tsx";
import { Glide } from "../components/Glide.tsx";
import { usePoll } from "../lib/hooks.ts";
import { storiesApi } from "./api/client.ts";
import { RoundGlassButton } from "./glass/index.ts";
import { storiesBehind, useAppActive } from "./pane.tsx";
import { storiesReduceMotion, storiesSound } from "./prefs.ts";
import type { Onboarding, Platform, StoriesDashboard, Story, StoryStatus } from "./api/types.ts";

// ---------- Buttons, cards, chips ----------

export function StButton({
  main = false,
  quiet = false,
  className = "",
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { main?: boolean; quiet?: boolean }) {
  return (
    <button
      type={type}
      className={`st-btn${main ? " st-btn--main" : ""}${quiet ? " st-btn--quiet" : ""}${className ? ` ${className}` : ""}`}
      {...rest}
    />
  );
}

/** A link that looks like a button (in-app paths go through the router). */
export function StLinkButton({ href, main = false, className = "", children, ...rest }: { href: string; main?: boolean; className?: string; children: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  return (
    <A href={href} className={`st-btn${main ? " st-btn--main" : ""}${className ? ` ${className}` : ""}`} {...rest}>
      {children}
    </A>
  );
}

export function StCard({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`st-card st-glass${className ? ` ${className}` : ""}`}>{children}</div>;
}

export type StTone = "sun" | "coral" | "mint" | "sky";

export function StChip({ children, tone }: { children: ReactNode; tone?: StTone }) {
  return <span className={`st-chip${tone ? ` st-chip--${tone}` : ""}`}>{children}</span>;
}

/**
 * "Technical details" (§45.36 E14): developer-app words (redirect URIs, Login configuration, App Review, Sandbox,
 * inference profiles, ARNs) and raw ids (account ids, model ids, app ids) folded away under a plain first line, one
 * tap away. Closed to start.
 */
export function StTech({ children, className = "", label = "Technical details" }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <details className={`st-tech-fold${className ? ` ${className}` : ""}`}>
      <summary className="st-tech-fold__sum">
        <StIcon name="chevron" size={16} className="st-tech-fold__mark" />
        {label}
      </summary>
      <div className="st-tech-fold__body">{children}</div>
    </details>
  );
}

/** Developer-app words a 6-8 year old would not follow: a line that has one goes behind "Technical details". */
export const TECH_WORDS = /\b(sandbox|app review|development mode|oauth|login configuration|redirect uri|inference profile|arn|client id|config(uration)? id)\b/i;

/** A list of sentences split into the plain ones (shown) and the technical ones (folded away, §45.36 E14). */
export function plainFirst(lines: readonly string[]): { plain: string[]; tech: string[] } {
  const plain: string[] = [];
  const tech: string[] = [];
  for (const l of lines) (TECH_WORDS.test(l) ? tech : plain).push(l);
  return { plain, tech };
}

/**
 * A page's heading row: the title, one plain line under it, and its main actions. It is a backing plate (.st-plate):
 * nothing over Ember, a glass plate in Picture and See-through, where anything can be behind its words.
 */
export function StPageHead({ title, lede, actions }: { title: ReactNode; lede?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="st-head st-plate">
      <div className="st-head__text">
        <h1 className="st-head__title st-display">{title}</h1>
        {lede ? <p className="st-head__lede">{lede}</p> : null}
      </div>
      {actions ? <div className="st-head__actions">{actions}</div> : null}
    </header>
  );
}

// ---------- Icons (Lamo Stories' own: chunky, round strokes) ----------

const PATHS = {
  home: "M4 11.5 12 5l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5H15V15H9v5.5H5.5A1.5 1.5 0 0 1 4 19z",
  bulb: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z",
  face: "M12 3.5c4.1 0 7.5 3.6 7.5 8s-3.4 8-7.5 8-7.5-3.6-7.5-8 3.4-8 7.5-8zM9.3 10.4h.01M14.7 10.4h.01M9 14.2c1.7 1.6 4.3 1.6 6 0",
  clapper: "M4 9.5h16v9A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5zM4 9.5 3.4 6.6a1.5 1.5 0 0 1 1.2-1.8l12.9-2.4a1.5 1.5 0 0 1 1.7 1.2l.6 3zM8.2 4.3l2.1 3.4M13.2 3.4l2.1 3.4",
  screen: "M3.5 6.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2zM10 8.5v5l4.5-2.5zM8.5 21h7",
  boxes: "M4 9h16v10a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19zM3 4.5h18V9H3zM10 13h4",
  plug: "M9 3v4M15 3v4M6.5 7h11v3.5a5.5 5.5 0 0 1-11 0zM12 16v5",
  sliders: "M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M9 14.5v5",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  download: "M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14",
  play: "M8 5.5v13l10-6.5z",
  check: "M5 12.5 9.5 17 19 7.5",
  alert: "M12 8.5v4.5M12 16.5h.01M10.3 4.4 2.9 17.4A2 2 0 0 0 4.6 20.4h14.8a2 2 0 0 0 1.7-3L13.7 4.4a2 2 0 0 0-3.4 0z",
  retry: "M4.5 12a7.5 7.5 0 1 0 2.3-5.4M4.5 4.5v4h4",
  external: "M14 4.5h5.5V10M19.5 4.5 11 13M17 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 4 18.5v-10A1.5 1.5 0 0 1 5.5 7H10",
  plus: "M12 5v14M5 12h14",
  close: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  star: "M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.6L12 16.8l-5.1 2.6 1-5.6-4.1-4 5.7-.8z",
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5z",
  heart: "M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z",
  comment: "M4.5 5.5h15v10h-9l-4.5 4v-4h-1.5z",
  chat: "M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4A1.5 1.5 0 0 1 4 14.5zM8.5 10h.01M12 10h.01M15.5 10h.01",
  copy: "M9 9h10.5v10.5H9zM5 15V5h10",
  key: "M14.5 9.5a4.5 4.5 0 1 1-1.3-3.2 4.5 4.5 0 0 1 1.3 3.2zM13.2 12.7 20 19.5M17 16.5l2-2M15 18.5l1.5-1.5",
  rocket: "M12 15.5 8.5 12c1.5-4.5 4.5-7.5 10-8.5-1 5.5-4 8.5-8.5 10zM8.5 12 5 11.5l3-3h3.5M12 15.5l.5 3.5 3-3V12.5M6.5 17.5c-1 1-1.5 3-1.5 3s2-.5 3-1.5",
  share: "M12 15V4M7.5 8.5 12 4l4.5 4.5M5 14v5.5h14V14",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  film: "M4 5.5h16v13H4zM4 9h16M4 15h16M8 5.5v13M16 5.5v13",
  picture: "M4 5.5h16v13H4zM4 16l4.5-4.5 4 4 2.5-2.5L20 17M15.5 9.5h.01",
  music: "M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z",
  board: "M4 4.5h7v7H4zM13 4.5h7v7h-7zM4 13.5h7v6H4zM13 13.5h7v6h-7z",
  scenes: "M4 6.5h16v11H4zM8.5 6.5v11M15.5 6.5v11",
  folder: "M3.5 7A1.5 1.5 0 0 1 5 5.5h4.5l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18z",
  clock: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 1 0 0-17zM12 7.5V12l3 2",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5a7.5 7.5 0 0 1 15 0",
  chevron: "M9 5.5l6.5 6.5L9 18.5",
} as const;

export type StIconName = keyof typeof PATHS;

export function StIcon({ name, size = 22, className = "" }: { name: StIconName; size?: number; className?: string }) {
  return (
    <svg
      className={`st-icon${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "more" ? 3.4 : 2.1}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

// ---------- Pick one (a bar on <Glide>) and a switch ----------

/** A pick-one bar: the owner's sliding highlight behind the chosen option, one tap to choose. */
export function StPick<T extends string>({
  label,
  value,
  options,
  onChange,
  stack = false,
  disabled = false,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; line?: string }[];
  onChange: (v: T) => void;
  /** one option per row (long names, or many options) */
  stack?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className={`st-pick${stack ? " st-pick--stack" : ""}`} role="radiogroup" aria-label={label}>
      <Glide active=".st-pick__opt.is-on" className="glide--st" />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          aria-disabled={disabled || undefined}
          className={`st-pick__opt${o.value === value ? " is-on" : ""}`}
          onClick={() => {
            if (!disabled && o.value !== value) onChange(o.value);
          }}
        >
          <span className="st-pick__label">{o.label}</span>
          {o.line ? <span className="st-pick__line">{o.line}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** A switch row: its words, and the orange toggle with its white knob (the figure .st-toggle, never disabled). */
export function StToggle({ checked, onChange, label, description, disabled = false }: { checked: boolean; onChange: (next: boolean) => void; label: string; description?: string; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="st-toggle-row">
      <div className="st-toggle-row__text">
        <span className="st-toggle-row__label" id={`${id}-l`}>
          {label}
        </span>
        {description ? (
          <span className="st-toggle-row__desc" id={`${id}-d`}>
            {description}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        className="st-switch st-toggle"
        aria-checked={checked}
        aria-labelledby={`${id}-l`}
        aria-describedby={description ? `${id}-d` : undefined}
        aria-disabled={disabled || undefined}
        onClick={() => {
          if (!disabled) onChange(!checked);
        }}
      >
        <span className="st-toggle__track" aria-hidden="true">
          <span className="st-toggle__knob" />
        </span>
      </button>
    </div>
  );
}

// ---------- The cast of the empty states ----------

export type MascotMood = "wave" | "sleepy" | "oops" | "cheer" | "think";

/** Pip's colours on the warm stage: an amber, coral, mint or sky body, espresso eyes, cream light. */
const PIP = { body: { sun: "#FFB766", coral: "#FF7F6A", mint: "#6FD9A4", sky: "#7CC6E6" }, ink: "#2A160B", light: "#FFF6EA", cheek: "#FF7F6A", floor: "#0F0A07" } as const;

/** Pip, the little bean who stands in for "nothing here yet": a character, never a blank box. */
export function StMascot({ mood = "wave", size = 120, tone = "sun" }: { mood?: MascotMood; size?: number; tone?: StTone }) {
  const body = PIP.body[tone];
  const eyesOpen = mood !== "sleepy";
  return (
    <svg className={`st-mascot st-mascot--${mood}`} width={size} height={size} viewBox="0 0 120 120" aria-hidden="true" focusable="false">
      <ellipse cx="60" cy="110" rx="30" ry="5" fill={PIP.floor} opacity="0.45" />
      <g className="st-mascot__body">
        <path d="M60 18c20 0 32 18 32 44s-12 44-32 44-32-18-32-44 12-44 32-44z" fill={body} />
        <path d="M44 30c5-6 11-8 16-8" stroke={PIP.light} strokeWidth="5" strokeLinecap="round" fill="none" opacity="0.55" />
        {eyesOpen ? (
          <>
            <ellipse cx="50" cy="54" rx="5.5" ry={mood === "oops" ? 7.5 : 6.5} fill={PIP.ink} />
            <ellipse cx="70" cy="54" rx="5.5" ry={mood === "oops" ? 7.5 : 6.5} fill={PIP.ink} />
            <circle cx="52" cy="51.5" r="1.8" fill={PIP.light} />
            <circle cx="72" cy="51.5" r="1.8" fill={PIP.light} />
          </>
        ) : (
          <>
            <path d="M44.5 55q5.5 4 11 0M64.5 55q5.5 4 11 0" stroke={PIP.ink} strokeWidth="3.2" strokeLinecap="round" fill="none" />
          </>
        )}
        <circle cx="42" cy="66" r="4.5" fill={PIP.cheek} opacity="0.5" />
        <circle cx="78" cy="66" r="4.5" fill={PIP.cheek} opacity="0.5" />
        {mood === "oops" ? (
          <ellipse cx="60" cy="72" rx="5" ry="6" fill={PIP.ink} />
        ) : mood === "think" ? (
          <path d="M53 72h14" stroke={PIP.ink} strokeWidth="3.4" strokeLinecap="round" />
        ) : (
          <path d="M50 68q10 10 20 0" stroke={PIP.ink} strokeWidth="3.4" strokeLinecap="round" fill="none" />
        )}
      </g>
      {mood === "cheer" ? (
        <>
          <path className="st-mascot__arm st-mascot__arm--l" d="M32 62 18 40" stroke={body} strokeWidth="9" strokeLinecap="round" />
          <path className="st-mascot__arm st-mascot__arm--r" d="M88 62 102 40" stroke={body} strokeWidth="9" strokeLinecap="round" />
        </>
      ) : (
        <>
          <path d="M32 70 22 84" stroke={body} strokeWidth="9" strokeLinecap="round" />
          <path className={mood === "wave" ? "st-mascot__arm st-mascot__arm--wave" : "st-mascot__arm"} d={mood === "think" ? "M88 70 78 60" : "M88 66 104 50"} stroke={body} strokeWidth="9" strokeLinecap="round" />
        </>
      )}
      {mood === "sleepy" ? (
        <g className="st-mascot__zzz" fill={PIP.light}>
          <text x="92" y="30" fontSize="14" fontWeight="800" style={{ fontFamily: "var(--st-font)" }}>z</text>
          <text x="102" y="18" fontSize="10" fontWeight="800" style={{ fontFamily: "var(--st-font)" }}>z</text>
        </g>
      ) : null}
      {mood === "think" ? <circle className="st-mascot__dot" cx="98" cy="30" r="5" fill={PIP.light} opacity="0.85" /> : null}
    </svg>
  );
}

/** An empty state with a character in it, on a glass card: what is missing and the one tap that fixes it. */
export function StEmpty({ mood = "wave", tone = "sun", title, children, action }: { mood?: MascotMood; tone?: StTone; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="st-empty st-glass">
      <StMascot mood={mood} tone={tone} size={112} />
      <h2 className="st-empty__title">{title}</h2>
      {children ? <p className="st-empty__text">{children}</p> : null}
      {action ? <div className="st-empty__action">{action}</div> : null}
    </div>
  );
}

/** A short wait: the mascot bobs while the page gets its words (never a bare spinner), on a backing plate. */
export function StLoading({ label = "Getting it ready…" }: { label?: string }) {
  return (
    <div className="st-loading st-plate" role="status">
      <StMascot mood="think" tone="sky" size={72} />
      <span>{label}</span>
    </div>
  );
}

/** Something did not load: the sentence the server gave, and Try again, on a coral-tinted glass card. */
export function StError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="st-error st-glass st-glass--tinted" role="alert">
      <StMascot mood="oops" tone="coral" size={84} />
      <p>{message}</p>
      {onRetry ? (
        <StButton main onClick={onRetry}>
          <StIcon name="retry" size={20} />
          Try again
        </StButton>
      ) : null}
    </div>
  );
}

/** One broken Lamo Stories page never blanks the studio: a friendly card, Try again, the dashboard. */
export class StBoundary extends Component<{ resetKey: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(error, info.componentStack);
  }
  override componentDidUpdate(prev: { resetKey: string }): void {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }
  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="st-page">
        <h1 className="sr-only">Something went wrong on this page</h1>
        <StEmpty
          mood="oops"
          tone="coral"
          title="Oops, this page tripped over"
          action={
            <>
              <StButton main onClick={() => this.setState({ failed: false })}>
                <StIcon name="retry" size={20} />
                Try again
              </StButton>
              <StLinkButton href="/stories">Go to the dashboard</StLinkButton>
            </>
          }
        >
          Tap Try again. If it trips again, go to the dashboard.
        </StEmpty>
      </section>
    );
  }
}

// ---------- A success: a burst of stars, and the cheer ----------

/** The burst in the warm palette: amber, the orange accent, cream, coral and mint. */
const STAR_COLOURS = ["#FFB766", "#FF8A3D", "#FFF3E4", "#FF7F6A", "#FFD9A8", "#6FD9A4"];

/** A short star burst from a point (a Connect that worked, a saved setting), with the success cheer on a tap. */
export function celebrate(origin?: { x: number; y: number }, cheer = true): void {
  if (cheer) storiesSound("success");
  starBurst(origin);
}

/**
 * Lamo Stories' confetti: `amount` stars from a point (the middle of the page's top third without one). It follows
 * Lamo Stories' own calm-motion switch (never Clip Factory's once it has its own), and draws nothing while Clip
 * Factory is on screen (a page kept behind it never celebrates over Clip Factory).
 */
export function starBurst(origin?: { x: number; y: number }, amount = 46): void {
  if (storiesBehind() || storiesReduceMotion() || typeof document === "undefined") return;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = window.innerWidth;
  const H = window.innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.className = "confetti st-burst";
  canvas.setAttribute("aria-hidden", "true");
  document.body.appendChild(canvas);
  ctx.scale(dpr, dpr);
  const ox = origin?.x ?? W / 2;
  const oy = origin?.y ?? H / 3;
  const count = Math.max(1, Math.round(amount));
  const stars = Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2 + Math.random() * 0.3;
    const speed = 3 + Math.random() * 6;
    return { x: ox, y: oy, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 2, r: 4 + Math.random() * 5, spin: Math.random() * Math.PI, color: STAR_COLOURS[i % STAR_COLOURS.length]! };
  });
  const start = performance.now();
  const LIFE = 1300;
  const drawStar = (x: number, y: number, r: number, rot: number) => {
    ctx.beginPath();
    for (let k = 0; k < 10; k++) {
      const rad = k % 2 === 0 ? r : r * 0.45;
      const a = rot + (k * Math.PI) / 5;
      ctx.lineTo(x + Math.cos(a) * rad, y + Math.sin(a) * rad);
    }
    ctx.closePath();
    ctx.fill();
  };
  const tick = (now: number) => {
    const t = now - start;
    ctx.clearRect(0, 0, W, H);
    for (const s of stars) {
      s.vy += 0.16;
      s.vx *= 0.985;
      s.x += s.vx;
      s.y += s.vy;
      s.spin += 0.08;
      ctx.globalAlpha = Math.max(0, 1 - t / LIFE);
      ctx.fillStyle = s.color;
      drawStar(s.x, s.y, s.r, s.spin);
    }
    if (t < LIFE) requestAnimationFrame(tick);
    else canvas.remove();
  };
  requestAnimationFrame(tick);
}

export function centerOf(el: Element | null | undefined): { x: number; y: number } | undefined {
  if (!el) return undefined;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// ---------- Words shared by the screens ----------

export const PLATFORM_NAME: Record<Platform, string> = { youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram", facebook: "Facebook", x: "X" };

export const STATUS_WORDS: Record<StoryStatus, { label: string; tone: StTone }> = {
  draft: { label: "Starting", tone: "sky" },
  producing: { label: "Being made", tone: "sky" },
  needs_check: { label: "Needs a check", tone: "coral" },
  review: { label: "Ready to watch", tone: "sun" },
  approved: { label: "Approved", tone: "mint" },
  rejected: { label: "Not used", tone: "coral" },
  published: { label: "Posted", tone: "mint" },
  failed: { label: "Stopped", tone: "coral" },
};

/** A story's state in words: a draft nothing is making (never started, or stopped with Cancel) is "Not made yet". */
export function statusWords(story: Pick<Story, "status" | "currentJobId">): { label: string; tone: StTone } {
  if (story.status === "draft" && !story.currentJobId) return { label: "Not made yet", tone: "sky" };
  return STATUS_WORDS[story.status];
}

// ---------- The dashboard, shared by the Dashboard page and the Needs you bar ----------

interface DashSnap {
  data: StoriesDashboard | null;
  error: string | null;
}

const dashSnaps = new Map<string, DashSnap>();
const dashAt = new Map<string, number>();
const dashFlight = new Map<string, Promise<void>>();
const dashSubs = new Set<() => void>();
const EMPTY: DashSnap = { data: null, error: null };

/** Loads the dashboard of `ws` now (one call at a time, shared by everything that shows it). */
export function refreshDashboard(ws: string): Promise<void> {
  const flying = dashFlight.get(ws);
  if (flying) return flying;
  const run = (async () => {
    try {
      const data = await storiesApi().dashboard(ws);
      dashSnaps.set(ws, { data, error: null });
    } catch (e) {
      dashSnaps.set(ws, { data: dashSnaps.get(ws)?.data ?? null, error: friendlyMessage(e) });
      throw e;
    } finally {
      dashAt.set(ws, Date.now());
      dashFlight.delete(ws);
      for (const fn of dashSubs) fn();
    }
  })();
  dashFlight.set(ws, run);
  return run;
}

/** The dashboard of `ws`, polled every 15 s (§45.16.4) while something shows it (not while Clip Factory is on screen). */
export function useDashboard(ws: string): DashSnap & { reload: () => void } {
  const active = useAppActive();
  const snap = useSyncExternalStore(
    (fn) => {
      dashSubs.add(fn);
      return () => dashSubs.delete(fn);
    },
    () => dashSnaps.get(ws) ?? EMPTY,
    () => EMPTY,
  );
  useEffect(() => {
    // Fresh enough when another part of the page loaded it a moment ago (or a moment before Clip Factory was shown).
    if (active && Date.now() - (dashAt.get(ws) ?? 0) > 2000) refreshDashboard(ws).catch(() => undefined);
  }, [ws, active]);
  usePoll(() => refreshDashboard(ws), active, 15_000);
  return { ...snap, reload: () => void refreshDashboard(ws).catch(() => undefined) };
}

/** Test hook: forget the shared dashboard. */
export function forgetDashboards(): void {
  dashSnaps.clear();
  dashAt.clear();
  dashFlight.clear();
}

/**
 * The Social accounts page as Needs you sentences name it ("Clips Funded › Social accounts", or just "Social
 * accounts"). A sentence stored before a rename still says "Funded Clips › Social accounts", "Clip Factory Stories ›
 * Social accounts" or "Lamo Stories › Social accounts" and reads the same way.
 */
const SOCIAL_PAGE = String.raw`(?:(?:(?:Clip(?: Factory)?|Lamo) Stories|Funded Clips|Clips Funded)\s*›\s*)?Social accounts`;

/**
 * A Needs you sentence shown on the Social accounts page it sends the owner to, without the trip (§45.36 E17): "Open
 * Lamo Stories › Social accounts, then tap Try again." reads "Fix it below, then tap Try again."; "Pick another in Lamo
 * Stories › Social accounts" reads "Pick another below". Anything else stays as the server said it.
 */
export function socialHere(sentence: string): string {
  return sentence
    .replace(new RegExp(String.raw`\bOpen ${SOCIAL_PAGE},? (?:and|then) tap (Connect|Reconnect)\b`, "g"), "Tap $1 below")
    .replace(new RegExp(String.raw`\bOpen ${SOCIAL_PAGE}, connect it, then\b`, "g"), "Connect it below, then")
    .replace(new RegExp(String.raw`\bOpen ${SOCIAL_PAGE}, then\b`, "g"), "Fix it below, then")
    .replace(new RegExp(String.raw`\s+(?:in|on) ${SOCIAL_PAGE}(?![A-Za-z])`, "g"), " below");
}

/** The address's page, without its query or hash. */
const pathOf = (href: string) => href.replace(/[?#].*$/, "").replace(/\/+$/, "") || "/";

type NeedsItem = StoriesDashboard["needsYou"][number];

/**
 * A stopped post whose account problem is fixed now (the account it names is connected again): it no longer sends
 * the owner to Social accounts, where nothing is left to fix, but to the post itself, to tap its Try again. The
 * server says so itself (dashboard._post_href); this reads an older answer the same way.
 */
export function afterFix(item: NeedsItem, accounts: StoriesDashboard["accounts"] | undefined): NeedsItem {
  if (!item.publishingJobId || !item.storyId || !item.platform || pathOf(item.href) !== "/stories/connections") return item;
  if (accounts?.find((a) => a.platform === item.platform)?.status !== "connected") return item;
  const title = item.title ? `“${item.title}”` : "the video";
  return { ...item, href: `/stories/review/${encodeURIComponent(item.storyId)}`, sentence: `${PLATFORM_NAME[item.platform]} is connected now. Tap Try again on ${title}.` };
}

/** On the page a Needs you item points to: where on it to look (the platform's card on Social accounts), else null. */
function targetOn(item: StoriesDashboard["needsYou"][number]): HTMLElement | null {
  if (!item.platform || typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>(`.st-conn[data-platform="${item.platform}"]`);
}

/**
 * On every Lamo Stories page: the first thing that needs the owner, with its sentence and the way there. `here` is the
 * page on screen: on the page the item points to, the sentence does not send him there again, and Show me brings the
 * card to fix into view instead of opening the same page (§45.36 E17).
 */
export function NeedsYouBar({ ws, here }: { ws: string; here?: string }) {
  const { data } = useDashboard(ws);
  const [gone, setGone] = useState<string | null>(null);
  const top = data?.needsYou[0];
  if (!top) return null;
  const first = afterFix(top, data?.accounts);
  const key = `${first.href}|${first.sentence}`;
  if (gone === key) return null;
  const more = (data?.needsYou.length ?? 1) - 1;
  const onIt = here !== undefined && pathOf(first.href) === pathOf(here);
  const onSocial = onIt && pathOf(first.href) === "/stories/connections";
  const sentence = onSocial ? socialHere(first.sentence) : first.sentence;
  const show = () => {
    const card = targetOn(first);
    if (!card) return;
    card.scrollIntoView({ block: "start", behavior: storiesReduceMotion() ? "auto" : "smooth" });
    if (!card.hasAttribute("tabindex")) card.setAttribute("tabindex", "-1");
    card.focus({ preventScroll: true });
  };
  return (
    <aside className="st-needs st-glass st-glass--tinted" aria-label="Needs you">
      <span className="st-needs__mark" aria-hidden="true">
        <StIcon name="alert" size={22} />
      </span>
      <p className="st-needs__text">
        <strong>Needs you: </strong>
        {sentence}
        {more > 0 ? <span className="st-needs__more"> And {more} more on the dashboard.</span> : null}
      </p>
      <div className="st-needs__actions">
        {!onIt ? (
          <StLinkButton href={first.href} className="st-needs__go st-btn--cream">
            Fix it
            <StIcon name="chevron" size={18} />
          </StLinkButton>
        ) : onSocial && first.platform ? (
          // Already on Social accounts: the card to fix comes into view, instead of the same page opening again.
          <StButton className="st-needs__go st-btn--cream" onClick={show}>
            Show me
            <StIcon name="chevron" size={18} />
          </StButton>
        ) : null}
        <RoundGlassButton label="Hide this for now" className="st-needs__hide" onClick={() => setGone(key)}>
          <StIcon name="close" size={20} />
        </RoundGlassButton>
      </div>
    </aside>
  );
}

// ---------- The onboarding, shared by the setup page, the dashboard card and the Social accounts page ----------

interface OnboardSnap {
  data: Onboarding | null;
  error: string | null;
}

const onboardSnaps = new Map<string, OnboardSnap>();
const onboardFlight = new Map<string, Promise<Onboarding | null>>();
const onboardSubs = new Set<() => void>();
const NO_ONBOARD: OnboardSnap = { data: null, error: null };

/** Loads the onboarding of `ws` now (one call at a time); null when the server could not say. */
export function refreshOnboarding(ws: string): Promise<Onboarding | null> {
  const flying = onboardFlight.get(ws);
  if (flying) return flying;
  const run = (async () => {
    try {
      const data = await storiesApi().getOnboarding(ws);
      onboardSnaps.set(ws, { data, error: null });
      return data;
    } catch (e) {
      onboardSnaps.set(ws, { data: onboardSnaps.get(ws)?.data ?? null, error: friendlyMessage(e) });
      return null;
    } finally {
      onboardFlight.delete(ws);
      for (const fn of onboardSubs) fn();
    }
  })();
  onboardFlight.set(ws, run);
  return run;
}

/** Puts the server's answer straight in (a PATCH answers with the whole onboarding). */
export function setOnboarding(ws: string, data: Onboarding): void {
  onboardSnaps.set(ws, { data, error: null });
  for (const fn of onboardSubs) fn();
}

export function useOnboarding(ws: string): OnboardSnap & { reload: () => Promise<Onboarding | null> } {
  const snap = useSyncExternalStore(
    (fn) => {
      onboardSubs.add(fn);
      return () => onboardSubs.delete(fn);
    },
    () => onboardSnaps.get(ws) ?? NO_ONBOARD,
    () => NO_ONBOARD,
  );
  useEffect(() => {
    void refreshOnboarding(ws);
  }, [ws]);
  return { ...snap, reload: () => refreshOnboarding(ws) };
}

/** Test hook: forget the shared onboarding. */
export function forgetOnboarding(): void {
  onboardSnaps.clear();
  onboardFlight.clear();
}

/** A progress ring with "4 of 11 done" beside it for screen readers; the arc eases to its place. */
export function StRing({ done, total, size = 88, label = true }: { done: number; total: number; size?: number; label?: boolean }) {
  const stroke = Math.max(6, Math.round(size / 9));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const part = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  return (
    <span className={`st-ring${part >= 1 ? " is-full" : ""}`} style={{ width: size, height: size }} role="img" aria-label={`${done} of ${total} done`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false">
        <circle className="st-ring__track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
        <circle
          className="st-ring__arc"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - part)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      {label ? (
        <span className="st-ring__text" aria-hidden="true">
          <strong>{done}</strong>
          <span>of {total}</span>
        </span>
      ) : null}
    </span>
  );
}
