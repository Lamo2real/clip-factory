// The money dashboard (docs/CONTRACTS.md §27, ADR-50): Monthly, Weekly, Daily and Yearly MRR for the apps the owner
// picks, a chart of the reported days, and money per clip. Only numbers an app reported: apps without a money API
// are left out with a note, never guessed. Every amount comes from the server and is only formatted here.
//
// Phones (and touch tablets) keep the controls in a dock at the bottom right, where the thumb rests, above the tab
// bar; Ask's home spot moves above the dock while this page is open. Wide screens with a mouse get a toolbar on the
// title's row, at the top right, that stays in view.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api, friendlyMessage } from "../../api/index.ts";
import type { MoneyChange, MoneyCurrencySummary, MoneyExcluded, MoneySummary, MoneyView, Platform } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { A, ErrorPanel, LinkButton, Pill, Segmented, Skeleton } from "../../components/ui.tsx";
import { PLATFORM_LABEL } from "../../lib/format.ts";
import { useLoad, useMedia } from "../../lib/hooks.ts";
import { fraction, formatMoney, goalText, MONEY_PATH, nearestGoal } from "../../lib/money.ts";
import {
  APPS,
  chipFor,
  chipSentence,
  choiceSearch,
  isAll,
  PERIOD_LABEL,
  PERIODS,
  plainDay,
  plainShort,
  readChoice,
  readStored,
  toggleApp,
  writeStored,
  type DashChoice,
} from "../../lib/moneyDash.ts";
import { useAction } from "../../lib/motion.ts";
import { prefersReducedMotion } from "../../lib/prefs.ts";
import { MoneyChart } from "./MoneyChart.tsx";
import { MoneyClipList } from "./MoneyClipList.tsx";

/** Where the controls sit in the dock: phones, and touch screens up to a large tablet. */
export const DOCK_QUERY = "(max-width: 767px), (pointer: coarse) and (max-width: 1194px)";
export const DOCK_H = 110;

const cache = new Map<string, MoneySummary>();

/** Tests only. */
export function forgetDashCache(): void {
  cache.clear();
}

function useSummary(apps: Platform[], period: DashChoice["period"]) {
  const key = `${apps.join(",")}|${period}`;
  const [state, setState] = useState<{ key: string; data: MoneySummary | null; error: string | null }>(() => ({ key, data: cache.get(key) ?? null, error: null }));
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    const hit = cache.get(key);
    // A new filter keeps the last numbers on screen until its own arrive: no skeleton flash, no jump.
    setState((s) => ({ key, data: hit ?? s.data, error: null }));
    api()
      .getMoneySummary(apps, period)
      .then((data) => {
        cache.set(key, data);
        if (alive) setState({ key, data, error: null });
      })
      .catch((e: unknown) => {
        if (alive) setState((s) => ({ ...s, error: friendlyMessage(e) }));
      });
    return () => {
      alive = false;
    };
    // `apps` is part of `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);
  return { ...state, fresh: state.key === key, reload: () => setNonce((n) => n + 1) };
}

/** The KPI's number counts up once (dopamine), never under reduced motion: the final number is on first paint. */
function useCountUp(target: number, run: boolean): number {
  const [shown, setShown] = useState(() => (run && !prefersReducedMotion() ? 0 : target));
  useEffect(() => {
    if (!run || prefersReducedMotion()) {
      setShown(target);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 700);
      const eased = 1 - (1 - t) ** 3;
      setShown(t >= 1 ? target : Math.round(target * eased));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, run]);
  return shown;
}

function ChangeChip({ change, days }: { change: MoneyChange; days: number }) {
  const chip = chipFor(change);
  const bump = useAction("toggle");
  const played = useRef(false);
  useEffect(() => {
    if (chip && change.direction === "up" && !played.current) {
      played.current = true;
      bump.play();
    }
  }, [chip, change.direction, bump]);
  if (!chip) return null;
  return (
    <span className={`dash-chip act act--toggle act--text is-${bump.phase}`} data-direction={change.direction} title={chipSentence(change, days) ?? undefined}>
      <span className="act__item">
        <Pill tone={chip.tone} icon={chip.icon ?? undefined}>
          {chip.text}
        </Pill>
      </span>
      <span className="sr-only">{chipSentence(change, days)}</span>
    </span>
  );
}

function Amount({ micros, currency, count = false }: { micros: number; currency: string; count?: boolean }) {
  const shown = useCountUp(micros, count);
  return (
    <span className="dash-num" data-final={formatMoney(micros, currency)}>
      {formatMoney(shown, currency)}
    </span>
  );
}

type Kpi = "monthly" | "weekly" | "daily" | "yearly";

const KPI_TEXT: Record<Kpi, { label: string; sub: string; days: number }> = {
  monthly: { label: "Monthly MRR", sub: "Money in the last 30 days", days: 30 },
  weekly: { label: "Weekly MRR", sub: "Last 7 days", days: 7 },
  daily: { label: "Daily MRR", sub: "A normal day lately (average of 30 days)", days: 30 },
  yearly: { label: "Yearly MRR", sub: "At this pace for a year", days: 365 },
};

function KpiLine({ kind, c, count }: { kind: Kpi; c: MoneyCurrencySummary; count: boolean }) {
  const value = kind === "monthly" ? c.monthly : kind === "weekly" ? c.weekly : null;
  return (
    <div className="dash-kpi__line" data-currency={c.currency}>
      <div className="dash-kpi__amount">
        {kind === "daily" ? (
          <Amount micros={c.daily.averageMicros} currency={c.currency} />
        ) : kind === "yearly" ? (
          <Amount micros={c.yearly.paceMicros} currency={c.currency} />
        ) : (
          <Amount micros={value!.amountMicros} currency={c.currency} count={count} />
        )}
        {kind === "yearly" ? null : <ChangeChip change={kind === "daily" ? c.daily : value!} days={KPI_TEXT[kind].days} />}
      </div>
      <span className="money-tag">{c.tag}</span>
      {kind === "daily" && c.daily.latest ? (
        <p className="dash-kpi__extra">
          Latest day: {plainDay(c.daily.latest.date)} · {formatMoney(c.daily.latest.amountMicros, c.currency)}
        </p>
      ) : null}
      {kind === "yearly" && c.yearly.last365Micros !== null ? (
        <p className="dash-kpi__extra">Last 365 days: {formatMoney(c.yearly.last365Micros, c.currency)}</p>
      ) : null}
    </div>
  );
}

function noCompare(c: MoneyCurrencySummary, kind: Kpi): boolean {
  if (kind === "yearly") return false;
  const ch = kind === "monthly" ? c.monthly : kind === "weekly" ? c.weekly : c.daily;
  return ch.direction === "none" && ch.previousPeriodMicros === null;
}

function KpiCard({ kind, currencies, help, main = false, children }: { kind: Kpi; currencies: MoneyCurrencySummary[]; help?: string; main?: boolean; children?: ReactNode }) {
  const t = KPI_TEXT[kind];
  const titleId = useId();
  return (
    <section className={`dash-kpi dash-kpi--${kind} glass${main ? " dash-kpi--main glass--green" : ""}`} aria-labelledby={titleId} data-kpi={kind} data-help={help}>
      <div className="dash-kpi__head">
        <h2 className="dash-kpi__label" id={titleId}>
          {t.label}
        </h2>
        {children}
      </div>
      <p className="dash-kpi__sub">{t.sub}</p>
      <div className="dash-kpi__lines">
        {currencies.map((c) => (
          <KpiLine key={c.currency} kind={kind} c={c} count={main} />
        ))}
      </div>
      {currencies.some((c) => noCompare(c, kind)) ? <p className="dash-kpi__extra">Not enough days to compare yet</p> : null}
    </section>
  );
}

function WhatIsMrr() {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <button type="button" className="money-why dash-why" aria-expanded={open} aria-controls={id} aria-label="What does MRR mean?" onClick={() => setOpen((o) => !o)}>
        ?
      </button>
      <p className="dash-why__text" id={id} hidden={!open}>
        MRR usually means subscriptions. Here it means the money YouTube (and other apps that share it) reported for your videos over that many days. Days can change for a few days after, and at month end.
      </p>
    </>
  );
}

function names(list: Platform[]): string {
  const n = list.map((p) => PLATFORM_LABEL[p]);
  return n.length <= 1 ? (n[0] ?? "") : `${n.slice(0, -1).join(", ")} and ${n.at(-1)}`;
}

/** Why an app is left out (§27.3): fixed words, never a number. */
function Notes({ excluded }: { excluded: MoneyExcluded[] }) {
  const notShared = excluded.filter((e) => e.reason === "not_shared");
  const rest = excluded.filter((e) => e.reason !== "not_shared");
  if (!excluded.length) return null;
  return (
    <section className="dash-notes glass" aria-label="Apps not counted">
      {notShared.length ? (
        <div className="dash-note" data-reason="not_shared">
          <p>
            <strong>Not counted:</strong> {names(notShared.map((e) => e.platform))} {notShared.length === 1 ? "doesn't" : "don't"} share money with apps.
          </p>
          <ul className="dash-note__chips" aria-label="Where each app shows your money">
            {notShared.map((e) => (
              <li key={e.platform}>
                {e.where?.url ? (
                  <a className="dash-shared" href={e.where.url} target="_blank" rel="noopener noreferrer" aria-label={`${PLATFORM_LABEL[e.platform]}: not shared. Look in ${e.where.label} (opens in a new tab)`}>
                    <PlatformMark platform={e.platform} size={18} />
                    <span>Not shared</span>
                  </a>
                ) : (
                  <span className="dash-shared" title={e.where?.label}>
                    <PlatformMark platform={e.platform} size={18} title={PLATFORM_LABEL[e.platform]} />
                    <span>Not shared</span>
                    <span className="sr-only">. Look in {e.where?.label}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {rest.map((e) => (
        <div className="dash-note" key={e.platform} data-reason={e.reason}>
          <p>
            <span className="dash-note__mark" aria-hidden="true">
              <PlatformMark platform={e.platform} size={16} />
            </span>
            {e.text}
          </p>
          {e.reason === "needs_permission" ? (
            <LinkButton href={`${MONEY_PATH}#money-youtube`} variant="action" size="md" icon="key">
              Allow money reading
            </LinkButton>
          ) : null}
        </div>
      ))}
    </section>
  );
}

/** Nothing can be counted: the nearest goal instead of zeros (the same bar as Home's money tile). */
function NoMoneyYet() {
  const { data } = useLoad<MoneyView>(() => api().getMoney());
  const near = data ? nearestGoal(data.platforms) : null;
  return (
    <section className="dash-kpi dash-kpi--main dash-kpi--empty glass glass--green" data-kpi="empty" data-help="money-dash-monthly">
      <h2 className="dash-kpi__label">Monthly MRR</h2>
      <p className="dash-empty__title">No money yet.</p>
      {near ? (
        <div className="money-tile__near" data-near={near.platform}>
          <p className="money-tile__near-line">
            <span className={`money-card__mark is-${near.platform}`} aria-hidden="true">
              <PlatformMark platform={near.platform} size={16} />
            </span>
            <span>
              <strong>{PLATFORM_LABEL[near.platform]}:</strong> {goalText(near.goal)}
            </span>
          </p>
          <span className="money-bar" role="progressbar" aria-label={goalText(near.goal)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction(near.goal) * 100)}>
            <span className="money-bar__fill" style={{ inlineSize: `${Math.round(fraction(near.goal) * 100)}%` }} />
          </span>
        </div>
      ) : null}
      <LinkButton href={MONEY_PATH} size="md" iconAfter="chevronRight" className="dash-empty__link">
        See how close you are
      </LinkButton>
    </section>
  );
}

/** The filter is only apps that never share money: one card saying where to look instead. */
function OnlyNotShared({ excluded }: { excluded: MoneyExcluded[] }) {
  return (
    <section className="dash-kpi dash-kpi--main dash-kpi--empty glass glass--green" data-kpi="not-shared" data-help="money-dash-monthly">
      <h2 className="dash-kpi__label">Monthly MRR</h2>
      {excluded.map((e) => (
        <p className="dash-empty__line" key={e.platform}>
          <span className="dash-note__mark" aria-hidden="true">
            <PlatformMark platform={e.platform} size={16} />
          </span>
          {PLATFORM_LABEL[e.platform]} doesn't share money with apps. Look in {e.where?.label ?? `the ${PLATFORM_LABEL[e.platform]} app`}.
        </p>
      ))}
    </section>
  );
}

function AppsFilter({ apps, onChange }: { apps: Platform[]; onChange: (apps: Platform[]) => void }) {
  // §20.11: the tapped chip's content bumps (`toggle`); instant under reduced motion.
  const bump = useAction("toggle");
  const [tapped, setTapped] = useState<Platform | "all" | null>(null);
  const all = isAll(apps);
  const chip = (key: Platform | "all", on: boolean, content: ReactNode, label: string) => (
    <button
      key={key}
      type="button"
      className={`dash-app${on ? " is-on" : ""}${key === "all" ? " dash-app--all" : ""}`}
      aria-pressed={on}
      aria-label={label}
      data-app={key}
      onClick={() => {
        onChange(toggleApp(apps, key));
        setTapped(key);
        bump.play();
      }}
    >
      <span className={`act act--toggle is-${tapped === key ? bump.phase : "idle"}`}>
        <span className="act__item" key={tapped === key ? bump.shot : 0}>
          {content}
        </span>
      </span>
    </button>
  );
  return (
    <div className="dash-apps" role="group" aria-label="Apps" data-help="money-dash-filter">
      {APPS.map((p) => chip(p, !all && apps.includes(p), <PlatformMark platform={p} size={20} />, PLATFORM_LABEL[p]))}
      {chip("all", all, <span>All</span>, "All apps")}
    </div>
  );
}

function PeriodPick({ value, onChange }: { value: DashChoice["period"]; onChange: (p: DashChoice["period"]) => void }) {
  return (
    <span className="dash-period" data-help="money-dash-period">
      <Segmented
        label="Period"
        value={String(value) as `${DashChoice["period"]}`}
        options={PERIODS.map((p) => ({ value: String(p) as `${DashChoice["period"]}`, label: PERIOD_LABEL[p] }))}
        onChange={(v) => onChange(Number(v) as DashChoice["period"])}
      />
    </span>
  );
}

function Controls({ choice, set, dock }: { choice: DashChoice; set: (c: Partial<DashChoice>) => void; dock: boolean }) {
  return (
    <div className={dock ? "money-dock glass glass--refract" : "dash-toolbar glass glass--refract"} data-help-dodge="">
      <AppsFilter apps={choice.apps} onChange={(apps) => set({ apps })} />
      <PeriodPick value={choice.period} onChange={(period) => set({ period })} />
    </div>
  );
}

function PaidLink() {
  return (
    <A href={MONEY_PATH} className="dash-head__link text-link">
      How close am I to getting paid?
    </A>
  );
}

function Banner({ summary }: { summary: MoneySummary }) {
  const err = summary.errors[0];
  if (!err && !summary.stale) return null;
  const app = err ? PLATFORM_LABEL[err.platform] : names(summary.included);
  return (
    <p className="dash-banner" role="status">
      <Icon name="alert" size={18} />
      <span>
        Couldn't check {app} today.{summary.through ? ` Showing money up to ${plainDay(summary.through)}.` : ""}
      </span>
    </p>
  );
}

function CurrencyPick({ currencies, value, onChange }: { currencies: MoneyCurrencySummary[]; value: string; onChange: (c: string) => void }) {
  if (currencies.length < 2) return null;
  return (
    <div className="dash-currency">
      <Segmented label="Money type" value={value} options={currencies.map((c) => ({ value: c.currency, label: c.currency }))} onChange={onChange} />
      <p className="dash-grey">Different money types are never added together.</p>
    </div>
  );
}

function Skeletons() {
  return (
    <div className="dash-grid-box" aria-hidden="true">
      <div className="dash-grid">
        <Skeleton className="dash-skel dash-skel--main" />
        <Skeleton className="dash-skel" />
        <Skeleton className="dash-skel" />
        <Skeleton className="dash-skel dash-skel--wide" />
      </div>
    </div>
  );
}

export function MoneyDashboard() {
  const dock = useMedia(DOCK_QUERY);
  const [choice, setChoiceState] = useState<DashChoice>(() => readChoice(location.search, readStored()));
  const { data, error, fresh, reload } = useSummary(choice.apps, choice.period);
  const [currency, setCurrency] = useState<string | null>(null);

  const set = useCallback((patch: Partial<DashChoice>) => setChoiceState((c) => ({ ...c, ...patch })), []);

  // Saved on this device and kept in the address (replaceState: no new history entry, no focus move, no scroll).
  useEffect(() => {
    writeStored(choice);
    const next = `${location.pathname}${choiceSearch(choice, location.search)}${location.hash}`;
    if (next !== `${location.pathname}${location.search}${location.hash}`) history.replaceState(history.state, "", next);
  }, [choice]);

  // The dock's room, set before the first paint so Ask's launcher never moves while this page is open (§19.8).
  useLayoutEffect(() => {
    if (!dock) return;
    const root = document.documentElement;
    root.classList.add("has-money-dock");
    root.style.setProperty("--dock-h", `${DOCK_H}px`);
    return () => {
      root.classList.remove("has-money-dock");
      root.style.removeProperty("--dock-h");
    };
  }, [dock]);

  // Wide screens: the toolbar floats in a rail down the page's right side (so it stays in view, top right, as the page
  // scrolls), and the header keeps its room free.
  const page = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = page.current;
    const bar = root?.querySelector<HTMLElement>(".dash-toolbar");
    if (dock || !root || !bar) return;
    const text = root.querySelector<HTMLElement>(".dash-head__text");
    const measure = () => {
      // Too narrow for the title and the toolbar side by side: the toolbar goes under the title, still on the right.
      const stacked = root.clientWidth - bar.offsetWidth < 300;
      root.classList.toggle("is-stacked", stacked);
      root.style.setProperty("--dash-tb-w", `${Math.ceil(bar.offsetWidth)}px`);
      root.style.setProperty("--dash-tb-h", `${Math.ceil(bar.offsetHeight)}px`);
      root.style.setProperty("--dash-head-h", stacked && text ? `${Math.ceil(text.offsetHeight) + 8}px` : "0px");
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    ro.observe(root);
    if (text) ro.observe(text);
    return () => ro.disconnect();
  }, [dock]);

  const shown = data?.currencies.find((c) => c.currency === currency) ?? data?.currencies[0] ?? null;
  const onlyNotShared = data && !data.included.length && data.excluded.length > 0 && data.excluded.every((e) => e.reason === "not_shared");
  const thisYear = new Date().getUTCFullYear();

  return (
    <div ref={page} className={`page money-dash${dock ? " is-dock" : " is-toolbar"}`} data-help="money-dash" aria-busy={!fresh || undefined}>
      {dock ? null : (
        <div className="dash-rail">
          <Controls choice={choice} set={set} dock={false} />
        </div>
      )}
      <header className="dash-head">
        <div className="dash-head__text">
          <h1 className="page-head__title">Money</h1>
          <p className="dash-grey dash-through">
            {data?.through ? (
              <>
                Up to {plainDay(data.through)}
                {data.lagNote ? <span> · {data.lagNote}</span> : null}
              </>
            ) : data ? (
              "Money the apps report shows here."
            ) : (
              " "
            )}
          </p>
        </div>
        {dock ? null : <span className="dash-head__room" aria-hidden="true" />}
        {/* Phones: the link waits under the cards, so the Monthly number is in view above the dock. */}
        {dock ? null : <PaidLink />}
      </header>

      {error && !data ? <ErrorPanel message={error} onRetry={reload} /> : null}
      {!data && !error ? <Skeletons /> : null}
      {data ? (
        <>
          <Banner summary={data} />
          <div className="dash-grid-box">
          <div className="dash-grid">
            {onlyNotShared ? (
              <OnlyNotShared excluded={data.excluded} />
            ) : !data.currencies.length ? (
              <NoMoneyYet />
            ) : (
              <>
                <KpiCard kind="monthly" currencies={data.currencies} help="money-dash-monthly" main>
                  <WhatIsMrr />
                </KpiCard>
                <KpiCard kind="weekly" currencies={data.currencies} />
                <KpiCard kind="daily" currencies={data.currencies} />
                <KpiCard kind="yearly" currencies={data.currencies} />
              </>
            )}
          </div>
          </div>
          {data.revised.days > 0 ? (
            <p className="dash-grey">
              {names(data.revised.platforms)} changed {data.revised.days === 1 ? "1 day" : `${data.revised.days} days`} after rechecking them. Apps can change a day for a while, and at month end.
            </p>
          ) : null}
          {onlyNotShared ? null : <Notes excluded={data.excluded} />}
          {dock ? <PaidLink /> : null}
          {shown ? (
            <section className="dash-chart-card glass" aria-labelledby="dash-chart-title">
              <div className="dash-section-head">
                <h2 className="dash-section-title" id="dash-chart-title">
                  {shown.chart.bucket === "week" ? "Money per week" : "Money per day"}
                </h2>
                <span className="money-tag">{shown.tag}</span>
              </div>
              <CurrencyPick currencies={data.currencies} value={shown.currency} onChange={setCurrency} />
              <MoneyChart summary={data} entry={shown} />
              <p className="dash-grey">Cards use fixed days. The picker changes the chart and the clip list.</p>
              <HistoryNote summary={data} entry={shown} thisYear={thisYear} />
            </section>
          ) : null}
        </>
      ) : null}

      <MoneyClipList choice={choice} onSort={(sort) => set({ sort })} />

      {dock ? <Controls choice={choice} set={set} dock /> : null}
    </div>
  );
}

/** The first day the chosen period would show if history reached that far back (a plain date, no time zone). */
function startOf(entry: MoneyCurrencySummary): string {
  const d = new Date(`${entry.chart.to}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (entry.chart.period - 1));
  return d.toISOString().slice(0, 10);
}

/** "Money history starts 1 Sep." when the period reaches back before the first stored day. */
function HistoryNote({ summary, entry, thisYear }: { summary: MoneySummary; entry: MoneyCurrencySummary; thisYear: number }) {
  const earliest = entry.platforms
    .map((p) => summary.historyFrom[p])
    .filter((d): d is string => Boolean(d))
    .sort()[0];
  if (!earliest || earliest <= startOf(entry)) return null;
  return <p className="dash-grey">Money history starts {plainShort(earliest, thisYear)}.</p>;
}
