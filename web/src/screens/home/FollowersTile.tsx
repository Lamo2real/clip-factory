// Home › Your followers (docs/CONTRACTS.md §43): how many follow the owner on each app right now, as each app last
// reported it (the daily check). Apps that are not connected share one line, which never names a skipped one (rule S),
// and with nothing connected and every app skipped there is no tile. A failed load simply hides the tile.
import { api } from "../../api/index.ts";
import type { FollowersView, Platform } from "../../api/types.ts";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { LinkButton } from "../../components/ui.tsx";
import { PLATFORM_LABEL } from "../../lib/format.ts";
import { followersTileEmpty, followersTileLine, joinNames, notConnected, totalRow } from "../../lib/followers.ts";
import { useLoad } from "../../lib/hooks.ts";

const NO_SKIPS: readonly Platform[] = [];

/** `skipped`: the skipped places (Settings.setupSkipped, Home passes them), never named as not connected. */
export function FollowersTile({ skipped = NO_SKIPS }: { skipped?: readonly Platform[] }) {
  const { data } = useLoad<FollowersView>(() => api().getFollowers(), "", "followers");
  if (!data || followersTileEmpty(data.platforms, skipped)) return null;
  const shown = data.platforms.filter((c) => c.state !== "not_connected");
  const off = notConnected(data.platforms, skipped);
  const now = Date.now();
  return (
    <section className="home-row followers-tile" aria-labelledby="followers-title" data-help="home-followers">
      <div className="home-row__intro">
        <h2 className="display-2" id="followers-title">
          Your <em>followers</em>.
        </h2>
        <p className="muted">{followersTileLine(data.platforms)}</p>
        {shown.length === 0 ? (
          <LinkButton href="/settings/posting/setup" size="sm" icon="users" iconAfter="chevronRight">
            Set up posting
          </LinkButton>
        ) : null}
      </div>
      <div className="followers-tile__body glass">
        {shown.length ? (
          <ul className="followers-tile__list">
            {shown.map((c) => {
              const row = totalRow(c, now);
              return (
                <li key={c.platform} className="followers-tile__row" data-platform={c.platform} data-state={c.state}>
                  <span className={`money-card__mark is-${c.platform}`} aria-hidden="true">
                    <PlatformMark platform={c.platform} size={16} />
                  </span>
                  <span className="followers-tile__text">
                    <span className="sr-only">{row.spoken}</span>
                    <span aria-hidden="true" className="followers-tile__main">
                      <strong>{PLATFORM_LABEL[c.platform]}:</strong>{" "}
                      {row.value ? <span className="followers-tile__num">{row.value}</span> : <span className="muted">{row.note}</span>}
                    </span>
                    {row.change ? (
                      <span aria-hidden="true" className="followers-tile__change">
                        {row.change}
                      </span>
                    ) : null}
                    {row.fine ? <span className="followers-tile__fine">{row.fine}</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}
        {off.length ? (
          <p className="followers-tile__off muted" data-off={off.join(",")}>
            Not connected: {joinNames(off)}.
          </p>
        ) : null}
      </div>
    </section>
  );
}
