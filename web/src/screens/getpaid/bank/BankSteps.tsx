// Your bank's step cards (docs/CONTRACTS.md §40.5.2): the §40.1 cards. A number in a circle ("Optional" for the
// email), an icon, a short title, then only what the step needs: its Open, short lines, Copy chips, the paste and
// upload boxes (step 5), "If you see" hints and the green answer. A step Clip Factory can see ticks itself and says
// how ("Enable Banking knows your app"). Only while all seven are done do they fold to one green row, which unfolds
// again as soon as one stops being done. Each-time lines sit under the numbered ones.
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type { BankStepId, BankView } from "../../../api/types.ts";
import { Icon } from "../../../components/Icon.tsx";
import { Button } from "../../../components/ui.tsx";
import { ActGlyph } from "../../../components/ui.tsx";
import { BANK_GUIDE, EACH_TIME_BEFORE, EACH_TIME_LOOK, bankStepNumber, copyValue, countryName, eachTimeEvery, firstLine, mailtoOf, type BankCopy, type BankStep } from "../../../getpaid/bank.ts";
import { useAction } from "../../../lib/motion.ts";
import { Rich, copyText } from "../../settings/setup/bits.tsx";

/** A Copy chip: Enable Banking's label (bold) or Clip Factory's words; a long value shows its first line and "…". */
export function BankCopyChip({ copy, view }: { copy: BankCopy; view: Pick<BankView, "values" | "key"> }) {
  const value = copyValue(copy.from, view);
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const act = useAction("copy");
  useEffect(() => () => clearTimeout(timer.current), []);
  const name = copy.label.replace(/\*\*/g, "");
  async function go() {
    if (value === null) return;
    act.play();
    const ok = await copyText(value);
    if (!ok) act.fail();
    setState(ok ? "copied" : "failed");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2400);
  }
  return (
    <div className={`copy-chip is-quiet${state === "copied" ? " is-copied" : ""}`} data-copy={copy.from}>
      <span className="copy-chip__text">
        <span className="copy-chip__label">
          <Rich text={copy.label} />
        </span>
        <code className="copy-chip__value">{value === null ? "Loading…" : copy.short ? firstLine(value) : value}</code>
      </span>
      <button type="button" className="copy-chip__btn" onClick={() => void go()} aria-disabled={value === null || undefined} aria-label={state === "copied" ? `${name} copied` : `Copy ${name}`} data-act="copy">
        <ActGlyph act={act}>
          <Icon name={state === "copied" ? "check" : "copy"} size={18} />
        </ActGlyph>
        <span aria-live="polite">{state === "copied" ? "Copied!" : state === "failed" ? "Selected: copy it" : "Copy"}</span>
      </button>
    </div>
  );
}

/** "Do this in…" lines filled in: step 6's {country} is his Money country's English name. */
function fill(line: string, view: BankView): string {
  return line.replace("{country}", countryName(view.country));
}

export type StepState = BankView["steps"][number];

/** Who said a done step is done: Clip Factory's own words for a step it saw, or "You said it's done". */
export const whoSaid = (s: StepState) => (s.by === "auto" && s.auto ? s.auto : "You said it's done");

export function BankStepCard({
  step,
  view,
  state,
  open,
  current,
  onToggle,
  main,
  onTick,
  onLinked,
  busy,
  children,
}: {
  step: BankStep;
  view: BankView;
  state: StepState;
  open: boolean;
  current: boolean;
  onToggle: () => void;
  /** The step's main action (its Open or Clip Factory's own button), or null when it is pinned or has none. */
  main: ReactNode;
  onTick: (id: BankStepId, done: boolean) => unknown;
  /** Step 6's green answer: "I linked them" runs the check. */
  onLinked: () => unknown;
  busy: string | null;
  children?: ReactNode;
}) {
  const n = bankStepNumber(step.id);
  const optional = step.role === "optional";
  const bodyId = `step-${step.id}-body`;
  const openFirst = !!main && !step.action;
  const copyAt = step.copyAt ?? step.say.length;
  const copies = step.copy?.length ? (
    <div className="gstep__copies">
      {step.copy.map((c) => (
        <BankCopyChip key={c.label} copy={c} view={view} />
      ))}
    </div>
  ) : null;
  const manual = step.manual !== false;
  return (
    <li
      className={`gstep glass gp-step bank-step${state.done ? " is-done" : ""}${current ? " is-current" : ""}${open ? " is-open" : ""}${optional ? " is-optional" : ""}`}
      id={`step-${step.id}`}
      data-step={step.id}
      data-help={`step-${step.id}`}
      data-done={state.done || undefined}
      data-by={state.done ? (state.by ?? "you") : undefined}
    >
      <button type="button" className="gstep__head" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        <span className={`gstep__num${optional && !state.done ? " gp-step__optional" : ""}`} aria-hidden="true">
          {state.done ? <Icon name="check" size={22} /> : optional ? "Optional" : n}
        </span>
        <span className="gstep__icon" aria-hidden="true">
          <Icon name={step.icon} size={22} />
        </span>
        <span className="gstep__title">
          {n !== null ? <span className="sr-only">Step {n}: </span> : <span className="sr-only">Optional: </span>}
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
          {step.mail ? (
            <div className="gstep__actions">
              {/* The one Open that isn't https: his own email app, with the email filled in. Never the vermilion. */}
              <a className="btn btn--glass btn--md cr-open" href={mailtoOf(view.values.ask)} data-bank="mailto">
                <Icon name="fileText" size={20} />
                <span className="btn__label">{step.open!.label}</span>
              </a>
            </div>
          ) : openFirst ? (
            <div className="gstep__actions">{main}</div>
          ) : null}
          <ul className="gstep__say">
            {step.say.map((line, i) => (
              <Fragment key={line}>
                {i === copyAt ? <li className="gp-step__inline">{copies}</li> : null}
                <li>
                  <Rich text={fill(line, view)} />
                </li>
              </Fragment>
            ))}
          </ul>
          {copyAt >= step.say.length ? copies : null}
          {main && step.action ? <div className="gstep__actions">{main}</div> : null}
          {children}
          {step.ifYouSee?.length ? (
            <ul className="gstep__hints">
              {step.ifYouSee.map((h) => (
                <li key={h.see} className="gstep__hint">
                  <Icon name="info" size={18} />
                  <span>
                    <span className="gstep__hint-see">
                      If you see <Rich text={h.see} />:
                    </span>{" "}
                    <Rich text={h.do} />
                    {h.copy ? <BankCopyChip copy={h.copy} view={view} /> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {step.id === "bank-link" ? (
            state.done ? null : (
              <div className="gstep__done-row">
                <Button size="lg" variant="glass" icon="check" act="tick" className="btn--leaf gstep__done" loading={busy === step.id} onClick={onLinked}>
                  {step.doneLabel}
                </Button>
              </div>
            )
          ) : manual ? (
            <div className="gstep__done-row">
              {state.done ? (
                state.by === "auto" ? null : (
                  <Button size="sm" variant="ghost" icon="undo" act="undo" onClick={() => onTick(step.id, false)} loading={busy === step.id}>
                    Not done yet
                  </Button>
                )
              ) : (
                <Button size="lg" variant="glass" icon="check" act="tick" className="btn--leaf gstep__done" onClick={() => onTick(step.id, true)} loading={busy === step.id}>
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

/** The each-time lines (unnumbered, never in the ring). */
export function eachTimeLines(view: BankView): string[] {
  const days = view.links.filter((l) => l.status !== "stopped" && l.totalDays).map((l) => l.totalDays!);
  return [EACH_TIME_LOOK, days.length ? eachTimeEvery(Math.min(...days)) : EACH_TIME_BEFORE];
}

export function BankSteps({
  view,
  isOpen,
  onToggle,
  current,
  mainOf,
  onTick,
  onLinked,
  busy,
  keyBox,
  linkCheck,
}: {
  view: BankView;
  isOpen: (id: BankStepId) => boolean;
  onToggle: (id: BankStepId) => void;
  current: BankStepId | null;
  mainOf: (step: BankStep) => ReactNode;
  onTick: (id: BankStepId, done: boolean) => unknown;
  onLinked: () => unknown;
  busy: string | null;
  keyBox: ReactNode;
  /** Step 6's check sentence, after "I linked them". */
  linkCheck: string | null;
}) {
  const [unfold, setUnfold] = useState(false);
  const stateOf = (id: BankStepId): StepState => view.steps.find((s) => s.id === id) ?? { id, done: false, by: null };
  const folded = !!view.fold && !unfold;
  const card = (step: BankStep) => (
    <BankStepCard
      key={step.id}
      step={step}
      view={view}
      state={stateOf(step.id)}
      open={isOpen(step.id)}
      current={current === step.id}
      onToggle={() => onToggle(step.id)}
      main={mainOf(step)}
      onTick={onTick}
      onLinked={onLinked}
      busy={busy}
    >
      {step.id === "bank-appid" ? keyBox : null}
      {step.id === "bank-link" && linkCheck ? (
        <p className="gp-result" role="status">
          <Icon name="info" size={18} />
          <span>
            <Rich text={linkCheck} />
          </span>
        </p>
      ) : null}
    </BankStepCard>
  );
  return (
    <section className="setup-part bank-steps" data-help="bank-steps" aria-labelledby="bank-steps-title">
      <h2 className="setup-part__title" id="bank-steps-title">
        Do these once
      </h2>
      {view.fold ? (
        <button type="button" className="bank-fold glass" aria-expanded={!folded} onClick={() => setUnfold((u) => !u)} data-bank="fold">
          <span className="gstep__num" aria-hidden="true">
            <Icon name="check" size={22} />
          </span>
          <span className="bank-fold__words">{view.fold}</span>
          <Icon name="chevronDown" size={20} className="icon act-turn" />
        </button>
      ) : null}
      {folded ? null : <ol className="guide-steps">{BANK_GUIDE.steps.map(card)}</ol>}
      <h2 className="setup-part__title" id="bank-each-title">
        Each time you get money
      </h2>
      <div className="gp-each glass">
        <ul className="gstep__say">
          {eachTimeLines(view).map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
