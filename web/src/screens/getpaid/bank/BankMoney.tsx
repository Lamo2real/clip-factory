// What reached his bank (docs/CONTRACTS.md §40.5.9): the bank page's Reached your bank part, Money's block "Reached
// your bank, so far", each place page's line, the pairs under Google's and Whop's payments, and the Your bank card's
// lines. Every sum is the server's, per place and per currency: the web only formats it (never added across
// currencies, never converted, never typed, never $0: a place with nothing is named in `notYet`). "Your bank says".
import "../../../styles/bank.css";
import type { ReactNode } from "react";
import type { Amount, BankPlaceLine, BankRow, BankView, GetPaidPlace, PayoutRow } from "../../../api/types.ts";
import { Icon } from "../../../components/Icon.tsx";
import { Button, LinkButton } from "../../../components/ui.tsx";
import { BANK_KEEPS, BANK_PATH } from "../../../getpaid/bank.ts";
import { formatMoney } from "../../../lib/money.ts";
import { Rich } from "../../settings/setup/bits.tsx";

export const REACHED = "Reached your bank";
export const REACHED_SO_FAR = "Reached your bank, so far";
export const IN_TOTAL = "In total:";
export const META_TOO = "And from Meta, for Instagram and Facebook together:";
export const ANSWER_THEM = "Answer them";
export const ASKS_HREF = `${BANK_PATH}#bank-asks`;

/** "SEK 1,234.56 · USD 40.00": one place's amounts, one per currency, never added across. */
export const amountsText = (amounts: readonly Amount[]) => amounts.map((a) => formatMoney(a.amountMicros, a.currency)).join(" · ");

/** "28 Oct" (a booking day, no time zone). */
export function bankDay(date: string): string {
  const d = new Date(`${date.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

/** The Your bank card's lines once something matched: "Reached your bank: SEK 4,102.10 so far" (at most 2). */
export function cardReachedLines(view: BankView): string[] {
  return view.reached.totals.slice(0, 2).map((t) => `${REACHED}: ${formatMoney(t.amountMicros, t.currency)} so far`);
}

/** "2 payments need you" (the card; the page and Money say the server's `needYou`). */
export function needYouCard(view: BankView): string | null {
  const n = view.asks.filter((a) => !a.notSure).length + (view.asksMore ?? 0);
  return n ? `${n} ${n === 1 ? "payment needs" : "payments need"} you` : null;
}

/** The line under a "Sent to your bank by Google/Whop" row the bank paired with (§40.5.9 `pairs`). */
export function pairFor(view: BankView | null, place: GetPaidPlace, row: Pick<PayoutRow, "date" | "amountMicros" | "currency" | "state">): string | null {
  if (!view || row.state !== "sent" || row.amountMicros === null || !row.currency) return null;
  const p = view.pairs.find((x) => x.place === place && x.payoutDate === row.date.slice(0, 10) && x.amountMicros === row.amountMicros && x.currency === row.currency);
  return p ? `Reached your bank on ${bankDay(p.reachedOn)} (Your bank says)` : null;
}

/** One place's "Reached your bank" line on its Get paid page (§40.5.9 `places[place]`). */
export function PlaceReached({ line }: { line: BankPlaceLine }) {
  return (
    <div className="bank-place" data-bank-place="" data-help="bank-reached">
      <p className="gp-sent__headline">
        <Rich text={line.headline} />
      </p>
      {line.amounts.map((a) => (
        <p key={a.currency} className="gp-sent__amount" data-currency={a.currency}>
          {formatMoney(a.amountMicros, a.currency)} <span className="gp-sent__sofar">so far</span>
        </p>
      ))}
      {line.metaAmounts?.length ? (
        <>
          <p className="gp-sent__small">{META_TOO}</p>
          {line.metaAmounts.map((a) => (
            <p key={a.currency} className="gp-sent__amount is-meta" data-currency={a.currency}>
              {formatMoney(a.amountMicros, a.currency)}
            </p>
          ))}
        </>
      ) : null}
      {line.note ? <p className="gp-sent__small">{line.note}</p> : null}
      {line.button ? (
        <div className="gp-sent__buttons">
          <LinkButton href={line.button.href} variant="glass" size="sm" iconAfter="chevronRight">
            {line.button.label}
          </LinkButton>
        </div>
      ) : null}
    </div>
  );
}

/** Per place, its amounts per currency; then "In total:" per currency; then the server's words. */
function Totals({ view, title }: { view: BankView; title: string }) {
  const r = view.reached;
  return (
    <>
      <ul className="bank-reached__places" aria-label={title}>
        {r.places.map((p) => (
          <li key={p.place} className="bank-reached__place" data-place={p.place}>
            <span className="bank-reached__name">{p.name}</span>
            <span className="bank-reached__amounts">{amountsText(p.amounts)}</span>
            {p.note ? <span className="bank-reached__note">{p.note}</span> : null}
          </li>
        ))}
      </ul>
      <div className="bank-reached__total" data-total="">
        <p className="bank-reached__total-label">{IN_TOTAL}</p>
        {r.totals.map((t) => (
          <p key={t.currency} className="bank-reached__total-num" data-currency={t.currency}>
            {formatMoney(t.amountMicros, t.currency)}
          </p>
        ))}
      </div>
    </>
  );
}

function Words({ view, needYou }: { view: BankView; needYou?: ReactNode }) {
  const r = view.reached;
  return (
    <>
      {r.totals.length ? <p className="money-tag bank-reached__tag">{r.tag}</p> : null}
      {r.twoMonies ? <p className="bank-reached__small">{r.twoMonies}</p> : null}
      {r.notYet ? <p className="bank-reached__small">{r.notYet}</p> : null}
      {r.since ? <p className="bank-reached__small">{r.since}</p> : null}
      {r.needYou ? (
        <div className="bank-reached__need">
          <p className="bank-reached__small">{r.needYou}</p>
          {needYou}
        </div>
      ) : null}
    </>
  );
}

/** The bank page's Reached your bank: per place, In total, the tag, then the rows newest first (at most 36). */
export function ReachedSection({ view, onNotThis, busy }: { view: BankView; onNotThis: (row: BankRow) => void; busy: string | null }) {
  const r = view.reached;
  const any = r.totals.length > 0;
  return (
    <section className="bank-reached glass" data-help="bank-reached" aria-labelledby="bank-reached-title" data-reached={r.state}>
      <h2 className="gp-section__title" id="bank-reached-title">
        {REACHED}
      </h2>
      {any ? <Totals view={view} title={REACHED} /> : <p className="bank-reached__empty">{r.empty ?? "Nothing from an app reached your bank yet."}</p>}
      <Words view={view} />
      {view.rows.length ? (
        <ul className="bank-rows" aria-label="Money that reached your bank">
          {view.rows.slice(0, 36).map((row) => (
            <li key={row.depositId} className="bank-row" data-place={row.place} data-how={row.how}>
              <span className="bank-row__money">{formatMoney(row.amountMicros, row.currency)}</span>
              <span className="bank-row__where">
                {bankDay(row.date)} · {row.name} · {row.bank}
              </span>
              <span className="bank-row__how">{row.howText}</span>
              <Button variant="ghost" size="sm" className="bank-row__not" loading={busy === row.depositId} onClick={() => onNotThis(row)}>
                Not from {row.place === "meta" ? "Instagram and Facebook" : row.name.replace(/ \(.+\)$/, "")}?
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * Money's block (§40.5.9 "The Money block"): "Reached your bank, so far", one line per place, "In total:" per
 * currency, the server's words, and "Answer them" (glass) when payments need him. Never added to the 30-day total or
 * to "Sent to your bank, so far" (what a platform sent is not what the bank booked). No vermilion.
 */
export function ReachedBlock({ view }: { view: BankView }) {
  const r = view.reached;
  return (
    <div className="cr-all__reached bank-money" data-help="money-reached" data-reached={r.state}>
      <h3 className="cr-all__sent-title">{REACHED_SO_FAR}</h3>
      {r.totals.length ? <Totals view={view} title={REACHED_SO_FAR} /> : <p className="cr-all__nothing">{r.empty ?? "Nothing from an app reached your bank yet."}</p>}
      <Words
        view={view}
        needYou={
          <LinkButton href={ASKS_HREF} variant="glass" size="sm" iconAfter="chevronRight">
            {ANSWER_THEM}
          </LinkButton>
        }
      />
    </div>
  );
}

/** What Clip Factory keeps (fixed words, no buttons). */
export function BankKeeps() {
  return (
    <section className="bank-keeps glass" data-help="bank-keeps" aria-labelledby="bank-keeps-title">
      <h2 className="gp-section__title" id="bank-keeps-title">
        What Clip Factory keeps
      </h2>
      <ul className="bank-keeps__list">
        {BANK_KEEPS.map((l) => (
          <li key={l}>
            <Icon name="shield" size={18} />
            <span>{l}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
