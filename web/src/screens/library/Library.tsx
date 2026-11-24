import { useState } from "react";
import { api } from "../../api/index.ts";
import { CrPostLines } from "../../components/CrPostLine.tsx";
import { useCr, useSubmissions } from "../../lib/contentRewards.ts";
import { Glide } from "../../components/Glide.tsx";
import { friendlyMessage } from "../../api/errors.ts";
import type { Clip, Learning, Platform, Post, TikTokPostOptions, CrSubmission } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { A, Button, Empty, ErrorPanel, LinkButton, PageHeader, Pill, Segmented, Skeleton, type Tone } from "../../components/ui.tsx";
import { compact, postNumbersNote, postStatusLabel, STATUS_LABEL } from "../../lib/metrics.ts";
import { autoPostLabel } from "../../lib/autopost.ts";
import { WeekView } from "./WeekView.tsx";
import { byPlatformOrder, count, MOMENT_LABEL, PLATFORM_LABEL, plural, relative } from "../../lib/format.ts";
import { useHeld, useLoad } from "../../lib/hooks.ts";
import { settingsPath } from "../../lib/settingsTree.ts";
import { navigate } from "../../lib/router.ts";
import { useLiveEvents } from "../../lib/live.ts";
import { useAction } from "../../lib/motion.ts";
import { applyClipEvent, applyLearningEvent, applyPostEvent, withMedia } from "../../lib/liveCache.ts";
import { SimilarClips } from "../../components/SimilarClips.tsx";
import { needsTikTokChoices, needsUploadAgain, START_GRACE_MS, STILL_WORKING, uploadClip, uploadedMessage } from "../../lib/upload.ts";
import { TikTokSheet } from "../review/TikTokSheet.tsx";
import { ClipStatusPill } from "../jobs/JobDetail.tsx";
import { useSetup } from "../settings/setup/useSetup.ts";
import { failedForPublicAccount, postError, tiktokAudited } from "../../lib/tiktokYourself.ts";
import { rowNeedsMac, tiktokFacts, tiktokRow, type TikTokRow, type TikTokRowContext } from "../../lib/tiktokMac.ts";
import { TikTokRowAction, useTikTokRowContext } from "./MacButtons.tsx";

export interface LibraryData {
  clips: Clip[];
  posts: Post[];
  learnings: Learning[];
  /** The posts or the insights did not load: the numbers part says so, with its own Try again. The clips still show. */
  numbersError: string | null;
  /** False when the post list did not load: a card then never guesses that a clip's posting did not start. */
  postsKnown: boolean;
}

/** The Library lists clips the owner kept: on their way out, out, or stuck on the way. */
const inLibrary = (c: Clip) => c.status === "confirmed" || c.status === "publishing" || c.status === "posted" || c.status === "failed";

/**
 * The clips, their posts and the insights. Only the clips are needed to show the Library: a failed post list or
 * insights call leaves the cards on screen and is said in the numbers part (numbersError).
 */
export async function loadLibrary(): Promise<LibraryData> {
  const [all, posts, insights] = await Promise.allSettled([api().listClips({ status: "all" }), api().listPosts(), api().insights()]);
  if (all.status === "rejected") throw all.reason;
  const failed = [posts, insights].find((r) => r.status === "rejected");
  const learned = insights.status === "fulfilled" ? insights.value : null;
  // Insights carry the freshest metrics; prefer them over the plain post list.
  const withMetrics = new Map((learned?.posts ?? []).map((p) => [p.postId, p]));
  return {
    clips: all.value.filter(inLibrary),
    posts: posts.status === "fulfilled" ? posts.value.map((p) => withMetrics.get(p.postId) ?? p) : [],
    learnings: learned?.learnings ?? [],
    numbersError: failed ? friendlyMessage(failed.reason) : null,
    postsKnown: posts.status === "fulfilled",
  };
}

export type Filter = "all" | "waiting" | "posted";

/** The Library's filter, read from its address (?show=waiting|posted), so Back and a reload keep it. */
export function filterFrom(search: string): Filter {
  const show = new URLSearchParams(search).get("show");
  return show === "waiting" || show === "posted" ? show : "all";
}

/** The Library's address for a filter. */
export function filterHref(filter: Filter): string {
  return filter === "all" ? "/library" : `/library?show=${filter}`;
}

/** A card's views: its posts' own numbers whenever one has them (live news keeps those fresh), else the clip's total. */
export function cardViews(clip: Pick<Clip, "totalViews">, posts: Pick<Post, "metrics">[]): number {
  if (posts.some((p) => p.metrics)) return posts.reduce((n, p) => n + (p.metrics?.views ?? 0), 0);
  return clip.totalViews ?? 0;
}

/**
 * A card's state word when the clip's own status would say the wrong thing: "Not started" while its posting never
 * started (Try again is under it), "Waiting for setup" while every post waits for its account. Null: the clip's
 * status pill ("Uploading" only while a post is really on its way).
 */
export function cardPill(clip: Pick<Clip, "status">, posts: Pick<Post, "status">[], notStarted: boolean): { label: string; tone: Tone } | null {
  if (notStarted) return { label: "Not started", tone: "warn" };
  const sending = clip.status === "confirmed" || clip.status === "publishing";
  if (sending && posts.length > 0 && posts.every((p) => p.status === "pending_integration")) return { label: STATUS_LABEL.waiting_for_connection, tone: "neutral" };
  return null;
}

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
            ? "This week's clips, most views first."
            : "Tap a clip to see how it did on each app."
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
  const { data, error, reload, setData } = useLoad(loadLibrary, "", "library");
  // Every campaign post's line on Content Rewards (§38.6), under its clip's own posts: each listed campaign's posts
  // (and those of campaigns the kept clips were made for), read with the one query the API answers, ?campaignId=.
  const crState = useCr();
  const campaignIds = [
    ...(crState.state === "ok" ? crState.data.campaigns.map((c) => c.campaignId) : []),
    ...(data?.clips ?? []).flatMap((c) => (c.campaignId ? [c.campaignId] : [])),
  ];
  const cr = useSubmissions({ campaignIds }, crState.state === "ok");
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
  // The filter lives in the address (?show=), so opening a clip and going Back, or a reload, keeps it.
  const [, redraw] = useState(0);
  const filter = filterFrom(typeof location === "undefined" ? "" : location.search);
  const setFilter = (next: Filter) => {
    if (next === filter) return;
    // Only the address changes: the list stays where it is on screen (navigate scrolls a new page to the top).
    const y = window.scrollY;
    navigate(filterHref(next), { replace: true });
    window.scrollTo({ top: y });
    redraw((n) => n + 1);
  };
  // The places that are set up (GET /v1/setup, kept fresh by live setup news, as on Review): a post still waiting
  // for one of them gets its own Post now. Unknown (loading, or the check failed): every waiting post stays grouped.
  const setup = useSetup();
  const ready: Platform[] = setup.data ? setup.data.platforms.filter((p) => p.ready).map((p) => p.platform) : [];
  // Your Mac posts TikTok (§47.4): each TikTok row says what the Mac is doing. The Mac's check-in is read while a row
  // may need it (a Mac post, or a clip the Mac could take).
  const tiktokFor = (c: Clip) => tiktokFacts(c, data?.posts.filter((p) => p.clipId === c.clipId) ?? []);
  const facts = data?.clips.map(tiktokFor) ?? [];
  const macCtx = useTikTokRowContext({
    audited: tiktokAudited(setup.data?.platforms),
    needsMac: facts.some(rowNeedsMac),
  });

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
      {data && data.clips.length === 0 ? (
        // Nothing kept yet: the one next step (Go to Review) comes first; no zero totals and no filter above it.
        <>
          <LibraryEmpty filter="all" anyKept={false} onShowAll={() => setFilter("all")} />
          {data.learnings.length ? (
            <section className="insights" aria-labelledby="learn-title">
              <Learnings learnings={data.learnings} />
            </section>
          ) : null}
        </>
      ) : null}
      {data && data.clips.length > 0 ? (
        <>
          <section className="insights" aria-labelledby="learn-title">
            <Learnings learnings={data.learnings} />
            <div className="totals">
              {data.numbersError ? (
                <ErrorPanel message={data.numbersError} onRetry={reload} />
              ) : (
                <>
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
                </>
              )}
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
                  <LibraryCard
                    clip={c}
                    posts={data.posts.filter((p) => p.clipId === c.clipId)}
                    ready={ready}
                    postsKnown={data.postsKnown}
                    macCtx={macCtx}
                    onKept={kept}
                    crSubs={cr.subs.filter((x) => x.clipId === c.clipId)}
                    onCrChange={cr.put}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </>
  );
}


/** What's working: the learnings from the owner's best clips, and the way to all of them. */
function Learnings({ learnings }: { learnings: Learning[] }) {
  return (
    <div className="learnings glass glass--green">
      <h2 className="display-3" id="learn-title">
        What&rsquo;s <em>working</em>
      </h2>
      {learnings.length ? (
        <ul className="learnings__list">
          {learnings.map((l) => (
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
  );
}

/**
 * What an empty list says depends on why it is empty: nothing kept at all (go keep some), every kept clip already
 * posted ("Not posted yet" is empty), or nothing out yet ("Posted" is empty while kept clips are on their way).
 */
export function libraryEmptyCopy(filter: Filter, anyKept: boolean): { title: string; body: string; action: "review" | "all" | null } {
  if (!anyKept) {
    return {
      title: "Nothing uploaded yet",
      body: "Go to Review and tap Upload on the clips you like.",
      action: "review",
    };
  }
  if (filter === "waiting") return { title: "Everything is posted!", body: "Every clip is out. Nice!", action: "all" };
  return { title: "Nothing posted yet", body: "Your clips are on their way. Tap Show all to see them.", action: "all" };
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

function LibraryCard({
  clip,
  posts,
  postsKnown = true,
  ready = [],
  macCtx = { audited: false },
  onKept,
  crSubs = [],
  onCrChange = () => undefined,
}: {
  clip: Clip;
  posts: Post[];
  /** False when the post list did not load: no "No posts yet" and no Try again for a start that may well have run. */
  postsKnown?: boolean;
  /** What the TikTok row reads (§47.4): the switches, the Mac's last check-in, auto-posting's runs, TikTok's approval. */
  macCtx?: TikTokRowContext;
  /** This clip's posts on Content Rewards (§38.6). */
  crSubs?: CrSubmission[];
  onCrChange?: (next: CrSubmission | null) => void;
  /** Places that are set up now: a post still waiting for one of them gets its own row with Post now (§33.6). */
  ready?: readonly Platform[];
  onKept: (clip: Clip, posts: Post[]) => void;
}) {
  // Posts still waiting for an account read as one line, not five identical rows.
  // Every row and mark follows the one app-wide platform order (YouTube, TikTok, Instagram, Facebook, X).
  const ordered = byPlatformOrder(posts);
  // A waiting post whose place is set up since can go now (a clip still publishing finishes its run first).
  const canPostNow = (p: Post) => p.status === "pending_integration" && ready.includes(p.platform) && clip.status !== "publishing";
  // TikTok's row says only what the owner's Mac is doing, with at most one button (§47.4, ADR-86): it gets its own row
  // even while TikTok is not set up or has no post at all. Null: TikTok approved the app, and the old rows stay.
  const tiktok = tiktokRow(tiktokFacts(clip, posts), macCtx);
  const ownRow = (p: Post) => p.status !== "pending_integration" || canPostNow(p) || (!!tiktok && p.platform === "tiktok");
  const waiting = ordered.filter((p) => !ownRow(p));
  const totalViews = cardViews(clip, posts);
  const rest = ordered.filter(ownRow);
  const noTikTok = !!tiktok && !posts.some((p) => p.platform === "tiktok");
  const failedPosts = posts.filter((p) => p.status === "failed");
  const onlyPublicTikTok = failedPosts.length > 0 && failedPosts.every(failedForPublicAccount);
  // A row's state words: TikTok's row, or the post's own state.
  const rowWords = (p: Post): string => {
    if (p.platform === "tiktok" && tiktok) return tiktok.words;
    if (canPostNow(p)) return "Ready to post";
    if (p.status === "failed" && p.error) return `${autoPostLabel(p, postStatusLabel(p))}. ${postError(p.error)}`;
    return autoPostLabel(p, postStatusLabel(p));
  };
  // TikTok's own row (§47.4): its one button replaces Try again and Post now, which would go through TikTok's API.
  const mine = (p: Post) => p.platform === "tiktok" && !!tiktok;
  // Its look follows the row: only Didn't work reads as an error (a refused upload is just not on TikTok yet, and "Not
  // sure it posted" may well be on TikTok), and only a post everyone can see lights up green (a private upload, Clip
  // Factory's or the Mac's, is not out yet).
  const look = (p: Post) => {
    if (!mine(p)) return p.status;
    const kind = tiktok!.kind;
    if (kind === "campaign") return "none";
    if (kind === "stopped") return tiktok!.button === "on_tiktok" ? "none" : "failed";
    if ((kind === "posted" || kind === "posted_you") && p.privacy !== "private") return "posted";
    return p.status === "failed" || p.status === "posted" ? "none" : p.status;
  };
  const row = (p: Post) => (
    <li key={p.postId} className={`post is-${look(p)}`}>
      <span className="post__mark" title={PLATFORM_LABEL[p.platform]}>
        <PlatformMark platform={p.platform} size={18} />
      </span>
      <span className="post__text">
        <span className="post__name">{PLATFORM_LABEL[p.platform]}</span>
        {/* TikTok's row is never cut short: "look on your TikTok first" must show in full (§47.4). */}
        <span className={mine(p) ? "post__status" : "post__status clamp-2"}>
          {mine(p) && tiktok!.spinner ? <span className="spinner spinner--sm" aria-hidden="true" /> : null}
          {rowWords(p)}
          {/* A Private test post has no numbers (§46.8); TikTok's row says only what the Mac does until it is posted. */}
          {(p.by === "you" && !p.url) || p.test || (mine(p) && tiktok!.kind !== "posted" && tiktok!.kind !== "posted_you") ? "" : postNumbersNote(p, relative)}
        </span>
      </span>
      {mine(p) ? <TikTokRowAction clip={clip} row={tiktok} mac={p.mac} onKept={onKept} /> : null}
      {/* One place did not work on an uploaded clip: Try again for that place only (§33). */}
      {p.status === "failed" && clip.status === "posted" && !failedForPublicAccount(p) && !mine(p) ? (
        <UploadAgain clip={clip} posts={posts} platform={p.platform} onKept={onKept} />
      ) : null}
      {/* Waiting for a place that is set up now: send it there (§33.6). */}
      {canPostNow(p) && !mine(p) ? <UploadAgain clip={clip} posts={posts} platform={p.platform} now onKept={onKept} /> : null}
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
  );
  // Uploaded, but its posting did not start (the start after a Try again, Post now or connect did not go through,
  // §14.5): once that lasts past the normal moment, the big Try again starts it.
  const stuck = useHeld(!!clip.startPending, START_GRACE_MS);
  const neverStarted = postsKnown && needsUploadAgain(clip, posts);
  const pill = cardPill(clip, posts, neverStarted || stuck);
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
            {clip.decidedAt ? ` · uploaded ${relative(clip.decidedAt)}` : ""}
          </span>
          {pill ? <Pill tone={pill.tone}>{pill.label}</Pill> : <ClipStatusPill status={clip.status} />}
          {/* A clip made the campaign way wears a small "Campaign" chip (§39.1); a normal clip carries no label. */}
          {clip.campaignId ? (
            <span className="lib-card__campaign" data-cr="campaign-chip">
              <Pill icon="coin">Campaign</Pill>
            </span>
          ) : null}
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
          {rest.filter((p) => p.platform === "youtube").map(row)}
          {noTikTok ? <NoTikTokRow clip={clip} row={tiktok!} onKept={onKept} /> : null}
          {rest.filter((p) => p.platform !== "youtube").map(row)}
        </ul>
      ) : neverStarted || !postsKnown ? null : (
        <p className="muted small">No posts yet.</p>
      )}
      {/* A clip that failed only because TikTok refused the public account: its row's Post with my Mac, not Try again. */}
      {neverStarted || stuck || (clip.status === "failed" && !onlyPublicTikTok) ? <UploadAgain clip={clip} posts={posts} onKept={onKept} /> : null}
      {crSubs.length ? <CrPostLines subs={crSubs} onChange={onCrChange} compact /> : null}
      <SimilarClips clipId={clip.clipId} />
    </article>
  );
}

/** TikTok's row on a kept clip with no TikTok post at all: what the Mac can do with it, and its one button (§47.4). */
function NoTikTokRow({ clip, row, onKept }: { clip: Clip; row: TikTokRow; onKept: (clip: Clip, posts: Post[]) => void }) {
  return (
    <li className="post is-none">
      <span className="post__mark" title={PLATFORM_LABEL.tiktok}>
        <PlatformMark platform="tiktok" size={18} />
      </span>
      <span className="post__text">
        <span className="post__name">{PLATFORM_LABEL.tiktok}</span>
        <span className="post__status">{row.words}</span>
      </span>
      <TikTokRowAction clip={clip} row={row} onKept={onKept} />
    </li>
  );
}

/**
 * An uploaded clip whose posting never started (the Upload stopped half way, or a start that did not go through:
 * `startPending`), or whose posts all failed: one big button tries again. With `platform`, a small Try again for that one place on a clip that went up elsewhere (§33).
 * When TikTok wants its privacy picked again, the Post to TikTok sheet opens first and its choices go with the Try
 * again (§14.5, §17.8). With `now`, Post now sends a post that waited for `platform` to be set up (§33.6); TikTok's
 * sheet always opens first there, since the owner picks who can see it before anything goes to TikTok.
 */
export function UploadAgain({
  clip,
  posts,
  platform,
  now = false,
  onKept,
}: {
  clip: Clip;
  posts: Post[];
  platform?: Platform;
  now?: boolean;
  onKept: (clip: Clip, posts: Post[]) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [sheet, setSheet] = useState(false);
  const failed = clip.status === "failed" || !!platform;
  // §20: the retry turn plays at the tap; an error (already said by the toast) shakes it, without a second deny.
  const act = useAction(now ? "send" : "retry");
  const mine = platform ? posts.filter((p) => p.platform === platform) : posts;

  function press() {
    if (now ? platform === "tiktok" : failed && needsTikTokChoices(mine)) setSheet(true);
    else void tryAgain();
  }

  async function tryAgain(tiktok?: TikTokPostOptions) {
    setBusy(true);
    setNote("");
    try {
      const out = await uploadClip(api(), clip.clipId, undefined, tiktok, platform ? [platform] : undefined);
      if (out.kind === "uploading") {
        setSheet(false);
        onKept(out.clip, out.posts);
        // Only say it is posting when it is: the start may not have gone through, or (a card that was not up to date)
        // the clip was still uploading, so the waiting place was not sent.
        const still = now && out.posts.find((p) => p.platform === platform)?.status === "pending_integration";
        if (out.clip.startPending) toast.info(STILL_WORKING);
        else if (still) toast.info(`This clip is still uploading. Post it to ${PLATFORM_LABEL[platform!]} when that is done.`);
        else {
          const going = out.posts.filter((p) => p.status === "queued" || p.status === "pending_integration");
          toast.success(
            platform
              ? now
                ? `Posting to ${PLATFORM_LABEL[platform]}!`
                : `Trying ${PLATFORM_LABEL[platform]} again!`
              : failed || !going.length
                ? "Trying again! Uploading now."
                : uploadedMessage(going),
          );
        }
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

  const sheetEl = sheet ? (
    <TikTokSheet
      clip={clip}
      caption={clip.captions.tiktok}
      action={now ? "Post now" : "Try again"}
      onUpload={(options) => void tryAgain(options)}
      onClose={() => setSheet(false)}
      busy={busy}
    />
  ) : null;
  if (platform)
    return (
      <span className="post__retry">
        <Button
          size="sm"
          variant="glass"
          icon={now ? "upload" : "retry"}
          act={act}
          loading={busy && !sheet}
          onClick={press}
          aria-label={`${now ? "Post now" : "Try again"}, ${PLATFORM_LABEL[platform]}`}
        >
          {now ? "Post now" : "Try again"}
        </Button>
        {note ? (
          <span className="sr-only" role="status">
            {note}
          </span>
        ) : null}
        {sheetEl}
      </span>
    );
  return (
    <div className="keep-again">
      <p className="keep-again__text">
        <Icon name="alert" size={18} />
        <span>{clip.status === "failed" ? "Uploading did not work. Tap Try again." : "This clip has not started uploading yet. Tap Try again."}</span>
      </p>
      <Button variant="primary" icon="retry" act={act} loading={busy && !sheet} onClick={press} aria-describedby={`keep-note-${clip.clipId}`}>
        Try again
      </Button>
      <p className="keep-again__note" id={`keep-note-${clip.clipId}`} role="status">
        {note}
      </p>
      {sheetEl}
    </div>
  );
}
