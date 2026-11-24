import { useEffect, useRef, useState, type CSSProperties } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import type { Job } from "../../api/types.ts";
import { JobStatusPill, jobTitle, sourceMeta, SourceThumb } from "../../components/JobBits.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { A, Button, Empty, ErrorPanel, LinkButton, PageHeader, Progress, Skeleton } from "../../components/ui.tsx";
import { Icon } from "../../components/Icon.tsx";
import { useSession } from "../../app/session.tsx";
import { deleteWithUndo, useDeletedJobs } from "../../lib/jobDeletes.ts";
import { DeleteJobsSheet, isWorking } from "./DeleteJobsSheet.tsx";
import { burst } from "../../lib/confetti.ts";
import { useAction } from "../../lib/motion.ts";
import { plural, relative } from "../../lib/format.ts";
import { useLoad } from "../../lib/hooks.ts";
import { useLiveEvents, useLivePoll } from "../../lib/live.ts";
import { applyJobEvent } from "../../lib/liveCache.ts";
import { LiveLine } from "./LiveLine.tsx";
import { mergeJobs, pollLimit } from "./mergeJobs.ts";
import { jobPercent, jobProgress } from "../../lib/jobProgress.ts";

/** Show older jobs loads more below: its chevron points and steps down (§20.3 `--act-dir`). */
const DOWN = { "--act-dir-in": "90deg" } as CSSProperties;

export function Jobs() {
  const { data, error, reload, setData } = useLoad(() => api().listJobs({ limit: 20 }), "", "jobs");
  const [more, setMore] = useState(false);
  const toast = useToast();
  const seen = useRef(new Map<string, Job["status"]>());
  // Show older jobs: the chevron steps on (§20.11 (a)); a page that does not load shakes it instead.
  const older = useAction("next");

  const { refresh } = useSession();
  const deleted = useDeletedJobs();
  // Select several (§34.6): the rows become tick boxes and a bar at the bottom deletes the ones picked.
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [asking, setAsking] = useState<Job[] | null>(null);
  // Select and Done take turns in one spot (so Make clips never slides under the finger): a second tap that soon is
  // the second half of a double tap, and does nothing.
  const selectButton = useRef<HTMLButtonElement>(null);
  const selectAt = useRef(-Infinity);
  // Select ended (either Cancel, Escape, a delete): the focus goes back to Select when its old place is gone.
  const refocus = useRef(false);

  // A deleted job leaves at once (Undo brings it back), wherever the news came from.
  const jobs = (data?.jobs ?? []).filter((j) => !deleted.jobs.has(j.jobId));
  const active = jobs.some(isWorking);
  const failed = jobs.filter((j) => j.status === "failed");
  const chosen = jobs.filter((j) => picked.has(j.jobId));

  function stopSelecting() {
    setSelecting(false);
    setPicked(new Set());
    refocus.current = true;
  }
  function startSelecting() {
    selectAt.current = performance.now();
    setSelecting(true);
  }
  useEffect(() => {
    if (selecting || !refocus.current) return;
    refocus.current = false;
    const at = document.activeElement;
    if (!at || at === document.body || !at.isConnected) selectButton.current?.focus({ preventScroll: true });
  }, [selecting, asking]);
  function toggle(jobId: string) {
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }
  // Escape leaves Select (the sheet takes Escape for itself while it is open).
  useEffect(() => {
    if (!selecting || asking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") stopSelecting();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting, asking]);
  // Leaving the list empty (everything deleted) ends Select too.
  useEffect(() => {
    if (selecting && data && jobs.length === 0) stopSelecting();
  }, [selecting, data, jobs.length]);

  function remove(list: Job[], clips: "keep" | "delete", review: Record<string, number>) {
    setAsking(null);
    stopSelecting();
    deleteWithUndo(
      list.map((j) => ({ jobId: j.jobId, working: isWorking(j), reviewClips: review[j.jobId] ?? 0 })),
      clips,
      toast,
      { onDeleted: () => refresh() },
    );
  }

  /** A job that just finished gets a small celebration, whether the news came by poll or live. */
  function celebrate(fresh: Job[]) {
    for (const j of fresh) {
      const before = seen.current.get(j.jobId);
      if (before && before !== "ready" && j.status === "ready") {
        seen.current.set(j.jobId, "ready");
        burst();
        toast.success(`${jobTitle(j)} is ready with ${plural(j.clipCount, "clip")}.`);
      }
    }
  }

  const refetch = async () => {
    const fresh = await api().listJobs({ limit: pollLimit(jobs.length) });
    celebrate(fresh.jobs);
    // Only the first page is fetched: merge it in and keep the cursor for "Show older jobs".
    setData((d) => (d ? { jobs: mergeJobs(d.jobs, fresh.jobs), nextCursor: d.nextCursor } : fresh));
  };

  // Live updates move the list along; the poll is the fallback (every 30 s while live).
  useLiveEvents(
    (e) => {
      if (e.type !== "job") return;
      if (e.item) celebrate([e.item]);
      setData((d) => (d ? { ...d, jobs: applyJobEvent(d.jobs, e) } : d));
    },
    () => void refetch().catch(() => undefined),
  );
  useLivePoll(refetch, active);
  for (const j of jobs) seen.current.set(j.jobId, j.status);

  async function loadMore() {
    if (!data?.nextCursor) return;
    setMore(true);
    try {
      const page = await api().listJobs({ limit: 20, cursor: data.nextCursor });
      setData((d) => (d ? { jobs: [...d.jobs, ...page.jobs], nextCursor: page.nextCursor } : page));
    } catch (e) {
      older.fail({ sound: false });
      toast.error(friendlyMessage(e));
    } finally {
      setMore(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title={
          <>
            Every <em>job</em>, start to finish.
          </>
        }
        lede="Each link or video is one job. Tap one to watch it being made."
        actions={
          jobs.length ? (
            <>
              {selecting ? (
                <Button
                  ref={selectButton}
                  variant="ghost"
                  icon="x"
                  className="jobs-select"
                  onClick={() => {
                    if (performance.now() - selectAt.current >= 400) stopSelecting();
                  }}
                >
                  Cancel
                </Button>
              ) : (
                <Button ref={selectButton} variant="ghost" icon="check" className="jobs-select" data-help="jobs-select" onClick={startSelecting}>
                  Select
                </Button>
              )}
              <LinkButton href="/" variant="primary" icon="scissors">
                Make clips
              </LinkButton>
            </>
          ) : undefined
        }
      />
      {error && !data ? <ErrorPanel message={error} onRetry={reload} /> : null}
      {!data && !error ? (
        <div className="job-list">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="job-skel" />
          ))}
        </div>
      ) : null}
      {data && jobs.length === 0 ? (
        <Empty
          icon="layers"
          title="No jobs yet"
          action={
            <LinkButton href="/" variant="primary" icon="scissors">
              Make clips
            </LinkButton>
          }
        >
          Tap Make clips and paste a YouTube, Twitch or Kick link.
        </Empty>
      ) : null}
      {jobs.length ? (
        <ul className={`job-list${selecting ? " is-selecting" : ""}`} aria-label={selecting ? "Pick jobs to delete" : undefined}>
          {jobs.map((j) => (
            <li key={j.jobId} className="job-item">
              {selecting ? (
                <PickRow job={j} on={picked.has(j.jobId)} onToggle={() => toggle(j.jobId)} />
              ) : (
                <>
                  <JobRow job={j} />
                  <button
                    type="button"
                    className="icon-btn job-item__delete"
                    aria-label={`Delete job: ${jobTitle(j)}`}
                    data-tip="Delete job"
                    onClick={() => setAsking([j])}
                  >
                    <Icon name="trash" size={20} />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {selecting ? (
        <div className="select-bar glass" role="toolbar" aria-label="Picked jobs">
          <p className="select-bar__count" aria-live="polite">
            {chosen.length ? `${plural(chosen.length, "job")} picked` : "Tap the jobs to delete"}
          </p>
          <Button variant="ghost" size="sm" icon="x" className="select-bar__cancel" onClick={stopSelecting}>
            Cancel
          </Button>
          {failed.length ? (
            <Button
              variant="ghost"
              size="sm"
              icon="alert"
              className="select-bar__failed"
              onClick={() => setPicked(new Set(failed.map((j) => j.jobId)))}
            >
              {`Pick all failed (${failed.length})`}
            </Button>
          ) : null}
          <Button
            variant="danger"
            size="sm"
            icon="trash"
            className="select-bar__delete"
            disabled={!chosen.length}
            onClick={() => setAsking(chosen)}
          >
            {chosen.length ? `Delete ${chosen.length}` : "Delete"}
          </Button>
        </div>
      ) : null}
      {asking ? (
        <DeleteJobsSheet jobs={asking} onClose={() => setAsking(null)} onDelete={(clips, review) => remove(asking, clips, review)} />
      ) : null}
      {data?.nextCursor ? (
        <div className="center-row">
          <Button icon="chevronDown" act={older} style={DOWN} onClick={loadMore} loading={more}>
            Show older jobs
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** In Select, a row is one big tick box: tap anywhere on it to pick it or let it go. */
function PickRow({ job, on, onToggle }: { job: Job; on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={jobTitle(job)}
      className={`job-row job-row--pick glass${on ? " is-on" : ""}`}
      onClick={onToggle}
    >
      <RowParts job={job} />
      <span className="job-row__tick" aria-hidden="true">
        {on ? <Icon name="check" size={18} /> : null}
      </span>
    </button>
  );
}

function JobRow({ job }: { job: Job }) {
  return (
    <A href={`/jobs/${job.jobId}`} className="job-row glass" data-help={job.status === "failed" ? "failed-job" : undefined}>
      <RowParts job={job} />
    </A>
  );
}

function RowParts({ job }: { job: Job }) {
  const working = isWorking(job);
  const step = job.steps.find((s) => s.status === "running");
  return (
    <>
      <SourceThumb job={job} className="job-row__thumb" />
      <span className="job-row__body">
        <span className="job-row__title clamp-2 user-text">{jobTitle(job)}</span>
        {/* The source may be cut short on a phone; when it started never is. */}
        <span className="job-row__meta">
          <span className="job-row__source">{sourceMeta(job)}</span>
          <span className="job-row__when">· {relative(job.createdAt)}</span>
        </span>
        {working ? (
          <span className="job-row__progress">
            <Progress value={jobProgress(job)} label={`${jobTitle(job)} progress`} tone="success" />
            <LiveLine
              job={job}
              compact
              className="job-row__step"
              after={` · ${jobPercent(job)}%`}
              fallback={
                <span className="job-row__step clamp-1">
                  {job.status === "queued" ? "Waiting to start" : (step?.label ?? "Working")} · {jobPercent(job)}%
                </span>
              }
            />
          </span>
        ) : job.status === "failed" && job.error ? (
          <span className="job-row__error user-text">{job.error}</span>
        ) : null}
      </span>
      <span className="job-row__side">
        <JobStatusPill status={job.status} />
        {job.status === "ready" ? <span className="job-row__count">{plural(job.clipCount, "clip")}</span> : null}
      </span>
    </>
  );
}
