import { useState } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import type { Clip, Learning, Post } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { Button, Empty, ErrorPanel, LinkButton, PageHeader, Segmented, Skeleton } from "../../components/ui.tsx";
import { count, MOMENT_LABEL, PLATFORM_LABEL, plural, relative } from "../../lib/format.ts";
import { useLoad } from "../../lib/hooks.ts";
import { useLiveEvents } from "../../lib/live.ts";
import { applyClipEvent, applyLearningEvent, applyPostEvent, withMedia } from "../../lib/liveCache.ts";
import { SimilarClips } from "../../components/SimilarClips.tsx";
import { keepClip, keptMessage, needsKeepAgain, STILL_WORKING } from "../../lib/keep.ts";
import { ClipStatusPill } from "../jobs/JobDetail.tsx";

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

type Filter = "all" | "waiting" | "posted";

export function Library() {
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
      return { views: t.views + p.metrics.views, likes: t.likes + p.metrics.likes, shares: t.shares + p.metrics.shares };
    },
    { views: 0, likes: 0, shares: 0 },
  );

  return (
    <div className="page">
      <PageHeader
        title={
          <>
            What went <em>out</em>, and how it did.
          </>
        }
        lede="Clips you kept and posted. Two days after a post goes up, Clip Factory checks how it did and learns from it."
      />
      {error && !data ? <ErrorPanel message={error} onRetry={reload} /> : null}
      {!data && !error ? <Skeleton className="review-skel" /> : null}
      {data ? (
        <>
          <section className="insights" aria-labelledby="learn-title">
            <div className="learnings glass glass--sage">
              <h2 className="display-3" id="learn-title">
                What&rsquo;s <em>working</em>
              </h2>
              {data.learnings.length ? (
                <ul className="learnings__list">
                  {data.learnings.map((l) => (
                    <li key={l.learningId}>
                      <p className="user-text">{l.text}</p>
                      <span className="learnings__meta">
                        {relative(l.createdAt)} · from {plural(l.postIds.length, "post")}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">Tips show up here two days after your first clips are posted.</p>
              )}
            </div>
            <div className="totals">
              <div className="stat glass">
                <span className="stat__value">{count(totals.views)}</span>
                <span className="stat__dots" aria-hidden="true">
                  {Array.from({ length: 5 }, (_, i) => (
                    <span key={i} />
                  ))}
                </span>
                <span className="stat__label">views after 48 hours</span>
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
            <Empty
              icon="library"
              title={filter === "posted" ? "Nothing posted yet" : "Nothing kept yet"}
              action={
                <LinkButton href="/review" variant="primary" icon="review" iconAfter="chevronRight">
                  Go to Review
                </LinkButton>
              }
            >
              Clips you keep show up here. Tap Go to Review and tap Keep on the ones you like.
            </Empty>
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
    </div>
  );
}

const POST_STATUS: Record<Post["status"], string> = {
  pending_integration: "Waiting for the account",
  queued: "Queued",
  posted: "Posted",
  failed: "Failed",
};

function LibraryCard({ clip, posts, onKept }: { clip: Clip; posts: Post[]; onKept: (clip: Clip, posts: Post[]) => void }) {
  // Posts still waiting for an account read as one line, not five identical rows.
  const waiting = posts.filter((p) => p.status === "pending_integration");
  const rest = posts.filter((p) => p.status !== "pending_integration");
  return (
    <article className="lib-card glass" aria-labelledby={`lib-${clip.clipId}`}>
      <div className="lib-card__top">
        <span className="lib-card__cover">{clip.coverUrl ? <img src={clip.coverUrl} alt="" loading="lazy" /> : null}</span>
        <div className="lib-card__head">
          <h3 className="lib-card__hook clamp-3 user-text" id={`lib-${clip.clipId}`}>
            {clip.hook}
          </h3>
          <span className="muted small">
            {MOMENT_LABEL[clip.momentType]}
            {clip.decidedAt ? ` · kept ${relative(clip.decidedAt)}` : ""}
          </span>
          <ClipStatusPill status={clip.status} />
        </div>
      </div>
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
              <span className="post__status">Posts once these accounts are connected</span>
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
                  {p.status === "failed" && p.error ? p.error : POST_STATUS[p.status]}
                  {p.status === "posted" && !p.metrics && p.perfCheckAt ? ` · numbers ${relative(p.perfCheckAt)}` : ""}
                </span>
              </span>
              {p.metrics ? (
                <span className="post__metrics" aria-label={`${p.metrics.views} views, ${p.metrics.likes} likes, ${p.metrics.comments} comments`}>
                  <span>
                    <Icon name="eye" size={15} />
                    {count(p.metrics.views)}
                  </span>
                  <span>
                    <Icon name="heart" size={15} />
                    {count(p.metrics.likes)}
                  </span>
                  <span>
                    <Icon name="comment" size={15} />
                    {count(p.metrics.comments)}
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
      ) : needsKeepAgain(clip, posts) ? (
        <KeepAgain clip={clip} onKept={onKept} />
      ) : (
        <p className="muted small">No posts yet.</p>
      )}
      <SimilarClips clipId={clip.clipId} />
    </article>
  );
}

/** A kept clip whose posting never started (the Keep stopped half way): one big button finishes it. */
export function KeepAgain({ clip, onKept }: { clip: Clip; onKept: (clip: Clip, posts: Post[]) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  async function tryAgain() {
    setBusy(true);
    setNote("");
    try {
      const out = await keepClip(api(), clip.clipId);
      if (out.kind === "kept") {
        toast.success(keptMessage(out.posts));
        onKept(out.clip, out.posts);
        return;
      }
      if (out.kind === "busy") setNote(STILL_WORKING);
      else toast.error(out.message);
    } catch (e) {
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="keep-again">
      <p className="keep-again__text">
        <Icon name="alert" size={18} />
        <span>This clip has not started posting yet. Tap Try again.</span>
      </p>
      <Button variant="primary" icon="retry" loading={busy} onClick={tryAgain} aria-describedby={`keep-note-${clip.clipId}`}>
        Try again
      </Button>
      <p className="keep-again__note" id={`keep-note-${clip.clipId}`} role="status">
        {note}
      </p>
    </div>
  );
}
