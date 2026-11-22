// Lamo Stories › Dashboard (docs/CONTRACTS.md §45.16.3): the tiles in the contract's order: Needs you, animations
// made, waiting for review, published, being made now (each with its step), connected accounts (n of 5 with names
// and statuses), performance (views, likes, comments, shares; "No numbers yet"; numbers until 7 days after each post)
// and recent activity (the last 10). Polled every 15 s with the Needs you bar (one shared call, §45.16.4). Until the
// setup is finished, a card above the tiles shows its ring ("4 of 11 done") and what is left (§45.29). Above both,
// "Continue: {name}" opens the idea, video, character or reference video the owner had open last (§45.34, request 2
// §2 "Each application should remember its own ... Open projects"), hidden once it is gone.
import { useEffect, useState } from "react";
import { ApiError, friendlyMessage } from "../../api/errors.ts";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { A } from "../../components/ui.tsx";
import { count, relative } from "../../lib/format.ts";
import { storiesApi } from "../api/client.ts";
import { STEP_LABEL, type ProjectRef, type StoriesApi, type StoriesDashboard, type StoryStatus } from "../api/types.ts";
import { currentChoice, rememberProject } from "../workspace.ts";
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

// ---------- Continue: the project open last ----------

interface OpenProject {
  kind: ProjectRef["kind"];
  name: string;
  href: string;
}

const PROJECT_WORDS: Record<ProjectRef["kind"], { line: string; icon: StIconName }> = {
  idea: { line: "The idea you had open", icon: "bulb" },
  story: { line: "The video you had open", icon: "clapper" },
  character: { line: "The character you had open", icon: "face" },
  reference: { line: "The reference video you had open", icon: "film" },
};

/** A video waiting for review (or done) opens in Review; one still being made, or stopped, in Production. */
const IN_REVIEW: readonly StoryStatus[] = ["review", "needs_check", "approved", "rejected", "published"];

/** A project that is not there any more (deleted): its own "could not find", never the workspace's. */
export function projectGone(e: unknown): boolean {
  return e instanceof ApiError && e.code === "not_found" && !/could not find that workspace/i.test(e.message);
}

/** The project's name and its page; null when it is gone (an idea no longer in the list), throws what the API threw. */
export async function openProject(api: StoriesApi, ws: string, ref: ProjectRef): Promise<OpenProject | null> {
  const id = encodeURIComponent(ref.id);
  switch (ref.kind) {
    case "idea": {
      const idea = (await api.listIdeas(ws, "all")).find((i) => i.ideaId === ref.id);
      return idea ? { kind: "idea", name: idea.title, href: `/stories/production/new?idea=${id}` } : null;
    }
    case "story": {
      const { story } = await api.getStory(ws, ref.id);
      return { kind: "story", name: story.title, href: `/stories/${IN_REVIEW.includes(story.status) ? "review" : "production"}/${id}` };
    }
    case "character": {
      const c = await api.getCharacter(ws, ref.id);
      return { kind: "character", name: c.name, href: `/stories/characters/${id}` };
    }
    case "reference": {
      const { reference } = await api.getReference(ws, ref.id);
      return { kind: "reference", name: reference.title, href: `/stories/references/${id}` };
    }
  }
}

/** "Continue: {name}": the project open last in this workspace (cf.workspace lastProject), hidden once it is gone. */
function ContinueCard({ ws }: { ws: string }) {
  const [open, setOpen] = useState<OpenProject | null>(null);
  useEffect(() => {
    const c = currentChoice();
    const ref = c.lastProject;
    // Another Lamo Stories workspace's project is not this one's.
    if (!ref || (c.lastStoriesWorkspaceId !== null && c.lastStoriesWorkspaceId !== ws)) return;
    let live = true;
    openProject(storiesApi(), ws, ref)
      .then((p) => {
        if (!live) return;
        setOpen(p);
        if (!p) rememberProject(null);
      })
      .catch((e: unknown) => {
        // Gone: forgotten, so it is not asked for again. Offline or a hiccup: simply not shown this time.
        if (projectGone(e)) rememberProject(null);
      });
    return () => {
      live = false;
    };
  }, [ws]);
  if (!open) return null;
  const words = PROJECT_WORDS[open.kind];
  return (
    <A href={open.href} className="st-continue" data-kind={open.kind}>
      <span className="st-continue__icon" aria-hidden="true">
        <StIcon name={words.icon} size={24} />
      </span>
      <span className="st-continue__text">
        <span className="st-continue__kind">{words.line}</span>
        <span className="st-continue__name">Continue: {open.name}</span>
      </span>
      <span className="st-continue__go" aria-hidden="true">
        <StIcon name="chevron" size={20} />
      </span>
    </A>
  );
}

/** The steps still left after Finish (skipped ones), as a short list with a way back to them (§45.36 E15). */
function SetupLeft({ left }: { left: { step: string; label: string }[] }) {
  return (
    <section className="st-setupcard st-setupcard--left" aria-labelledby="st-setupleft-title">
      <span className="st-setupcard__mark" aria-hidden="true">
        <StIcon name="bulb" size={24} />
      </span>
      <div className="st-setupcard__text">
        <h2 className="st-setupcard__title" id="st-setupleft-title">
          Finish setting up: {left.length} left
        </h2>
        <ul className="st-setupcard__list" aria-label="Still to do">
          {left.map((s) => (
            <li key={s.step}>{s.label}</li>
          ))}
        </ul>
      </div>
      <StLinkButton href="/stories/setup" className="st-setupcard__go">
        Open setup
        <StIcon name="chevron" size={18} />
      </StLinkButton>
    </section>
  );
}

/**
 * The setup's card (§45.29): shown until the setup is finished, with the ring and the first things left. After Finish
 * with steps skipped, a small card keeps listing them (§45.36 E15).
 */
function SetupCard({ ws }: { ws: string }) {
  const { data } = useOnboarding(ws);
  if (!data) return null;
  const left = data.steps.filter((s) => s.state !== "done" && s.step !== "done");
  if (data.finishedAt) return left.length ? <SetupLeft left={left} /> : null;
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
      <ContinueCard ws={ws} />
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
