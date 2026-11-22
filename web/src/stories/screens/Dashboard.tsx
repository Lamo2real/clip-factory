// Lamo Stories › Dashboard (docs/CONTRACTS.md §45.16.3): the tiles in the contract's order: Needs you, animations
// made, waiting for review, published, being made now (each with its step), connected accounts (n of 5 with names
// and statuses), performance (views, likes, comments, shares; "No numbers yet"; numbers until 7 days after each post)
// and recent activity (the last 10). Polled every 15 s with the Needs you bar (one shared call, §45.16.4). Until the
// setup is finished, a card above the tiles shows its ring ("4 of 11 done") and what is left (§45.29).
import { useState } from "react";
import { friendlyMessage } from "../../api/errors.ts";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { A } from "../../components/ui.tsx";
import { count, relative } from "../../lib/format.ts";
import { storiesApi } from "../api/client.ts";
import { STEP_LABEL, type StoriesDashboard } from "../api/types.ts";
import {
  celebrate,
  centerOf,
  PLATFORM_NAME,
  refreshDashboard,
  StButton,
  StEmpty,
  StError,
  StIcon,
  StLinkButton,
  StLoading,
  StMascot,
  StPageHead,
  StRing,
  useDashboard,
  useOnboarding,
  type StIconName,
  type StTone,
} from "../ui.tsx";
import type { StoriesScreenProps } from "./types.ts";

const ACCOUNT_WORDS: Record<StoriesDashboard["accounts"][number]["status"], { label: string; tone: StTone }> = {
  connected: { label: "Connected", tone: "mint" },
  choose_account: { label: "Pick an account", tone: "sun" },
  needs_reconnect: { label: "Connect again", tone: "coral" },
  same_as_clips: { label: "Same as Clip Factory", tone: "coral" },
  not_connected: { label: "Not connected", tone: "sky" },
};

const ACTIVITY: Record<StoriesDashboard["activity"][number]["kind"], { icon: StIconName; words: string }> = {
  made: { icon: "clapper", words: "Made" },
  approved: { icon: "check", words: "Approved" },
  rejected: { icon: "close", words: "Not used" },
  changes: { icon: "retry", words: "Changes asked for" },
  posted: { icon: "share", words: "Posted" },
  failed: { icon: "alert", words: "Stopped" },
};

function Stat({ value, label, tone, icon, href }: { value: number; label: string; tone: StTone; icon: StIconName; href?: string }) {
  const body = (
    <>
      <span className={`st-stat__icon st-stat__icon--${tone}`} aria-hidden="true">
        <StIcon name={icon} size={24} />
      </span>
      <span className="st-stat__value">{count(value)}</span>
      <span className="st-stat__label">{label}</span>
    </>
  );
  return href ? (
    <A href={href} className={`st-tile st-stat st-stat--${tone} st-stat--link`}>
      {body}
    </A>
  ) : (
    <div className={`st-tile st-stat st-stat--${tone}`}>{body}</div>
  );
}

function NeedsYou({ ws, items }: { ws: string; items: StoriesDashboard["needsYou"] }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const retry = async (id: string, el: HTMLElement | null) => {
    setBusy(id);
    try {
      await storiesApi().retryPublishing(ws, id);
      celebrate(centerOf(el));
      toast.success("Trying again now.");
      await refreshDashboard(ws).catch(() => undefined);
    } catch (e) {
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="st-tile st-tile--wide st-tile--needs" aria-labelledby="st-dash-needs">
      <h2 className="st-tile__title" id="st-dash-needs">
        <StIcon name="alert" size={22} />
        Needs you
        {items.length ? <span className="st-tile__count">{items.length}</span> : null}
      </h2>
      {items.length === 0 ? (
        <div className="st-calm">
          <StMascot mood="cheer" tone="mint" size={72} />
          <p>Nothing needs you right now. Nice work!</p>
        </div>
      ) : (
        <ul className="st-needs-list">
          {items.map((n, i) => (
            <li key={`${n.href}-${n.publishingJobId ?? n.storyId ?? n.platform ?? i}-${i}`} className="st-needs-list__item">
              {n.platform ? (
                <span className="st-needs-list__mark" title={PLATFORM_NAME[n.platform]}>
                  <PlatformMark platform={n.platform} size={20} />
                </span>
              ) : (
                <span className="st-needs-list__mark" aria-hidden="true">
                  <StIcon name="screen" size={20} />
                </span>
              )}
              <p className="st-needs-list__text">
                {n.storyId && n.platform ? <strong>{n.title} · {PLATFORM_NAME[n.platform]}: </strong> : null}
                {n.sentence}
              </p>
              <div className="st-needs-list__actions">
                {n.publishingJobId ? (
                  <StButton
                    disabled={busy === n.publishingJobId}
                    aria-disabled={busy === n.publishingJobId || undefined}
                    onClick={(e) => void retry(n.publishingJobId!, e.currentTarget)}
                  >
                    <StIcon name="retry" size={18} />
                    Try again
                  </StButton>
                ) : null}
                <StLinkButton href={n.href} main>
                  Open
                </StLinkButton>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Producing({ items }: { items: StoriesDashboard["producing"] }) {
  return (
    <section className="st-tile st-tile--wide" aria-labelledby="st-dash-making">
      <h2 className="st-tile__title" id="st-dash-making">
        <StIcon name="clapper" size={22} />
        Being made now
        <span className="st-tile__count">{items.length}</span>
      </h2>
      {items.length === 0 ? (
        <div className="st-calm">
          <StMascot mood="sleepy" tone="sky" size={72} />
          <p>The studio is quiet. Make a video to wake it up.</p>
        </div>
      ) : (
        <ul className="st-making">
          {items.map((p) => (
            <li key={p.storyId}>
              <A href={`/stories/production/${encodeURIComponent(p.storyId)}`} className="st-making__row">
                <span className="st-making__title">{p.title}</span>
                <span className="st-making__step">{STEP_LABEL[p.step]}</span>
                <span className="st-bar" role="progressbar" aria-label={`${p.title}: ${STEP_LABEL[p.step]}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p.progress * 100)}>
                  <span className="st-bar__fill" style={{ width: `${Math.max(4, Math.round(p.progress * 100))}%` }} />
                </span>
              </A>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Accounts({ items }: { items: StoriesDashboard["accounts"] }) {
  const connected = items.filter((a) => a.status === "connected").length;
  return (
    <section className="st-tile" aria-labelledby="st-dash-accounts">
      <h2 className="st-tile__title" id="st-dash-accounts">
        <StIcon name="plug" size={22} />
        Connected accounts
      </h2>
      <p className="st-tile__big">
        {connected} <span>of {items.length || 5}</span>
      </p>
      <ul className="st-accounts">
        {items.map((a) => (
          <li key={a.platform} className="st-accounts__row">
            <span className="st-accounts__mark">
              <PlatformMark platform={a.platform} size={20} />
            </span>
            <span className="st-accounts__name">
              <span className="sr-only">{PLATFORM_NAME[a.platform]}: </span>
              {a.accountName ?? PLATFORM_NAME[a.platform]}
            </span>
            <span className={`st-chip st-chip--${ACCOUNT_WORDS[a.status].tone}`}>{ACCOUNT_WORDS[a.status].label}</span>
          </li>
        ))}
      </ul>
      <StLinkButton href="/stories/connections">Open Social accounts</StLinkButton>
    </section>
  );
}

function Performance({ perf }: { perf: StoriesDashboard["performance"] }) {
  const none = perf.posts === 0 || perf.checkedAt === null;
  const nums: { icon: StIconName; label: string; value: number }[] = [
    { icon: "eye", label: "Views", value: perf.views },
    { icon: "heart", label: "Likes", value: perf.likes },
    { icon: "comment", label: "Comments", value: perf.comments },
    { icon: "share", label: "Shares", value: perf.shares },
  ];
  return (
    <section className="st-tile" aria-labelledby="st-dash-perf">
      <h2 className="st-tile__title" id="st-dash-perf">
        <StIcon name="star" size={22} />
        How the videos do
      </h2>
      {none ? (
        <p className="st-tile__note">No numbers yet. They show up after the first post.</p>
      ) : (
        <ul className="st-perf">
          {nums.map((n) => (
            <li key={n.label} className="st-perf__item">
              <StIcon name={n.icon} size={20} />
              <span className="st-perf__value">{count(n.value)}</span>
              <span className="st-perf__label">{n.label}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="st-tile__note">
        Numbers until 7 days after each post.
        {perf.checkedAt ? ` Checked ${relative(perf.checkedAt)}.` : ""}
        {perf.posts ? ` From ${perf.posts} ${perf.posts === 1 ? "post" : "posts"}.` : ""}
      </p>
    </section>
  );
}

function Activity({ items }: { items: StoriesDashboard["activity"] }) {
  return (
    <section className="st-tile st-tile--wide" aria-labelledby="st-dash-activity">
      <h2 className="st-tile__title" id="st-dash-activity">
        <StIcon name="clock" size={22} />
        What happened lately
      </h2>
      {items.length === 0 ? (
        <p className="st-tile__note">Nothing yet. Your first video shows up here.</p>
      ) : (
        <ol className="st-activity">
          {items.map((a, i) => (
            <li key={`${a.at}-${a.storyId}-${a.kind}-${i}`}>
              <A href={`/stories/review/${encodeURIComponent(a.storyId)}`} className={`st-activity__row st-activity__row--${a.kind}`}>
                <span className="st-activity__icon" aria-hidden="true">
                  <StIcon name={ACTIVITY[a.kind].icon} size={18} />
                </span>
                <span className="st-activity__text">
                  <strong>{ACTIVITY[a.kind].words}</strong> {a.title}
                  {a.platform ? ` on ${PLATFORM_NAME[a.platform]}` : ""}
                </span>
                <span className="st-activity__when">{relative(a.at)}</span>
              </A>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** The setup's card (§45.29): shown until the setup is finished, with the ring and the first things left. */
function SetupCard({ ws }: { ws: string }) {
  const { data } = useOnboarding(ws);
  if (!data || data.finishedAt) return null;
  const left = data.steps.filter((s) => s.state !== "done" && s.step !== "done");
  return (
    <section className="st-setupcard" aria-labelledby="st-setupcard-title">
      <StRing done={data.done} total={data.total} size={88} />
      <div className="st-setupcard__text">
        <h2 className="st-setupcard__title" id="st-setupcard-title">
          Set up Lamo Stories: {data.done} of {data.total} done
        </h2>
        {left.length ? (
          <p className="st-setupcard__left">
            Still to do: {left.slice(0, 3).map((s) => s.label).join(", ")}
            {left.length > 3 ? ` and ${left.length - 3} more` : ""}. You can make videos already.
          </p>
        ) : (
          <p className="st-setupcard__left">Everything is set up. Tap Finish to close the setup.</p>
        )}
      </div>
      <StLinkButton href="/stories/setup" main className="st-setupcard__go">
        {data.done === 0 ? "Start the setup" : left.length ? "Carry on" : "Finish"}
        <StIcon name="chevron" size={18} />
      </StLinkButton>
    </section>
  );
}

export function DashboardScreen({ ws }: StoriesScreenProps) {
  const { data, error, reload } = useDashboard(ws);
  return (
    <section className="st-page st-dash">
      <StPageHead
        title="Dashboard"
        lede="Everything happening in your animation studio."
        actions={
          <>
            <StLinkButton href="/stories/ideas">
              <StIcon name="bulb" size={20} />
              New idea
            </StLinkButton>
            <StLinkButton href="/stories/production/new" main>
              <StIcon name="clapper" size={20} />
              Make a video
            </StLinkButton>
          </>
        }
      />
      <SetupCard ws={ws} />
      {!data && error ? (
        <StError message={error} onRetry={reload} />
      ) : !data ? (
        <StLoading label="Counting the videos…" />
      ) : data.counts.made === 0 && data.producing.length === 0 && data.needsYou.length === 0 && data.activity.length === 0 ? (
        <>
          <StEmpty title="Your studio is ready" action={<StLinkButton href="/stories/production/new" main>Make your first video</StLinkButton>}>
            Pick an idea and a character, and Lamo Stories makes the cartoon.
          </StEmpty>
          <div className="st-tiles">
            <Accounts items={data.accounts} />
          </div>
        </>
      ) : (
        <div className="st-tiles">
          <NeedsYou ws={ws} items={data.needsYou} />
          <Stat value={data.counts.made} label="Animations made" tone="mint" icon="film" href="/stories/library?kind=videos" />
          <Stat value={data.counts.review + data.counts.needsCheck} label="Waiting for review" tone="sun" icon="screen" href="/stories/review" />
          <Stat value={data.counts.published} label="Published" tone="sky" icon="share" href="/stories/library" />
          <Producing items={data.producing} />
          <Accounts items={data.accounts} />
          <Performance perf={data.performance} />
          <Activity items={data.activity} />
        </div>
      )}
      {error && data ? <p className="st-stale" role="status">{error}</p> : null}
    </section>
  );
}
