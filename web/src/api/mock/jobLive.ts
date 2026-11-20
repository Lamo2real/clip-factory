// Mock mode's live status lines (docs/CONTRACTS.md §31): what each step says while it runs, so the one-line status
// can be seen (npm run dev:mock), screenshotted and tested with nothing leaving the machine.
import type { Job, JobLive } from "../types.ts";

type Frame = Omit<JobLive, "jobId" | "at" | "since"> & { sinceSec?: number };

/** One sample line per step, like the agent's templates write them. */
export const SAMPLE_LINES: Record<string, Frame> = {
  resolve: { step: "resolve", text: "Finding the video" },
  download: { step: "download", text: "Getting the video", detail: "412 MB of 1.2 GB · 34%", tech: "yt-dlp · 4.1 MB/s", pct: 34 },
  transcribe: { step: "transcribe", text: "Writing down the words", detail: "part 3 of 8", tech: "Amazon Transcribe", i: 3, n: 8 },
  analyze: { step: "analyze", text: "Reading the chat", detail: "12,430 messages", tech: "Twitch chat replay" },
  watch: { step: "watch", text: "Watching the video with Claude", detail: "part 2 of 5", tech: "Claude Fable 5.1 · thinking", sinceSec: 48 },
  select: { step: "select", text: "Picking the best moments with Claude", tech: "Claude Fable 5.1 · thinking", sinceSec: 21 },
  render: { step: "render", text: "Cutting clip 3 of 7", detail: "0:41 of 0:58", tech: "ffmpeg · 1080×1920 · 30 fps", i: 3, n: 7, pct: 70 },
  checklist: { step: "checklist", text: "Checking clip 4 of 7 with Claude", tech: "Claude Fable 5.1 · thinking", i: 4, n: 7, sinceSec: 72 },
  captions: { step: "captions", text: "Writing captions for clip 6 of 7", i: 6, n: 7 },
  finalize: { step: "finalize", text: "Saving clip 2 of 7", i: 2, n: 7 },
};

/** What the line says next, one after another (window.__cfMockLive.line() pushes them in order). */
export const SCRIPT: Frame[] = [
  SAMPLE_LINES.render!,
  { ...SAMPLE_LINES.render!, detail: "0:52 of 0:58", pct: 90 },
  { step: "render", text: "Cutting clip 4 of 7", detail: "0:03 of 0:47", tech: "ffmpeg · 1080×1920 · 30 fps", i: 4, n: 7, pct: 6 },
  SAMPLE_LINES.checklist!,
];

export function lineFor(job: Pick<Job, "jobId" | "run">, frame: Frame, now = Date.now()): JobLive {
  const { sinceSec, ...rest } = frame;
  return {
    jobId: job.jobId,
    ...(job.run ? { run: job.run } : {}),
    ...rest,
    ...(sinceSec !== undefined ? { since: new Date(now - sinceSec * 1000).toISOString() } : {}),
    at: new Date(now).toISOString(),
  };
}

/** The line a fetched job carries: its running step's sample, only while it is running. */
export function sampleLine(job: Job, now = Date.now()): JobLive | undefined {
  if (job.status !== "running") return undefined;
  const step = job.steps.find((s) => s.status === "running");
  const frame = step ? SAMPLE_LINES[step.key] : undefined;
  return frame ? lineFor(job, frame, now) : undefined;
}
