// "Sent to your bank" on a place page (docs/CONTRACTS.md §40.4): the place's sent line, then each payment Google or
// Whop reported, newest first (at most 36). A payment is "sent to your bank", never "reached your bank": only his bank
// can say that (§40.5). While Your bank is off, the bank line says to look in the bank's app; on, the place's own
// "Reached your bank" line (§40.5.9) takes its place, and each sent payment the bank paired with says when it reached
// the bank. Amounts are only formatted (or shown as Google wrote them), never added, converted or guessed; a place
// that tells apps nothing says so, never $0.
import type { GetPaidCard, GetPaidPlace, PayoutRow, SentLine } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { Button, LinkButton, Skeleton } from "../../components/ui.tsx";
import { isGetPaidPlace } from "../../getpaid/index.ts";
import { bankView, useBank } from "../../lib/bank.ts";
import { BANK_TEXT } from "../../lib/getPaid.ts";
import { formatMoney } from "../../lib/money.ts";
import { prefersReducedMotion } from "../../lib/prefs.ts";
import { OpenButton } from "../campaigns/bits.tsx";
import { Rich } from "../settings/setup/bits.tsx";
import { PlaceReached, pairFor } from "./bank/BankMoney.tsx";

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

/** A link to the page it is drawn on ("See them" on YouTube's own page) is left out: it would go nowhere. */
function linksHere(href: string, here: string | undefined): boolean {
  return !!here && href.split(/[?#]/)[0] === here && !href.includes("#");
}

/** The `#anchor` of a link to a place on the page it is drawn on ("…/youtube#yt-reading" on YouTube's page), else null. */
export function anchorHere(href: string, here: string | undefined): string | null {
  const at = href.indexOf("#");
  if (at < 0 || !href.slice(at + 1)) return null;
  const path = href.slice(0, at).split("?")[0];
  return at === 0 || (!!here && path === here) ? href.slice(at + 1) : null;
}

/**
 * Goes to a step on this page on every tap: the address keeps its `?back=` and gets the step's `#anchor` (so the page
 * opens that step), and the step comes into view with the focus on its head. Going to the same address again
 * through the router would do nothing.
 */
export function jumpHere(anchor: string): void {
  const to = `${location.pathname}${location.search}#${anchor}`;
  if (location.hash !== `#${anchor}`) {
    history.replaceState(history.state, "", to);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }
  setTimeout(() => {
    const el = document.getElementById(anchor) ?? document.getElementById(`step-${anchor}`);
    if (!el) return;
    el.scrollIntoView?.({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    (el.querySelector<HTMLElement>(":scope > .gstep__head") ?? el).focus({ preventScroll: true });
  }, 60);
}

/** A place's sent line: its headline, its amounts per currency (never added across), and where to look. */
export function SentLineView({ sent, compact = false, here }: { sent: SentLine; compact?: boolean; here?: string }) {
  const button = sent.button && !linksHere(sent.button.href, here) ? sent.button : null;
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
      {sent.where?.button || button ? (
        <div className="gp-sent__buttons">
          {sent.where?.button ? <OpenButton label={sent.where.button.label} href={sent.where.button.url} size="sm" /> : null}
          {button ? (
            button.external ? (
              <OpenButton label={button.label} href={button.href} size="sm" />
            ) : anchorHere(button.href, here) ? (
              <Button variant="glass" size="sm" iconAfter="chevronDown" onClick={() => jumpHere(anchorHere(button.href, here)!)} data-sent-jump="">
                {button.label}
              </Button>
            ) : (
              <LinkButton href={button.href} variant="glass" size="sm" iconAfter="chevronRight">
                {button.label}
              </LinkButton>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** "Waiting to be paid" (YouTube only, §40.4): Google's own words for the balance it hasn't paid yet, never in a total. */
export const waitingLine = (unpaid: NonNullable<GetPaidCard["unpaid"]>) => `Waiting to be paid: ${unpaid.text} (YouTube says).`;

/** The place a page is for, from its own address ("/settings/posting/getpaid/youtube" → youtube). */
export function placeOf(here: string | undefined): GetPaidPlace | undefined {
  const p = here ? /^\/settings\/posting\/getpaid\/([a-z]+)$/.exec(here)?.[1] : undefined;
  return p && isGetPaidPlace(p) ? p : undefined;
}

export function SentRows({ sent, rows, unpaid, here }: { sent: SentLine; rows: readonly PayoutRow[]; unpaid?: GetPaidCard["unpaid"]; here?: string }) {
  const shown = rows.slice(0, 36);
  const place = placeOf(here);
  const bankLoad = useBank();
  const bank = bankView(bankLoad);
  const line = bank && place ? bank.places[place] : undefined;
  // Your bank not read yet: no bank line for a moment, rather than "can't see your bank" before it turns out it can.
  const waiting = bankLoad.state === "loading" && !!place;
  return (
    <section className="gp-sent glass" data-help="getpaid-sent" aria-labelledby="gp-sent-title">
      <h2 className="gp-section__title" id="gp-sent-title">
        Sent to your bank
      </h2>
      <SentLineView sent={sent} here={here} />
      {unpaid ? (
        <div className="gp-sent__unpaid" data-sent="unpaid">
          <p className="gp-sent__small">{waitingLine(unpaid)}</p>
          {unpaid.note ? <p className="gp-sent__small">{unpaid.note}</p> : null}
        </div>
      ) : null}
      {shown.length ? (
        <ul className="gp-sent__rows" aria-label="Payments">
          {shown.map((r, i) => (
            <li key={`${r.date}-${i}`} className={`gp-sent__row is-${r.state}`} data-state={r.state}>
              <span className="gp-sent__date">{payoutDate(r.date)}</span>
              <span className="gp-sent__money">{rowAmount(r)}</span>
              <span className="gp-sent__words">{rowWords(r)}</span>
              {i === 0 && r.state === "sent" && sent.arrive ? <span className="gp-sent__arrive">{sent.arrive}</span> : null}
              {/* Only a payout still on its way can arrive: a failed or returned one never says it is coming. */}
              {r.arriveBy && r.state === "on_its_way" ? <span className="gp-sent__arrive">Whop says it should arrive by {payoutDate(r.arriveBy)}.</span> : null}
              {place && pairFor(bank, place, r) ? (
                <span className="gp-sent__reached" data-pair="">
                  <Icon name="checkCircle" size={16} />
                  <span>{pairFor(bank, place, r)}</span>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {line ? (
        <PlaceReached line={line} />
      ) : waiting ? (
        <Skeleton className="line-skel" />
      ) : (
        <p className="gp-bank-line">
          <Icon name="info" size={18} />
          <span>{BANK_TEXT}</span>
        </p>
      )}
    </section>
  );
}
