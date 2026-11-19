// Home › Streamers (docs/CONTRACTS.md §24.5): the streamers the owner follows, live ones first with a LIVE ring.
// Shown only when the owner follows someone; a failed load simply hides it (Home's own lists still show).
import { api } from "../../api/index.ts";
import type { Follow } from "../../api/types.ts";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { A, LinkButton } from "../../components/ui.tsx";
import { plural } from "../../lib/format.ts";
import { useLoad } from "../../lib/hooks.ts";
import { useLiveEvents } from "../../lib/live.ts";
import { applyFollowEvent, Avatar, FOLLOW_LABEL, sortFollows, watchingLine } from "../settings/FollowBranch.tsx";

export const STREAMERS_PATH = "/settings/clip-making/streamers";
const MAX_SHOWN = 8;

async function loadFollows(): Promise<Follow[]> {
  try {
    return (await api().listFollows()).follows;
  } catch {
    return [];
  }
}

/** "2 live now" or "Nobody is live right now". */
export function liveSummary(follows: readonly Follow[]): string {
  const live = follows.filter((f) => f.live?.isLive).length;
  return live ? `${live} live now.` : "Nobody is live right now.";
}

export function StreamersRow() {
  const { data, setData, reload } = useLoad(loadFollows, "", "streamers");
  useLiveEvents(
    (e) => {
      if (e.type === "follow") setData((d) => (d ? applyFollowEvent(d, e) : d));
    },
    () => void reload(),
  );
  if (!data || data.length === 0) return null;
  const shown = sortFollows(data).slice(0, MAX_SHOWN);
  return (
    <section className="home-row streamers-row" aria-labelledby="streamers-title">
      <div className="home-row__intro">
        <h2 className="display-2" id="streamers-title">
          Your{" "}
          <span className="nowrap">
            <em>streamers</em>.
          </span>
        </h2>
        <p className="muted">
          You follow {plural(data.length, "streamer")}. {liveSummary(data)}
        </p>
        <LinkButton href={STREAMERS_PATH} size="sm" icon="users" iconAfter="chevronRight">
          See them all
        </LinkButton>
      </div>
      <ul className="streamers-row__list" aria-label="Streamers you follow">
        {shown.map((f) => {
          const watching = f.live?.isLive ? watchingLine(f.live.viewers) : null;
          return (
            <li key={f.followId}>
              <A href={STREAMERS_PATH} className={`streamer-chip${f.live?.isLive ? " is-live" : ""}`} data-follow={f.followId}>
                <span className="streamer-chip__pic">
                  <Avatar name={f.name} url={f.avatarUrl} live={!!f.live?.isLive} size={64} />
                  <span className="streamer-chip__mark" aria-hidden="true">
                    <PlatformMark platform={f.platform} size={16} />
                  </span>
                  {f.live?.isLive ? <span className="streamer-chip__live">LIVE</span> : null}
                </span>
                <span className="streamer-chip__name user-text clamp-1">{f.name}</span>
                {/* The platform's name is always written, live or not ("Live on Twitch"). */}
                <span className="streamer-chip__meta">
                  {f.live?.isLive ? `Live on ${FOLLOW_LABEL[f.platform]}` : FOLLOW_LABEL[f.platform]}
                </span>
                {watching ? <span className="streamer-chip__watching">{watching}</span> : null}
                <span className="sr-only">{f.live?.isLive ? ` is live on ${FOLLOW_LABEL[f.platform]}` : ` on ${FOLLOW_LABEL[f.platform]}`}</span>
              </A>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
