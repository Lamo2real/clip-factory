// Settings › Posting › Money (docs/CONTRACTS.md §21): a "Do I get paid here?" switch per app, a box for the owner's
// real amount for 1,000 views (from the app's own money page), and where each usual amount comes from. The usual
// amounts live in config/earnings.json; the owner's choices are saved in Settings and follow them to every device.
import { useState, type FormEvent } from "react";
import type { Platform, Settings } from "../../api/types.ts";
import { useSession } from "../../app/session.tsx";
import { Icon } from "../../components/Icon.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { Button, Pill, Skeleton } from "../../components/ui.tsx";
import { APP_NAME, EARNINGS, formatRate, paidProgramNote, parseRate, rateFor, rateRange, sourceDate } from "../../lib/earnings.ts";
import { useAction } from "../../lib/motion.ts";
import { Apple, Panel } from "./parts.tsx";

const SHORT = APP_NAME;

/** "16 Nov 2026" from "2026-11-16". */
export function dayLabel(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** The app's mark on a small dark tile (like the stacks), so X's mark and the word "X" never read as "X X". */
function AppName({ platform }: { platform: Platform }) {
  return (
    <span className="money__app">
      <span className={`money__tile is-${platform}`} aria-hidden="true">
        <PlatformMark platform={platform} size={16} />
      </span>
      <span className="money__app-name">{SHORT[platform]}</span>
    </span>
  );
}

export function MoneyBranch() {
  const { me } = useSession();
  const s = me?.settings;
  return (
    <>
      <Panel>
        <Apple id="money-how" wide>
          <p className="money__how">
            <Pill tone="success" icon="info">
              Best guess
            </Pill>
            <span>Amounts are in US dollars, checked on {dayLabel(EARNINGS.asOf)}.</span>
          </p>
        </Apple>
      </Panel>
      <Panel>
        <Apple id="money-paid" wide>
          {!s ? (
            <Skeleton className="line-skel" />
          ) : (
            <ul className="money__list">
              {EARNINGS.order.map((p) => (
                <li key={p}>
                  <PaidRow platform={p} settings={s} />
                </li>
              ))}
            </ul>
          )}
        </Apple>
      </Panel>
      <Panel>
        <Apple id="money-rate" wide>
          {!s ? (
            <Skeleton className="line-skel" />
          ) : (
            <ul className="money__list">
              {EARNINGS.order.map((p) => (
                <li key={p}>
                  <RateRow platform={p} settings={s} />
                </li>
              ))}
            </ul>
          )}
        </Apple>
      </Panel>
      <Panel>
        <Apple id="money-sources" wide>
          <ul className="money__list">
            {EARNINGS.order.map((p) => (
              <li key={p}>
                <SourcesRow platform={p} />
              </li>
            ))}
          </ul>
        </Apple>
      </Panel>
    </>
  );
}

function PaidRow({ platform, settings }: { platform: Platform; settings: Settings }) {
  const { saveSettings } = useSession();
  const toast = useToast();
  const { paid } = rateFor(platform, settings);
  const name = SHORT[platform];
  return (
    <div className={`money__item${paid ? "" : " is-off"}`} data-money-paid={platform}>
      <div className="money__paid">
        <AppName platform={platform} />
        <span className="money__paid-word" aria-hidden="true">
          {paid ? "Yes" : "No"}
        </span>
        <button
          type="button"
          role="switch"
          className="switch"
          data-help-dodge=""
          aria-checked={paid}
          aria-label={`Do I get paid on ${name}?`}
          onClick={() => {
            const next = !paid;
            void saveSettings({ earningsPaid: { ...(settings.earningsPaid ?? {}), [platform]: next } }).then((saved) => {
              if (saved) toast.success(next ? `${name} is on. Clips earn money there.` : `${name} is off. Clips earn $0 there.`, { group: "money" });
            });
          }}
        >
          <span className="switch__thumb" />
        </button>
      </div>
      <p className="money__note">{EARNINGS.platforms[platform].kidNote}</p>
      {paid ? (
        <p className="money__rule" data-money-rule={platform}>
          <Icon name="info" size={16} />
          <span>{paidProgramNote(platform)}</span>
        </p>
      ) : null}
    </div>
  );
}

function RateRow({ platform, settings }: { platform: Platform; settings: Settings }) {
  const { saveSettings } = useSession();
  const toast = useToast();
  const usual = EARNINGS.platforms[platform];
  const inUse = rateFor(platform, settings);
  const name = SHORT[platform];
  const [text, setText] = useState(inUse.yours ? String(inUse.rate) : "");
  const [problem, setProblem] = useState<string | null>(null);
  const save = useAction("save");
  const reset = useAction("undo");
  const fieldId = `money-rate-${platform}`;
  const helpId = `money-rate-help-${platform}`;
  const errId = `money-rate-err-${platform}`;
  const rates = settings.earningsRates ?? {};

  /** Saves the typed amount: "ok", "invalid" (the box says why) or "failed" (the error toast already said why). */
  async function submit(e: FormEvent): Promise<"ok" | "invalid" | "failed"> {
    e.preventDefault();
    const parsed = parseRate(text);
    if (!parsed.ok) {
      setProblem(parsed.message);
      return "invalid";
    }
    setProblem(null);
    setText(String(parsed.value));
    const saved = await saveSettings({ earningsRates: { ...rates, [platform]: parsed.value } });
    if (!saved) return "failed";
    toast.success(`Saved. ${name} now uses ${formatRate(parsed.value)} for 1,000 views.`, { group: "money" });
    return "ok";
  }

  async function backToUsual() {
    const rest = { ...rates };
    delete rest[platform];
    setText("");
    setProblem(null);
    const saved = await saveSettings({ earningsRates: rest });
    if (!saved) return false;
    toast.success(`${name} uses the usual amount again.`, { group: "money" });
    return true;
  }

  return (
    <form
      className="money__item money__form"
      data-money-rate={platform}
      noValidate
      onSubmit={(e) => {
        // Enter in the box and the Save button both land here, once.
        void submit(e).then((r) => (r === "ok" ? save.play() : save.fail({ sound: r === "invalid" })));
      }}
    >
      <AppName platform={platform} />
      <p className="money__usual">
        Usually <strong>{formatRate(usual.typicalUsdPer1000)}</strong> <span className="money__range">({rateRange(platform)})</span>
      </p>
      <label className="money__label" htmlFor={fieldId}>
        Your amount for 1,000 views on {name}
      </label>
      <div className="money__row">
        <span className="money__input">
          <span className="money__dollar" aria-hidden="true">
            $
          </span>
          <input
            id={fieldId}
            className="input money__field"
            inputMode="decimal"
            autoComplete="off"
            placeholder={usual.typicalUsdPer1000.toFixed(2)}
            value={text}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? `${errId} ${helpId}` : helpId}
            onChange={(e) => {
              setText(e.target.value);
              if (problem) setProblem(null);
            }}
          />
        </span>
        <Button type="submit" size="sm" icon="check" act={save} playOnClick={false}>
          Save
        </Button>
        {inUse.yours ? (
          <Button size="sm" variant="ghost" icon="undo" act={reset} playOnClick={false} onClick={() => backToUsual().then((ok) => (ok ? reset.play() : reset.fail({ sound: false })))}>
            Use the usual
          </Button>
        ) : null}
      </div>
      {problem ? (
        <p className="field__status is-bad" id={errId} role="alert">
          <Icon name="alert" size={16} />
          <span>{problem}</span>
        </p>
      ) : null}
      <p className="money__help" id={helpId}>
        {inUse.yours ? `Using your amount: ${formatRate(inUse.rate)}.` : "Using the usual amount."}
      </p>
    </form>
  );
}

function SourcesRow({ platform }: { platform: Platform }) {
  const [open, setOpen] = useState(false);
  const usual = EARNINGS.platforms[platform];
  const id = `money-more-${platform}`;
  return (
    <div className="money__item" data-money-sources={platform}>
      <button type="button" className="money__more" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={16} />
        <AppName platform={platform} />
        <span className="money__more-word">{open ? "Hide" : "Show"}</span>
      </button>
      {open ? (
        <div className="money__sources" id={id}>
          {/* Plain words only; the full rules and units stay in config/earnings.json for maintainers. */}
          <p className="money__fine">
            <strong>Who gets paid: </strong>
            {usual.kidRules}
          </p>
          <p className="money__fine">
            <strong>What counts: </strong>
            {usual.kidCounts}
          </p>
          <ul className="money__links">
            {usual.sources.map((src) => (
              <li key={src.url}>
                <a className="text-link money__link" href={src.url} target="_blank" rel="noopener noreferrer">
                  {src.title}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
                <span className="money__date">{sourceDate(src.date)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
