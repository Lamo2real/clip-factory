// Home › Your money (docs/CONTRACTS.md §25.7): the money apps reported this month (one line per currency, each tagged
// as that app's estimate), or "No money yet. Here's how close you are" with the bar nearest its goal. A failed load
// simply hides it (Home's own lists still show). Celebrations play here too, once each. "Connect an app…" never stands
// for skipped places only (rule S): with nothing connected and every app skipped, there is no tile.
import type { MoneyView, Platform } from "../../api/types.ts";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { LinkButton } from "../../components/ui.tsx";
import { PLATFORM_LABEL } from "../../lib/format.ts";
import { fraction, goalText, nearestGoal } from "../../lib/money.ts";
import { DASH_PATH } from "../../lib/moneyDash.ts";
import { useMoney } from "../../lib/useMoney.ts";
import { MonthLines } from "../settings/MoneyBranch.tsx";

/**
 * What the tile says under its title, for the tests. null: nothing is connected and every app is skipped, so the
 * only thing to say would be a reminder of places he chose to leave out, and the tile does not show.
 */
export function moneyTileLine(view: MoneyView, skipped: readonly Platform[] = []): string | null {
  if (view.thisMonth.length) return "Money the apps reported this month.";
  if (view.platforms.every((c) => c.state === "not_connected"))
    return view.platforms.some((c) => !skipped.includes(c.platform)) ? "Connect an app to see how close you are to getting paid." : null;
  return "No money yet. Here's how close you are.";
}

const NO_SKIPS: readonly Platform[] = [];

/** `skipped`: the skipped places (Settings.setupSkipped, Home passes them). */
export function MoneyTile({ skipped = NO_SKIPS }: { skipped?: readonly Platform[] }) {
  const { data } = useMoney();
  const line = data ? moneyTileLine(data, skipped) : null;
  if (!data || line === null) return null;
  const near = data.thisMonth.length ? null : nearestGoal(data.platforms);
  return (
    <section className="home-row money-tile" aria-labelledby="money-title" data-help="home-money">
      <div className="home-row__intro">
        <h2 className="display-2" id="money-title">
          Your <em>money</em>.
        </h2>
        <p className="muted">{line}</p>
        <LinkButton href={DASH_PATH} size="sm" icon="coin" iconAfter="chevronRight">
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
