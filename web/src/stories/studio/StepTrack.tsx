// The eight production steps of a story (docs/CONTRACTS.md §45.9, §45.16.5): Write the story, Check the facts, Draw
// the scenes, Animate, Add sounds and music, Add captions, Put it together, Ready to watch. Each shows done, now,
// waiting, skipped or stopped, with "Scene 3 of 6" while a step works through the scenes, and the eased progress bar.
import { STEP_LABEL, STEP_ORDER, type ProductionJob, type StepKey, type Story, type StoryStatus, type StoryStep } from "../api/types.ts";
import { ProgressBar } from "./kit.tsx";
import { STEP_WORD } from "./words.ts";

/** The steps to draw: the job's own, else what the story says (stale steps still to make, the rest done). */
export function stepsOf(job: ProductionJob | null, story: Pick<Story, "stale" | "status"> | null): StoryStep[] {
  if (job && job.contentType === "animation" && job.steps.length) {
    const byKey = new Map(job.steps.map((s) => [s.key, s]));
    return STEP_ORDER.map((key) => byKey.get(key) ?? { key, label: STEP_LABEL[key], status: "pending" });
  }
  const stale = new Set<StepKey>(story?.stale ?? STEP_ORDER);
  return STEP_ORDER.map((key) => ({ key, label: STEP_LABEL[key], status: stale.has(key) ? "pending" : "done" }));
}

/** The step working now, or the one that stopped. */
export function currentStep(steps: StoryStep[]): StoryStep | null {
  return steps.find((s) => s.status === "running") ?? steps.find((s) => s.status === "failed") ?? null;
}

/** One plain line: what is happening now (a rejected video's last run is never "ready to watch"). */
export function nowLine(job: ProductionJob | null, steps: StoryStep[], status?: StoryStatus): string {
  if (!job) return "";
  if (status === "rejected") return "Not used. It won't be posted.";
  if (job.status === "queued") return "Getting ready to start…";
  if (job.status === "failed") return job.error ?? "Making the video stopped. Tap Try again.";
  if (job.status === "canceled") return "You stopped this one.";
  if (job.status === "ready") return "All done! It's ready to watch.";
  if (job.status === "needs_check") return "Made, but some facts need checking.";
  const now = currentStep(steps);
  if (!now) return "Working…";
  const word = now.key === "portrait" ? "Drawing the picture" : (STEP_WORD[now.key as StepKey] ?? now.label);
  return now.n && now.n > 1 ? `${word}: scene ${Math.min(now.n, (now.i ?? 0) + 1)} of ${now.n}` : `${word}…`;
}

const MARK: Record<StoryStep["status"], string> = { done: "✓", running: "", pending: "", failed: "!", skipped: "–" };

export function StepTrack({
  job,
  story,
  compact = false,
  label = "Making the video",
  bar = true,
  line = true,
}: {
  job: ProductionJob | null;
  story: Pick<Story, "stale" | "status"> | null;
  compact?: boolean;
  label?: string;
  /** the eased progress bar (off where the page shows the progress itself: a video's preview dial) */
  bar?: boolean;
  /** the "what is happening now" line (off where the preview says it) */
  line?: boolean;
}) {
  const steps = stepsOf(job, story);
  const live = job && (job.status === "queued" || job.status === "running");
  const progress = job ? job.progress : steps.filter((s) => s.status === "done" || s.status === "skipped").length / steps.length;
  return (
    <div className={`st-s-track${compact ? " st-s-track--compact" : ""}${live ? " is-live" : ""}`}>
      <ol className="st-s-track__steps" aria-label={label}>
        {steps.map((s, i) => (
          <li key={s.key} className={`st-s-track__step is-${s.status}`} aria-current={s.status === "running" ? "step" : undefined}>
            <span className="st-s-track__dot" aria-hidden="true">
              {s.status === "running" ? <span className="st-s-track__spin" /> : MARK[s.status] || i + 1}
            </span>
            <span className={compact ? "st-s-sr" : "st-track__label"}>
              {s.label}
              <span className="st-s-sr">
                {": "}
                {s.status === "done" ? "done" : s.status === "running" ? "working on it now" : s.status === "failed" ? "stopped" : s.status === "skipped" ? "skipped" : "waiting"}
              </span>
            </span>
            {!compact && s.status === "running" && s.message ? <span className="st-s-track__msg">{s.message}</span> : null}
            {!compact && s.status === "failed" && s.message ? <span className="st-s-track__msg is-bad">{s.message}</span> : null}
          </li>
        ))}
      </ol>
      {bar ? <ProgressBar value={progress} label={`${label}: ${Math.round(progress * 100)}% done`} /> : null}
      {job && line ? <p className={`st-s-track__now${job.status === "failed" ? " is-bad" : ""}`}>{nowLine(job, steps, story?.status)}</p> : null}
    </div>
  );
}
