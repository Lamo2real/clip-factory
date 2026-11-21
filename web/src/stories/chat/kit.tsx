// Small building blocks of the chat and the reference pages (docs/CONTRACTS.md §45.16.2): a pick-one list on <Glide>
// (the owner's sliding highlight), a sheet, icons, the creative director's face, an eased progress bar, the Undo bar,
// a star burst with the success cheer, and the plain sentence of a failed call. Styled by ../styles/chat.css. Click
// and deny sounds come from the app's global click handler (a switched-off control is aria-disabled, never disabled,
// so a tap on it is still heard as "no").
import { useEffect, useId, useRef, type ButtonHTMLAttributes, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ApiError } from "../../api/errors.ts";
import { Glide } from "../../components/Glide.tsx";
import { trapTab } from "../../components/Sheet.tsx";
import { prefersReducedMotion } from "../../lib/prefs.ts";
import { sounds } from "../../lib/sounds.ts";

/** The sentence for a failed call: the server's own when it sent one, else `fallback`. */
export function sentence(e: unknown, fallback = "That did not work. Try again."): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message && e.message.length < 240 && /[.!?]$/.test(e.message.trim())) return e.message;
  return fallback;
}

// ---------- Icons ----------

const PATHS = {
  chat: "M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H11l-4.5 3.5V16h0a2 2 0 0 1-2-2z",
  plus: "M12 5v14M5 12h14",
  send: "M4.5 12 19.5 5l-4 14.5-3.5-6zM12 13.5l7.5-8.5",
  stop: "M7 7h10v10H7z",
  picture: "M4 5.5h16v13H4zM4 16l4.5-4.5 4 4 2.5-2.5L20 17M15.5 9.5h.01",
  pencil: "M5 19l1-4.5L15.5 5a2.1 2.1 0 0 1 3 3L9 17.5zM13.5 7l3 3",
  trash: "M5 7h14M10 7V4.5h4V7M7 7l1 12.5h8L17 7M10.5 10.5v6M13.5 10.5v6",
  back: "M15 5.5 8.5 12l6.5 6.5",
  close: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  retry: "M4.5 12a7.5 7.5 0 1 0 2.3-5.4M4.5 4.5v4h4",
  film: "M4 5.5h16v13H4zM4 9h16M4 15h16M8 5.5v13M16 5.5v13",
  upload: "M12 16V4.5M7.5 9 12 4.5 16.5 9M5 15v4.5h14V15",
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5z",
  bulb: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z",
  face: "M12 3.5c4.1 0 7.5 3.6 7.5 8s-3.4 8-7.5 8-7.5-3.6-7.5-8 3.4-8 7.5-8zM9.3 10.4h.01M14.7 10.4h.01M9 14.2c1.7 1.6 4.3 1.6 6 0",
  clapper: "M4 9.5h16v9A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5zM4 9.5 3.4 6.6a1.5 1.5 0 0 1 1.2-1.8l12.9-2.4a1.5 1.5 0 0 1 1.7 1.2l.6 3zM8.2 4.3l2.1 3.4M13.2 3.4l2.1 3.4",
  check: "M5 12.5 9.5 17 19 7.5",
  chevron: "M9 5.5l6.5 6.5L9 18.5",
  tune: "M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M9 14.5v5",
  ear: "M8 9a4 4 0 1 1 8 0c0 3-3 4-3 6.5a2.5 2.5 0 0 1-5 0M10.5 10a1.5 1.5 0 1 1 3 0",
  pen: "M5 19h4l10-10-4-4L5 15zM13 7l4 4",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  return (
    <svg className="st-chat-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}

// ---------- The creative director (the face of the assistant and of the empty states) ----------

export function Director({ size = 44, mood = "smile" }: { size?: number; mood?: "smile" | "think" | "oops" | "cheer" }) {
  return (
    <svg className={`st-chat-director st-chat-director--${mood}`} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <circle cx="32" cy="36" r="22" fill="#62C6FF" />
      <path d="M12 26c2-11 12-17 22-16 9 1 15 6 17 12-8-3-27-3-39 4z" fill="#FF6F61" />
      <circle cx="40" cy="11" r="3" fill="#FF6F61" />
      {mood === "think" ? (
        <path d="M22 35h6M36 35h6" stroke="#1C1842" strokeWidth="3" strokeLinecap="round" />
      ) : (
        <>
          <ellipse cx="25" cy="35" rx="3" ry={mood === "oops" ? 4.2 : 3.6} fill="#1C1842" />
          <ellipse cx="39" cy="35" rx="3" ry={mood === "oops" ? 4.2 : 3.6} fill="#1C1842" />
          <circle cx="26" cy="33.6" r="1" fill="#FFF6E5" />
          <circle cx="40" cy="33.6" r="1" fill="#FFF6E5" />
        </>
      )}
      <circle cx="19" cy="42" r="3" fill="#FF6F61" opacity="0.45" />
      <circle cx="45" cy="42" r="3" fill="#FF6F61" opacity="0.45" />
      {mood === "oops" ? (
        <ellipse cx="32" cy="46" rx="3.2" ry="3.8" fill="#1C1842" />
      ) : mood === "think" ? (
        <path d="M27 46h10" stroke="#1C1842" strokeWidth="3" strokeLinecap="round" />
      ) : (
        <path d={mood === "cheer" ? "M24 43q8 10 16 0z" : "M25 44q7 6 14 0"} stroke="#1C1842" strokeWidth="3" strokeLinecap="round" fill={mood === "cheer" ? "#1C1842" : "none"} />
      )}
    </svg>
  );
}

/** An empty or broken state with the director in it: what is missing and the one tap that fixes it. */
export function Empty({ mood = "smile", title, children, action }: { mood?: "smile" | "think" | "oops" | "cheer"; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="st-chat-empty">
      <Director size={96} mood={mood} />
      <h2 className="st-chat-empty__title">{title}</h2>
      {children ? <p className="st-chat-empty__text">{children}</p> : null}
      {action ? <div className="st-chat-empty__action">{action}</div> : null}
    </div>
  );
}

/** A short wait: the director thinks while the page gets its words (never a bare spinner). */
export function Waiting({ label = "Getting it ready…" }: { label?: string }) {
  return (
    <div className="st-chat-wait" role="status">
      <Director size={56} mood="think" />
      <span>{label}</span>
    </div>
  );
}

// ---------- Buttons ----------

/**
 * A button. `off` makes it aria-disabled (still focusable, a tap plays the deny sound and does nothing), with `why`
 * as its description so the owner hears why.
 */
export function Btn({
  main = false,
  quiet = false,
  danger = false,
  icon,
  off = false,
  className = "",
  onClick,
  children,
  label,
  ...rest
}: {
  main?: boolean;
  quiet?: boolean;
  danger?: boolean;
  icon?: IconName;
  off?: boolean;
  className?: string;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  children?: ReactNode;
  /** aria-label, for an icon-only button */
  label?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "disabled">) {
  const cls = ["st-chat-btn", main && "st-chat-btn--main", quiet && "st-chat-btn--quiet", danger && "st-chat-btn--danger", !children && "st-chat-btn--icon", className].filter(Boolean).join(" ");
  return (
    <button
      type="button"
      className={cls}
      aria-disabled={off || undefined}
      aria-label={label}
      onClick={(e) => {
        if (off) return;
        onClick?.(e);
      }}
      {...rest}
    >
      {icon ? <Icon name={icon} size={20} /> : null}
      {children}
    </button>
  );
}

// ---------- Pick one ----------

export interface PickOption<T extends string> {
  value: T;
  label: string;
  line?: string;
  badge?: ReactNode;
}

/** A pick-one list or bar: the sliding highlight behind the chosen option, one tap to choose. */
export function Pick<T extends string>({
  label,
  value,
  options,
  onChange,
  stack = false,
  className = "",
}: {
  label: string;
  value: T | null;
  options: PickOption<T>[];
  onChange: (v: T) => void;
  stack?: boolean;
  className?: string;
}) {
  return (
    <div className={`st-chat-pick${stack ? " st-chat-pick--stack" : ""}${className ? ` ${className}` : ""}`} role="radiogroup" aria-label={label}>
      <Glide active=".st-chat-pick__opt.is-on" className="glide--st-chat" />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={`st-chat-pick__opt${o.value === value ? " is-on" : ""}`}
          onClick={() => {
            if (o.value !== value) onChange(o.value);
          }}
        >
          <span className="st-chat-pick__label">
            {o.label}
            {o.badge ? <span className="st-chat-pick__badge">{o.badge}</span> : null}
          </span>
          {o.line ? <span className="st-chat-pick__line">{o.line}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Chip({ tone = "sky", children }: { tone?: "sun" | "coral" | "mint" | "sky"; children: ReactNode }) {
  return <span className={`st-chat-chip st-chat-chip--${tone}`}>{children}</span>;
}

// ---------- A sheet over the page ----------

/**
 * A dialog over the page (bottom sheet on phones, a card in the middle on wide screens). Focus moves in and comes
 * back, Tab stays inside, Escape or a tap outside closes it. Drawn inside the Lamo Stories app (its look and
 * tokens), above everything.
 */
export function Sheet({ title, onClose, children, actions, wide = false }: { title: string; onClose: () => void; children: ReactNode; actions?: ReactNode; wide?: boolean }) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = box.current?.querySelector<HTMLElement>('[aria-checked="true"], button, a[href], input, textarea');
    (first ?? box.current)?.focus();
    return () => before?.focus({ preventScroll: true });
  }, []);

  function keys(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      close.current();
      return;
    }
    trapTab(e, box.current);
  }

  const host = (typeof document !== "undefined" && document.querySelector(".stories-app")) || document.body;
  return createPortal(
    <div className="st-chat-scrim" onClick={(e) => e.target === e.currentTarget && close.current()}>
      <div ref={box} className={`st-chat-sheet${wide ? " st-chat-sheet--wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} tabIndex={-1} onKeyDown={keys}>
        <div className="st-chat-sheet__head">
          <h2 className="st-chat-sheet__title" id={`${id}-t`}>
            {title}
          </h2>
          <Btn quiet icon="close" label="Close" onClick={() => close.current()} />
        </div>
        <div className="st-chat-sheet__body">{children}</div>
        {actions ? <div className="st-chat-sheet__actions">{actions}</div> : null}
      </div>
    </div>,
    host,
  );
}

// ---------- Progress, Undo ----------

/** An eased progress bar (0..1); `label` is read out. */
export function Progress({ value, label }: { value: number; label: string }) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className="st-chat-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)}>
      <span className="st-chat-progress__fill" style={{ transform: `scaleX(${v})` }} />
    </div>
  );
}

/** "Deleted. Undo" for a few seconds at the bottom of the page. */
export function UndoBar({ text, onUndo }: { text: string; onUndo: () => void }) {
  return (
    <div className="st-chat-undo" role="status">
      <span>{text}</span>
      <Btn main onClick={onUndo}>
        Undo
      </Btn>
    </div>
  );
}

// ---------- A success: stars and the cheer ----------

const STAR_COLOURS = ["#FFC94A", "#FF6F61", "#47D6A0", "#62C6FF", "#FFF6E5"];

export function centerOf(el: Element | null | undefined): { x: number; y: number } | undefined {
  if (!el) return undefined;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** A short burst of stars from a point, and the success sound. Only the sound when motion is reduced. */
export function cheer(origin?: { x: number; y: number }): void {
  sounds.play("success");
  if (prefersReducedMotion() || typeof document === "undefined") return;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = window.innerWidth;
  const H = window.innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.className = "st-chat-burst";
  canvas.setAttribute("aria-hidden", "true");
  document.body.appendChild(canvas);
  ctx.scale(dpr, dpr);
  const ox = origin?.x ?? W / 2;
  const oy = origin?.y ?? H / 3;
  const stars = Array.from({ length: 36 }, (_, i) => {
    const angle = (i / 36) * Math.PI * 2 + Math.random() * 0.3;
    const speed = 2.5 + Math.random() * 5.5;
    return { x: ox, y: oy, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 2, r: 3.5 + Math.random() * 4.5, spin: Math.random() * Math.PI, color: STAR_COLOURS[i % STAR_COLOURS.length]! };
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
        const a = s.spin + (k * Math.PI) / 5;
        ctx.lineTo(s.x + Math.cos(a) * rad, s.y + Math.sin(a) * rad);
      }
      ctx.closePath();
      ctx.fill();
    }
    if (t < LIFE) requestAnimationFrame(tick);
    else canvas.remove();
  };
  requestAnimationFrame(tick);
}

// ---------- Words ----------

/** "0:42", "12:05". */
export function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "12 MB", "1.4 GB". */
export function size(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", else the date. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} day${s < 86400 * 2 ? "" : "s"} ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}
