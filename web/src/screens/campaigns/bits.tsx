// Small pieces every Content Rewards screen shares (docs/CONTRACTS.md §38.1): the numbered step card with its
// fold-outs, the Open button (exact https page, new tab), brand text shown as plain escaped words with Show more,
// the brand's picture or a round letter, and the green answer button.
import { useId, useState, type ReactNode } from "react";
import { Icon, type IconName } from "../../components/Icon.tsx";
import { Button } from "../../components/ui.tsx";
import { usePinMain } from "../../lib/contentRewards.ts";
import type { CrFold, CrStep } from "../../setup/types.ts";
import { CopyChip, Rich } from "../settings/setup/bits.tsx";

/** Brand text (names, briefs, notes) is untrusted: plain words, never HTML, at most 300 characters with Show more. */
export function BrandText({ text, max = 300, className = "" }: { text: string; max?: number; className?: string }) {
  const [all, setAll] = useState(false);
  const long = text.length > max;
  return (
    <span className={`user-text ${className}`}>
      {all || !long ? text : `${text.slice(0, max).trimEnd()}…`}
      {long ? (
        <button type="button" className="text-link cr-more" onClick={() => setAll((a) => !a)} aria-expanded={all}>
          {all ? "Show less" : "Show more"}
        </button>
      ) : null}
    </span>
  );
}

/** An Open button: the exact https page in a new tab (the desktop app hands it to the system browser). */
export function OpenButton({
  label,
  href,
  primary = false,
  size = "md",
  onOpen,
  icon = "external",
}: {
  label: string;
  href: string;
  primary?: boolean;
  size?: "sm" | "md" | "lg";
  onOpen?: () => void;
  icon?: IconName;
}) {
  if (!/^https:\/\//.test(href)) return null;
  return (
    <a
      className={`btn btn--${primary ? "primary" : "glass"} btn--${size} cr-open`}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-help-clear={primary ? "" : undefined}
      onClick={onOpen}
    >
      <Icon name={icon} size={20} />
      <span className="btn__label">{label}</span>
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/** A green answer button ("I sent it", "It says Submit clip", "I added it"). */
export function GreenButton({ children, onClick, loading, size = "md", icon = "check" }: { children: ReactNode; onClick: () => unknown; loading?: boolean; size?: "sm" | "md" | "lg"; icon?: IconName }) {
  return (
    <Button variant="glass" size={size} icon={icon} act="tick" className="btn--leaf" loading={loading} onClick={onClick}>
      {children}
    </Button>
  );
}

/** The brand's picture (copied into the media bucket by the API), else a round letter. */
export function BrandMark({ name, url, size = 44 }: { name: string; url?: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  const letter = (name.trim()[0] ?? "?").toUpperCase();
  return url && !broken ? (
    <img className="cr-brand" src={url} alt="" width={size} height={size} style={{ width: size, height: size }} onError={() => setBroken(true)} />
  ) : (
    <span className="cr-brand cr-brand--letter" aria-hidden="true" style={{ width: size, height: size }}>
      {letter}
    </span>
  );
}

/** "If you see X, do Y" hints. */
export function Hints({ list }: { list: { see: string; do: string }[] | undefined }) {
  if (!list?.length) return null;
  return (
    <ul className="gstep__hints">
      {list.map((h) => (
        <li key={h.see} className="gstep__hint">
          <Icon name="info" size={18} />
          <span>
            {/* The lead-in is quiet: only the other site's own labels are bold (§38.1). */}
            <span className="gstep__hint-see">
              If you see <Rich text={h.see} />:
            </span>{" "}
            <Rich text={h.do} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Short lines, one action each (bold = the other site's own label). */
export function Lines({ lines, className = "gstep__say" }: { lines: readonly string[]; className?: string }) {
  if (!lines.length) return null;
  return (
    <ul className={className}>
      {lines.map((line) => (
        <li key={line}>
          <Rich text={line} />
        </li>
      ))}
    </ul>
  );
}

/** An unnumbered helper inside a step: a question that opens more lines. */
export function Fold({ fold, open, onToggle }: { fold: Pick<CrFold, "id" | "question" | "say" | "open" | "ifYouSee">; open?: boolean; onToggle?: (open: boolean) => void }) {
  const id = useId();
  return (
    <details
      className="cr-fold"
      id={fold.id}
      data-fold={fold.id}
      open={open}
      onToggle={(e) => onToggle?.((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cr-fold__q" aria-controls={`${id}-body`}>
        <Icon name="info" size={18} />
        <span>
          <Rich text={fold.question} />
        </span>
        <Icon name="chevronRight" size={18} className="icon cr-fold__chev act-turn" />
      </summary>
      <div className="cr-fold__body" id={`${id}-body`}>
        <Lines lines={fold.say} />
        {fold.open ? (
          <div className="gstep__actions">
            <OpenButton label={fold.open.label} href={fold.open.url} />
          </div>
        ) : null}
        <Hints list={fold.ifYouSee} />
      </div>
    </details>
  );
}

/**
 * One numbered Content Rewards step (the §17.1 card): number in a circle, icon, title, a few short lines, then
 * only what the step needs, and "I did this" (green). A step Clip Factory can see ticks itself.
 */
export function CrStepCard({
  step,
  number,
  done,
  open,
  current,
  primary,
  onToggle,
  onDone,
  busy,
  say,
  children,
  copies,
  lead,
}: {
  step: CrStep;
  /** null: an unnumbered card ("Content Rewards said no?"). */
  number: number | null;
  done: boolean;
  open: boolean;
  current: boolean;
  /** The step's Open is the screen's one vermilion button. */
  primary: boolean;
  onToggle: () => void;
  onDone?: (done: boolean) => unknown;
  busy?: boolean;
  /** Lines that replace the step's own (Connect's words depend on where the page runs). */
  say?: readonly string[];
  children?: ReactNode;
  /** Copy chips made from live values (the owner's account links, the amount to move). */
  copies?: { label: string; value: string | null }[];
  /** The `lead` with live words ("Already added YouTube and Instagram there? Tap I added them."). */
  lead?: string;
}) {
  const bodyId = `step-${step.id}-body`;
  const manual = step.manual !== false;
  // Phones: the step's vermilion Open sits last in the card and stays pinned at the bottom right while the card is on
  // screen (§38.1). Elsewhere it sits right under the step's lines.
  const pin = usePinMain() && primary && !!step.open;
  const openEl = step.open ? <OpenButton label={step.open.label} href={step.open.url} primary={primary} size="lg" /> : null;
  // §39.1: a step with a `lead` and its own answer ("I have an account") puts that green answer right under its Open
  // button, before the other lines, so someone who already did it taps once.
  const early = manual && !!onDone && !!step.doneLabel && !done;
  const answerEl = early ? (
    <Button size="lg" variant="glass" icon="check" act="tick" className="btn--leaf gstep__done" onClick={() => onDone!(true)} loading={busy}>
      {step.doneLabel}
    </Button>
  ) : null;
  return (
    <li
      className={`gstep glass${done ? " is-done" : ""}${current ? " is-current" : ""}${open ? " is-open" : ""}${number === null ? " is-helper" : ""}`}
      id={`step-${step.id}`}
      data-step={step.id}
      data-help={`step-${step.id}`}
      data-done={done || undefined}
    >
      <button type="button" className="gstep__head" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <span className="gstep__num" aria-hidden="true">
          {done ? <Icon name="check" size={22} /> : number !== null ? number : <Icon name="info" size={20} />}
        </span>
        <span className="gstep__icon" aria-hidden="true">
          <Icon name={step.icon} size={22} />
        </span>
        <span className="gstep__title">
          {number !== null ? <span className="sr-only">Step {number}: </span> : null}
          <Rich text={step.title} />
          {done ? <span className="sr-only"> (done)</span> : null}
        </span>
        <Icon name="chevronRight" size={20} className="icon gstep__chev act-turn" />
      </button>
      {open ? (
        <div className={`gstep__body${pin ? " has-pin" : ""}`} id={bodyId}>
          {step.lead ? (
            <p className="gstep__lead">
              <Rich text={lead ?? step.lead} />
            </p>
          ) : null}
          {early && !pin ? (
            <div className="gstep__actions gstep__actions--stack">
              {openEl}
              {answerEl}
            </div>
          ) : null}
          <Lines lines={say ?? step.say} />
          {openEl && !pin && !early ? <div className="gstep__actions">{openEl}</div> : null}
          {copies?.length || step.copy?.length ? (
            <div className="gstep__copies">
              {(copies ?? []).map((c) => (
                <CopyChip key={c.label} label={c.label} value={c.value} quiet />
              ))}
            </div>
          ) : null}
          {children}
          {step.folds?.length ? (
            <div className="cr-folds">
              {step.folds.map((f) => (
                <Fold key={f.id} fold={f} />
              ))}
            </div>
          ) : null}
          <Hints list={step.ifYouSee} />
          {manual && onDone && !early ? (
            <div className="gstep__done-row">
              {done ? (
                <Button size="sm" variant="ghost" icon="undo" act="undo" onClick={() => onDone(false)} loading={busy}>
                  Not done yet
                </Button>
              ) : (
                <Button size="lg" variant="glass" icon="check" act="tick" className="btn--leaf gstep__done" onClick={() => onDone(true)} loading={busy}>
                  I did this
                </Button>
              )}
            </div>
          ) : null}
          {pin ? (
            <div className={`gstep__actions cr-pin${early ? " cr-pin--stack" : ""}`}>
              {openEl}
              {answerEl}
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** A soft callout with an icon (no edges). */
export function Note({ icon = "info", tone = "info", children, role }: { icon?: IconName; tone?: "info" | "bad" | "ok"; children: ReactNode; role?: "status" | "alert" }) {
  return (
    <p className={`callout callout--${tone === "bad" ? "bad" : "info"}${tone === "ok" ? " cr-ok" : ""}`} role={role}>
      <Icon name={icon} size={18} />
      <span>{children}</span>
    </p>
  );
}
