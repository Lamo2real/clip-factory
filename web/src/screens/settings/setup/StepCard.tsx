// One big numbered step (docs/CONTRACTS.md §17.1): number, icon, title, a few short lines, then only what the step
// needs (Open, Copy chips, paste boxes, the upload box, a shut "If you see…" fold) and I did this. A done step folds
// to a leaf tick row; tapping it opens it again.
import type { ReactNode } from "react";
import { Icon } from "../../../components/Icon.tsx";
import { ActGlyph, Button } from "../../../components/ui.tsx";
import { useAction } from "../../../lib/motion.ts";
import type { GuideStep } from "../../../setup/index.ts";
import { CopyChip, Rich } from "./bits.tsx";

export function StepCard({
  step,
  number,
  done,
  open,
  current,
  primary,
  copyValue,
  onToggle,
  onDone,
  busy,
  children,
}: {
  step: GuideStep;
  number: number;
  done: boolean;
  /** Showing its words and buttons (the current step, or one the owner opened). */
  open: boolean;
  /** The first step that is not done yet. */
  current: boolean;
  /** This step's main action is the screen's one main (vermilion) button. */
  primary: boolean;
  /** The text each Copy chip copies (null while loading). */
  copyValue: (value: NonNullable<GuideStep["copy"]>[number]["value"]) => string | null;
  onToggle: () => void;
  /** Marks the step; may resolve to false when the mark could not be saved (the button then plays its failure). */
  onDone: (done: boolean) => unknown;
  busy?: boolean;
  /** The step's own controls: paste boxes, the upload box, Connect, a picker. */
  children?: ReactNode;
}) {
  const bodyId = `step-${step.id}-body`;
  const download = useAction("download");
  return (
    <li
      className={`gstep glass${done ? " is-done" : ""}${current ? " is-current" : ""}${open ? " is-open" : ""}`}
      id={`step-${step.id}`}
      data-step={step.id}
      data-help={`step-${step.id}`}
      data-done={done || undefined}
    >
      <button type="button" className="gstep__head" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <span className="gstep__num" aria-hidden="true">
          {done ? <Icon name="check" size={22} /> : number}
        </span>
        <span className="gstep__icon" aria-hidden="true">
          <Icon name={step.icon} size={22} />
        </span>
        <span className="gstep__title">
          <span className="sr-only">Step {number}: </span>
          {step.title}
          {done ? <span className="sr-only"> (done)</span> : null}
          {step.optional && !done ? <span className="gstep__optional">If you need it</span> : null}
        </span>
        <Icon name="chevronRight" size={20} className="icon gstep__chev act-turn" />
      </button>
      {open ? (
        <div className="gstep__body" id={bodyId}>
          <ul className="gstep__say">
            {step.say.map((line) => (
              <li key={line}>
                <Rich text={line} />
              </li>
            ))}
          </ul>
          {step.open || step.download ? (
            <div className="gstep__actions">
              {step.open ? (
                <a
                  className={`btn btn--${primary ? "primary" : "action"} btn--lg gstep__open`}
                  href={step.open.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Icon name="external" size={20} />
                  <span className="btn__label">{step.open.label}</span>
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              ) : null}
              {step.download ? (
                <a
                  className="btn btn--glass btn--md"
                  href={step.download.href}
                  download="clip-factory-icon.png"
                  data-act="download"
                  onClick={() => download.play()}
                >
                  <ActGlyph act={download}>
                    <Icon name="download" size={20} />
                  </ActGlyph>
                  <span className="btn__label">{step.download.label}</span>
                </a>
              ) : null}
            </div>
          ) : null}
          {step.copy?.length ? (
            <div className="gstep__copies">
              {step.copy.map((c) => (
                <CopyChip key={c.label} label={c.label} value={copyValue(c.value)} />
              ))}
            </div>
          ) : null}
          {children}
          {/* Only needed when the platform looks different: one fold, shut until tapped (like Find campaigns). */}
          {step.ifYouSee?.length ? (
            <details className="cr-fold">
              <summary className="cr-fold__q">
                <Icon name="info" size={18} />
                <span>If you see…</span>
                <Icon name="chevronRight" size={18} className="icon cr-fold__chev act-turn" />
              </summary>
              <div className="cr-fold__body">
                <ul className="gstep__hints">
                  {step.ifYouSee.map((h) => (
                    <li key={h.see} className="gstep__hint">
                      <Icon name="info" size={18} />
                      <span>
                        <strong className="gstep__hint-see">
                          If you see <Rich text={h.see} />:
                        </strong>{" "}
                        <Rich text={h.do} />
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          ) : null}
          {step.auto ? null : (
            <div className="gstep__done-row">
              {done ? (
                <Button size="sm" variant="ghost" icon="undo" act="undo" onClick={() => onDone(false)} loading={busy}>
                  Not done yet
                </Button>
              ) : (
                // A step with its own Open has that as its strong button; I did this is the green leaf glass (as in Get paid).
                <Button size="lg" variant={step.open ? "glass" : "action"} icon="check" act="tick" className={`${step.open ? "btn--leaf " : ""}gstep__done`} onClick={() => onDone(true)} loading={busy}>
                  I did this
                </Button>
              )}
            </div>
          )}
        </div>
      ) : null}
    </li>
  );
}
