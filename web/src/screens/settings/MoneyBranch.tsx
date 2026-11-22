// Settings › Posting › Money (docs/CONTRACTS.md §25.7): how close the owner is to each app's paid programme and the
// money each app itself reported. Nothing is typed in and nothing is guessed: an app that does not share money says
// so, with where to look in that app. "Allow money reading" comes back here with ?result=…&platform=….
import { useEffect, useRef, useState } from "react";
import { api, friendlyMessage } from "../../api/index.ts";
import type { MoneyResult, MoneyView, Platform } from "../../api/types.ts";
import { MoneyCard } from "../../components/MoneyCard.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { Button, ErrorPanel, LinkButton, Skeleton } from "../../components/ui.tsx";
import { burst } from "../../lib/confetti.ts";
import { CR_MONEY_PATH, useCr } from "../../lib/contentRewards.ts";
import { PLATFORM_LABEL } from "../../lib/format.ts";
import { formatMoney, MONEY_RESULTS, PAYOUTS, resultCopy } from "../../lib/money.ts";
import { useAction } from "../../lib/motion.ts";
import { useMoney } from "../../lib/useMoney.ts";
import { Apple, Panel } from "./parts.tsx";

const ORDER: Platform[] = ["youtube", "tiktok", "instagram", "facebook", "x"];

/** Reads ?result=&platform= once and takes them out of the address, so a reload does not say it again. */
export function readMoneyResult(): { result: MoneyResult; platform: Platform } | null {
  const q = new URLSearchParams(location.search);
  const result = q.get("result") as MoneyResult | null;
  const platform = q.get("platform") as Platform | null;
  if (!result) return null;
  q.delete("result");
  q.delete("platform");
  const rest = q.toString();
  history.replaceState(history.state, "", `${location.pathname}${rest ? `?${rest}` : ""}${location.hash}`);
  if (!MONEY_RESULTS.includes(result) || !platform || !ORDER.includes(platform)) return null;
  return { result, platform };
}

export function MoneyBranch() {
  const { data, error, reload, setData } = useMoney();
  const toast = useToast();
  const arrived = useRef(false);
  const [checking, setChecking] = useState(false);
  const check = useAction("refresh");

  async function checkNow(quiet = false): Promise<boolean> {
    setChecking(true);
    try {
      const out = await api().refreshMoney();
      if (!out.started) {
        if (!quiet) toast.info("Clip Factory checked less than an hour ago. Your numbers are up to date.", { group: "money" });
        return false;
      }
      if (!quiet) toast.success("Checking every app now. New numbers show in a minute.", { group: "money" });
      setTimeout(() => void reload(), 4000);
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    if (arrived.current) return;
    arrived.current = true;
    const back = readMoneyResult();
    if (!back) return;
    const { ok, text } = resultCopy(back.result, PLATFORM_LABEL[back.platform]);
    if (ok) {
      burst(undefined, 120);
      toast.success(text, { group: "money-result" });
      void checkNow(true);
    } else {
      toast.info(text, { group: "money-result" });
    }
    // checkNow is stable enough for a one-time arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <Panel className="money-top">
        <div className="money-top__row">
          <MonthLines view={data} />
          <Button variant="primary" size="md" icon="retry" act={check} loading={checking} onClick={() => checkNow()} className="money-top__check" data-help="money-check">
            Check now
          </Button>
        </div>
        <p className="money-top__rule">
          Clip Factory only shows money an app reports. It never guesses, and you never type money in. Each amount is that
          app's own estimate.
        </p>
      </Panel>
      {error && !data ? (
        <Panel>
          <ErrorPanel message={error} onRetry={() => void reload()} />
        </Panel>
      ) : null}
      <Panel>
        <Apple id="money-dashboard" wide>
          <LinkButton href="/money" icon="chart" iconAfter="chevronRight">
            Open the money dashboard
          </LinkButton>
        </Apple>
      </Panel>
      <Panel>
        <Apple id="money-country" wide>
          {data ? <CountryPick view={data} onChange={(v) => setData(() => v)} /> : <Skeleton className="line-skel" />}
        </Apple>
      </Panel>
      {ORDER.map((p) => {
        const card = data?.platforms.find((c) => c.platform === p);
        return (
          <Panel key={p}>
            <Apple id={`money-${p}`} wide>
              {card ? <MoneyCard card={card} named={false} /> : <Skeleton className="money-card-skel" />}
            </Apple>
          </Panel>
        );
      })}
      <CrMoneyApple />
      <Panel>
        <Apple id="money-payouts" wide>
          <Payouts />
          {/* §40.8 change 4: the steps for each app are in Get paid. */}
          <LinkButton href="/settings/posting/getpaid" icon="coin" iconAfter="chevronRight" data-money="getpaid">
            Open Get paid
          </LinkButton>
        </Apple>
      </Panel>
    </>
  );
}

/** "This month: $12.40 · YouTube's estimate", one line per currency (never converted), or how to get there. */
export function MonthLines({ view }: { view: MoneyView | null }) {
  if (!view) return <Skeleton className="line-skel" />;
  if (!view.thisMonth.length) {
    return (
      <p className="money-top__none">
        <strong>No money yet.</strong> Each card below shows how close you are.
      </p>
    );
  }
  return (
    <ul className="money-top__lines" aria-label="Money this month">
      {view.thisMonth.map((line) => (
        <li key={line.currency} data-money-month={line.currency}>
          <span className="money-top__lead">This month</span>
          <strong className="money-top__num">{formatMoney(line.amountMicros, line.currency)}</strong>
          <span className="money-tag">{line.platforms.map((p) => (p === "facebook" ? "Meta" : PLATFORM_LABEL[p])).join(" and ")}'s estimate</span>
        </li>
      ))}
    </ul>
  );
}

function CountryPick({ view, onChange }: { view: MoneyView; onChange: (v: MoneyView) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <label className="money-country">
      <span className="sr-only">Your country</span>
      <select
        className="input money-country__select"
        value={view.country ?? ""}
        disabled={busy}
        onChange={async (e) => {
          const code = e.target.value;
          if (!code) return;
          setBusy(true);
          try {
            const next = await api().setMoneyCountry(code);
            onChange(next);
            const name = view.countries.find((c) => c.code === code)?.name ?? code;
            toast.success(`Saved. Your country is ${name}.`, { group: "money" });
          } catch (err) {
            toast.error(friendlyMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <option value="" disabled>
          Pick your country
        </option>
        {view.countries.map((c) => (
          <option key={c.code} value={c.code}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function Payouts() {
  return (
    <div className="money-payouts">
      <p className="money-payouts__safe">
        <strong>Clip Factory never needs your bank details.</strong> Each app sends money to you itself.
      </p>
      <ul className="money-payouts__list">
        {PAYOUTS.map((p) => (
          <li key={p.platform} data-payout={p.platform}>
            <span className={`money-card__mark is-${p.platform}`} aria-hidden="true">
              <PlatformMark platform={p.platform} size={16} />
            </span>
            <span>
              <strong>{PLATFORM_LABEL[p.platform]}:</strong> {p.how}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Content Rewards' money (§38.7) lives on the Money page; here one link takes him there. Hidden without it. */
function CrMoneyApple() {
  const cr = useCr();
  if (cr.state === "missing" || cr.state === "loading") return null;
  return (
    <Panel>
      <Apple id="money-contentrewards" wide>
        <LinkButton href={CR_MONEY_PATH} icon="coin" iconAfter="chevronRight">
          Open Content Rewards money
        </LinkButton>
      </Apple>
    </Panel>
  );
}
