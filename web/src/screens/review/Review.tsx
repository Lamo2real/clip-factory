import { useCallback, useEffect, useLayoutEffect, useRef, useState, type SyntheticEvent } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import type { Captions, Clip, TikTokPostOptions } from "../../api/types.ts";
import { useSession } from "../../app/session.tsx";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { A, Button, Empty, ErrorPanel, LinkButton, PageHeader, Pill, Skeleton } from "../../components/ui.tsx";
import { burst, centerOf } from "../../lib/confetti.ts";
import { MOMENT_LABEL, plural, timecode } from "../../lib/format.ts";
import { ACT_REWIND_MS, useAction } from "../../lib/motion.ts";
import { useLoad } from "../../lib/hooks.ts";
import { useLiveEvents } from "../../lib/live.ts";
import { applyClipEvent, withMedia } from "../../lib/liveCache.ts";
import { SimilarClips } from "../../components/SimilarClips.tsx";
import { keepClip, keptMessage, STILL_WORKING } from "../../lib/keep.ts";
import { onClipBack, throwAwayWithUndo, useThrownAway } from "../../lib/throwAways.ts";
import { CaptionTabs, captionsTooLong, type CaptionTabsHandle } from "./CaptionTabs.tsx";
import { TikTokSheet } from "./TikTokSheet.tsx";
import { useUnsaved } from "../../features/help/unsaved.ts";

/** Video and cover links are presigned for an hour (docs/CONTRACTS.md §5); fetch new ones a little before that. */
export const MEDIA_FRESH_MS = 50 * 60 * 1000;

export function Review({ jobId }: { jobId: string | null }) {
  const loadedAt = useRef(0);
  const { data, error, reload, setData } = useLoad(
    () =>
      api()
        .listClips({ status: "review", ...(jobId ? { jobId } : {}) })
        .then((clips) => {
          loadedAt.current = Date.now();
          return clips;
        }),
    jobId ?? "",
  );

  // Coming back to the app after a long while: the video links have expired, so fetch the list again.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && loadedAt.current && Date.now() - loadedAt.current > MEDIA_FRESH_MS)
        void reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [reload]);

  // Arriving from a clip link (/review#clip-…) scrolls to that clip once the list is on screen: once per arrival,
  // so later list changes (Keep, Throw away, Undo, live news) never pull the page back to it.
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (!data || !location.hash || scrolledTo.current === location.hash) return;
    const el = document.getElementById(location.hash.slice(1));
    if (!el) return;
    el.scrollIntoView({ block: "start" });
    scrolledTo.current = location.hash;
  }, [data]);

  // Thrown away (Undo still counting down, or already declined): left out of the list, even after leaving Review and
  // coming back while the server still lists the clip as waiting (the store outlives this screen).
  const thrown = useThrownAway();
  const visible = data ? data.filter((c) => !thrown.has(c.clipId)) : null;

  // Clips being kept right here: their cards leave on their own, and live news about them waits.
  const settling = useRef(new Set<string>());
  const settle = (clipId: string, on: boolean) => (on ? settling.current.add(clipId) : settling.current.delete(clipId));

  // Live: new clips appear as the agent finishes them; clips decided elsewhere leave; caption edits show up.
  const waiting = (c: Clip) => c.status === "review" && (!jobId || c.jobId === jobId);
  useLiveEvents(
    (e) => {
      if (e.type !== "clip" || settling.current.has(e.id)) return;
      const missing = data ? applyClipEvent(data, e, waiting).needMedia : [];
      setData((d) => (d ? applyClipEvent(d, e, waiting).clips : d));
      for (const clipId of missing)
        void api()
          .getClip(clipId)
          .then((fresh) => setData((d) => (d ? withMedia(d, fresh) : d)))
          .catch(() => undefined);
    },
    () =>
      void api()
        .listClips({ status: "review", ...(jobId ? { jobId } : {}) })
        .then((fresh) => {
          loadedAt.current = Date.now();
          setData(() => fresh.filter((c) => !settling.current.has(c.clipId)));
        })
        .catch(() => undefined),
  );

  const toast = useToast();
  const { me, refresh } = useSession();
  // Clips kept on this visit: each gets a "See how it does" link once its card has left the list.
  const [justKept, setJustKept] = useState<Clip[]>([]);
  const kept = (clip: Clip) => setJustKept((k) => [clip, ...k.filter((c) => c.clipId !== clip.clipId)].slice(0, 5));
  // Where focus goes when a card leaves while it holds focus: the next card's title (or the one before, or the empty
  // state's Make clips), so keyboard and screen reader users keep their place (§12.4).
  const focusNext = useRef<string | null>(null);
  const leaving = (clipId: string) => {
    const card = document.getElementById(`clip-${clipId}`);
    const at = document.activeElement;
    if (card && at && at !== document.body && !card.contains(at)) return;
    // Read from the page, not from a list kept by this render: the card's leave runs a moment after the tap, and the
    // list may have changed since (another card kept, live news).
    const after = (card?.nextElementSibling ?? card?.previousElementSibling) as HTMLElement | null | undefined;
    focusNext.current = after?.id.startsWith("clip-") ? `hook-${after.id.slice("clip-".length)}` : "review-empty";
  };
  useLayoutEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    const el =
      target === "review-empty" ? document.querySelector<HTMLElement>(".review-empty a, .review-empty .empty__title") : document.getElementById(target);
    focusNext.current = null;
    el?.focus();
  });
  const remove = (clipId: string) => {
    leaving(clipId);
    setData((d) => (d ? d.filter((c) => c.clipId !== clipId) : d));
  };
  // Cards coming back after Undo (or a failed throw away) play the mirror of their leaving motion (§20.7).
  const [returning, setReturning] = useState<ReadonlySet<string>>(() => new Set());
  const returnTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = returnTimers.current;
    return () => timers.forEach((t) => clearTimeout(t));
  }, []);
  // A thrown-away clip comes back (Undo, or the decline failed): it is still in the list, so it shows again in its
  // place, plays the mirror of its leaving motion and takes the focus.
  useEffect(
    () =>
      onClipBack((clipId) => {
        // Undo (tapped in its toast, or focus already lost) takes the focus to the card that came back; a decline
        // that fails later never pulls the focus away from what the owner is doing now.
        const at = document.activeElement;
        if (!at || at === document.body || at.closest(".toasts")) focusNext.current = `hook-${clipId}`;
        setReturning((r) => new Set(r).add(clipId));
        clearTimeout(returnTimers.current.get(clipId));
        returnTimers.current.set(
          clipId,
          setTimeout(() => {
            returnTimers.current.delete(clipId);
            setReturning((r) => {
              const next = new Set(r);
              next.delete(clipId);
              return next;
            });
          }, ACT_REWIND_MS),
        );
      }),
    [],
  );

  /** "Throw away" happens for real only after 8 seconds, so a slip of the finger can be undone. */
  function throwAway(clip: Clip) {
    leaving(clip.clipId);
    throwAwayWithUndo(clip, toast, () => void refresh().catch(() => undefined));
  }

  return (
    <div className="page">
      <PageHeader
        title={
          <>
            Yes or <em>no</em>, clip by clip.
          </>
        }
        lede={
          jobId
            ? "These clips all come from one job. Tap Keep to post one, or Throw away if you do not like it. Tap Show every job to see the rest."
            : "Watch each clip. Tap Keep to post it, or Throw away if you do not like it. Nothing posts until you tap Keep."
        }
        actions={
          jobId ? (
            <LinkButton href="/review" size="sm" icon="x" act="clear">
              Show every job
            </LinkButton>
          ) : undefined
        }
      />
      {justKept.length ? (
        <section className="kept-now glass" aria-labelledby="kept-now-title">
          <h2 className="kept-now__title" id="kept-now-title">
            <Icon name="checkCircle" size={20} />
            Kept just now
          </h2>
          <ul className="kept-now__list">
            {justKept.map((c) => (
              <li key={c.clipId} className="kept-now__item">
                <span className="kept-now__hook clamp-2 user-text">{c.hook}</span>
                <LinkButton href={`/clips/${c.clipId}`} size="sm" icon="chart" iconAfter="chevronRight">
                  See how it does
                </LinkButton>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {error && !data ? <ErrorPanel message={error} onRetry={reload} /> : null}
      {!data && !error ? <Skeleton className="review-skel" /> : null}
      {visible && visible.length === 0 ? (
        <div className="review-empty">
          <Empty
            icon="checkCircle"
            title="All done!"
            action={
              <LinkButton href="/" variant="primary" icon="scissors">
                Make clips
              </LinkButton>
            }
          >
            There is nothing to check right now. Tap Make clips to get new ones.
          </Empty>
        </div>
      ) : null}
      {visible && visible.length > 0 ? (
        <>
          <p className="review-count" aria-live="polite">
            {jobId ? reviewCountForJob(visible.length, me?.counts.review) : `${plural(visible.length, "clip")} waiting`}
          </p>
          <ol className="review-list">
            {visible.map((c, i) => (
              <li key={c.clipId} id={`clip-${c.clipId}`} className="review-list__item">
                <ReviewCard clip={c} next={i === 0} returning={returning.has(c.clipId)} onDone={remove} onKept={kept} onThrowAway={throwAway} onSettling={settle} />
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </div>
  );
}

/** The count line on a Review filtered to one job: says it is one job, and how many wait in all when that is more. */
export function reviewCountForJob(here: number, all: number | undefined): string {
  const line = `${plural(here, "clip")} from this job waiting`;
  return all !== undefined && all > here ? `${line} (${all} in all)` : line;
}

type SaveState = "idle" | "saving" | "saved" | "failed";

function ReviewCard({
  clip,
  next,
  returning,
  onDone,
  onKept,
  onThrowAway,
  onSettling,
}: {
  clip: Clip;
  /** The top card: its Keep is the screen's one tomato button; the cards below get a quiet Keep. */
  next: boolean;
  /** Just put back by Undo: the card plays its return (§20.7). */
  returning: boolean;
  onDone: (clipId: string) => void;
  /** Kept: the list offers a link to the clip's numbers. */
  onKept: (clip: Clip) => void;
  onThrowAway: (clip: Clip) => void;
  /** Tells the list this card is leaving (or, after a failed Keep, staying after all). */
  onSettling: (clipId: string, on: boolean) => void;
}) {
  const toast = useToast();
  const { me, refresh } = useSession();
  const [captions, setCaptions] = useState<Captions>(clip.captions);
  // The Post to TikTok sheet (§17.8) is open: Keep waits for its choices.
  const [sheet, setSheet] = useState(false);
  const [dirty, setDirty] = useState<Partial<Captions>>({});
  const [save, setSave] = useState<SaveState>("idle");
  const [busy, setBusy] = useState<"confirm" | null>(null);
  const [leaving, setLeaving] = useState(false);
  // The last Keep did not finish: the button becomes "Try again", which asks the server to finish it.
  const [keepFailed, setKeepFailed] = useState(false);
  const [keepNote, setKeepNote] = useState("");
  // Keep's heart pops when a keep really starts (Try again's arrow turns once it failed); a Keep that is refused or
  // does not finish shakes it.
  // The TikTok sheet's Keep flies its own plane and shakes on its own button when posting fails (§20.11 (a)).
  const keepAct = useAction(keepFailed ? "retry" : "keep");
  const sheetAct = useAction("send");
  // The TikTok sheet's choices from the Keep that did not finish: Try again sends them again.
  const lastTikTok = useRef<TikTokPostOptions | undefined>(undefined);
  const confirmRef = useRef<HTMLDivElement>(null);
  const tabs = useRef<CaptionTabsHandle>(null);
  // Stable, so the open sheet is not re-set-up on every typed letter (§17.8).
  const closeSheet = useCallback(() => setSheet(false), []);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The latest unsaved edits, and whether the clip was already kept or thrown away (then nothing more is saved).
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const settled = useRef(false);
  // Ask Clip Factory asks before taking the owner away from a caption edit that is not saved yet (§19.8).
  useUnsaved(() => !settled.current && Object.keys(dirtyRef.current).length > 0);

  // Fresh presigned links after the old ones expired (keyed by the link they replace, so a list reload wins).
  const [media, setMedia] = useState<{ was: string | undefined; videoUrl?: string; coverUrl?: string } | null>(null);
  const renewing = useRef(0);
  const videoUrl = media && media.was === clip.videoUrl ? media.videoUrl : clip.videoUrl;
  const coverUrl = media && media.was === clip.videoUrl ? media.coverUrl : clip.coverUrl;

  /** A video or cover failed to load (most often an expired link): ask for the clip again and swap in new links. */
  async function renewMedia(e: SyntheticEvent<HTMLVideoElement | HTMLImageElement>) {
    const el = e.currentTarget;
    if (Date.now() - renewing.current < 30_000) return;
    renewing.current = Date.now();
    try {
      const fresh = await api().getClip(clip.clipId);
      if (fresh.videoUrl === videoUrl && fresh.coverUrl === coverUrl) return;
      setMedia({ was: clip.videoUrl, videoUrl: fresh.videoUrl, coverUrl: fresh.coverUrl });
      if (el instanceof HTMLVideoElement) requestAnimationFrame(() => el.load());
    } catch {
      toast.error("This clip's video could not load. Reload the page to try again.");
    }
  }

  // Leaving Review (or closing the app) within the save delay still saves what was typed.
  const flush = useCallback(() => {
    const patch = dirtyRef.current;
    if (settled.current || !Object.keys(patch).length) return;
    clearTimeout(timer.current);
    void api()
      .updateClip(clip.clipId, patch)
      .catch(() => undefined);
  }, [clip.clipId]);

  useEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);

  // Edits save themselves shortly after typing stops, so nothing is lost if the owner walks away.
  useEffect(() => {
    if (!Object.keys(dirty).length) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const patch = dirty;
      setSave("saving");
      try {
        await api().updateClip(clip.clipId, patch);
        setDirty((d) => {
          const rest = { ...d };
          for (const k of Object.keys(patch) as (keyof Captions)[]) if (rest[k] === patch[k]) delete rest[k];
          return rest;
        });
        setSave("saved");
      } catch {
        setSave("failed");
      }
    }, 900);
    return () => clearTimeout(timer.current);
  }, [dirty, clip.clipId]);

  function edit(patch: Partial<Captions>) {
    setCaptions((c) => ({ ...c, ...patch }));
    setDirty((d) => ({ ...d, ...patch }));
  }

  function leave() {
    setLeaving(true);
    setTimeout(() => onDone(clip.clipId), 420);
    void refresh().catch(() => undefined);
  }

  async function confirm() {
    if (captionsTooLong(captions)) {
      keepAct.fail({ sound: false });
      // Opens the too-long tab (it may be scrolled out of sight) and names the platform.
      const name = tabs.current?.showTooLong();
      toast.error(
        name
          ? `Your ${name} caption is longer than its platform allows. Make it shorter, then tap Keep.`
          : "One caption is longer than its platform allows. Make it shorter, then tap Keep.",
      );
      return;
    }
    // TikTok connected: its rules say the owner picks who can see the post first (§17.8).
    if (!keepFailed && me?.settings.platforms.includes("tiktok")) {
      setBusy("confirm");
      const tiktok = await api()
        .listAccounts()
        .then((all) => all.find((a) => a.platform === "tiktok")?.status === "connected")
        .catch(() => false);
      setBusy(null);
      if (tiktok) {
        setSheet(true);
        return;
      }
    }
    // The heart (or Try again's arrow) plays only now that a keep really starts: not on the tap that opens the
    // TikTok sheet, and never on a refused Keep (§20.5, §20.8).
    keepAct.play();
    await keep(keepFailed ? lastTikTok.current : undefined);
  }

  async function keep(tiktok?: TikTokPostOptions) {
    lastTikTok.current = tiktok;
    setBusy("confirm");
    setKeepNote("");
    clearTimeout(timer.current);
    settled.current = true;
    onSettling(clip.clipId, true);
    try {
      const out = await keepClip(api(), clip.clipId, Object.keys(dirty).length || tiktok ? captions : undefined, tiktok);
      if (out.kind === "kept") {
        setSheet(false);
        burst(centerOf(confirmRef.current), 120);
        toast.success(keptMessage(out.posts));
        if (tiktok) toast.info("TikTok can take a few minutes to process your clip.");
        onKept(out.clip);
        leave();
        return;
      }
      if (out.kind === "gone") {
        toast.error(out.message);
        leave();
        return;
      }
      setKeepFailed(true);
      setKeepNote(STILL_WORKING);
      setBusy(null);
      (tiktok ? sheetAct : keepAct).fail();
    } catch (e) {
      settled.current = false;
      onSettling(clip.clipId, false);
      setKeepFailed(true);
      // The error toast plays the deny sound.
      (tiktok ? sheetAct : keepAct).fail({ sound: false });
      toast.error(friendlyMessage(e));
      setBusy(null);
    }
  }

  function throwAway() {
    clearTimeout(timer.current);
    settled.current = true;
    setLeaving(true);
    setTimeout(() => onThrowAway(clip), 320);
  }

  const passed = clip.checklist.items.filter((i) => i.pass).length;

  return (
    <article className={`review-card glass${leaving ? " is-leaving" : returning ? " is-returning" : ""}`} aria-labelledby={`hook-${clip.clipId}`}>
      <div className="review-card__head">
        <div className="review-card__tags">
          <Pill tone="tomato">{MOMENT_LABEL[clip.momentType]}</Pill>
          <Pill tone="neutral" icon="clock">
            {timecode(clip.durationSec)}
          </Pill>
          <Pill tone="sage">Score {clip.score}/10</Pill>
          <Pill tone="neutral">{clip.layout === "facecam_top" ? "Facecam on top" : "Blurred fill"}</Pill>
        </div>
        <h2 className="review-card__hook user-text" id={`hook-${clip.clipId}`} tabIndex={-1}>
          {clip.hook}
        </h2>
        <p className="review-card__summary user-text">{clip.summary}</p>
        <p className="review-card__source">
          {/* The icon sits inside the link (or the plain line), so it never wraps onto a line of its own. */}
          {clip.sourceUrlAt ? (
            <a href={clip.sourceUrlAt} target="_blank" rel="noreferrer noopener" className="text-link">
              <Icon name="link" size={16} />
              From {timecode(clip.sourceStart)} to {timecode(clip.sourceEnd)} in the source
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : (
            <span className="review-card__source-text">
              <Icon name="link" size={16} />
              From {timecode(clip.sourceStart)} to {timecode(clip.sourceEnd)} in the source
            </span>
          )}
        </p>
      </div>

      <div className="review-card__media">
        <div className="player">
          {videoUrl ? (
            <video
              className="player__video"
              src={videoUrl}
              poster={coverUrl}
              onError={renewMedia}
              controls
              playsInline
              preload="none"
              aria-label={`Clip: ${clip.hook}`}
            />
          ) : (
            <>
              {coverUrl ? (
                <img className="player__video" src={coverUrl} alt={`Cover for: ${clip.hook}`} onError={renewMedia} />
              ) : null}
              <span className="player__note">
                <Icon name="play" size={16} />
                Preview not available
              </span>
            </>
          )}
        </div>
      </div>

      <div className="review-card__body">
        <details className="checklist">
          <summary className="checklist__summary">
            <span>Checks before posting</span>
            <span className={`checklist__score${passed === clip.checklist.items.length ? " is-ok" : ""}`}>
              {passed} of {clip.checklist.items.length} passed
            </span>
            <Icon name="chevronRight" size={18} className="icon checklist__chev act-turn" />
          </summary>
          <ul className="checklist__items">
            {clip.checklist.items.map((i) => (
              <li key={i.key} className={i.pass ? "is-pass" : "is-fail"}>
                <Icon name={i.pass ? "checkCircle" : "xCircle"} size={18} />
                <span>
                  {i.label}
                  <span className="sr-only">{i.pass ? ", passed" : ", needs attention"}</span>
                  {i.note ? <span className="checklist__note user-text">{i.note}</span> : null}
                </span>
              </li>
            ))}
          </ul>
          {clip.checklist.fixes.length ? (
            <div className="checklist__fixes">
              <span className="field__label">Ideas to make it better</span>
              <ul>
                {clip.checklist.fixes.map((f) => (
                  <li key={f} className="user-text">
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </details>

        <div data-help="captions" data-help-dodge="">
          <CaptionTabs captions={captions} onChange={edit} handle={tabs} />
        </div>
        <p className={`save-state is-${save}`} aria-live="polite">
          {save === "saving" ? "Saving…" : save === "saved" ? "Captions saved" : save === "failed" ? "Not saved yet. Your changes are saved when you tap Keep." : ""}
        </p>

        {keepFailed ? (
          <div className="keep-again keep-again--review">
            <p className="keep-again__text">
              <Icon name="alert" size={18} />
              <span>Keeping this clip did not finish. Tap Try again.</span>
            </p>
            <p className="keep-again__note" role="status">
              {keepNote}
            </p>
          </div>
        ) : null}
        <div className="review-card__actions" ref={confirmRef} data-help-dodge="">
          <Button variant="ghost" icon="trash" act="throw" data-help="throw-away" disabled={busy !== null || leaving} onClick={throwAway}>
            Throw away
          </Button>
          <Button
            variant={next ? "primary" : "glass"}
            size="lg"
            icon={keepFailed ? "retry" : "check"}
            act={keepAct}
            playOnClick={false}
            data-help={keepFailed ? "try-again keep" : "keep"}
            loading={busy === "confirm"}
            disabled={leaving}
            onClick={confirm}
          >
            {keepFailed ? "Try again" : "Keep"}
          </Button>
        </div>
        {sheet ? (
          <TikTokSheet
            clip={{ ...clip, videoUrl, coverUrl }}
            caption={captions.tiktok}
            onCaption={(text) => edit({ tiktok: text })}
            onKeep={(options) => void keep(options)}
            onClose={closeSheet}
            busy={busy === "confirm"}
            act={sheetAct}
          />
        ) : null}
        <A href={`/jobs/${clip.jobId}`} className="text-link small review-card__job">
          See the job this clip came from
        </A>
        <SimilarClips clipId={clip.clipId} />
      </div>
    </article>
  );
}
