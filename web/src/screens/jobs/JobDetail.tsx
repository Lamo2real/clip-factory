import { useEffect, useRef, useState } from "react";
import { api } from "../../api/index.ts";
import type { Campaign } from "../../api/types.ts";
import { CrPostLines } from "../../components/CrPostLine.tsx";
import { campaignPath, useCr, useSubmissions } from "../../lib/contentRewards.ts";
import { friendlyMessage } from "../../api/errors.ts";
import type { Clip, ClipStatus, Job } from "../../api/types.ts";
import { useSession } from "../../app/session.tsx";
import { Icon } from "../../components/Icon.tsx";
import { LiveLine } from "./LiveLine.tsx";
import { MacWait } from "./MacWait.tsx";
import { wantsMac } from "../../lib/macFetch.ts";
import { NotifyCard } from "../settings/NotifyBranch.tsx";
import { JobStatusPill, jobTitle, sourceMeta, SourceThumb, StepTimeline } from "../../components/JobBits.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { A, Button, Empty, ErrorPanel, LinkButton, Pill, Progress, Skeleton, type Tone } from "../../components/ui.tsx";
import { burst } from "../../lib/confetti.ts";
import { clipModelLabel } from "../../lib/models.ts";
import { useAction } from "../../lib/motion.ts";
import { MOMENT_LABEL, plural, relative, timecode } from "../../lib/format.ts";
import { useLoad } from "../../lib/hooks.ts";
import { useLiveEvents, useLivePoll } from "../../lib/live.ts";
import { applyClipEvent, byRank, withMedia } from "../../lib/liveCache.ts";
import { stopWithUndo, useStopping } from "./pendingStops.ts";
import { DeleteJobsSheet } from "./DeleteJobsSheet.tsx";
import { deleteWithUndo, onJobsBack, useDeletedJobs } from "../../lib/jobDeletes.ts";
import { navigate } from "../../lib/router.ts";
import { jobPercent, jobProgress } from "../../lib/jobProgress.ts";

const CLIP_STATUS: Record<ClipStatus, { label: string; tone: Tone }> = {
  review: { label: "Needs a look", tone: "vermilion" },
  confirmed: { label: "Uploading", tone: "success" },
  publishing: { label: "Uploading", tone: "success" },
  posted: { label: "Posted", tone: "bone" },
  declined: { label: "Thrown away", tone: "neutral" },
  failed: { label: "Post failed", tone: "warn" },
};

export function ClipStatusPill({ status }: { status: ClipStatus }) {
  const s = CLIP_STATUS[status];
  return <Pill tone={s.tone}>{s.label}</Pill>;
}

export function JobDetail({ jobId }: { jobId: string }) {
  const { data, error, missing, reload, setData } = useLoad(() => api().getJob(jobId), jobId);
  const { refresh } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // A Stop waiting for its Undo lives outside this page (pendingStops.ts), so leaving and coming back keeps it.
  const stopping = useStopping(jobId);
  const wasStopping = useRef(stopping);
  const lastStatus = useRef<Job["status"] | null>(null);
  // Stop job keeps its handle here, not in the button: the button leaves while the Undo toast is up and comes back
  // rewinding when Undo is tapped (§20.7). Try again shakes when the server says no.
  const stopAct = useAction("stop");
  const retryAct = useAction("retry");
  // Stop job leaves for its "Stopping…" note: the focus goes there too (not to the page's body).
  const stoppingNote = useRef<HTMLParagraphElement>(null);
  const focusNote = useRef(false);

  const [asking, setAsking] = useState(false);
  const deleted = useDeletedJobs().jobs.has(jobId);

  const job = data?.job;
  const working = job?.status === "running" || job?.status === "queued";

  /** Delete job (§34): the page goes back to All jobs at once; Undo on the toast brings the job back there. */
  function remove(clips: "keep" | "delete", review: Record<string, number>) {
    if (!job) return;
    setAsking(false);
    deleteWithUndo([{ jobId, working, reviewClips: review[jobId] ?? 0 }], clips, toast, { onDeleted: () => refresh() });
    navigate("/jobs");
  }
  // Deleted on this device but the page is still open (Back, or a second tab): show it gone; Undo shows it again.
  useEffect(() => onJobsBack((ids) => ids.includes(jobId) && void refetch().catch(() => undefined)));

  /** The job just finished: a small celebration, once. */
  function celebrate(next: Job) {
    if (lastStatus.current && lastStatus.current !== "ready" && next.status === "ready") {
      lastStatus.current = "ready";
      burst();
      toast.success(`Done. ${plural(next.clipCount, "clip")} ready for review.`);
      void refresh().catch(() => undefined);
    }
  }

  const refetch = async () => {
    const next = await api().getJob(jobId);
    celebrate(next.job);
    setData(() => next);
  };

  // Live: this job's progress and its clips as they are made. The poll is the fallback (every 30 s while live).
  useLiveEvents(
    (e) => {
      if (e.type === "job" && e.id === jobId) {
        if (e.op === "delete") return void reload();
        if (!e.item) return;
        const item = e.item;
        celebrate(item);
        setData((d) => (d ? { ...d, job: item } : d));
      } else if (e.type === "clip") {
        if (e.item && e.item.jobId !== jobId) return;
        // Every clip of this job stays listed, whatever its status; a deleted one leaves.
        const keep = (c: Clip) => c.jobId === jobId;
        const missing = data ? applyClipEvent(data.clips, e, keep, byRank).needMedia : [];
        setData((d) => (d ? { ...d, clips: applyClipEvent(d.clips, e, keep, byRank).clips } : d));
        for (const clipId of missing)
          void api()
            .getClip(clipId)
            .then((fresh) => setData((d) => (d ? { ...d, clips: withMedia(d.clips, fresh) } : d)))
            .catch(() => undefined);
      }
    },
    () => void refetch().catch(() => undefined),
  );
  useLivePoll(refetch, working);
  if (job) lastStatus.current = job.status;

  // A pending Stop just ended (sent, undone, or the job had already finished): fetch the job as it is now. This also
  // covers a Stop started before the page was left and come back to, whose result went to the old page.
  useEffect(() => {
    if (wasStopping.current && !stopping) void refetch().catch(() => undefined);
    wasStopping.current = stopping;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopping]);

  async function retry() {
    setBusy(true);
    try {
      const updated = await api().retryJob(jobId);
      setData((d) => (d ? { ...d, job: updated } : d));
      toast.info("Starting again from the beginning.");
      void refresh().catch(() => undefined);
    } catch (e) {
      retryAct.fail({ sound: false });
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!stopping || !focusNote.current) return;
    focusNote.current = false;
    stoppingNote.current?.focus({ preventScroll: true });
  }, [stopping]);

  /** Stopping waits 8 seconds for an Undo, so a slip of the finger never loses a job. */
  function stop() {
    focusNote.current = true;
    stopWithUndo(jobId, toast, {
      onUndo: () => stopAct.rewind(),
      onStopped: (updated) => {
        setData((d) => (d ? { ...d, job: updated } : d));
        void refresh().catch(() => undefined);
      },
      onFail: () => stopAct.fail({ sound: false }),
    });
  }

  if ((error && !data && missing) || deleted) {
    return <JobGone />;
  }
  if (error && !data) {
    return (
      <div className="page">
        <h1 className="sr-only">Could not load this job</h1>
        <BackLink />
        <ErrorPanel message={error} onRetry={reload} />
      </div>
    );
  }
  if (!job) {
    return (
      <div className="page">
        <h1 className="sr-only">Loading job</h1>
        <BackLink />
        <Skeleton className="detail-skel" />
      </div>
    );
  }

  const pct = jobPercent(job);

  return (
    <div className="page job-detail">
      <BackLink />
      <header className="page-head">
        <div className="page-head__text">
          <h1 className="page-head__title page-head__title--sm user-text">{jobTitle(job)}</h1>
          {/* The tag rides inside the title's plate, on the line with the start time, so it never floats outside it
              (CONTRACTS §11.1). */}
          <div className="page-head__meta">
            <JobStatusPill status={job.status} />
            <p className="page-head__lede">
              Started {relative(job.createdAt)} · aiming for{" "}
              {job.clipTarget.min === job.clipTarget.max
                ? plural(job.clipTarget.min, "clip")
                : <span className="nowrap">{`${job.clipTarget.min}–${job.clipTarget.max} clips`}</span>}
            </p>
          </div>
        </div>
      </header>

      <div className="detail-grid">
        <section className="panel glass" aria-labelledby="progress-title">
          <div className="panel__head">
            <h2 className="panel__title" id="progress-title">
              Progress
            </h2>
            <span className="panel__pct" aria-hidden="true">
              {pct}%
            </span>
          </div>
          <Progress value={jobProgress(job)} label="Job progress" tone={job.status === "failed" ? "primary" : "success"} />
          <p className="sr-only" aria-live="polite">
            {job.status === "running"
              ? `${pct} percent.`
              : job.status === "ready"
                ? `Finished with ${plural(job.clipCount, "clip")}.`
                : job.status === "failed"
                  ? "The job failed."
                  : job.status === "queued"
                    ? "Waiting to start."
                    : "Canceled."}
          </p>
          {job.status === "failed" && job.error ? (
            <div className="callout callout--bad" role="alert">
              <Icon name="alert" />
              <p className="user-text">{job.error}</p>
            </div>
          ) : null}
          {job.status === "canceled" && job.replacedBy ? (
            <div className="callout callout--info job-replaced" role="status">
              <Icon name="upload" />
              <p>Replaced by your video file.</p>
            </div>
          ) : null}
          <LiveLine job={job} />
          <MacWait job={job} />
          <StepTimeline steps={job.steps} />
          {job.status === "ready" && job.model ? (
            <p className="panel__note job-model" data-help="job-model">
              <Icon name="sparkle" size={18} />
              <span>
                {`Made with ${clipModelLabel(job.model)}.`}
                {job.modelWanted ? ` ${clipModelLabel(job.modelWanted)} could not be used, so the usual one was.` : ""}
              </span>
            </p>
          ) : null}
          <div className="panel__actions">
            {/* First, so the job's own next step (Try again, Check these clips) keeps the thumb's corner. */}
            <Button variant="ghost" icon="trash" className="job-delete" data-help="delete-job" onClick={() => setAsking(true)}>
              Delete job
            </Button>
            {working && !stopping ? (
              <Button variant="ghost" icon="stop" act={stopAct} onClick={stop}>
                Stop job
              </Button>
            ) : null}
            {working && stopping ? (
              <p className="panel__note" role="status" tabIndex={-1} ref={stoppingNote}>
                <Icon name="clock" size={18} />
                <span>Stopping in a few seconds. Tap Undo to keep it going. Clips already made are kept.</span>
              </p>
            ) : null}
            {/* A job a video file replaced has one way on: the new job (Try again would make the video twice). */}
            {job.replacedBy ? (
              <LinkButton variant="primary" iconAfter="chevronRight" href={`/jobs/${job.replacedBy}`}>
                Open the new job
              </LinkButton>
            ) : null}
            {(job.status === "failed" || job.status === "canceled") && !job.replacedBy ? (
              <Button variant="primary" icon="retry" act={retryAct} data-help="try-again" loading={busy} onClick={retry}>
                Try again
              </Button>
            ) : null}
            {/* Also while the job waits for a Mac (nobody may have the app, a PC user reads "your Mac") and after Stop:
                a link job never leaves the owner without a way out (§35.5). */}
            {(job.status === "failed" || job.status === "canceled" || wantsMac(job)) && job.source.type === "link" && !job.replacedBy ? (
              <LinkButton href={`/?file=1&from=${job.jobId}`} variant="ghost" icon="upload">
                Use a video file
              </LinkButton>
            ) : null}
            {job.status === "ready" && data.clips.some((c) => c.status === "review") ? (
              <LinkButton href={`/review?job=${job.jobId}`} variant="primary" iconAfter="chevronRight">
                Check these clips
              </LinkButton>
            ) : null}
          </div>
          {working ? <NotifyCard /> : null}
          {asking ? (
            <DeleteJobsSheet
              jobs={[job]}
              reviewCounts={{ [jobId]: data.clips.filter((c) => c.status === "review").length }}
              onClose={() => setAsking(false)}
              onDelete={remove}
            />
          ) : null}
        </section>

        <section className="panel glass source-card" aria-labelledby="source-title">
          <h2 className="panel__title" id="source-title">
            Source
          </h2>
          <SourceThumb job={job} className="source-card__thumb" />
          <p className="source-card__title user-text">{jobTitle(job)}</p>
          <p className="muted small">{sourceMeta(job)}</p>
          {job.source.url ? (
            <a className="text-link source-card__link" href={job.source.url} target="_blank" rel="noreferrer noopener">
              <span className="clamp-1 user-text">{job.source.url}</span>
              <Icon name="external" size={16} />
            </a>
          ) : null}
          {job.notes ? (
            <div className="source-card__notes">
              <span className="field__label">Notes</span>
              <p className="user-text">{job.notes}</p>
            </div>
          ) : null}
        </section>
      </div>

      {job.campaignId ? <JobCampaignStrip campaignId={job.campaignId} note={job.campaignNote} clipIds={data.clips.map((c) => c.clipId)} /> : null}

      <section className="clips-section" aria-labelledby="clips-title">
        <h2 className="display-3" id="clips-title">
          Clips <em>from this job</em>
        </h2>
        {data.clips.length === 0 ? (
          <p className="muted">
            {emptyClipsText(job.status)}
          </p>
        ) : (
          <ul className="clip-grid">
            {data.clips.map((c) => (
              <li key={c.clipId}>
                <ClipTile clip={c} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** What the Clips section says when it is empty, so it never contradicts the fix shown above it. */
export function emptyClipsText(status: Job["status"]): string {
  switch (status) {
    case "queued":
    case "running":
      return "Clips show up here as soon as they are made.";
    case "failed":
      return "No clips yet. Fix the problem above, then tap Try again.";
    case "canceled":
      return "No clips yet. This job was stopped. Tap Try again.";
    case "ready":
      return "This job made no clips. Go back to Home and try a different link.";
  }
}

/**
 * Where a clip tile goes (§16.8): a clip waiting for a look opens on Review, a kept one opens its own page. A thrown
 * away clip is not listed anywhere else, so its tile is not a link.
 */
export function clipTileHref(clip: Pick<Clip, "clipId" | "status">): string | null {
  if (clip.status === "review") return `/review#clip-${clip.clipId}`;
  if (clip.status === "declined") return null;
  return `/clips/${clip.clipId}`;
}

function ClipTile({ clip }: { clip: Clip }) {
  const href = clipTileHref(clip);
  const body = (
    <>
      <span className="clip-tile__media">
        {clip.coverUrl ? <img src={clip.coverUrl} alt="" loading="lazy" /> : <Icon name="review" size={28} />}
        <span className="clip-tile__rank">#{clip.rank}</span>
      </span>
      <span className="clip-tile__body">
        <span className="clip-tile__hook clamp-2 user-text">{clip.hook}</span>
        <span className="clip-tile__meta">
          {MOMENT_LABEL[clip.momentType]} · {timecode(clip.durationSec)}
        </span>
        <ClipStatusPill status={clip.status} />
      </span>
    </>
  );
  return href ? (
    <A href={href} className="clip-tile glass">
      {body}
    </A>
  ) : (
    <div className="clip-tile clip-tile--static glass">{body}</div>
  );
}

/**
 * A job that is not there: deleted (here or on another device), or a wrong link. A clip that came from a deleted job
 * links here ("See the job this clip came from"), so the words say the clips still work (§34.7).
 */
export function JobGone() {
  return (
    <div className="page">
      <BackLink />
      <Empty
        icon="info"
        heading="h1"
        title="This job is gone"
        action={
          <LinkButton href="/jobs" variant="primary" icon="chevronLeft">
            See all jobs
          </LinkButton>
        }
      >
        It was deleted, or the link is wrong. Clips you kept from it still work.
      </Empty>
    </div>
  );
}

function BackLink() {
  return (
    <A href="/jobs" className="back-link">
      <Icon name="chevronLeft" size={18} />
      <span>All jobs</span>
    </A>
  );
}

/**
 * "Campaign clips · FaZe Clips · Following 9 rules" (§39.1's names for §38.5's strip: the job's campaign and the count
 * of its rules), the agent's campaign note, and one line per campaign post of this job's clips (§38.6). Hidden when
 * the API has no Content Rewards. The job's own copy of the rules stays on the server, so the name and the count come
 * from the job's campaign; once that campaign is removed the strip says only "Campaign clips".
 */
function JobCampaignStrip({ campaignId, note, clipIds }: { campaignId: string; note?: string; clipIds: string[] }) {
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  // "No Content Rewards" comes from the overview (an API from before §38, or switched off), never from this one
  // campaign: a campaign he removed answers 404, and the job still keeps its copy, its note and its lines (§38.8).
  const cr = useCr();
  const off = cr.state === "missing" || cr.state === "soon";
  useEffect(() => {
    if (off) return;
    let alive = true;
    api()
      .crCampaign(campaignId)
      .then((c) => alive && setCampaign(c))
      .catch(() => alive && setCampaign(null));
    return () => {
      alive = false;
    };
  }, [campaignId, off]);
  const subs = useSubmissions({ campaignId }, !off);
  const mine = subs.subs.filter((s) => clipIds.includes(s.clipId));
  if (off) return null;
  return (
    <section className="panel glass cr-job" aria-labelledby="cr-job-title">
      <h2 className="panel__title" id="cr-job-title" data-cr="job-strip">
        <Icon name="coin" size={20} />
        <span className="cr-job__strip">
          Campaign clips
          {campaign ? (
            <>
              {/* Each dot stays with the words after it, so a narrow phone never leaves one alone at a line's end. */}{" "}
              <span className="cr-job__name">
                {"· "}
                <A href={campaignPath(campaignId)} className="text-link user-text">
                  {campaign.name}
                </A>
              </span>{" "}
              <span className="nowrap">{`· Following ${plural(campaign.plainRules.length, "rule")}`}</span>
            </>
          ) : null}
        </span>
      </h2>
      {note ? (
        <p className="callout callout--info">
          <Icon name="info" size={18} />
          <span className="user-text">{note}</span>
        </p>
      ) : null}
      {mine.length ? <CrPostLines subs={mine} onChange={subs.put} compact /> : null}
    </section>
  );
}
