// Realistic demo data for mock mode: jobs in every state, clips waiting for review, posts with 48-hour numbers.
import type { Account, Captions, Clip, Job, Learning, MomentType, Platform, Post, Settings, Skill, Step, StepKey } from "../types.ts";
import { coverArt, thumbArt } from "./art.ts";

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let counter = 0;
/** A ULID-shaped id (26 chars, time-sortable). Deterministic randomness keeps screenshots stable. */
export function ulid(time = Date.now()): string {
  let t = time;
  let head = "";
  for (let i = 0; i < 10; i++) {
    head = B32[t % 32] + head;
    t = Math.floor(t / 32);
  }
  counter += 1;
  let tail = "";
  let n = counter * 2654435761;
  for (let i = 0; i < 16; i++) {
    tail += B32[n % 32];
    n = Math.floor(n / 32) + i * 7 + counter;
  }
  return head + tail;
}

export const STEP_LABELS: Record<StepKey, string> = {
  resolve: "Read the link",
  download: "Download the audio",
  transcribe: "Transcribe every word",
  analyze: "Find the loud moments",
  select: "Pick the best moments",
  render: "Cut and edit the clips",
  checklist: "Check each clip",
  captions: "Write the captions",
  finalize: "Finish up",
};
export const STEP_KEYS = Object.keys(STEP_LABELS) as StepKey[];

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Steps for a job that has finished `done` steps; the next one is `running` unless the job is not running. */
export function stepsAt(done: number, state: "running" | "failed" | "canceled" | "queued" | "ready", message?: string): Step[] {
  return STEP_KEYS.map((key, i) => {
    let status: Step["status"] = "pending";
    if (state === "ready" || i < done) status = "done";
    else if (i === done && state === "running") status = "running";
    else if (i === done && state === "failed") status = "failed";
    const step: Step = { key, label: STEP_LABELS[key], status };
    if (status === "running" || status === "failed") step.message = message;
    return step;
  });
}

function captions(hook: string, tags: string): Captions {
  return {
    youtubeTitle: `${hook} ${tags}`.slice(0, 100),
    youtubeDescription: `${hook}\n\nFull stream linked on the channel. ${tags}`,
    instagram: `${hook}\n\nFollow for daily clips.\n${tags} #reels #gaming`,
    facebook: `${hook} Watch to the end.`,
    tiktok: `${hook} ${tags} #fyp #gaming`,
    x: `${hook} ${tags}`.slice(0, 270),
  };
}

const MOMENTS: { hook: string; summary: string; type: MomentType; score: number }[] = [
  { hook: "He did NOT see that coming", summary: "A getaway goes wrong when the police helicopter lands on the roof.", type: "no_way", score: 9 },
  { hook: "Chat called it before he did", summary: "Chat predicts the betrayal two minutes before it happens.", type: "interaction", score: 8 },
  { hook: "The calmest rage quit ever", summary: "A whispered meltdown after losing the race on the final corner.", type: "rage", score: 8 },
  { hook: "Twelve cars, one bridge", summary: "A pile-up on the bridge turns into a full server brawl.", type: "chaos", score: 9 },
  { hook: "First time seeing the new map", summary: "Genuine first reaction to the new city reveal.", type: "first_reaction", score: 7 },
  { hook: "Speedrunners are not real gamers", summary: "A hot take on speedrunning that splits chat in half.", type: "hot_take", score: 7 },
  { hook: "The getaway driver is twelve", summary: "A kid in voice chat drives the best escape of the night.", type: "interaction", score: 8 },
  { hook: "One shot. Whole lobby gone.", summary: "A rocket at the gas station clears the lobby.", type: "chaos", score: 9 },
  { hook: "He finally lost it at 3 a.m.", summary: "The sixth failed heist ends with a desk slam.", type: "rage", score: 6 },
  { hook: "Police chase in reverse", summary: "The whole chase is driven backwards, on purpose.", type: "no_way", score: 8 },
  { hook: "This is why we don't trust Marco", summary: "Marco sells out the crew for 200 dollars.", type: "interaction", score: 7 },
  { hook: "Wait for the jump", summary: "A ramp jump over the river lands on a moving train.", type: "no_way", score: 9 },
];

function checklist(score: number) {
  const items = [
    { key: "hook_3s", label: "Hook lands in the first 3 seconds", pass: true },
    { key: "captions", label: "Captions are readable on a phone", pass: true },
    { key: "loop", label: "Ending loops back to the start", pass: score >= 8, note: score >= 8 ? undefined : "The last second cuts mid-word." },
    { key: "length", label: "Between 15 and 60 seconds", pass: true },
    { key: "audio", label: "Audio peaks below -1 dB", pass: score !== 6, note: score === 6 ? "One shout clips briefly at 0:21." : undefined },
    { key: "context", label: "Makes sense without the stream", pass: score >= 7 },
  ];
  const fixes = items.filter((i) => !i.pass).map((i) => i.note ?? `Fix: ${i.label.toLowerCase()}.`);
  return { items, fixes };
}

const PLATFORMS: Platform[] = ["youtube", "instagram", "facebook", "tiktok", "x"];

export interface Store {
  jobs: Job[];
  clips: Clip[];
  posts: Post[];
  skills: (Skill & { content: string })[];
  learnings: Learning[];
  settings: Settings;
  accounts: Account[];
}

function makeClip(job: Job, rank: number, m: (typeof MOMENTS)[number], status: Clip["status"], seed: number, tags: string, ageMs: number): Clip {
  const start = 600 + rank * 913 + seed * 37;
  const duration = 18 + ((seed * 7) % 38);
  const layout = seed % 3 === 0 ? "blur_fill" : "facecam_top";
  const url = job.source.url;
  return {
    clipId: ulid(Date.now() - ageMs),
    jobId: job.jobId,
    rank,
    status,
    momentType: m.type,
    hook: m.hook,
    summary: m.summary,
    durationSec: duration,
    sourceStart: start,
    sourceEnd: start + duration,
    sourceUrlAt: url ? `${url}${url.includes("?") ? "&" : "?"}t=${start}` : undefined,
    layout,
    coverUrl: coverArt(seed, m.hook, layout),
    captions: captions(m.hook, tags),
    checklist: checklist(m.score),
    score: m.score,
    createdAt: iso(ageMs),
    decidedAt: status === "review" ? undefined : iso(ageMs - 20 * MIN),
  };
}

export function seed(): Store {
  const job = (partial: Partial<Job> & Pick<Job, "status" | "source">, ageMs: number, done: number, message?: string): Job => {
    const steps = stepsAt(done, partial.status === "ready" ? "ready" : (partial.status as "running"), message);
    return {
      jobId: ulid(Date.now() - ageMs),
      clipTarget: { min: 5, max: 10 },
      steps,
      progress: partial.status === "ready" ? 1 : done / STEP_KEYS.length,
      clipCount: 0,
      createdAt: iso(ageMs),
      updatedAt: iso(Math.max(0, ageMs - 40 * MIN)),
      ...partial,
    };
  };

  const running = job(
    {
      status: "running",
      source: {
        type: "link",
        platform: "youtube",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        title: "Ranked grind to Diamond: six-hour stream with chat",
        channel: "LamoPlays",
        durationSec: 6 * 3600 + 12 * 60,
        thumbnailUrl: thumbArt(0, "Ranked grind"),
      },
      notes: "#gta6 #ranked",
    },
    12 * MIN,
    5,
    "Cutting clip 3 of 7",
  );
  const queued = job(
    {
      status: "queued",
      source: { type: "upload", platform: "upload", key: "uploads/u/1/podcast-ep-42.mp4", filename: "podcast-ep-42.mp4", title: "podcast-ep-42.mp4" },
    },
    2 * MIN,
    0,
  );
  const twitch = job(
    {
      status: "ready",
      source: {
        type: "link",
        platform: "twitch",
        url: "https://www.twitch.tv/videos/2245119876",
        title: "Heist night with the crew (no sleep until we win)",
        channel: "lamo",
        durationSec: 4 * 3600 + 40 * 60,
        thumbnailUrl: thumbArt(1, "Heist night"),
      },
      notes: "#gtarp",
      clipCount: 7,
    },
    26 * HOUR,
    9,
  );
  const kick = job(
    {
      status: "ready",
      source: {
        type: "link",
        platform: "kick",
        url: "https://kick.com/lamo/videos/8f2c1a",
        title: "Server launch day: the first 3 hours",
        channel: "lamo",
        durationSec: 3 * 3600 + 5 * 60,
        thumbnailUrl: thumbArt(2, "Launch day"),
      },
      clipCount: 5,
    },
    4 * 24 * HOUR,
    9,
  );
  const failed = job(
    {
      status: "failed",
      source: {
        type: "link",
        platform: "youtube",
        url: "https://youtu.be/aqz-KE-bpKQ",
        title: "Charity marathon, part two",
        channel: "LamoPlays",
        thumbnailUrl: thumbArt(3, "Marathon"),
      },
      error: "YouTube blocked the download from the cloud. Add your YouTube cookies in Settings, then press Retry.",
    },
    2 * 24 * HOUR,
    1,
    "YouTube asked for a sign-in.",
  );
  const canceled = job(
    {
      status: "canceled",
      source: { type: "link", platform: "twitch", url: "https://www.twitch.tv/lamo", title: "Live channel: lamo", channel: "lamo", thumbnailUrl: thumbArt(4, "Live") },
    },
    5 * 24 * HOUR,
    2,
  );

  const clips: Clip[] = [];
  const twitchStatuses: Clip["status"][] = ["review", "review", "review", "review", "confirmed", "confirmed", "declined"];
  twitchStatuses.forEach((st, i) => clips.push(makeClip(twitch, i + 1, MOMENTS[i]!, st, i, "#gtarp #heist", 25 * HOUR - i * MIN)));
  const kickStatuses: Clip["status"][] = ["posted", "posted", "posted", "review", "declined"];
  kickStatuses.forEach((st, i) => clips.push(makeClip(kick, i + 1, MOMENTS[7 + i]!, st, i + 7, "#gaming", 4 * 24 * HOUR - i * MIN)));

  // One kept clip whose posting never started (the Keep stopped half way): the Library offers "Try again" for it.
  const stuck = clips.filter((c) => c.status === "confirmed").at(-1);
  const posts: Post[] = [];
  const metricsBase = [48210, 12900, 3100];
  clips
    .filter((c) => c.status === "posted" || c.status === "confirmed")
    .forEach((c, ci) => {
      if (c === stuck) return;
      for (const [pi, platform] of PLATFORMS.entries()) {
        const postedAgo = 3 * 24 * HOUR - ci * HOUR;
        if (c.status === "posted") {
          const base = (metricsBase[ci % 3] ?? 2000) / (pi + 1);
          const checked = postedAgo > 48 * HOUR;
          posts.push({
            postId: ulid(Date.now() - postedAgo),
            clipId: c.clipId,
            platform,
            status: "posted",
            url: `https://example.com/${platform}/${c.clipId.slice(-6)}`,
            postedAt: iso(postedAgo),
            perfCheckAt: new Date(Date.now() - postedAgo + 48 * HOUR).toISOString(),
            metrics: checked
              ? {
                  views: Math.round(base),
                  likes: Math.round(base * 0.071),
                  comments: Math.round(base * 0.006),
                  shares: Math.round(base * 0.012),
                  checkedAt: iso(postedAgo - 48 * HOUR),
                }
              : undefined,
          });
        } else {
          posts.push({ postId: ulid(), clipId: c.clipId, platform, status: "pending_integration" });
        }
      }
    });

  const skills: Store["skills"] = [
    {
      skillId: "builtin-short-form-video-playbook",
      name: "short-form-video-playbook",
      description:
        "Plan, script, hook, edit and package videos and clips for TikTok, Reels, Shorts and YouTube.",
      enabled: true,
      builtin: true,
      format: "md",
      size: 7847,
      createdAt: iso(30 * 24 * HOUR),
      content:
        "---\nname: short-form-video-playbook\ndescription: Plan, script, hook, edit and package videos and clips.\n---\n\n# Short-form and YouTube video playbook\n\nA repeatable system for making videos and clips that people click on and watch to the end.\n\n## A. Clip\n\n1. Find the moment: a reaction, a fight, a fail, a hot take.\n2. Hook in the first second. Put the payoff on screen early.\n3. Captions big, centred, two to four words at a time.\n4. End on a loop so the replay feels seamless.\n",
    },
    {
      skillId: ulid(Date.now() - 6 * 24 * HOUR),
      name: "gta-rp-hooks",
      description: "Hooks and caption rules that work for GTA roleplay clips: name the character, tease the betrayal.",
      enabled: true,
      builtin: false,
      format: "md",
      size: 2310,
      createdAt: iso(6 * 24 * HOUR),
      content:
        "---\nname: gta-rp-hooks\ndescription: Hooks and caption rules for GTA roleplay clips.\n---\n\n# GTA RP hooks\n\n- Lead with the character's name when the audience knows them.\n- Tease the betrayal, never reveal it in the hook.\n- Keep police chases under 40 seconds.\n",
    },
    {
      skillId: ulid(Date.now() - 2 * 24 * HOUR),
      name: "brand-voice",
      description: "The channel's tone: dry, quick, never mean. Banned words and the sign-off line.",
      enabled: false,
      builtin: false,
      format: "zip",
      size: 18_402,
      createdAt: iso(2 * 24 * HOUR),
      content: "---\nname: brand-voice\ndescription: The channel's tone.\n---\n\n# Brand voice\n\nDry, quick, never mean.\n",
    },
  ];

  const posted = posts.filter((p) => p.metrics);
  const learnings: Learning[] = [
    {
      learningId: ulid(Date.now() - 20 * HOUR),
      text: "Chaos clips with a number in the hook (\"Twelve cars, one bridge\") got three times the views of rage clips.",
      createdAt: iso(20 * HOUR),
      postIds: posted.slice(0, 3).map((p) => p.postId),
    },
    {
      learningId: ulid(Date.now() - 2 * 24 * HOUR),
      text: "Clips under 30 seconds were watched to the end twice as often on TikTok and Shorts.",
      createdAt: iso(2 * 24 * HOUR),
      postIds: posted.slice(3, 6).map((p) => p.postId),
    },
    {
      learningId: ulid(Date.now() - 3 * 24 * HOUR),
      text: "Facecam on top beat the blurred-fill layout on Instagram for reaction moments.",
      createdAt: iso(3 * 24 * HOUR),
      postIds: posted.slice(6, 8).map((p) => p.postId),
    },
  ];

  return {
    jobs: [queued, running, twitch, failed, kick, canceled],
    clips,
    posts,
    skills,
    learnings,
    settings: {
      clipMin: 5,
      clipMax: 10,
      maxSourceHours: 6,
      soundEnabled: true,
      clickSound: 6,
      errorSound: 5,
      reduceMotion: false,
      hasYoutubeCookies: false,
      platforms: [...PLATFORMS],
    },
    accounts: PLATFORMS.map((platform) => ({ platform, status: "not_connected" })),
  };
}

export { coverArt, thumbArt, MOMENTS, PLATFORMS };
