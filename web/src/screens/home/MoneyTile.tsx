// Home › Your money (docs/CONTRACTS.md §25.7): the money apps reported this month (one line per currency, each tagged
// as that app's estimate), or "No money yet. Here's how close you are" with the bar nearest its goal. A failed load
// simply hides it (Home's own lists still show). Celebrations play here too, once each.
import type { MoneyView } from "../../api/types.ts";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { LinkButton } from "../../components/ui.tsx";
import { PLATFORM_LABEL } from "../../lib/format.ts";
import { fraction, goalText, MONEY_PATH, nearestGoal } from "../../lib/money.ts";
import { useMoney } from "../../lib/useMoney.ts";
import { MonthLines } from "../settings/MoneyBranch.tsx";

/** What the tile says under its title, for the tests. */
export function moneyTileLine(view: MoneyView): string {
  if (view.thisMonth.length) return "Money the apps reported this month.";
  if (view.platforms.every((c) => c.state === "not_connected")) return "Connect an app to see how close you are to getting paid.";
  return "No money yet. Here's how close you are.";
}

export function MoneyTile() {
  const { data } = useMoney();
  if (!data) return null;
  const near = data.thisMonth.length ? null : nearestGoal(data.platforms);
  return (
    <section className="home-row money-tile" aria-labelledby="money-title" data-help="home-money">
      <div className="home-row__intro">
        <h2 className="display-2" id="money-title">
          Your <em>money</em>.
        </h2>
        <p className="muted">{moneyTileLine(data)}</p>
        <LinkButton href={MONEY_PATH} size="sm" icon="coin" iconAfter="chevronRight">
          See money
        </LinkButton>
      </div>
      <div className="money-tile__body glass">
        {data.thisMonth.length ? (
          <MonthLines view={data} />
        ) : near ? (
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
        ) : (
          <p className="muted">Each app's card shows where to look.</p>
        )}
      </div>
    </section>
  );
}
