import { useState } from "react";
import { api } from "../../api/index.ts";
import { Glide } from "../../components/Glide.tsx";
import { friendlyMessage } from "../../api/errors.ts";
import type { Clip, Learning, Post, TikTokPostOptions } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { A, Button, Empty, ErrorPanel, LinkButton, PageHeader, Segmented, Skeleton } from "../../components/ui.tsx";
import { compact, postStatusLabel, STATUS_LABEL } from "../../lib/metrics.ts";
import { WeekView } from "./WeekView.tsx";
import { byPlatformOrder, count, MOMENT_LABEL, PLATFORM_LABEL, plural, relative } from "../../lib/format.ts";
import { useLoad } from "../../lib/hooks.ts";
import { settingsPath } from "../../lib/settingsTree.ts";
import { useLiveEvents } from "../../lib/live.ts";
import { useAction } from "../../lib/motion.ts";
import { applyClipEvent, applyLearningEvent, applyPostEvent, withMedia } from "../../lib/liveCache.ts";
import { SimilarClips } from "../../components/SimilarClips.tsx";
import { keepClip, keptMessage, needsKeepAgain, needsTikTokChoices, STILL_WORKING } from "../../lib/keep.ts";
import { TikTokSheet } from "../review/TikTokSheet.tsx";
import { ClipStatusPill } from "../jobs/JobDetail.tsx";
import { useSession } from "../../app/session.tsx";
import { clipEarnings, postViews } from "../../lib/earnings.ts";
import { EarnedChip } from "../../components/EarnedChip.tsx";

interface LibraryData {
  clips: Clip[];
  posts: Post[];
  learnings: Learning[];
}

/** The Library lists clips the owner kept: on their way out, out, or stuck on the way. */
const inLibrary = (c: Clip) => c.status === "confirmed" || c.status === "publishing" || c.status === "posted" || c.status === "failed";

async function loadLibrary(): Promise<LibraryData> {
  const [all, posts, insights] = await Promise.all([api().listClips({ status: "all" }), api().listPosts(), api().insights()]);
  // Insights carry the freshest metrics; prefer them over the plain post list.
  const withMetrics = new Map(insights.posts.map((p) => [p.postId, p]));
  return {
    clips: all.filter(inLibrary),
    posts: posts.map((p) => withMetrics.get(p.postId) ?? p),
    learnings: insights.learnings,
  };
}

export type Filter = "all" | "waiting" | "posted";

/** Library: every kept clip, or This week's clips with their "Best this week" stars (§16.8). */
export function Library({ view = "all", week = null }: { view?: "all" | "week"; week?: string | null }) {
  return (
    <div className="page">
      <PageHeader
        title={
          <>
            What went <em>out</em>, and how it did.
          </>
        }
        lede={
          view === "week"
            ? "This week's clips, most views first. Star the ones that did best, and Clip Factory learns how to make more like them."
            : "Clips you kept and posted. Tap a clip to see how it did on each app."
        }
      />
      <nav className="lib-tabs" aria-label="Library views">
        <Glide active=".lib-tab.is-on" className="glide--dark" />
        <A href="/library" className={`lib-tab${view === "all" ? " is-on" : ""}`} aria-current={view === "all" ? "page" : undefined}>
          <Icon name="library" size={18} />
          All clips
        </A>
        <A href="/library?view=week" className={`lib-tab${view === "week" ? " is-on" : ""}`} aria-current={view === "week" ? "page" : undefined} data-help="this-week-tab">
          <Icon name="star" size={18} />
          This week
        </A>
      </nav>
      {view === "week" ? <WeekView week={week} /> : <AllClips />}
    </div>
  );
}

function AllClips() {
  const { data, error, reload, setData } = useLoad(loadLibrary);
  // Keep again worked: swap in the fresh clip and its new posts.
  const kept = (clip: Clip, posts: Post[]) =>
    setData((d) =>
      d
        ? {
            ...d,
            clips: d.clips.map((c) => (c.clipId === clip.clipId ? clip : c)),
            posts: [...d.posts.filter((p) => p.clipId !== clip.clipId), ...posts],
          }
        : d,
    );
  const [filter, setFilter] = useState<Filter>("all");

  // Live: kept clips arrive, posts change state and get their numbers, new learnings appear.
  useLiveEvents(
    (e) => {
      if (e.type === "clip") {
        const missing = data ? applyClipEvent(data.clips, e, inLibrary).needMedia : [];
        setData((d) => (d ? { ...d, clips: applyClipEvent(d.clips, e, inLibrary).clips } : d));
        for (const clipId of missing)
          void api()
            .getClip(clipId)
            .then((fresh) => setData((d) => (d ? { ...d, clips: withMedia(d.clips, fresh) } : d)))
            .catch(() => undefined);
      } else if (e.type === "post") setData((d) => (d ? { ...d, posts: applyPostEvent(d.posts, e) } : d));
      else if (e.type === "learning") setData((d) => (d ? { ...d, learnings: applyLearningEvent(d.learnings, e) } : d));
    },
    () => void reload(),
  );

  const clips =
    data?.clips.filter((c) =>
      filter === "all" ? true : filter === "posted" ? c.status === "posted" : c.status !== "posted",
    ) ?? [];
  const totals = (data?.posts ?? []).reduce(
    (t, p) => {
      if (!p.metrics) return t;
      return {
        views: t.views + (p.metrics.views ?? 0),
        likes: t.likes + (p.metrics.likes ?? 0),
        shares: t.shares + (p.metrics.shares ?? 0),
      };
    },
    { views: 0, likes: 0, shares: 0 },
  );

  return (
    <>
      {error && !data ? <ErrorPanel message={error} onRetry={reload} /> : null}
      {!data && !error ? <Skeleton className="review-skel" /> : null}
      {data ? (
        <>
          <section className="insights" aria-labelledby="learn-title">
            <div className="learnings glass glass--green">
              <h2 className="display-3" id="learn-title">
                What&rsquo;s <em>working</em>
              </h2>
              {data.learnings.length ? (
                <ul className="learnings__list">
                  {data.learnings.map((l) => (
                    <li key={l.learningId}>
                      <p className="user-text">{l.text}</p>
                      <span className="learnings__meta">
                        {l.kind === "week" ? "" : "Older note · "}
                        {relative(l.createdAt)} · from {plural(l.postIds.length, "post")}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">Star your best clips in This week, and Clip Factory learns from them.</p>
              )}
              <p className="learnings__more">
                <A href={settingsPath("clip-making", "learned")}>See what it learned from your best clips</A>
              </p>
            </div>
            <div className="totals">
              <div className="stat glass">
                <span className="stat__value">{count(totals.views)}</span>
                <span className="stat__dots" aria-hidden="true">
                  {Array.from({ length: 5 }, (_, i) => (
                    <span key={i} />
                  ))}
                </span>
                <span className="stat__label">views across every app</span>
              </div>
              <div className="mini-stats">
                <div className="mini-stat glass">
                  <Icon name="heart" size={18} />
                  <span className="mini-stat__value">{count(totals.likes)}</span>
                  <span className="mini-stat__label">likes</span>
                </div>
                <div className="mini-stat glass">
                  <Icon name="share" size={18} />
                  <span className="mini-stat__value">{count(totals.shares)}</span>
                  <span className="mini-stat__label">shares</span>
                </div>
              </div>
            </div>
          </section>

          <div className="toolbar">
            <Segmented<Filter>
              label="Show"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All" },
                { value: "waiting", label: "Not posted yet" },
                { value: "posted", label: "Posted" },
              ]}
            />
          </div>

          {clips.length === 0 ? (
            <LibraryEmpty filter={filter} anyKept={data.clips.length > 0} onShowAll={() => setFilter("all")} />
          ) : (
            <ul className="library-grid">
              {clips.map((c) => (
                <li key={c.clipId}>
                  <LibraryCard clip={c} posts={data.posts.filter((p) => p.clipId === c.clipId)} onKept={kept} />
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </>
  );
}


/**
 * What an empty list says depends on why it is empty: nothing kept at all (go keep some), every kept clip already
 * posted ("Not posted yet" is empty), or nothing out yet ("Posted" is empty while kept clips are on their way).
 */
export function libraryEmptyCopy(filter: Filter, anyKept: boolean): { title: string; body: string; action: "review" | "all" | null } {
  if (!anyKept) {
    return {
      title: filter === "posted" ? "Nothing posted yet" : "Nothing kept yet",
      body: "Clips you keep show up here. Tap Go to Review and tap Keep on the ones you like.",
      action: "review",
    };
  }
  if (filter === "waiting") return { title: "Everything is posted!", body: "Every clip you kept is out. Nice! Tap Show all to see them.", action: "all" };
  return { title: "Nothing posted yet", body: "Your kept clips show up here once they are posted. Tap Show all to see how they are doing.", action: "all" };
}

function LibraryEmpty({ filter, anyKept, onShowAll }: { filter: Filter; anyKept: boolean; onShowAll: () => void }) {
  const copy = libraryEmptyCopy(filter, anyKept);
  return (
    <Empty
      icon="library"
      title={copy.title}
      action={
        copy.action === "review" ? (
          <LinkButton href="/review" variant="primary" icon="review" iconAfter="chevronRight">
            Go to Review
          </LinkButton>
        ) : copy.action === "all" ? (
          <Button variant="primary" icon="library" onClick={onShowAll}>
            Show all
          </Button>
        ) : undefined
      }
    >
      {copy.body}
    </Empty>
  );
}

function LibraryCard({ clip, posts, onKept }: { clip: Clip; posts: Post[]; onKept: (clip: Clip, posts: Post[]) => void }) {
  // Posts still waiting for an account read as one line, not five identical rows.
  // Every row and mark follows the one app-wide platform order (YouTube, TikTok, Instagram, Facebook, X).
  const ordered = byPlatformOrder(posts);
  const waiting = ordered.filter((p) => p.status === "pending_integration");
  const totalViews = clip.totalViews ?? posts.reduce((n, p) => n + (p.metrics?.views ?? 0), 0);
  const rest = ordered.filter((p) => p.status !== "pending_integration");
  const { me } = useSession();
  const views = postViews(posts);
  const earned = Object.keys(views).length ? clipEarnings(views, clip.durationSec, me?.settings) : null;
  return (
    <article className="lib-card glass" aria-labelledby={`lib-${clip.clipId}`}>
      <div className="lib-card__top">
        <A href={`/clips/${clip.clipId}`} className="lib-card__cover" tabIndex={-1} aria-hidden="true">
          {clip.coverUrl ? <img src={clip.coverUrl} alt="" loading="lazy" /> : null}
        </A>
        <div className="lib-card__head">
          <h3 className="lib-card__hook clamp-3 user-text" id={`lib-${clip.clipId}`}>
            <A href={`/clips/${clip.clipId}`} className="lib-card__link">
              {clip.hook}
            </A>
          </h3>
          <span className="muted small">
            {MOMENT_LABEL[clip.momentType]}
            {clip.decidedAt ? ` · kept ${relative(clip.decidedAt)}` : ""}
          </span>
          <ClipStatusPill status={clip.status} />
          {earned ? <EarnedChip usd={earned.usd} reason={earned.reason} /> : null}
        </div>
      </div>
      <LinkButton href={`/clips/${clip.clipId}`} size="sm" icon="chart" iconAfter="chevronRight" className="lib-card__see">
        {totalViews > 0 ? `${count(totalViews)} views · See how it did` : "See how it did"}
      </LinkButton>
      {posts.length ? (
        <ul className="posts">
          {waiting.length ? (
            <li className="post post--group">
              <span className="post__marks">
                {waiting.map((p) => (
                  <span key={p.postId} className="post__mark" title={PLATFORM_LABEL[p.platform]}>
                    <PlatformMark platform={p.platform} size={16} title={PLATFORM_LABEL[p.platform]} />
                  </span>
                ))}
              </span>
              <span className="post__status">{STATUS_LABEL.waiting_for_connection}. Posts once these accounts are connected.</span>
            </li>
          ) : null}
          {rest.map((p) => (
            <li key={p.postId} className={`post is-${p.status}`}>
              <span className="post__mark" title={PLATFORM_LABEL[p.platform]}>
                <PlatformMark platform={p.platform} size={18} />
              </span>
              <span className="post__text">
                <span className="post__name">{PLATFORM_LABEL[p.platform]}</span>
                <span className="post__status clamp-2">
                  {p.status === "failed" && p.error ? p.error : postStatusLabel(p)}
                  {p.status === "posted" && !p.metrics && p.perfCheckAt ? ` · numbers ${relative(p.perfCheckAt)}` : ""}
                </span>
              </span>
              {p.metrics ? (
                <span className="post__metrics">
                  {/* A plain span cannot carry an aria-label: the numbers are read from this text instead. */}
                  <span className="sr-only">
                    {`${p.metrics.views ?? "no"} views, ${p.metrics.likes ?? "no"} likes, ${p.metrics.comments ?? "no"} comments`}
                  </span>
                  <span aria-hidden="true">
                    <Icon name="eye" size={15} />
                    {compact(p.metrics.views)}
                  </span>
                  <span aria-hidden="true">
                    <Icon name="heart" size={15} />
                    {compact(p.metrics.likes)}
                  </span>
                  <span aria-hidden="true">
                    <Icon name="comment" size={15} />
                    {compact(p.metrics.comments)}
                  </span>
                </span>
              ) : null}
              {p.url ? (
                <a className="icon-btn post__open" href={p.url} target="_blank" rel="noreferrer noopener" aria-label={`Open the ${PLATFORM_LABEL[p.platform]} post`}>
                  <Icon name="external" size={16} />
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      ) : needsKeepAgain(clip, posts) ? null : (
        <p className="muted small">No posts yet.</p>
      )}
      {needsKeepAgain(clip, posts) || clip.status === "failed" ? <KeepAgain clip={clip} posts={posts} onKept={onKept} /> : null}
      <SimilarClips clipId={clip.clipId} />
    </article>
  );
}

/**
 * A kept clip whose posting never started (the Keep stopped half way), or whose posts all failed: one big button
 * tries again. When TikTok wants its privacy picked again, the Post to TikTok sheet opens first and its choices go
 * with the Try again (§14.5, §17.8).
 */
export function KeepAgain({ clip, posts, onKept }: { clip: Clip; posts: Post[]; onKept: (clip: Clip, posts: Post[]) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [sheet, setSheet] = useState(false);
  const failed = clip.status === "failed";
  // §20: the retry turn plays at the tap; an error (already said by the toast) shakes it, without a second deny.
  const act = useAction("retry");

  function press() {
    if (failed && needsTikTokChoices(posts)) setSheet(true);
    else void tryAgain();
  }

  async function tryAgain(tiktok?: TikTokPostOptions) {
    setBusy(true);
    setNote("");
    try {
      const out = await keepClip(api(), clip.clipId, undefined, tiktok);
      if (out.kind === "kept") {
        setSheet(false);
        toast.success(failed ? "Trying again! Posting now." : keptMessage(out.posts));
        onKept(out.clip, out.posts);
        return;
      }
      if (out.kind === "busy") setNote(STILL_WORKING);
      else {
        act.fail({ sound: false });
        toast.error(out.message);
      }
    } catch (e) {
      act.fail({ sound: false });
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="keep-again">
      <p className="keep-again__text">
        <Icon name="alert" size={18} />
        <span>{failed ? "Posting did not work. Tap Try again." : "This clip has not started posting yet. Tap Try again."}</span>
      </p>
      <Button variant="primary" icon="retry" act={act} loading={busy && !sheet} onClick={press} aria-describedby={`keep-note-${clip.clipId}`}>
        Try again
      </Button>
      <p className="keep-again__note" id={`keep-note-${clip.clipId}`} role="status">
        {note}
      </p>
      {sheet ? (
        <TikTokSheet
          clip={clip}
          caption={clip.captions.tiktok}
          action="Try again"
          onKeep={(options) => void tryAgain(options)}
          onClose={() => setSheet(false)}
          busy={busy}
        />
      ) : null}
    </div>
  );
}
