// Money › All your money (docs/CONTRACTS.md §39.2): every place's money over one 30-day period, in one glass card at the
// top of the page, with one total per currency. Only money a platform or Content Rewards reported, never calculated,
// guessed, converted or typed in: every sum is the server's (GET /v1/money/everywhere), the web only formats it. A
// place that tells apps nothing says "Not available from TikTok" and where to look, never $0. No vermilion here: at
// most one glass button at each row's right end. An API from before §39 (404) shows nothing. §40.4: under each row one
// small grey line says what that place sent toward the bank ("Sent to your bank by Google", or where to look), and
// under the total the block "Sent to your bank, so far" (one line per currency, never added to the 30-day total).
// §40.5.9: once a bank was ever connected, the block "Reached your bank, so far" (what the bank booked, per place and
// per currency) comes under it, and its bank line says so instead of "Clip Factory can't see your bank".
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api, friendlyMessage } from "../../api/index.ts";
import { ApiError } from "../../api/errors.ts";
import type { MoneyEverywhere, MoneyPlace, SentLine } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { Button, LinkButton } from "../../components/ui.tsx";
import { CR_MONEY_PATH, usd } from "../../lib/contentRewards.ts";
import { bankView, useBank } from "../../lib/bank.ts";
import { onLiveSignal } from "../../lib/live.ts";
import { formatMoney } from "../../lib/money.ts";
import { OpenButton } from "../campaigns/bits.tsx";
import { Rich } from "../settings/setup/bits.tsx";
import { ReachedBlock } from "../getpaid/bank/BankMoney.tsx";
import { showCrMoney } from "./CrMoneyPart.tsx";

export const ALL_MONEY_TITLE = "All your money";
export const NOTHING_TO_ADD = "Nothing to add up yet.";
export const TWO_MONIES = "Different money, like dollars and euros, is never added together.";
export const PAID_OUT = "Paid to your bank: look on Whop, **Balances**.";
/** The block under the total (§40.4). */
export const SENT_TITLE = "Sent to your bank, so far";
export const SENT_TWO_MONIES = "Different money, like dollars and kronor, is never added together.";
/** Said before a row's sent line that doesn't say so itself, so it never reads as the row's earnings. */
export const SENT_LABEL = "Sent to your bank:";
/**
 * A sent line's own button (Allow payment reading, Connect Whop, See them, Open Stripe) is on that place's Get paid page:
 * a row keeps at most one button, at its right end (§39.2), so the line says where to find it.
 */
export const MORE_IN_GETPAID = "More in Get paid below.";
/** The Monthly card's line while Content Rewards is on All your money (§39.2). */
export const APPS_ONLY = "Apps only. Content Rewards is in All your money.";

export type EverywhereLoad = { state: "loading"; data: null } | { state: "off"; data: null } | { state: "error"; data: null; error: string } | { state: "ok"; data: MoneyEverywhere };

/** GET /v1/money/everywhere, read again on live news (a resync, Content Rewards' money). 404: an API before §39. */
export function useMoneyEverywhere(): EverywhereLoad & { reload: () => void } {
  const [load, setLoad] = useState<EverywhereLoad>({ state: "loading", data: null });
  const seq = useRef(0);
  const reload = useCallback(() => {
    const mine = ++seq.current;
    api()
      .getMoneyEverywhere()
      .then((data) => mine === seq.current && setLoad({ state: "ok", data }))
      .catch((e: unknown) => {
        if (mine !== seq.current) return;
        if (e instanceof ApiError && e.status === 404) setLoad({ state: "off", data: null });
        else setLoad((l) => (l.state === "ok" ? l : { state: "error", data: null, error: friendlyMessage(e) }));
      });
  }, []);
  useEffect(() => {
    reload();
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = onLiveSignal((s) => {
      if (s.kind !== "resync" && s.event.type !== "contentrewards" && s.event.type !== "setup" && s.event.type !== "getpaid") return;
      if (t) clearTimeout(t);
      t = setTimeout(reload, 800);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  }, [reload]);
  return { ...load, reload };
}

/** "2:10 pm" (the time Content Rewards' numbers are from, in this device's time). */
export function clockTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(d).replace(/\s?([AP])M$/i, (_m, x: string) => ` ${x.toLowerCase()}m`);
}

/**
 * A row's one small grey sent line (§40.4): "Sent to your bank by Google: kr 2 468,00 so far · YouTube says", or the
 * place's not-available line. Amounts are only formatted, one per currency, never added across.
 */
export function sentText(sent: SentLine, said?: string): string {
  // The server's headlines and tags have no full stop: one goes in before the next sentence.
  const dot = (s: string) => (/[.!?…]$/.test(s) ? s : `${s}.`);
  const more = (text: string) => (sent.button || sent.where?.button ? `${dot(text)} ${MORE_IN_GETPAID}` : text);
  if (sent.state === "number") {
    const amounts = sent.amounts.map((a) => formatMoney(a.amountMicros, a.currency)).join(" · ");
    return more([`${sent.headline}${amounts ? `: ${amounts} so far` : ""}`, sent.tag, amounts ? null : sent.notAdded].filter(Boolean).join(" · "));
  }
  const where = sent.where?.text;
  const label = /sent to your bank/i.test(sent.headline) ? "" : `${SENT_LABEL} `;
  // The row already says it ("Not available from TikTok"): only where to look.
  const head = where && said && sent.headline.trim().toLowerCase() === said.trim().toLowerCase() ? "" : `${dot(sent.headline)} `;
  return more(`${label}${where ? `${head}${where}` : sent.headline}`);
}

/** The row's own where line, unless its sent line's says the same and more ("…Balance, then Transactions…"). */
export function rowWhere(p: Pick<MoneyPlace, "where" | "sent">): string | null {
  const own = p.where?.text ?? null;
  const sentWhere = p.sent && p.sent.state !== "number" ? p.sent.where?.text : undefined;
  if (!own || !sentWhere) return own;
  const bare = (t: string) => t.trim().replace(/[.!]+$/, "");
  return bare(sentWhere).startsWith(bare(own)) ? null : own;
}

/** The Content Rewards row's small lines, in money's time order; each number only when Content Rewards reported it.
 * With the row's own sent line (§40.4), "Paid out to your bank" is left out: the sent line says it. */
export function crLines(cr: NonNullable<MoneyPlace["cr"]>, withSent = false): string[] {
  const now = [
    cr.stillEarningCents !== null ? `Still earning ${usd(cr.stillEarningCents)}` : null,
    cr.readyToMoveCents !== null ? `Ready to move to Whop ${usd(cr.readyToMoveCents)}` : null,
    cr.onItsWayCents !== null ? `On its way to Whop ${usd(cr.onItsWayCents)}` : null,
  ].filter((x): x is string => !!x);
  const at = clockTime(cr.asOf);
  return [
    ...(now.length ? [`Right now (Content Rewards says${at ? `, ${at}` : ""}): ${now.join(" · ")}`] : []),
    `Earned since you started: ${cr.paidSoFarCents == null ? "Checking…" : usd(cr.paidSoFarCents)}`,
    ...(withSent ? [] : [PAID_OUT]),
  ];
}

function Mark({ place }: { place: MoneyPlace["place"] }) {
  return (
    <span className={`cr-all__mark is-${place}`} aria-hidden="true">
      {place === "contentrewards" ? <Icon name="coin" size={20} /> : <PlatformMark platform={place} size={20} />}
    </span>
  );
}

/** The row's one glass button at its right end: its own, else the where line's Open, else Content Rewards' "See it all". */
function RowButton({ p }: { p: MoneyPlace }) {
  if (p.button) {
    return p.button.external ? (
      <OpenButton label={p.button.label} href={p.button.href} size="sm" />
    ) : (
      <LinkButton href={p.button.href} variant="glass" size="sm" iconAfter="chevronRight">
        {p.button.label}
      </LinkButton>
    );
  }
  if (p.where?.button) return <OpenButton label={p.where.button.label} href={p.where.button.url} size="sm" />;
  if (p.place === "contentrewards" && p.state !== "not_set_up")
    return (
      <LinkButton
        href={CR_MONEY_PATH}
        variant="glass"
        size="sm"
        iconAfter="chevronRight"
        onClick={(e) => {
          // Money's own Content Rewards part is on this page: scroll there on every tap (the router does nothing for
          // the address it is already on, and opens a new one at its top).
          if (showCrMoney()) e.preventDefault();
        }}
      >
        See it all
      </LinkButton>
    );
  return null;
}

function Row({ p }: { p: MoneyPlace }) {
  const number = p.state === "number";
  return (
    <li className={`cr-all__row is-${p.state}`} data-place={p.place} data-state={p.state}>
      <Mark place={p.place} />
      <div className="cr-all__words">
        <p className="cr-all__name">{p.name}</p>
        <p className="cr-all__headline">{p.headline}</p>
        {number
          ? p.amounts.map((a) => (
              <p key={a.currency} className="cr-all__amount" data-currency={a.currency}>
                {formatMoney(a.amountMicros, a.currency)}
              </p>
            ))
          : null}
        {number && p.tag ? <p className="cr-all__tag money-tag">{p.tag}</p> : null}
        {p.why ? <p className="cr-all__why">{p.why}</p> : null}
        {p.note ? <p className="cr-all__note">{p.note}</p> : null}
        {rowWhere(p) ? <p className="cr-all__where">{rowWhere(p)}</p> : null}
        {p.cr && p.state !== "not_set_up" ? (
          <ul className="cr-all__cr">
            {crLines(p.cr, !!p.sent).map((l) => (
              <li key={l}>
                <Rich text={l} />
              </li>
            ))}
          </ul>
        ) : null}
        {p.sent ? (
          <p className="cr-all__sent" data-sent={p.sent.state}>
            <Rich text={sentText(p.sent, p.headline)} />
          </p>
        ) : null}
      </div>
      <div className="cr-all__button">
        <RowButton p={p} />
      </div>
    </li>
  );
}

/** "YouTube + Content Rewards". */
function namesOf(m: MoneyEverywhere, ids: readonly string[]): string {
  return ids.map((id) => m.places.find((p) => p.place === id)?.name ?? id).join(" + ");
}

export function AllMoney({ load }: { load: EverywhereLoad & { reload: () => void } }) {
  const id = useId();
  const bankLoad = useBank();
  const bank = bankView(bankLoad);
  // Only once a bank was ever connected (`moneyLine`); before that, and while Your bank is off, today's bank line stays.
  // While Your bank is still being read, no bank line at all for that moment (never "can't see your bank" first).
  const reached = bank?.moneyLine ? bank : null;
  const bankLine = bankLoad.state === "loading" ? null : reached?.moneyLine;
  if (load.state === "off") return null;
  if (load.state === "loading") return <section className="cr-all glass is-loading" aria-hidden="true" data-help="money-everywhere" />;
  if (load.state === "error")
    return (
      <section className="cr-all glass" data-help="money-everywhere" aria-labelledby={`${id}-t`}>
        <h2 className="cr-all__title" id={`${id}-t`}>
          {ALL_MONEY_TITLE}
        </h2>
        <p className="cr-all__why" role="alert">
          {load.error}
        </p>
        <div className="cr-all__button">
          <Button variant="glass" size="sm" icon="retry" act="retry" onClick={load.reload}>
            Try again
          </Button>
        </div>
      </section>
    );
  const m = load.data;
  return (
    <section className="cr-all glass" data-help="money-everywhere" aria-labelledby={`${id}-t`}>
      <div className="cr-all__head">
        <h2 className="cr-all__title" id={`${id}-t`}>
          {ALL_MONEY_TITLE}
        </h2>
        <p className="cr-all__period">
          Every place · {m.periodText}
          {m.lagNote ? ` · ${m.lagNote}` : ""}
        </p>
      </div>
      {/* The answer first: the total, then each place. */}
      <div className="cr-all__total" data-total={m.totals.length ? "yes" : "none"}>
        {m.totals.length ? (
          m.totals.map((t) => (
            <div key={t.currency} className="cr-all__sum" data-currency={t.currency}>
              <p className="cr-all__total-line">
                <span className="cr-all__total-label">Total: </span>
                <span className="cr-all__total-num">{formatMoney(t.amountMicros, t.currency)}</span>
              </p>
              <p className="cr-all__total-where">
                {namesOf(m, t.places)} · {m.periodText}
              </p>
              <p className="cr-all__tag money-tag">{t.tag}</p>
            </div>
          ))
        ) : (
          <p className="cr-all__nothing">{NOTHING_TO_ADD}</p>
        )}
        {m.totals.length > 1 ? <p className="cr-all__why">{TWO_MONIES}</p> : null}
        {m.notCountedText ? <p className="cr-all__why">{m.notCountedText}</p> : null}
      </div>
      <ul className="cr-all__rows" aria-label="Every place">
        {m.places.map((p) => (
          <Row key={p.place} p={p} />
        ))}
      </ul>
      {m.sent ? <SentSoFar sent={m.sent} bankLine={bankLine} /> : null}
      {reached ? <ReachedBlock view={reached} /> : null}
    </section>
  );
}

/**
 * "Sent to your bank, so far" (§40.4): one line per currency in the places' order, each naming who sent it, with how
 * it is known; never added to the 30-day total, never across currencies; "Nothing sent to your bank yet." only with no
 * sent rows at all. What reached the bank only the bank can say: the bank line says so (or, once Your bank read a
 * bank, `moneyLine`: "What reached your bank is below.").
 */
export function SentSoFar({ sent, bankLine }: { sent: NonNullable<MoneyEverywhere["sent"]>; /** null: Your bank is still being read, so no bank line yet. */ bankLine?: string | null }) {
  return (
    <div className="cr-all__sentsofar" data-help="money-sent" data-sent-total={sent.totals.length ? "yes" : "none"}>
      <h3 className="cr-all__sent-title">{SENT_TITLE}</h3>
      {sent.empty && !sent.totals.length && !sent.notAdded ? <p className="cr-all__nothing">{sent.empty}</p> : null}
      {sent.totals.length ? (
        <ul className="cr-all__sent-lines" aria-label={SENT_TITLE}>
          {sent.totals.map((t) => (
            <li key={t.currency} data-currency={t.currency}>
              <span className="cr-all__sent-num">{formatMoney(t.amountMicros, t.currency)}</span>
              <span className="cr-all__sent-names"> · {t.names}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {sent.totals.length ? <p className="cr-all__tag money-tag">{sent.tag}</p> : null}
      {sent.totals.length ? <p className="cr-all__why">{SENT_TWO_MONIES}</p> : null}
      {sent.notAdded ? <p className="cr-all__why">{sent.notAdded}</p> : null}
      {sent.notCountedText ? <p className="cr-all__why">{sent.notCountedText}</p> : null}
      {bankLine === null ? null : <p className="cr-all__why cr-all__bank">{bankLine ?? sent.bankText}</p>}
    </div>
  );
}

/** Whether All your money has a Content Rewards row (then the Monthly card says it is apps only). */
export function crRowOf(load: EverywhereLoad): MoneyPlace | null {
  return load.state === "ok" ? (load.data.places.find((p) => p.place === "contentrewards") ?? null) : null;
}
