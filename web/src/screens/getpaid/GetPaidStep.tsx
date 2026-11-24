// One Get paid step card (docs/CONTRACTS.md §40.1): the §17.1 and §38.1 card. Number in a circle ("Optional" for the
// reading step), an icon, a short title, then only what the step needs: its Open (exact https page, new tab), short
// lines, Copy chips, "If you see X, do Y" hints and the green answer. A step Clip Factory can see ticks itself and
// says how ("YouTube says you're in"); a step it can't see has the green answer. A done step folds to a tick row that
// says who said so. A `phone` step on a computer says to use the phone and has no Open.
import { Fragment, type ReactNode } from "react";
import type { Platform } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { Button } from "../../components/ui.tsx";
import { phoneApp } from "../../getpaid/index.ts";
import type { GetPaidStep as Step } from "../../getpaid/types.ts";
import { phoneLine } from "../../lib/getPaid.ts";
import { Hints, OpenButton } from "../campaigns/bits.tsx";
import { CopyChip, Rich } from "../settings/setup/bits.tsx";

export interface StepState {
  done: boolean;
  by: "you" | "auto" | null;
  /** "YouTube says you're in" */
  auto?: string;
}

/** Who said a done step is done: the platform's words, or "You said it's done". */
export function whoSaid(state: StepState): string {
  return state.by === "auto" && state.auto ? state.auto : "You said it's done";
}

/** The step's main action, as one button: its first Open, or Clip Factory's own action (Allow payment reading). */
export function MainAction({
  step,
  primary,
  onAction,
  busy,
}: {
  step: Step;
  primary: boolean;
  onAction?: () => unknown;
  busy?: boolean;
}) {
  if (step.action === "allow_payment_reading")
    return (
      <Button variant={primary ? "primary" : "glass"} size="lg" icon="eye" act="connect" loading={busy} onClick={() => onAction?.()} data-help-clear={primary ? "" : undefined} data-gp="allow-payments">
        Allow payment reading
      </Button>
    );
  return step.open ? <OpenButton label={step.open.label} href={step.open.url} primary={primary} size="lg" /> : null;
}

export function GetPaidStep({
  step,
  place,
  number,
  state,
  open,
  current,
  primary,
  pinned,
  phone,
  onToggle,
  onDone,
  onAction,
  busy,
  actionBusy,
  children,
}: {
  step: Step;
  place: Platform;
  /** null: the optional reading step ("Optional") or an each-time step (unnumbered). */
  number: number | null;
  state: StepState;
  open: boolean;
  /** The first step not done. */
  current: boolean;
  /** This step's main action is the page's one vermilion. */
  primary: boolean;
  /** Phones: the page pins this step's main action at the bottom right, so the card leaves it out. */
  pinned: boolean;
  /** This device is a phone (a `phone` step's Open opens the app). */
  phone: boolean;
  onToggle: () => void;
  onDone?: (done: boolean) => unknown;
  onAction?: () => unknown;
  busy?: boolean;
  actionBusy?: boolean;
  /** The step's own extras (Allow payment reading's last result). */
  children?: ReactNode;
}) {
  const bodyId = `step-${step.id}-body`;
  const reading = step.role === "reading";
  const each = step.role === "each_time";
  const manual = step.manual !== false && !!onDone;
  // On a computer, a step done in a phone app has no Open: the website doesn't have those screens.
  const away = !!step.phone && !phone;
  const main = away || pinned ? null : <MainAction step={step} primary={primary} onAction={onAction} busy={actionBusy} />;
  const openFirst = main && !step.action;
  const copies = step.copy?.length ? (
    <div className="gstep__copies" key="copies">
      {step.copy.map((c) => (
        <CopyChip key={c.label} label={c.label} value={c.value} quiet />
      ))}
    </div>
  ) : null;
  const copyAt = step.copyAt ?? step.say.length;
  return (
    <li
      className={`gstep glass gp-step${state.done ? " is-done" : ""}${current ? " is-current" : ""}${open ? " is-open" : ""}${reading ? " is-optional" : ""}${each ? " is-helper" : ""}`}
      id={`step-${step.id}`}
      data-step={step.id}
      data-help={`step-${step.id}`}
      data-done={state.done || undefined}
      data-by={state.done ? (state.by ?? "you") : undefined}
    >
      <button type="button" className="gstep__head" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <span className={`gstep__num${reading && !state.done ? " gp-step__optional" : ""}`} aria-hidden="true">
          {state.done ? <Icon name="check" size={22} /> : reading ? "Optional" : number !== null ? number : <Icon name={step.icon} size={20} />}
        </span>
        {number !== null || reading ? (
          <span className="gstep__icon" aria-hidden="true">
            <Icon name={step.icon} size={22} />
          </span>
        ) : null}
        <span className="gstep__title">
          {number !== null ? <span className="sr-only">Step {number}: </span> : reading ? <span className="sr-only">Optional: </span> : null}
          {step.title}
          {state.done ? (
            <span className="gp-step__who" data-who={state.by ?? "you"}>
              {whoSaid(state)}
            </span>
          ) : null}
        </span>
        <Icon name="chevronRight" size={20} className="icon gstep__chev act-turn" />
      </button>
      {open ? (
        <div className="gstep__body" id={bodyId}>
          {step.lead ? (
            <p className="gstep__lead">
              <Rich text={step.lead} />
            </p>
          ) : null}
          {step.when ? (
            <p className="gp-step__when">
              <Icon name="clock" size={18} />
              <span>{step.when}</span>
            </p>
          ) : null}
          {away ? (
            <p className="gp-step__phone">
              <Icon name="phone" size={18} />
              <span>{phoneLine(phoneApp(place))}</span>
            </p>
          ) : null}
          {openFirst ? <div className="gstep__actions">{main}</div> : null}
          {/* A step whose main button is Clip Factory's own (Allow payment reading) still opens its page first, in glass. */}
          {step.action && step.open && !away ? (
            <div className="gstep__actions">
              <OpenButton label={step.open.label} href={step.open.url} size="md" />
            </div>
          ) : null}
          <ul className="gstep__say">
            {step.say.map((line, i) => (
              <Fragment key={line}>
                {i === copyAt ? <li className="gp-step__inline">{copies}</li> : null}
                {step.more
                  ?.filter((m) => m.before === i && !away)
                  .map((m) => (
                    <li key={m.url} className="gp-step__inline">
                      <OpenButton label={m.label} href={m.url} size="md" />
                    </li>
                  ))}
                <li>
                  <Rich text={line} />
                </li>
              </Fragment>
            ))}
          </ul>
          {copyAt >= step.say.length ? copies : null}
          {main && step.action ? <div className="gstep__actions">{main}</div> : null}
          {children}
          {/* Only needed when the place looks different: one fold, shut until tapped (as in the setup guides). */}
          {step.ifYouSee?.length ? (
            <details className="cr-fold">
              <summary className="cr-fold__q">
                <Icon name="info" size={18} />
                <span>If you see…</span>
                <Icon name="chevronRight" size={18} className="icon cr-fold__chev act-turn" />
              </summary>
              <div className="cr-fold__body">
                <Hints list={step.ifYouSee} />
                {step.ifYouSee.some((h) => h.open) ? (
                  <div className="gstep__actions">
                    {step.ifYouSee
                      .filter((h) => h.open)
                      .map((h) => (
                        <OpenButton key={h.open!.url} label={h.open!.label} href={h.open!.url} size="md" />
                      ))}
                  </div>
                ) : null}
              </div>
            </details>
          ) : null}
          {manual ? (
            <div className="gstep__done-row">
              {state.done ? (
                state.by === "auto" ? null : (
                  <Button size="sm" variant="ghost" icon="undo" act="undo" onClick={() => onDone!(false)} loading={busy}>
                    Not done yet
                  </Button>
                )
              ) : (
                <Button size="lg" variant="glass" icon="check" act="tick" className="btn--leaf gstep__done" onClick={() => onDone!(true)} loading={busy}>
                  {step.doneLabel ?? "I did this"}
                </Button>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
