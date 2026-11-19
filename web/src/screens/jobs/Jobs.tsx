import { useRef, useState, type CSSProperties } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import type { Job } from "../../api/types.ts";
import { JobStatusPill, jobTitle, sourceMeta, SourceThumb } from "../../components/JobBits.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { A, Button, Empty, ErrorPanel, LinkButton, PageHeader, Progress, Skeleton } from "../../components/ui.tsx";
import { burst } from "../../lib/confetti.ts";
import { useAction } from "../../lib/motion.ts";
import { plural, relative } from "../../lib/format.ts";
import { useLoad } from "../../lib/hooks.ts";
import { useLiveEvents, useLivePoll } from "../../lib/live.ts";
import { applyJobEvent } from "../../lib/liveCache.ts";
import { mergeJobs, pollLimit } from "./mergeJobs.ts";

/** Show older jobs loads more below: its chevron points and steps down (§20.3 `--act-dir`). */
const DOWN = { "--act-dir-in": "90deg" } as CSSProperties;

export function Jobs() {
  const { data, error, reload, setData } = useLoad(() => api().listJobs({ limit: 20 }), "", "jobs");
  const [more, setMore] = useState(false);
  const toast = useToast();
  const seen = useRef(new Map<string, Job["status"]>());
  // Show older jobs: the chevron steps on (§20.11 (a)); a page that does not load shakes it instead.
  const older = useAction("next");

  const jobs = data?.jobs ?? [];
  const active = jobs.some((j) => j.status === "running" || j.status === "queued");

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
        lede="Every link or video you add is one job. Tap one to watch it being made, step by step."
        actions={
          jobs.length ? (
            <LinkButton href="/" variant="primary" icon="scissors">
              Make clips
            </LinkButton>
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
          Tap Make clips, paste a YouTube, Twitch or Kick link, and your first job starts.
        </Empty>
      ) : null}
      {jobs.length ? (
        <ul className="job-list">
          {jobs.map((j) => (
            <li key={j.jobId}>
              <JobRow job={j} />
            </li>
          ))}
        </ul>
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

function JobRow({ job }: { job: Job }) {
  const working = job.status === "running" || job.status === "queued";
  const step = job.steps.find((s) => s.status === "running");
  return (
    <A href={`/jobs/${job.jobId}`} className="job-row glass" data-help={job.status === "failed" ? "failed-job" : undefined}>
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
            <Progress value={job.progress} label={`${jobTitle(job)} progress`} tone="success" />
            <span className="job-row__step clamp-1">
              {job.status === "queued" ? "Waiting to start" : (step?.label ?? "Working")} · {Math.round(job.progress * 100)}%
            </span>
          </span>
        ) : job.status === "failed" && job.error ? (
          <span className="job-row__error user-text">{job.error}</span>
        ) : null}
      </span>
      <span className="job-row__side">
        <JobStatusPill status={job.status} />
        {job.status === "ready" ? <span className="job-row__count">{plural(job.clipCount, "clip")}</span> : null}
      </span>
    </A>
  );
}
