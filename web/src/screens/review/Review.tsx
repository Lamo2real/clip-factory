import { useCallback, useEffect, useLayoutEffect, useRef, useState, type SyntheticEvent } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import type { Captions, Clip, Platform, TikTokCreator, TikTokPostOptions, YoutubePrivacy } from "../../api/types.ts";
import { useSession } from "../../app/session.tsx";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { A, Button, Empty, ErrorPanel, LinkButton, PageHeader, Pill, Skeleton } from "../../components/ui.tsx";
import { burst, centerOf } from "../../lib/confetti.ts";
import { MOMENT_LABEL, PLATFORM_ORDER, plural, timecode } from "../../lib/format.ts";
import { ACT_REWIND_MS, useAction } from "../../lib/motion.ts";
import { useLoad } from "../../lib/hooks.ts";
import { useLiveEvents } from "../../lib/live.ts";
import { applyClipEvent, withMedia } from "../../lib/liveCache.ts";
import { SimilarClips } from "../../components/SimilarClips.tsx";
import { defaultUploadTo, readUploadTo, saveUploadTo, STILL_WORKING, uploadClip, uploadedMessage, uploadLabel } from "../../lib/upload.ts";
import { useSetup } from "../settings/setup/useSetup.ts";
import { goingToLine, UploadToChips } from "./UploadTo.tsx";
import { onClipBack, throwAwayWithUndo, useThrownAway } from "../../lib/throwAways.ts";
import { useDeletedJobs } from "../../lib/jobDeletes.ts";
import { captionsTooLong, PlaceRows, type PlaceRowsHandle } from "./PlaceRows.tsx";
import { choicesReady, myTikTokChoices, NO_TIKTOK_CHOICES, tiktokOptions, tooLongForTikTok, type TikTokChoices } from "../../lib/tiktokChoices.ts";
import { cardOptionsFrom, optionsFor, presetOf, type CardOptions } from "../../lib/preset.ts";
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
    "review",
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
  // so later list changes (Upload, Throw away, Undo, live news) never pull the page back to it.
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
  // Clips of a job deleted with its Review clips leave the same way (§34.5).
  const goneJobs = useDeletedJobs().reviewJobs;
  const visible = data ? data.filter((c) => !thrown.has(c.clipId) && !goneJobs.has(c.jobId)) : null;

  // Clips being uploaded right here: their cards leave on their own, and live news about them waits.
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
  // The places that are set up (GET /v1/setup, kept fresh by live setup news): only they get an Upload to chip.
  const setup = useSetup();
  // Not known yet (loading), or the check failed: then `ready` stays null and Upload waits, so a failed check can never
  // send a clip to places nobody picked.
  const ready: Platform[] | null = setup.data ? setup.data.platforms.filter((p) => p.ready).map((p) => p.platform) : null;
  const setupFailed = !setup.data && !!setup.error;
  // Clips uploaded on this visit: each gets a "See how it does" link once its card has left the list.
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
    // list may have changed since (another card uploaded, live news).
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
            ? "These clips all come from one job. Tap Upload to post one, or Throw away if you do not like it. Tap Show every job to see the rest."
            : "Watch each clip. Tap Upload to post it, or Throw away if you do not like it. Nothing posts until you tap Upload."
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
            Uploaded just now
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
                <ReviewCard clip={c} ready={ready} setupFailed={setupFailed} onCheckAgain={() => void setup.reload()} next={i === 0} returning={returning.has(c.clipId)} onDone={remove} onKept={kept} onThrowAway={throwAway} onSettling={settle} />
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </div>
  );
}

/** Why Clip Factory picked this moment, in a few plain words; nothing at all when nothing stood out (§5 pickedFor). */
export function WhyPicked({ text }: { text: string | undefined }) {
  if (!text) return null;
  return (
    <p className="review-card__why">
      <span className="review-card__why-label">Why:</span> <span className="user-text">{text}</span>
    </p>
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
  ready,
  setupFailed,
  onCheckAgain,
  next,
  returning,
  onDone,
  onKept,
  onThrowAway,
  onSettling,
}: {
  clip: Clip;
  /** The places that are set up (null while loading). */
  ready: Platform[] | null;
  /** The check of what is set up did not work: the card says so and offers to check again. */
  setupFailed: boolean;
  onCheckAgain: () => void;
  /** The top card: its Upload is the screen's one main (vermilion) button; the cards below get a quiet Upload. */
  next: boolean;
  /** Just put back by Undo: the card plays its return (§20.7). */
  returning: boolean;
  onDone: (clipId: string) => void;
  /** Uploaded: the list offers a link to the clip's numbers. */
  onKept: (clip: Clip) => void;
  onThrowAway: (clip: Clip) => void;
  /** Tells the list this card is leaving (or, after a failed Upload, staying after all). */
  onSettling: (clipId: string, on: boolean) => void;
}) {
  const toast = useToast();
  const { me, refresh } = useSession();
  const [captions, setCaptions] = useState<Captions>(clip.captions);
  // The Post to TikTok sheet (§17.8) is open: only when nothing is set up yet but TikTok is connected (§34.4).
  const [sheet, setSheet] = useState(false);
  // Where it goes (§33): the owner's taps on this card, else this device's last choice / Where clips go, minus
  // places that are not set up.
  const [picked, setPicked] = useState<Platform[] | null>(null);
  const chosen: Platform[] = ready ? (picked ? picked.filter((p) => ready.includes(p)) : defaultUploadTo(ready, readUploadTo(), me?.settings.platforms)) : [];
  function toggle(p: Platform) {
    setPicked(chosen.includes(p) ? chosen.filter((x) => x !== p) : [...chosen, p]);
  }
  const [dirty, setDirty] = useState<Partial<Captions>>({});
  const [save, setSave] = useState<SaveState>("idle");
  const [busy, setBusy] = useState<"confirm" | null>(null);
  const [leaving, setLeaving] = useState(false);
  // The last Upload did not finish: the button becomes "Try again", which asks the server to finish it.
  const [keepFailed, setKeepFailed] = useState(false);
  const [keepNote, setKeepNote] = useState("");
  // Upload's plane flies when an upload really starts (Try again's arrow turns once it failed); an Upload that is
  // refused or does not finish shakes it.
  // The TikTok sheet's Upload flies its own plane and shakes on its own button when posting fails (§20.11 (a)).
  const keepAct = useAction(keepFailed ? "retry" : "send");
  const sheetAct = useAction("send");
  // The TikTok sheet's choices from the Upload that did not finish: Try again sends them again.
  const lastTikTok = useRef<TikTokPostOptions | undefined>(undefined);
  const confirmRef = useRef<HTMLDivElement>(null);
  const rows = useRef<PlaceRowsHandle>(null);

  // TikTok's options live in its row on the card (§34): asked for when the owner taps Use my settings or opens the
  // TikTok row (TikTok's rules: this creator's current options, every time), never before.
  const tiktokOn = chosen.includes("tiktok");
  const [ttWanted, setTtWanted] = useState(false);
  const [ttAsk, setTtAsk] = useState(0);
  const [creator, setCreator] = useState<TikTokCreator | null>(null);
  const [ttError, setTtError] = useState<string | null>(null);
  const [choices, setChoices] = useState<TikTokChoices>(NO_TIKTOK_CHOICES);
  // Use my settings was tapped on this card (TikTok's choices are the owner's own tap, never a default).
  const [applied, setApplied] = useState(false);
  // My settings (§34), from the server. YouTube, Instagram and X use them from the start (no TikTok-style rule there);
  // `own` holds this card's changes to them, null until the owner changes one in a row.
  const youtubePrivacy: YoutubePrivacy = me?.settings.youtubePrivacy ?? "public";
  const preset = presetOf(me?.settings.postPreset);
  const presetRef = useRef(preset);
  presetRef.current = preset;
  const [own, setOwn] = useState<CardOptions | null>(null);
  const opts: CardOptions = own ?? cardOptionsFrom(preset, youtubePrivacy);
  // The owner changed something in a row after My settings went on: the button offers to put his settings back.
  const [changed, setChanged] = useState(false);
  function setOpt<K extends keyof CardOptions>(platform: K, patch: Partial<CardOptions[K]>) {
    setOwn({ ...opts, [platform]: { ...opts[platform], ...patch } });
    setChanged(true);
  }
  // Use my settings was tapped before TikTok answered: its choices go on as soon as the answer comes.
  const applyWhenAsked = useRef(false);
  useEffect(() => {
    if (!ttWanted) return;
    let alive = true;
    setTtError(null);
    api()
      .tiktokCreatorInfo()
      .then((c) => {
        if (!alive) return;
        setCreator(c);
        if (applyWhenAsked.current) {
          applyWhenAsked.current = false;
          applyTikTok(c);
        }
      })
      .catch((e) => {
        if (!alive) return;
        applyWhenAsked.current = false;
        setTtError(friendlyMessage(e));
      });
    return () => {
      alive = false;
    };
    // applyTikTok only reads state setters and the clip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttWanted, ttAsk]);
  const askTikTok = () => (ttWanted ? setTtAsk((n) => n + 1) : setTtWanted(true));
  function applyTikTok(c: TikTokCreator) {
    const mine = myTikTokChoices(presetRef.current.tiktok, c);
    setChoices(mine);
    setApplied(true);
    // Nothing TikTok offers fits (or the clip is too long for TikTok): the row opens to say why.
    if (!choicesReady(mine) || tooLongForTikTok(clip.durationSec, c.maxDurationSec)) rows.current?.open("tiktok");
  }
  /** "Use my settings": every ticked place gets the owner's saved settings; TikTok's go on with this one tap. */
  function useMySettings() {
    setOwn(null);
    setChanged(false);
    if (!tiktokOn) return;
    if (creator) return applyTikTok(creator);
    applyWhenAsked.current = true;
    askTikTok();
  }
  const ttTooLong = !!creator && tooLongForTikTok(clip.durationSec, creator.maxDurationSec);
  const ttReady = !!creator && choicesReady(choices) && !ttTooLong;
  // The settings are on: places other than TikTok use them from the start; TikTok needs the owner's tap.
  const settingsOn = !changed && (!tiktokOn || applied);
  const ttAsking = ttWanted && !creator && !ttError;
  // Stable, so the open sheet is not re-set-up on every typed letter (§17.8).
  const closeSheet = useCallback(() => setSheet(false), []);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The latest unsaved edits, and whether the clip was already uploaded or thrown away (then nothing more is saved).
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

  // Nothing is set up yet: Upload saves the clip the old way, and it goes up once a place is set up (§33.1).
  const noneReady = !!ready && ready.length === 0;

  async function confirm() {
    // Also on Try again: a place picked, or none turned off, is checked every time.
    if (!noneReady && !chosen.length) {
      keepAct.fail({ sound: false });
      toast.error("Pick at least one place to upload to.");
      return;
    }
    if (captionsTooLong(captions, noneReady ? undefined : chosen)) {
      keepAct.fail({ sound: false });
      // Opens the too-long row (it may be scrolled out of sight) and names the platform.
      const name = rows.current?.showTooLong();
      toast.error(
        name
          ? `Your ${name} caption is longer than its platform allows. Make it shorter, then tap Upload.`
          : "One caption is longer than its platform allows. Make it shorter, then tap Upload.",
      );
      return;
    }
    // TikTok is one of the places: its choices are on the card (Use my settings, or the TikTok row), §34.
    if (tiktokOn) {
      if (!ttReady) {
        keepAct.fail({ sound: false });
        rows.current?.open("tiktok");
        toast.error(uploadWhy ?? "Tap Use my settings first.");
        return;
      }
      keepAct.play();
      await upload(tiktokOptions(choices, creator!));
      return;
    }
    // Nothing set up but TikTok connected (a step still waits): TikTok's own sheet asks first, as before §33.
    // Try again keeps the choices already made there.
    const haveTikTok = keepFailed && !!lastTikTok.current;
    let tiktokGoing = false;
    if (noneReady && !haveTikTok && me?.settings.platforms.includes("tiktok")) {
      setBusy("confirm");
      tiktokGoing = await api()
        .listAccounts()
        .then((all) => all.find((a) => a.platform === "tiktok")?.status === "connected")
        .catch(() => false);
      setBusy(null);
    }
    if (tiktokGoing) {
      setSheet(true);
      return;
    }
    // The plane (or Try again's arrow) plays only now that an upload really starts: not on the tap that opens the
    // TikTok sheet, and never on a refused Upload (§20.5, §20.8).
    keepAct.play();
    await upload(haveTikTok ? lastTikTok.current : undefined);
  }

  async function upload(tiktok?: TikTokPostOptions) {
    lastTikTok.current = tiktok;
    setBusy("confirm");
    setKeepNote("");
    clearTimeout(timer.current);
    settled.current = true;
    onSettling(clip.clipId, true);
    try {
      const out = await uploadClip(
        api(),
        clip.clipId,
        Object.keys(dirty).length || tiktok ? captions : undefined,
        tiktok,
        chosen.length ? chosen : undefined,
        chosen.length ? optionsFor(chosen, opts) : undefined,
      );
      if (out.kind === "uploading") {
        if (chosen.length) saveUploadTo(chosen);
        setSheet(false);
        burst(centerOf(confirmRef.current), 120);
        toast.success(uploadedMessage(out.posts));
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
      (sheet ? sheetAct : keepAct).fail();
    } catch (e) {
      settled.current = false;
      onSettling(clip.clipId, false);
      setKeepFailed(true);
      // The error toast plays the deny sound.
      (sheet ? sheetAct : keepAct).fail({ sound: false });
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
  // Why Upload is off because of TikTok, in plain words (null when TikTok is ready or not ticked).
  const uploadWhy: string | null = !tiktokOn || ttReady
    ? null
    : ttError
      ? "TikTok did not answer. Tap Ask TikTok again, or untick TikTok."
      : ttAsking
        ? "Asking TikTok…"
        : !creator
          ? "Tap Use my settings first. TikTok needs your tap."
          : ttTooLong
            ? "This clip is too long for TikTok. Untick TikTok to upload it to the rest."
            : !choices.privacy
              ? "Pick who can see it on TikTok first."
              : "Pick Your brand or Branded content on TikTok first.";
  const placesShown = ready && !noneReady ? chosen : PLATFORM_ORDER;

  return (
    <article className={`review-card glass${leaving ? " is-leaving" : returning ? " is-returning" : ""}`} aria-labelledby={`hook-${clip.clipId}`}>
      <div className="review-card__head">
        <div className="review-card__tags">
          <Pill tone="vermilion">{MOMENT_LABEL[clip.momentType]}</Pill>
          <Pill tone="neutral" icon="clock">
            {timecode(clip.durationSec)}
          </Pill>
          <Pill tone="success">Score {clip.score}/10</Pill>
          <Pill tone="neutral">{clip.layout === "facecam_top" ? "Facecam on top" : "Blurred fill"}</Pill>
        </div>
        <h2 className="review-card__hook user-text" id={`hook-${clip.clipId}`} tabIndex={-1}>
          {clip.hook}
        </h2>
        <p className="review-card__summary user-text">{clip.summary}</p>
        <WhyPicked text={clip.pickedFor} />
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

        {ready ? (
          <UploadToChips ready={ready} chosen={chosen} onToggle={toggle} />
        ) : setupFailed ? (
          <div className="upload-to upload-to--none">
            <p className="callout callout--bad" role="alert">
              <Icon name="alert" size={18} />
              <span>Could not check your places. Check again, then tap Upload.</span>
            </p>
            <Button variant="glass" icon="retry" act="retry" onClick={onCheckAgain}>
              Check again
            </Button>
          </div>
        ) : (
          <Skeleton className="line-skel" />
        )}

        {ready && !noneReady && chosen.length ? (
          <div className="my-settings" data-help="use-my-settings">
            <Button
              variant="glass"
              size="lg"
              block
              icon={settingsOn ? "checkCircle" : "sliders"}
              act="tick"
              className={settingsOn ? "btn--bone my-settings__btn is-on" : "my-settings__btn"}
              loading={ttAsking && applyWhenAsked.current}
              aria-describedby={`mine-${clip.clipId}`}
              data-help-clear=""
              onClick={useMySettings}
            >
              {settingsOn ? "Your settings are on" : "Use my settings"}
            </Button>
            <p className="my-settings__note" id={`mine-${clip.clipId}`}>
              {changed
                ? "You changed some for this clip. Tap to put yours back."
                : tiktokOn
                  ? applied
                    ? "Every place uses your settings. Tap a place below to change it for this clip."
                    : "Your other places already use your settings. TikTok needs your tap each time."
                  : "Every place uses your settings. Tap a place below to change it for this clip."}
            </p>
          </div>
        ) : null}

        <PlaceRows
          places={placesShown}
          captions={captions}
          onChange={edit}
          handle={rows}
          settings={!!ready && !noneReady}
          options={opts}
          onOptions={setOpt}
          tiktok={{
            creator,
            error: ttError,
            asking: ttAsking,
            onAskAgain: askTikTok,
            choices,
            onChoices: (patch) => {
              setChoices((c) => ({ ...c, ...patch }));
              // Commercial content is about this clip only (never in My settings), so ticking it keeps "Your settings are on".
              if (applied && ("privacy" in patch || "comments" in patch || "duet" in patch || "stitch" in patch)) setChanged(true);
            },
            durationSec: clip.durationSec,
            onOpen: () => setTtWanted(true),
          }}
        />
        <p className={`save-state is-${save}`} aria-live="polite">
          {save === "saving" ? "Saving…" : save === "saved" ? "Captions saved" : save === "failed" ? "Not saved yet. Your changes are saved when you tap Upload." : ""}
        </p>

        {keepFailed ? (
          <div className="keep-again keep-again--review">
            <p className="keep-again__text">
              <Icon name="alert" size={18} />
              <span>Uploading this clip did not finish. Tap Try again.</span>
            </p>
            <p className="keep-again__note" role="status">
              {keepNote}
            </p>
          </div>
        ) : null}
        {ready && !keepFailed && !noneReady ? (
          <p className={`upload-going${chosen.length && !uploadWhy ? "" : " is-none"}`} id={`going-${clip.clipId}`} aria-live="polite">
            {uploadWhy ?? goingToLine(chosen)}
          </p>
        ) : null}
        {ready && !noneReady && tiktokOn ? (
          <p className="tt-legal">
            By posting, you agree to TikTok&apos;s{" "}
            <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noopener noreferrer">
              Music Usage Confirmation
            </a>
            {choices.commercial && choices.branded ? (
              <>
                {" "}
                and{" "}
                <a href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noopener noreferrer">
                  Branded Content Policy
                </a>
              </>
            ) : null}
            .
          </p>
        ) : null}
        <div className="review-card__actions" ref={confirmRef} data-help-dodge="">
          <Button variant="ghost" icon="trash" act="throw" data-help="throw-away" disabled={busy !== null || leaving} onClick={throwAway}>
            Throw away
          </Button>
          <Button
            variant={next ? "primary" : "glass"}
            size="lg"
            icon={keepFailed ? "retry" : "upload"}
            act={keepAct}
            playOnClick={false}
            data-help={keepFailed ? "try-again upload" : "upload"}
            data-help-clear=""
            loading={busy === "confirm"}
            disabled={leaving || !ready || (!noneReady && !chosen.length) || !!uploadWhy}
            aria-describedby={ready && !keepFailed && !noneReady ? `going-${clip.clipId}` : undefined}
            onClick={confirm}
          >
            {keepFailed ? "Try again" : uploadLabel(chosen)}
          </Button>
        </div>
        {sheet ? (
          <TikTokSheet
            clip={{ ...clip, videoUrl, coverUrl }}
            caption={captions.tiktok}
            onCaption={(text) => edit({ tiktok: text })}
            onUpload={(tiktok) => void upload(tiktok)}
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
