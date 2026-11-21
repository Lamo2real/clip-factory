// "Sent to your bank" on a place page (docs/CONTRACTS.md §40.4): the place's sent line, then each payment Google or
// Whop reported, newest first (at most 36). A payment is "sent to your bank", never "reached your bank": only a bank
// can say that (§40.5, not built), so the bank line always says to look in the bank's app. Amounts are only formatted
// (or shown as Google wrote them), never added, converted or guessed; a place that tells apps nothing says so, never $0.
import type { PayoutRow, SentLine } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { LinkButton } from "../../components/ui.tsx";
import { BANK_TEXT } from "../../lib/getPaid.ts";
import { formatMoney } from "../../lib/money.ts";
import { OpenButton } from "../campaigns/bits.tsx";
import { Rich } from "../settings/setup/bits.tsx";

/** "23 Oct 2026" (a plain date, no time zone). */
export function payoutDate(date: string): string {
  const d = new Date(`${date.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** What one row says about its money (§40.4's words). */
export function rowWords(row: PayoutRow): string {
  const who = row.by === "Google" ? "YouTube says" : "Whop says";
  switch (row.state) {
    case "sent":
      return `Sent to your bank by ${row.by} · ${who}`;
    case "on_its_way":
      return `On its way (${who})`;
    case "didnt_go_through":
      return "Didn't go through. Whop puts it back in your balance.";
    case "came_back":
      return "Came back from the bank.";
    case "gone":
      return "Google no longer lists this payment.";
  }
}

/** The amount as reported: formatted, or Google's own words when its money type couldn't be read. */
export function rowAmount(row: Pick<PayoutRow, "amountMicros" | "currency" | "text">): string {
  if (row.amountMicros !== null && row.currency) return formatMoney(row.amountMicros, row.currency);
  return row.text ?? "";
}

/** A place's sent line: its headline, its amounts per currency (never added across), and where to look. */
export function SentLineView({ sent, compact = false }: { sent: SentLine; compact?: boolean }) {
  return (
    <div className={`gp-sent__line${compact ? " is-compact" : ""}`} data-sent={sent.state}>
      <p className="gp-sent__headline">
        <Rich text={sent.headline} />
      </p>
      {sent.state === "number"
        ? sent.amounts.map((a) => (
            <p key={a.currency} className="gp-sent__amount" data-currency={a.currency}>
              {formatMoney(a.amountMicros, a.currency)} <span className="gp-sent__sofar">so far</span>
            </p>
          ))
        : null}
      {sent.tag ? <p className="money-tag gp-sent__tag">{sent.tag}</p> : null}
      {sent.why ? <p className="gp-sent__small">{sent.why}</p> : null}
      {sent.notAdded ? <p className="gp-sent__small">{sent.notAdded}</p> : null}
      {sent.note ? <p className="gp-sent__small">{sent.note}</p> : null}
      {sent.arrive ? <p className="gp-sent__small">{sent.arrive}</p> : null}
      {sent.where ? <p className="gp-sent__small">{sent.where.text}</p> : null}
      {sent.where?.button || sent.button ? (
        <div className="gp-sent__buttons">
          {sent.where?.button ? <OpenButton label={sent.where.button.label} href={sent.where.button.url} size="sm" /> : null}
          {sent.button ? (
            sent.button.external ? (
              <OpenButton label={sent.button.label} href={sent.button.href} size="sm" />
            ) : (
              <LinkButton href={sent.button.href} variant="glass" size="sm" iconAfter="chevronRight">
                {sent.button.label}
              </LinkButton>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function SentRows({ sent, rows }: { sent: SentLine; rows: readonly PayoutRow[] }) {
  const shown = rows.slice(0, 36);
  return (
    <section className="gp-sent glass" data-help="getpaid-sent" aria-labelledby="gp-sent-title">
      <h2 className="gp-section__title" id="gp-sent-title">
        Sent to your bank
      </h2>
      <SentLineView sent={sent} />
      {shown.length ? (
        <ul className="gp-sent__rows" aria-label="Payments">
          {shown.map((r, i) => (
            <li key={`${r.date}-${i}`} className={`gp-sent__row is-${r.state}`} data-state={r.state}>
              <span className="gp-sent__date">{payoutDate(r.date)}</span>
              <span className="gp-sent__money">{rowAmount(r)}</span>
              <span className="gp-sent__words">{rowWords(r)}</span>
              {i === 0 && r.state === "sent" && sent.arrive ? <span className="gp-sent__arrive">{sent.arrive}</span> : null}
              {r.arriveBy && r.state !== "sent" ? <span className="gp-sent__arrive">Whop says it should arrive by {payoutDate(r.arriveBy)}.</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="gp-bank-line">
        <Icon name="info" size={18} />
        <span>{BANK_TEXT}</span>
      </p>
    </section>
  );
}
