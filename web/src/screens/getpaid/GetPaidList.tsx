// Settings › Posting › Get paid (docs/CONTRACTS.md §40.1 item 1): the server's summary line, then one big glass card per
// place (YouTube, TikTok, Instagram, Facebook, X, then Content Rewards while it is on): its mark, name, a ring over its
// numbered steps, the status pill and one line; X's card adds its warning. No vermilion here: each card is one big tap
// to its page. Under the cards, Your bank (§40.5.2 item 1): while BANK_READING is off, today's words and no tap; on,
// one big glass tap to the bank page with its pill, line and ring, and what reached the bank so far.
// Never part of Set up posting: not in "n of 5 ready", not on the floating to-do list.
import "../../styles/getpaid.css";
import type { GetPaidCard } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { ProgressRing } from "../../components/ProgressRing.tsx";
import { A, ErrorPanel, Skeleton } from "../../components/ui.tsx";
import { getPaidPath, getPaidTime } from "../../getpaid/index.ts";
import { BANK_PATH } from "../../getpaid/bank.ts";
import { bankView, useBank } from "../../lib/bank.ts";
import { BANK_TEXT, useGetPaid } from "../../lib/getPaid.ts";
import { BankPill, BankRing } from "./bank/BankLinks.tsx";
import { cardReachedLines, needYouCard } from "./bank/BankMoney.tsx";
import { StatusPill } from "./StatusPill.tsx";

export const GETPAID_SOON = "Get paid is coming in the next update.";

/** A place's mark: the platform's own, or Content Rewards' coin. */
export function PlaceMark({ place, size = 28 }: { place: GetPaidCard["place"]; size?: number }) {
  return (
    <span className={`setup-card__mark gp-mark is-${place}${place === "contentrewards" ? " cr-mark" : ""}`} aria-hidden="true">
      {place === "contentrewards" ? <Icon name="coin" size={size} /> : <PlatformMark platform={place} size={size} />}
    </span>
  );
}

/** "2 of 6 steps done" for a ring's label. */
export function ringLabel(card: Pick<GetPaidCard, "name" | "ring">): string {
  return `${card.name}: ${card.ring.done} of ${card.ring.total} steps done`;
}

function PlaceCard({ card }: { card: GetPaidCard }) {
  const fraction = card.ring.total ? card.ring.done / card.ring.total : 0;
  return (
    <li className="setup-card-wrap glass gp-card-wrap">
      <A href={getPaidPath(card.place)} className="setup-card gp-card" data-place={card.place} data-status={card.status} data-help={`getpaid-${card.place}`}>
        <PlaceMark place={card.place} />
        <span className="setup-card__text gp-card__text">
          <span className="setup-card__name">{card.name}</span>
          <StatusPill card={card} />
          <span className="gp-card__line">{card.line}</span>
          {card.warning ? (
            <span className="gp-card__warning">
              <Icon name="alert" size={16} />
              <span>{card.warning}</span>
            </span>
          ) : null}
          <span className="setup-card__time">{getPaidTime(card.place)}</span>
        </span>
        <ProgressRing value={fraction} size={48} stroke={6} label={ringLabel(card)}>
          {card.ring.total && card.ring.done === card.ring.total ? <Icon name="check" size={18} /> : null}
        </ProgressRing>
        <Icon name="chevronRight" size={20} className="icon setup-card__go" />
      </A>
    </li>
  );
}

/** The list is the branch's one apple (`getpaid`): Settings search and Ask land on it with #getpaid and light it up. */
export function GetPaidList() {
  const load = useGetPaid();
  if (load.state === "missing")
    return (
      <div className="gp-list" id="getpaid" data-help="getpaid-list getpaid" tabIndex={-1}>
        <p className="callout callout--info">
          <Icon name="info" size={18} />
          <span>{GETPAID_SOON}</span>
        </p>
        <YourBank />
      </div>
    );
  if (load.state === "error" && !load.data) return <ErrorPanel message={load.error} onRetry={() => void load.reload()} />;
  const data = load.data;
  return (
    <div className="gp-list" id="getpaid" data-help="getpaid-list getpaid" tabIndex={-1}>
      <p className="gp-summary" aria-live="polite">
        {data ? data.summary : <Skeleton className="line-skel" />}
      </p>
      <ul className="setup-cards gp-cards" aria-label="Every place that can pay you">
        {data
          ? data.places.map((card) => <PlaceCard key={card.place} card={card} />)
          : [0, 1, 2, 3, 4].map((i) => (
              <li key={i} className="setup-card-wrap">
                <Skeleton className="setup-card-skel" />
              </li>
            ))}
      </ul>
      <YourBank />
    </div>
  );
}

/**
 * Your bank (§40.5.2 item 1). Off (BANK_READING off, an API from before it, or not read yet): today's words and no
 * tap. On: one big glass tap to the bank page, with the card mark, "Your bank", the pill and line and a ring; once
 * something matched, "Reached your bank: SEK 4,102.10 so far" (one line per currency, at most 2), and "2 payments
 * need you" when there are questions. No vermilion.
 */
export function YourBank() {
  const view = bankView(useBank());
  if (!view)
    return (
      <section className="gp-bank glass" aria-labelledby="gp-bank-title" data-bank="none" data-help="getpaid-bank-card">
        <span className="gp-bank__icon" aria-hidden="true">
          <Icon name="card" size={26} />
        </span>
        <div>
          <h2 className="gp-section__title" id="gp-bank-title">
            Your bank
          </h2>
          <p>{BANK_TEXT}</p>
        </div>
      </section>
    );
  const reached = cardReachedLines(view);
  const need = needYouCard(view);
  return (
    <div className="setup-card-wrap glass gp-card-wrap gp-bank-wrap">
      <A href={BANK_PATH} className="setup-card gp-bank-card" data-bank={view.status} data-help="getpaid-bank-card">
        <span className="setup-card__mark gp-mark bank-mark" aria-hidden="true">
          <Icon name="card" size={28} />
        </span>
        <span className="setup-card__text gp-card__text">
          <span className="setup-card__name">Your bank</span>
          <BankPill status={view.status} tone={view.tone} pill={view.pill} />
          <span className="gp-card__line">{view.line}</span>
          {reached.map((l) => (
            <span key={l} className="gp-card__reached">
              {l}
            </span>
          ))}
          {need ? <span className="gp-card__need">{need}</span> : null}
        </span>
        <BankRing view={view} size={48} />
        <Icon name="chevronRight" size={20} className="icon setup-card__go" />
      </A>
    </div>
  );
}
