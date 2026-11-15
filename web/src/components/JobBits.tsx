import type { Job, JobStatus, Step } from "../api/types.ts";
import { duration, PLATFORM_LABEL } from "../lib/format.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { PlatformMark } from "./PlatformMark.tsx";
import { Pill, type Tone } from "./ui.tsx";

const STATUS: Record<JobStatus, { label: string; tone: Tone; icon: IconName }> = {
  queued: { label: "Waiting", tone: "neutral", icon: "clock" },
  running: { label: "Working", tone: "sage", icon: "bolt" },
  ready: { label: "Ready", tone: "ink", icon: "checkCircle" },
  failed: { label: "Failed", tone: "tomato", icon: "alert" },
  canceled: { label: "Canceled", tone: "neutral", icon: "stop" },
};

export function JobStatusPill({ status }: { status: JobStatus }) {
  const s = STATUS[status];
  return (
    <Pill tone={s.tone} icon={s.icon}>
      {s.label}
    </Pill>
  );
}

export function jobTitle(job: Job): string {
  return job.source.title || job.source.filename || job.source.url || "Untitled video";
}

export function SourceThumb({ job, className = "" }: { job: Job; className?: string }) {
  return (
    <span className={`thumb ${className}`}>
      {job.source.thumbnailUrl ? <img src={job.source.thumbnailUrl} alt="" loading="lazy" /> : null}
      <span className="thumb__mark" title={PLATFORM_LABEL[job.source.platform]}>
        <PlatformMark platform={job.source.platform} size={16} />
      </span>
    </span>
  );
}

export function sourceMeta(job: Job): string {
  const parts: string[] = [PLATFORM_LABEL[job.source.platform]];
  if (job.source.channel) parts.push(job.source.channel);
  if (job.source.durationSec) parts.push(duration(job.source.durationSec));
  return parts.join(" · ");
}

const STEP_ICON: Record<Step["status"], IconName | null> = {
  done: "check",
  failed: "x",
  skipped: "minus",
  running: null,
  pending: null,
};

/** The pipeline as a vertical timeline. The running step pulses; finished steps fill the rail. */
export function StepTimeline({ steps }: { steps: Step[] }) {
  return (
    <ol className="timeline">
      {steps.map((s, i) => {
        const icon = STEP_ICON[s.status];
        return (
          <li key={s.key} className={`timeline__step is-${s.status}`} style={{ ["--i" as string]: i }}>
            <span className="timeline__node" aria-hidden="true">
              {icon ? <Icon name={icon} size={14} /> : null}
            </span>
            <span className="timeline__text">
              <span className="timeline__label">
                {s.label}
                <span className="sr-only">
                  {", "}
                  {s.status === "done"
                    ? "done"
                    : s.status === "running"
                      ? "in progress"
                      : s.status === "failed"
                        ? "failed"
                        : s.status === "skipped"
                          ? "skipped"
                          : "not started"}
                </span>
              </span>
              {s.message ? <span className="timeline__msg user-text">{s.message}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
