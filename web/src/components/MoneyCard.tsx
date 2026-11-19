// One platform's money card (docs/CONTRACTS.md §25.7): its state pill, one plain line, the money it reported (tagged
// as that platform's estimate, never "paid"), up to three eased goal bars with the rest under More, explanations
// behind a small "?", a grey "2–3 days behind · checked 2 h ago" line, and at most one vermilion button.
import { useId, useState } from "react";
import { api, friendlyMessage } from "../api/index.ts";
import type { MoneyCard as Card, MoneyGoal, MoneyRevenue } from "../api/types.ts";
import { checkedAgo, formatMoney, fraction, goalText, SHOWN_GOALS, STATE_TONE } from "../lib/money.ts";
import { PLATFORM_LABEL } from "../lib/format.ts";
import { useAction } from "../lib/motion.ts";
import { CopyChip } from "../screens/settings/setup/bits.tsx";
import { Icon } from "./Icon.tsx";
import { PlatformMark } from "./PlatformMark.tsx";
import { useToast } from "./Toasts.tsx";
import { Button, Pill } from "./ui.tsx";

/** A small "?" that opens one explanation under the line it belongs to (kept out of the way: one number, one bar). */
function WhyButton({ open, onToggle, controls, label }: { open: boolean; onToggle: () => void; controls: string; label: string }) {
  return (
    <button type="button" className="money-why" aria-expanded={open} aria-controls={controls} aria-label={`What does ${label} mean?`} onClick={onToggle}>
      ?
    </button>
  );
}

function Goal({ goal, or }: { goal: MoneyGoal; or: boolean }) {
  const f = fraction(goal);
  const text = goalText(goal);
  const why = [goal.note, goal.help, goal.approx && goal.kind !== "number" ? "About: this is our count." : undefined].filter(Boolean).join(" ");
  const [open, setOpen] = useState(false);
  const whyId = useId();
  return (
    <li className={`money-goal is-${goal.kind}${goal.reached ? " is-reached" : ""}`} data-goal={goal.key}>
      {or ? <span className="money-goal__or">or</span> : null}
      <p className="money-goal__line">
        {goal.kind === "tick" ? (
          <Icon name={goal.reached ? "checkCircle" : "xCircle"} size={18} className={`icon money-goal__tick${goal.reached ? " is-on" : ""}`} />
        ) : goal.reached ? (
          <Icon name="checkCircle" size={18} className="icon money-goal__tick is-on" />
        ) : null}
        <span className="money-goal__text">
          {text}
          {/* The "?" stays glued to the last word, so it never wraps onto a row of its own. */}
          {why ? (
            <span className="money-goal__why">
              {"\u00a0"}
              <WhyButton open={open} onToggle={() => setOpen((o) => !o)} controls={whyId} label={goal.label} />
            </span>
          ) : null}
        </span>
        {why && open ? (
          <span className="money-why__text" id={whyId} role="note">
            {why}
          </span>
        ) : null}
      </p>
      {goal.kind === "bar" && goal.current !== null ? (
        <span
          className="money-bar"
          role="progressbar"
          aria-label={text}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(f * 100)}
        >
          <span className="money-bar__fill" style={{ inlineSize: `${Math.round(f * 100)}%` }} />
        </span>
      ) : null}
      {goal.missing ? <p className="money-goal__missing">{goal.missing}</p> : null}
    </li>
  );
}

function Goals({ goals }: { goals: MoneyGoal[] }) {
  return (
    <ul className="money-goals">
      {goals.map((g, i) => (
        <Goal key={g.key} goal={g} or={i > 0 && goals[i - 1]!.or === g.key} />
      ))}
    </ul>
  );
}

/** The last 30 reported days as a small line (hidden with fewer than two days). */
function MoneySpark({ revenue }: { revenue: MoneyRevenue }) {
  const days = revenue.last30;
  if (days.length < 2) return null;
  const w = 120;
  const h = 32;
  const max = Math.max(...days.map((d) => d.amountMicros), 1);
  const pts = days.map((d, i) => `${Math.round((i / (days.length - 1)) * (w - 4) + 2)},${Math.round(h - 2 - (d.amountMicros / max) * (h - 4))}`).join(" ");
  return (
    <svg className="spark money-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={`Each day for the last ${days.length} days that ${PLATFORM_LABEL[revenue.platform]} reported`}>
      <polyline className="spark__line" points={pts} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Revenue({ revenue }: { revenue: MoneyRevenue }) {
  return (
    <div className="money-revenue" data-money="revenue">
      <p className="money-revenue__line">
        <span className="money-revenue__lead">This month</span>
        <strong className="money-revenue__num">{formatMoney(revenue.thisMonthMicros, revenue.currency)}</strong>
        <span className="money-tag">{revenue.tag}</span>
      </p>
      <MoneySpark revenue={revenue} />
      {revenue.note ? <p className="money-card__fine">{revenue.note}</p> : null}
    </div>
  );
}

function Where({ label, url, lead }: { label: string; url?: string; lead: string }) {
  return (
    <p className="money-card__where">
      <span>{lead} </span>
      {url ? (
        <a className="text-link" href={url} target="_blank" rel="noopener noreferrer">
          {label}
          <Icon name="external" size={14} />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : (
        <strong>{label}</strong>
      )}
    </p>
  );
}

/** "Allow money reading": one vermilion button that does the whole round trip, with the grown-up steps folded away. */
function Permission({ card }: { card: Card }) {
  const need = card.needsPermission!;
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState(false);
  const act = useAction("connect");
  const id = useId();
  async function allow() {
    setBusy(true);
    try {
      const { authorizeUrl } = await api().connectAccount(card.platform, "money");
      // Only the platform's own https page, or the pretend app's Money page, is ever opened.
      if (!/^https:\/\//.test(authorizeUrl) && !authorizeUrl.startsWith("/settings/posting/money?")) throw new Error("bad authorize url");
      location.assign(authorizeUrl);
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      setBusy(false);
      return false;
    }
  }
  return (
    <div className="money-permission" data-money-permission={card.platform}>
      <Button variant="action" size="lg" icon="key" act={act} loading={busy} onClick={allow} className="money-permission__go">
        {need.button}
      </Button>
      <button type="button" className="money-more text-link" aria-expanded={steps} aria-controls={id} onClick={() => setSteps((s) => !s)}>
        <Icon name={steps ? "chevronDown" : "chevronRight"} size={16} />
        First time? Steps for a grown-up
      </button>
      {steps ? (
        <div className="money-permission__steps" id={id}>
          <ol>
            {need.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          {/* Quiet copy buttons: "Allow money reading" stays the card's only vermilion button (§25.7). */}
          {need.copy?.map((c) => <CopyChip key={c.value} label={c.label} value={c.value} quiet />)}
          {need.open ? (
            <a className="text-link" href={need.open.url} target="_blank" rel="noopener noreferrer">
              {need.open.label}
              <Icon name="external" size={14} />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function MoneyCard({ card, now = Date.now(), named = true }: { card: Card; now?: number; named?: boolean }) {
  const [more, setMore] = useState(false);
  const moreId = useId();
  const name = PLATFORM_LABEL[card.platform];
  const shown = card.goals.slice(0, SHOWN_GOALS);
  const hidden = [...card.goals.slice(SHOWN_GOALS), ...card.more];
  const checked = checkedAgo(card.checkedAt, now);
  const fine = [card.lagNote, checked].filter(Boolean).join(" · ");
  return (
    <article className={`money-card is-${card.state}`} data-money-card={card.platform} aria-labelledby={`money-${card.platform}-name`}>
      <header className="money-card__head">
        <span className={`money-card__mark is-${card.platform}`} aria-hidden="true">
          <PlatformMark platform={card.platform} size={20} />
        </span>
        <h3 className={`money-card__name${named ? "" : " sr-only"}`} id={`money-${card.platform}-name`}>
          {name}
        </h3>
        <span className="money-card__pill" data-money-state={card.state}>
          <Pill tone={STATE_TONE[card.state]} icon={card.state === "earning" || card.state === "in_program" ? "checkCircle" : undefined}>
            {card.pill}
          </Pill>
        </span>
      </header>
      <p className="money-card__line">{card.line}</p>
      {card.revenue ? <Revenue revenue={card.revenue} /> : null}
      {card.approxMonth ? (
        <p className="money-card__fine">
          Meta's approximate number this month: {formatMoney(card.approxMonth.amountMicros, card.approxMonth.currency)} · {card.approxMonth.tag} · {card.approxMonth.note}
        </p>
      ) : null}
      {card.comingSoon ? <p className="money-card__soon">{card.comingSoon}</p> : null}
      {/* One "not shared" sentence per card: the not_available line already says it. */}
      {card.notShared && card.state !== "not_available" ? <p className="money-card__fine">{card.notShared}</p> : null}
      {card.needsPermission ? <Permission card={card} /> : null}
      {shown.length ? <Goals goals={shown} /> : null}
      {hidden.length ? (
        <>
          <button type="button" className="money-more text-link" aria-expanded={more} aria-controls={moreId} onClick={() => setMore((m) => !m)}>
            <Icon name={more ? "chevronDown" : "chevronRight"} size={16} />
            {more ? "Less" : "More"}
          </button>
          {more ? (
            <div id={moreId}>
              <Goals goals={hidden} />
            </div>
          ) : null}
        </>
      ) : null}
      {card.extras.length ? (
        <ul className="money-card__extras">
          {card.extras.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      {card.state !== "not_connected" ? (
        <>
          <Where lead="Program status:" label={card.statusWhere.label} url={card.statusWhere.url} />
          <Where lead="Money you get:" label={card.paidWhere.label} url={card.paidWhere.url} />
        </>
      ) : null}
      {card.lastError && card.state !== "error" ? <p className="money-card__fine">{card.lastError}</p> : null}
      {fine ? <p className="money-card__fine money-card__checked">{fine}</p> : null}
    </article>
  );
}
