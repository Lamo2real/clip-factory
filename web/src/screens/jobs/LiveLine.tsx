import { useState, type ReactNode } from "react";
import type { Job } from "../../api/types.ts";
import { lineWords, useJobLive, useNow } from "../../lib/jobLive.ts";
import { JobNote } from "./JobNote.tsx";

type LiveJob = Pick<Job, "jobId" | "status" | "run" | "live" | "note" | "steps">;

/**
 * What the job is doing right now, in one line under the progress bar (CONTRACTS §31): a big plain sentence
 * ("Cutting clip 3 of 10"), a small grey detail ("0:41 of 0:58") and a tiny "what is running" line
 * ("ffmpeg · 1080×1920 · 30 fps"). Updated live over the shared connection. Before the first line arrives the job's
 * own note shows (JobNote); once the job ends, nothing.
 *
 * `compact`: one line with an ellipsis, no "what is running" line, for the Jobs list and Home's "Working now". It
 * takes the row's own class, shows `fallback` (the step label) until a line arrives, and adds `after` (" · 34%").
 *
 * On the job page this is the one place that speaks the step (the progress panel says only the percent); in the
 * compact rows it stays quiet (`aria-live="off"` inside Home's live list). The visible words are not a live region (the seconds would be read out every second). A separate hidden status
 * says only the sentence, and only when the step or the clip number changes.
 */
export function LiveLine({
  job,
  compact = false,
  className = "",
  fallback = null,
  after = "",
}: {
  job: LiveJob;
  compact?: boolean;
  className?: string;
  fallback?: ReactNode;
  after?: string;
}) {
  const line = useJobLive(job);
  const now = useNow(!!line);
  const label = job.steps.find((s) => s.key === line?.step)?.label ?? job.steps.find((s) => s.status === "running")?.label;
  const words = line ? lineWords(line, now, label) : null;
  const key = line ? `${line.step}|${line.i ?? ""}|${line.n ?? ""}|${words?.stale ? "stale" : ""}` : "";
  // What the hidden status says changes only with the step or the clip number (state set while rendering, React's
  // way to follow a prop without an extra render pass).
  const [heard, setHeard] = useState({ key: "", say: "" });
  if (words && key !== heard.key) setHeard({ key, say: words.say });

  if (!line || !words) return compact ? fallback : <JobNote job={job} />;
  if (compact) {
    // The detail (seconds, MB) is hidden from screen readers: Home's list is a live region and would read it out.
    return (
      <span
        className={`${className} live-line--compact clamp-1${words.stale ? " is-stale" : ""}`}
        data-live-line=""
        aria-live="off"
      >
        <span className="live-line__text">{words.text}</span>
        {words.detail ? <span className="live-line__more" aria-hidden="true">{` · ${words.detail}`}</span> : null}
        {after}
      </span>
    );
  }
  return (
    <div className={`live-line${words.stale ? " is-stale" : ""}`} data-live-line="">
      <span className="live-line__dot" aria-hidden="true" />
      <div className="live-line__body">
        <p className="live-line__text clamp-1" key={words.text}>
          {words.text}
        </p>
        {words.detail ? <p className="live-line__detail clamp-1">{words.detail}</p> : null}
        {words.tech ? (
          <p className="live-line__tech clamp-1" translate="no">
            {words.tech}
          </p>
        ) : null}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {heard.say}
      </p>
    </div>
  );
}
