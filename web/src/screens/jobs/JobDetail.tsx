import { useRef, useState } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import type { Clip, ClipStatus, Job } from "../../api/types.ts";
import { useSession } from "../../app/session.tsx";
import { Icon } from "../../components/Icon.tsx";
import { JobStatusPill, jobTitle, sourceMeta, SourceThumb, StepTimeline } from "../../components/JobBits.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { A, Button, Empty, ErrorPanel, LinkButton, Pill, Progress, Skeleton, type Tone } from "../../components/ui.tsx";
import { burst } from "../../lib/confetti.ts";
import { MOMENT_LABEL, plural, relative, timecode } from "../../lib/format.ts";
import { useLoad } from "../../lib/hooks.ts";
import { useLiveEvents, useLivePoll } from "../../lib/live.ts";
import { applyClipEvent, byRank, withMedia } from "../../lib/liveCache.ts";

const CLIP_STATUS: Record<ClipStatus, { label: string; tone: Tone }> = {
  review: { label: "Needs a look", tone: "tomato" },
  confirmed: { label: "Kept", tone: "sage" },
  publishing: { label: "Posting", tone: "sage" },
  posted: { label: "Posted", tone: "ink" },
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
  const [busy, setBusy] = useState<"cancel" | "retry" | null>(null);
  const [stopping, setStopping] = useState(false);
  const lastStatus = useRef<Job["status"] | null>(null);

  const job = data?.job;
  const working = job?.status === "running" || job?.status === "queued";

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

  async function act(kind: "cancel" | "retry") {
    setBusy(kind);
    try {
      const updated = kind === "cancel" ? await api().cancelJob(jobId) : await api().retryJob(jobId);
      setData((d) => (d ? { ...d, job: updated } : d));
      toast.info(kind === "cancel" ? "Job stopped." : "Starting again from the beginning.");
      void refresh().catch(() => undefined);
    } catch (e) {
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(null);
      setStopping(false);
    }
  }

  /** Stopping waits 8 seconds for an Undo, so a slip of the finger never loses a job. */
  function stop() {
    setStopping(true);
    toast.undo("Stopping this job.", {
      onUndo: () => setStopping(false),
      onCommit: () => void act("cancel"),
    });
  }

  if (error && !data && missing) {
    return (
      <div className="page">
        <BackLink />
        <Empty
          icon="info"
          title="This job is gone"
          action={
            <LinkButton href="/jobs" variant="primary" icon="chevronLeft">
              See all jobs
            </LinkButton>
          }
        >
          It may have been removed. Tap See all jobs to pick another one.
        </Empty>
      </div>
    );
  }
  if (error && !data) {
    return (
      <div className="page">
        <BackLink />
        <ErrorPanel message={error} onRetry={reload} />
      </div>
    );
  }
  if (!job) {
    return (
      <div className="page">
        <BackLink />
        <Skeleton className="detail-skel" />
      </div>
    );
  }

  const running = job.steps.find((s) => s.status === "running");
  const pct = Math.round(job.progress * 100);

  return (
    <div className="page job-detail">
      <BackLink />
      <header className="page-head">
        <div className="page-head__text">
          <h1 className="page-head__title page-head__title--sm user-text">{jobTitle(job)}</h1>
          <p className="page-head__lede">
            Started {relative(job.createdAt)} · aiming for{" "}
            {job.clipTarget.min === job.clipTarget.max
              ? plural(job.clipTarget.min, "clip")
              : `${job.clipTarget.min}–${job.clipTarget.max} clips`}
          </p>
        </div>
        <div className="page-head__actions">
          <JobStatusPill status={job.status} />
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
          <Progress value={job.progress} label="Job progress" tone={job.status === "failed" ? "tomato" : "sage"} />
          <p className="sr-only" aria-live="polite">
            {job.status === "running"
              ? `${pct} percent. ${running?.label ?? "Working"}.`
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
          <StepTimeline steps={job.steps} />
          <div className="panel__actions">
            {working && !stopping ? (
              <Button variant="ghost" icon="stop" loading={busy === "cancel"} onClick={stop}>
                Stop job
              </Button>
            ) : null}
            {working && stopping ? (
              <p className="panel__note" role="status">
                <Icon name="clock" size={18} />
                <span>Stopping in a few seconds. Tap Undo to keep it going. Clips already made are kept.</span>
              </p>
            ) : null}
            {job.status === "failed" || job.status === "canceled" ? (
              <Button variant="primary" icon="retry" loading={busy === "retry"} onClick={() => act("retry")}>
                Try again
              </Button>
            ) : null}
            {job.status === "ready" && data.clips.some((c) => c.status === "review") ? (
              <LinkButton href={`/review?job=${job.jobId}`} variant="primary" iconAfter="chevronRight">
                Check these clips
              </LinkButton>
            ) : null}
          </div>
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

      <section className="clips-section" aria-labelledby="clips-title">
        <h2 className="display-3" id="clips-title">
          Clips <em>from this job</em>
        </h2>
        {data.clips.length === 0 ? (
          <p className="muted">
            {working
              ? "Clips show up here as soon as they are made."
              : "This job made no clips. Go back to Home and try a different link."}
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

function ClipTile({ clip }: { clip: Clip }) {
  const href = clip.status === "review" ? `/review#clip-${clip.clipId}` : "/library";
  return (
    <A href={href} className="clip-tile glass">
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
    </A>
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
