// Live numbers in answers (docs/CONTRACTS.md §19.7): read by the browser with the owner's own token through the
// normal API client, from routes the pages already use. The assistant itself never reads clips, posts or weeks.
import type { Api } from "../../api/types.ts";
import { PLATFORM_LABEL } from "../../lib/format.ts";
import { compact } from "../../lib/metrics.ts";
import { isoWeek, shiftWeek, weekRange } from "../../lib/week.ts";
import type { HelpLiveSpec } from "./types.ts";

export type LiveResult =
  /** Fill the placeholders with these. */
  | { kind: "values"; values: Record<string, string> }
  /** Say this instead of the number sentence ("No clips this week yet."). */
  | { kind: "text"; text: string }
  /** Nothing to show here (a clip's views when the panel was not opened on a clip). */
  | { kind: "skip" };

const JOB_WORD = { queued: "waiting to start", running: "working", ready: "ready", failed: "failed", canceled: "stopped" } as const;

export interface LiveWhere {
  /** The clip page the panel was opened on, if any. */
  clipId?: string | null;
  now?: Date;
}

/** Reads one metric. Throws when the read fails (the panel then says it couldn't get the number). */
export async function readLive(spec: HelpLiveSpec, a: Api, where: LiveWhere = {}): Promise<LiveResult> {
  const values = (v: Record<string, string>): LiveResult => ({ kind: "values", values: v });
  switch (spec.metric) {
    case "best_clip_week_views":
    case "week_total_views":
    case "week_clips": {
      const now = isoWeek(where.now ?? new Date());
      const week = spec.range === "last_week" ? shiftWeek(now, -1) : now;
      const { from, to } = weekRange(week);
      const view = await a.getWeek(week, from, to);
      const clips = [...view.clips].sort((x, y) => y.totals.views - x.totals.views);
      if (spec.metric === "week_clips") return values({ value: String(clips.length), posted: String(clips.filter((c) => c.posted).length) });
      if (!clips.length) return { kind: "text", text: spec.range === "last_week" ? "No clips last week." : "No clips this week yet." };
      if (spec.metric === "week_total_views") return values({ value: compact(clips.reduce((n, c) => n + c.totals.views, 0)) });
      const best = clips[0]!;
      return values({ value: compact(best.totals.views), hook: best.clip.hook });
    }
    case "review_waiting":
      return values({ value: String((await a.me()).counts.review) });
    case "jobs_running":
      return values({ value: String((await a.me()).counts.running) });
    case "clips_posted":
      return values({ value: String((await a.me()).counts.posted) });
    case "latest_job": {
      const job = (await a.listJobs({ limit: 1 })).jobs[0];
      if (!job) return { kind: "text", text: "You have no jobs yet." };
      return values({ value: JOB_WORD[job.status], progress: String(Math.round(job.progress * 100)), clips: String(job.clipCount) });
    }
    case "clip_views": {
      if (!where.clipId) return { kind: "skip" };
      const perf = await a.clipPerformance(where.clipId);
      return values({ value: compact(perf.totals.views), platform: perf.bestPlatform ? PLATFORM_LABEL[perf.bestPlatform] : "no app yet" });
    }
    case "skills_on":
      // Every skill is always used (§18), so this is every skill the owner has, built-ins included.
      return values({ value: String((await a.listSkills()).length) });
    case "accounts_connected":
      return values({ value: String((await a.listAccounts()).filter((x) => x.status === "connected").length) });
  }
}
