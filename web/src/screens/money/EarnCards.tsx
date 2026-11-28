// Money › Can I earn? (docs/CONTRACTS.md §58): one glass card per connected app that says, in one word, whether
// its money program is open to the owner yet, with an eased bar per requirement, one line on what to do next and one
// folded Details section. The words, the percent and the next step come from the server (`MoneyCard.ready`); this
// only draws them. Celebrations ("You can join YouTube Partner Program!") play once through useMoney, never here.
// No money amounts (they're elsewhere on this page). Loading draws a skeleton; an error, or an API from before this
// change (no card has `ready`), draws nothing.
import { useId, useState } from "react";
import type { MoneyCard, MoneyGoal, MoneyReadyStatus, Platform } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { Pill, Skeleton, type Tone } from "../../components/ui.tsx";
import { PLATFORM_LABEL } from "../../lib/format.ts";
import { capitalise, fraction, goalText } from "../../lib/money.ts";
import { plainShort } from "../../lib/moneyDash.ts";
import { useMoney } from "../../lib/useMoney.ts";

export const EARN_TITLE = "Can I earn?";
export const CANT_SEE = "Can't see this yet";
const ORDER: Platform[] = ["youtube", "tiktok", "instagram", "facebook", "x"];

/** Green for good news, warm for close, calm for the rest. Never vermilion: that is only for actions. */
export const READY_TONE: Record<MoneyReadyStatus, Tone> = {
  ready: "success",
  joined: "success",
  close: "warn",
  not_yet: "neutral",
  cant_see: "neutral",
  not_open: "neutral",
  invite: "neutral",
};

/** The cards to show, in the fixed app order: only connected apps the server measured. */
export function earnCards(cards: readonly MoneyCard[]): MoneyCard[] {
  return ORDER.map((p) => cards.find((c) => c.platform === p && c.state !== "not_connected" && c.ready)).filter((c): c is MoneyCard => !!c);
}

function EarnGoal({ goal, or }: { goal: MoneyGoal; or: boolean }) {
  const text = goalText(goal);
  const f = fraction(goal);
  return (
    <li className={`earn-goal is-${goal.kind}${goal.reached ? " is-reached" : ""}`} data-goal={goal.key}>
      {or ? <span className="money-goal__or">or</span> : null}
      {goal.missing ? (
        <p className="earn-goal__line">
          <span className="earn-goal__text">{capitalise(goal.label)}</span>
          <span className="earn-goal__missing">{CANT_SEE}</span>
        </p>
      ) : (
        <>
          <p className="earn-goal__line">
            {goal.kind === "tick" || goal.reached ? (
              <Icon name={goal.reached ? "checkCircle" : "xCircle"} size={18} className={`icon money-goal__tick${goal.reached ? " is-on" : ""}`} />
            ) : null}
            <span className="earn-goal__text">{text}</span>
          </p>
          {goal.kind === "bar" && goal.current !== null ? (
            <span className="earn-bar" role="progressbar" aria-label={text} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(f * 100)}>
              <span className="earn-bar__fill" style={{ inlineSize: `${Math.round(f * 100)}%` }} />
            </span>
          ) : null}
        </>
      )}
    </li>
  );
}

function EarnGoals({ goals }: { goals: MoneyGoal[] }) {
  return (
    <ul className="earn-goals">
      {goals.map((g, i) => (
        <EarnGoal key={g.key} goal={g} or={i > 0 && goals[i - 1]!.or === g.key} />
      ))}
    </ul>
  );
}

function External({ href, children }: { href: string; children: string }) {
  return (
    <a className="text-link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <Icon name="external" size={14} />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/** "support.google.com" for a source link: short, and says whose page it is. */
function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function EarnCard({ card }: { card: MoneyCard }) {
  const ready = card.ready!;
  const [open, setOpen] = useState(false);
  const id = useId();
  const name = PLATFORM_LABEL[card.platform];
  const goals = card.goals.filter((g) => g.kind !== "number" || g.missing);
  const notes = [...card.goals, ...card.more].map((g) => [g.note, g.help].filter(Boolean).join(" ")).filter(Boolean);
  const sources = ready.sources.filter((u) => /^https:\/\//.test(u));
  const nextUrl = ready.nextUrl && /^https:\/\//.test(ready.nextUrl) ? ready.nextUrl : undefined;
  return (
    <article className={`earn-card glass is-${ready.status}`} data-earn={card.platform} data-earn-status={ready.status} aria-labelledby={`${id}-t`}>
      <header className="earn-card__head">
        <span className={`money-card__mark is-${card.platform}`} aria-hidden="true">
          <PlatformMark platform={card.platform} size={20} />
        </span>
        <h3 className="earn-card__title" id={`${id}-t`}>
          <span className="sr-only">{name}: </span>
          {card.programme}
        </h3>
        <span className="earn-card__pill">
          <Pill tone={READY_TONE[ready.status]} icon={ready.status === "ready" || ready.status === "joined" ? "checkCircle" : undefined}>
            {ready.word}
          </Pill>
        </span>
      </header>
      {goals.length ? <EarnGoals goals={goals} /> : null}
      <p className="earn-card__next">{nextUrl ? <External href={nextUrl}>{ready.next}</External> : ready.next}</p>
      <button type="button" className="money-more text-link earn-card__fold" aria-expanded={open} aria-controls={`${id}-d`} onClick={() => setOpen((o) => !o)}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={16} />
        Details
      </button>
      {open ? (
        <div className="earn-card__details" id={`${id}-d`}>
          {card.more.length ? <EarnGoals goals={card.more} /> : null}
          {ready.regionNote ? <p className="earn-card__fine">{ready.regionNote}</p> : null}
          {notes.length || card.extras.length ? (
            <ul className="earn-card__notes">
              {[...new Set([...notes, ...card.extras])].map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
          <p className="earn-card__fine">
            <span>Program status: </span>
            {card.statusWhere.url ? <External href={card.statusWhere.url}>{card.statusWhere.label}</External> : <strong>{card.statusWhere.label}</strong>}
          </p>
          <p className="earn-card__fine">Checked {plainShort(ready.checked, -1)}</p>
          {sources.length ? (
            <p className="earn-card__fine earn-card__sources">
              <span>From: </span>
              {sources.map((u) => (
                <External key={u} href={u}>
                  {host(u)}
                </External>
              ))}
            </p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function EarnCards() {
  const { data, error } = useMoney();
  const id = useId();
  if (error) return null;
  if (!data)
    return (
      <section className="earn" aria-hidden="true" data-earn-loading>
        <Skeleton className="earn__skel" />
      </section>
    );
  const cards = earnCards(data.platforms);
  if (!cards.length) return null;
  return (
    <section className="earn" aria-labelledby={`${id}-t`}>
      <h2 className="earn__title" id={`${id}-t`}>
        {EARN_TITLE}
      </h2>
      <div className="earn__cards">
        {cards.map((c) => (
          <EarnCard key={c.platform} card={c} />
        ))}
      </div>
    </section>
  );
}
