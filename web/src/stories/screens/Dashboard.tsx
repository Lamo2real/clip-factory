// Lamo Stories › Dashboard (docs/CONTRACTS.md §45.16.3): the tiles in the contract's order: Needs you, animations
// made, waiting for review, published, being made now (each with its step), connected accounts (n of 5 with names
// and statuses), performance (views, likes, comments, shares; "No numbers yet"; numbers until 7 days after each post)
// and recent activity (the last 10). Polled every 15 s with the Needs you bar (one shared call, §45.16.4). Until the
// setup is finished, a card above the tiles shows its ring ("4 of 11 done") and what is left (§45.29). Above both,
// "Continue: {name}" opens the idea, video, character or reference video the owner had open last (§45.34, request 2
// §2 "Each application should remember its own ... Open projects"), hidden once it is gone.
//
// The look (styles/st-dashboard.css, the liquid-glass contract styles/GLASS-CONTRACT.md): the page head on its backing
// plate (rule 6), every tile a smoky glass card (.st-glass), the counts as big light numerals with a small unit
// (StatNumeral), one solid cream card among them with an orange toggle (the next video's music, saved in the
// workspace's settings like Settings › Video does), the videos being made as media rows, the setup's progress on an
// arc with a white knob (ArcDial), round glass marks (.st-round-btn) with warm glyphs, and pills to pick what "What
// happened lately" shows (on the sliding highlight). One orange main action per screen: the setup's way on while it
// is open, else the empty studio's first video, else Make a video; every other button is glass.
import { useEffect, useId, useState } from "react";
import { ApiError, friendlyMessage } from "../../api/errors.ts";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { A } from "../../components/ui.tsx";
import { count, relative } from "../../lib/format.ts";
import { storiesApi } from "../api/client.ts";
import { STEP_LABEL, type Onboarding, type ProjectRef, type StoriesApi, type StoriesDashboard, type StoryStatus } from "../api/types.ts";
import { ArcDial, CreamCard, GlassToggle, MediaRow, StatNumeral } from "../glass/index.ts";
import { useWorkspaceConfig } from "../settings/data.ts";
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
  StPick,
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

/** Each line's icon and word; a status (done, or stopped) also gets its colour, the rest a round glass mark. */
const ACTIVITY: Record<StoriesDashboard["activity"][number]["kind"], { icon: StIconName; words: string; status?: "mint" | "coral" }> = {
  made: { icon: "clapper", words: "Made" },
  approved: { icon: "check", words: "Approved", status: "mint" },
  rejected: { icon: "close", words: "Not used", status: "coral" },
  changes: { icon: "retry", words: "Changes asked for" },
  posted: { icon: "share", words: "Posted", status: "mint" },
  failed: { icon: "alert", words: "Stopped", status: "coral" },
};

/** "1.5K" → a big "1.5" and a small "K": the numeral and its unit (plain counts have no unit). */
export function splitCount(n: number): { num: string; unit?: string } {
  const s = count(n);
  const m = /^([\d.,]+)\s*([^\d\s.,]+)$/.exec(s);
  return m ? { num: m[1]!, unit: m[2]! } : { num: s };
}

/** The small unit of a count of videos: "video" for one, else "videos" (after a K or M: "K videos"). */
export function videosUnit(n: number): string {
  const { unit } = splitCount(n);
  const word = n === 1 ? "video" : "videos";
  return unit ? `${unit} ${word}` : word;
}

function Stat({ value, label, tone, icon, href }: { value: number; label: string; tone: StTone; icon: StIconName; href?: string }) {
  const n = splitCount(value);
  const body = (
    <>
      <span className={`st-round-btn st-dash-stat__icon st-dash-stat__icon--${tone}`} aria-hidden="true">
        <StIcon name={icon} size={22} />
      </span>
      <StatNumeral value={n.num} unit={videosUnit(value)} label={label} className="st-dash-stat__figure" />
      {href ? (
        <span className="st-round-btn st-dash-stat__go" aria-hidden="true">
          <StIcon name="chevron" size={18} />
        </span>
      ) : null}
    </>
  );
  return href ? (
    <A href={href} className={`st-tile st-glass st-dash-stat st-dash-stat--${tone} st-dash-stat--link`}>
      {body}
    </A>
  ) : (
    <div className={`st-tile st-glass st-dash-stat st-dash-stat--${tone}`}>{body}</div>
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
    <section className="st-tile st-glass st-tile--wide st-tile--needs" aria-labelledby="st-dash-needs">
      <h2 className="st-tile__title st-display" id="st-dash-needs">
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
                <span className="st-round-btn st-needs-list__mark" title={PLATFORM_NAME[n.platform]}>
                  <PlatformMark platform={n.platform} size={20} />
                </span>
              ) : (
                <span className="st-round-btn st-needs-list__mark" aria-hidden="true">
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
                    aria-disabled={busy === n.publishingJobId || undefined}
                    onClick={(e) => {
                      // Kid-proof: never disabled; a second tap while it is trying says no (the deny sound).
                      if (busy !== n.publishingJobId) void retry(n.publishingJobId!, e.currentTarget);
                    }}
                  >
                    <StIcon name="retry" size={18} />
                    Try again
                  </StButton>
                ) : null}
                <StLinkButton href={n.href}>Open</StLinkButton>
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
    <section className="st-tile st-glass st-tile--wide" aria-labelledby="st-dash-making">
      <h2 className="st-tile__title st-display" id="st-dash-making">
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
                <MediaRow
                  thumb={
                    <span className="st-making__thumb">
                      <StIcon name="clapper" size={28} />
                    </span>
                  }
                  title={<span className="st-making__title">{p.title}</span>}
                  meta={<span className="st-making__step">{STEP_LABEL[p.step]}</span>}
                  progress={p.progress}
                  progressLabel={`${p.title}: ${STEP_LABEL[p.step]}`}
                  progressText={`${Math.round(p.progress * 100)}%`}
                />
                <span className="st-round-btn st-making__go" aria-hidden="true">
                  <StIcon name="chevron" size={18} />
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
    <section className="st-tile st-glass" aria-labelledby="st-dash-accounts">
      <h2 className="st-tile__title st-display" id="st-dash-accounts">
        <StIcon name="plug" size={22} />
        Connected accounts
      </h2>
      <p className="st-tile__big st-stat__value">
        <span className="st-stat__num">{connected}</span> <span className="st-stat__unit">of {items.length || 5}</span>
      </p>
      <ul className="st-accounts">
        {items.map((a) => (
          <li key={a.platform} className="st-accounts__row">
            <span className="st-round-btn st-accounts__mark">
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
    <section className="st-tile st-glass" aria-labelledby="st-dash-perf">
      <h2 className="st-tile__title st-display" id="st-dash-perf">
        <StIcon name="star" size={22} />
        How the videos do
      </h2>
      {none ? (
        <p className="st-tile__note">No numbers yet. They show up after the first post.</p>
      ) : (
        <ul className="st-perf">
          {nums.map((n) => {
            const v = splitCount(n.value);
            return (
              <li key={n.label} className="st-perf__item">
                <span className="st-round-btn st-perf__icon" aria-hidden="true">
                  <StIcon name={n.icon} size={18} />
                </span>
                <StatNumeral value={v.num} unit={v.unit} label={n.label} className="st-perf__figure" />
              </li>
            );
          })}
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

type ActivityKind = StoriesDashboard["activity"][number]["kind"];
type ActivityShow = ActivityKind | "all";
const ACTIVITY_ORDER: readonly ActivityKind[] = ["made", "approved", "changes", "rejected", "posted", "failed"];

/** The pills of "What happened lately": All, then only the kinds that are in the list (never an empty choice). */
export function activityPills(items: StoriesDashboard["activity"]): { value: ActivityShow; label: string }[] {
  const kinds = ACTIVITY_ORDER.filter((k) => items.some((a) => a.kind === k));
  return kinds.length < 2 ? [] : [{ value: "all", label: "All" }, ...kinds.map((k) => ({ value: k, label: ACTIVITY[k].words }))];
}

function Activity({ items }: { items: StoriesDashboard["activity"] }) {
  const [pick, setPick] = useState<ActivityShow>("all");
  const pills = activityPills(items);
  // A kind that left the list (the poll brought new lines) shows everything again.
  const show: ActivityShow = pick !== "all" && pills.some((p) => p.value === pick) ? pick : "all";
  const shown = show === "all" ? items : items.filter((a) => a.kind === show);
  return (
    <section className="st-tile st-glass st-tile--wide" aria-labelledby="st-dash-activity">
      <div className="st-tile__head">
        <h2 className="st-tile__title st-display" id="st-dash-activity">
          <StIcon name="clock" size={22} />
          What happened lately
        </h2>
        {pills.length ? (
          <div className="st-dash-pills">
            <StPick label="What happened lately" value={show} options={pills} onChange={setPick} />
          </div>
        ) : null}
      </div>
      {items.length === 0 ? (
        <p className="st-tile__note">Nothing yet. Your first video shows up here.</p>
      ) : (
        <ol className="st-activity">
          {shown.map((a, i) => (
            <li key={`${a.at}-${a.storyId}-${a.kind}-${i}`}>
              <A href={`/stories/review/${encodeURIComponent(a.storyId)}`} className={`st-activity__row st-activity__row--${a.kind}`}>
                <span className={ACTIVITY[a.kind].status ? `st-activity__icon st-activity__icon--${ACTIVITY[a.kind].status}` : "st-round-btn st-activity__icon"} aria-hidden="true">
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

// ---------- The next video: the one cream card, with an orange toggle ----------

/**
 * The settings the next video starts from (the workspace's own, as Settings › Video saves them): its length, and its
 * music on an orange toggle. Shown once the workspace has loaded; nothing when it could not load.
 */
function NextVideo({ ws }: { ws: string }) {
  const { workspace, config, save } = useWorkspaceConfig(ws);
  const id = useId();
  if (!workspace.data) return null;
  const music = config.musicOn !== false;
  return (
    <CreamCard
      className="st-dash-next"
      title="Next video"
      headingLevel={2}
      footer={
        <div className="st-dash-next__music">
          <label className="st-dash-next__label" htmlFor={`${id}-music`}>
            <StIcon name="music" size={18} />
            Music
          </label>
          <GlassToggle id={`${id}-music`} label="Music" checked={music} onChange={(v) => save({ musicOn: v })} />
        </div>
      }
    >
      <p className="st-dash-next__len">
        <span className="st-dash-next__num">{config.defaultDurationSec}</span> <span className="st-dash-next__unit">seconds</span>
      </p>
    </CreamCard>
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
    <A href={open.href} className="st-continue st-glass st-glass--hero st-lens" data-kind={open.kind}>
      <span className="st-round-btn st-dash-continue__icon" aria-hidden="true">
        <StIcon name={words.icon} size={24} />
      </span>
      <span className="st-continue__text">
        <span className="st-continue__kind">{words.line}</span>
        <span className="st-continue__name">Continue: {open.name}</span>
      </span>
      <span className="st-round-btn st-round-btn--cream st-dash-continue__go" aria-hidden="true">
        <StIcon name="chevron" size={20} />
      </span>
    </A>
  );
}

/** The steps still left after Finish (skipped ones), as a short list with a way back to them (§45.36 E15). */
function SetupLeft({ left }: { left: { step: string; label: string }[] }) {
  return (
    <section className="st-setupcard st-setupcard--left st-glass" aria-labelledby="st-setupleft-title">
      <span className="st-round-btn st-dash-setup__mark" aria-hidden="true">
        <StIcon name="bulb" size={24} />
      </span>
      <div className="st-setupcard__text">
        <h2 className="st-setupcard__title st-display" id="st-setupleft-title">
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

/** The setup is still open: its big card shows, and its way on is the screen's one orange action. */
function setupOpen(o: Onboarding | null): boolean {
  return !!o && !o.finishedAt;
}

/**
 * The setup's card (§45.29): shown until the setup is finished, with the ring and the first things left. After Finish
 * with steps skipped, a small card keeps listing them (§45.36 E15).
 */
function SetupCard({ data }: { data: Onboarding | null }) {
  if (!data) return null;
  const left = data.steps.filter((s) => s.state !== "done" && s.step !== "done");
  if (data.finishedAt) return left.length ? <SetupLeft left={left} /> : null;
  return (
    <section className="st-setupcard st-glass st-glass--hero st-lens" aria-labelledby="st-setupcard-title">
      <ArcDial value={data.done} max={Math.max(1, data.total)} label="Setup" valueText={`${data.done} of ${data.total} done`} className="st-setupcard__dial">
        <span className="st-dial__value">{data.done}</span>
        <span className="st-setupcard__of">
          of {data.total}
        </span>
      </ArcDial>
      <div className="st-setupcard__text">
        <h2 className="st-setupcard__title st-display" id="st-setupcard-title">
          Set up Funded Clips: {data.done} of {data.total} done
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
  const setup = useOnboarding(ws).data;
  const empty = !!data && data.counts.made === 0 && data.producing.length === 0 && data.needsYou.length === 0 && data.activity.length === 0;
  // One orange main action on the screen (the contract's --st-action): the setup's way on while it is open, else the
  // empty studio's first video, else Make a video.
  const settingUp = setupOpen(setup);
  return (
    <section className="st-page st-dash">
      {/* The shell's page head is the backing plate for its loose words (rule 6): nothing over Ember, a glass plate over
          a picture or the desktop. */}
      <StPageHead
        title="Dashboard"
        lede="Everything happening in your animation studio."
        actions={
          <>
            <StLinkButton href="/stories/ideas">
              <StIcon name="bulb" size={20} />
              New idea
            </StLinkButton>
            <StLinkButton href="/stories/production/new" main={!settingUp && !empty}>
              <StIcon name="clapper" size={20} />
              Make a video
            </StLinkButton>
          </>
        }
      />
      <ContinueCard ws={ws} />
      <SetupCard data={setup} />
      {!data && error ? (
        <StError message={error} onRetry={reload} />
      ) : !data ? (
        <StLoading label="Counting the videos…" />
      ) : empty ? (
        <>
          <StEmpty title="Your studio is ready" action={<StLinkButton href="/stories/production/new" main={!settingUp}>Make your first video</StLinkButton>}>
            Pick an idea and a character, and Funded Clips makes the cartoon.
          </StEmpty>
          <div className="st-tiles st-tiles--start">
            <Accounts items={data.accounts} />
            <NextVideo ws={ws} />
          </div>
        </>
      ) : (
        <div className="st-tiles">
          <NeedsYou ws={ws} items={data.needsYou} />
          <Stat value={data.counts.made} label="Animations made" tone="mint" icon="film" href="/stories/library?kind=videos" />
          <Stat value={data.counts.review + data.counts.needsCheck} label="Waiting for review" tone="sun" icon="screen" href="/stories/review" />
          <Stat value={data.counts.published} label="Published" tone="sky" icon="share" href="/stories/library" />
          <NextVideo ws={ws} />
          <Producing items={data.producing} />
          <Accounts items={data.accounts} />
          <Performance perf={data.performance} />
          <Activity items={data.activity} />
        </div>
      )}
      {error && data ? (
        <p className="st-stale st-plate" role="status">
          {error}
        </p>
      ) : null}
    </section>
  );
}
