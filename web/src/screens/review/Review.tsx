import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import type { Captions, Clip } from "../../api/types.ts";
import { useSession } from "../../app/session.tsx";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { A, Button, Empty, ErrorPanel, LinkButton, PageHeader, Pill, Skeleton } from "../../components/ui.tsx";
import { burst, centerOf } from "../../lib/confetti.ts";
import { MOMENT_LABEL, plural, timecode } from "../../lib/format.ts";
import { useLoad } from "../../lib/hooks.ts";
import { useLiveEvents } from "../../lib/live.ts";
import { applyClipEvent, withMedia } from "../../lib/liveCache.ts";
import { SimilarClips } from "../../components/SimilarClips.tsx";
import { keepClip, keptMessage, STILL_WORKING } from "../../lib/keep.ts";
import { CaptionTabs, captionsTooLong } from "./CaptionTabs.tsx";

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

  // Arriving from a clip link (/review#clip-…) scrolls to that clip once the list is on screen.
  useEffect(() => {
    if (!data || !location.hash) return;
    const el = document.getElementById(location.hash.slice(1));
    el?.scrollIntoView({ block: "start" });
  }, [data]);

  // Clips being kept or thrown away right here: their cards leave on their own, and live news about them waits.
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
  const { refresh } = useSession();
  const order = useRef<string[]>([]);
  if (data) for (const c of data) if (!order.current.includes(c.clipId)) order.current.push(c.clipId);
  const remove = (clipId: string) => setData((d) => (d ? d.filter((c) => c.clipId !== clipId) : d));
  // Puts a clip back where it was (by rank and job) after Undo, or when throwing it away failed.
  const restore = (clip: Clip) =>
    setData((d) => {
      if (!d || d.some((c) => c.clipId === clip.clipId)) return d;
      return [...d, clip].sort((a, b) => order.current.indexOf(a.clipId) - order.current.indexOf(b.clipId));
    });

  /** "Throw away" happens for real only after 8 seconds, so a slip of the finger can be undone. */
  function throwAway(clip: Clip) {
    settle(clip.clipId, true);
    remove(clip.clipId);
    toast.undo("Clip thrown away.", {
      onUndo: () => {
        settle(clip.clipId, false);
        restore(clip);
      },
      onCommit: () => {
        api()
          .declineClip(clip.clipId)
          .then(() => refresh())
          .catch((e) => {
            settle(clip.clipId, false);
            restore(clip);
            toast.error(`${friendlyMessage(e)} The clip is back in your list.`);
          });
      },
    });
  }

  return (
    <div className="page">
      <PageHeader
        title={
          <>
            Yes or <em>no</em>, clip by clip.
          </>
        }
        lede="Watch each clip. Tap Keep to post it, or Throw away if you do not like it. Nothing posts until you tap Keep."
        actions={
          jobId ? (
            <LinkButton href="/review" size="sm" icon="x">
              Show every job
            </LinkButton>
          ) : undefined
        }
      />
      {error && !data ? <ErrorPanel message={error} onRetry={reload} /> : null}
      {!data && !error ? <Skeleton className="review-skel" /> : null}
      {data && data.length === 0 ? (
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
      ) : null}
      {data && data.length > 0 ? (
        <>
          <p className="review-count" aria-live="polite">
            {plural(data.length, "clip")} waiting
          </p>
          <ol className="review-list">
            {data.map((c) => (
              <li key={c.clipId} id={`clip-${c.clipId}`} className="review-list__item">
                <ReviewCard clip={c} onDone={remove} onThrowAway={throwAway} onSettling={settle} />
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </div>
  );
}

type SaveState = "idle" | "saving" | "saved" | "failed";

function ReviewCard({
  clip,
  onDone,
  onThrowAway,
  onSettling,
}: {
  clip: Clip;
  onDone: (clipId: string) => void;
  onThrowAway: (clip: Clip) => void;
  /** Tells the list this card is leaving (or, after a failed Keep, staying after all). */
  onSettling: (clipId: string, on: boolean) => void;
}) {
  const toast = useToast();
  const { refresh } = useSession();
  const [captions, setCaptions] = useState<Captions>(clip.captions);
  const [dirty, setDirty] = useState<Partial<Captions>>({});
  const [save, setSave] = useState<SaveState>("idle");
  const [busy, setBusy] = useState<"confirm" | null>(null);
  const [leaving, setLeaving] = useState(false);
  // The last Keep did not finish: the button becomes "Try again", which asks the server to finish it.
  const [keepFailed, setKeepFailed] = useState(false);
  const [keepNote, setKeepNote] = useState("");
  const confirmRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The latest unsaved edits, and whether the clip was already kept or thrown away (then nothing more is saved).
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const settled = useRef(false);

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
      toast.error("One caption is longer than its platform allows. Make the one marked in red shorter, then tap Keep.");
      return;
    }
    setBusy("confirm");
    setKeepNote("");
    clearTimeout(timer.current);
    settled.current = true;
    onSettling(clip.clipId, true);
    try {
      const out = await keepClip(api(), clip.clipId, Object.keys(dirty).length ? captions : undefined);
      if (out.kind === "kept") {
        burst(centerOf(confirmRef.current), 120);
        toast.success(keptMessage(out.posts));
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
    } catch (e) {
      settled.current = false;
      onSettling(clip.clipId, false);
      setKeepFailed(true);
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
    <article className={`review-card glass${leaving ? " is-leaving" : ""}`} aria-labelledby={`hook-${clip.clipId}`}>
      <div className="review-card__head">
        <div className="review-card__tags">
          <Pill tone="tomato">{MOMENT_LABEL[clip.momentType]}</Pill>
          <Pill tone="neutral" icon="clock">
            {timecode(clip.durationSec)}
          </Pill>
          <Pill tone="sage">Score {clip.score}/10</Pill>
          <Pill tone="neutral">{clip.layout === "facecam_top" ? "Facecam on top" : "Blurred fill"}</Pill>
        </div>
        <h2 className="review-card__hook user-text" id={`hook-${clip.clipId}`}>
          {clip.hook}
        </h2>
        <p className="review-card__summary user-text">{clip.summary}</p>
        <p className="review-card__source">
          <Icon name="link" size={16} />
          {clip.sourceUrlAt ? (
            <a href={clip.sourceUrlAt} target="_blank" rel="noreferrer noopener" className="text-link">
              From {timecode(clip.sourceStart)} to {timecode(clip.sourceEnd)} in the source
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ) : (
            <span>
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
            <Icon name="chevronRight" size={18} className="icon checklist__chev" />
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

        <CaptionTabs captions={captions} onChange={edit} />
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
        <div className="review-card__actions" ref={confirmRef}>
          <Button variant="ghost" icon="trash" disabled={busy !== null || leaving} onClick={throwAway}>
            Throw away
          </Button>
          <Button
            variant="primary"
            size="lg"
            icon={keepFailed ? "retry" : "check"}
            loading={busy === "confirm"}
            disabled={leaving}
            onClick={confirm}
          >
            {keepFailed ? "Try again" : "Keep"}
          </Button>
        </div>
        <A href={`/jobs/${clip.jobId}`} className="text-link small review-card__job">
          See the job this clip came from
        </A>
        <SimilarClips clipId={clip.clipId} />
      </div>
    </article>
  );
}
