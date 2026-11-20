// Realistic demo data for mock mode: jobs in every state, clips waiting for review, posts with 48-hour numbers.
import type { Account, Captions, Clip, Job, Learning, MomentType, Platform, Post, SeriesPoint, Settings, Step, StepKey } from "../types.ts";
import { presetOf } from "../../lib/preset.ts";
import { isoWeek, weekRange, shiftWeek, weekStart } from "../../lib/week.ts";
import { coverArt, thumbArt } from "./art.ts";
import type { MockSkill } from "./skills.ts";
import { growth, metricsFor, type WeekItem } from "./statsData.ts";

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let counter = 0;
/** A ULID-shaped id (26 chars, time-sortable). Deterministic randomness keeps screenshots stable. */
/** The fixture skills' ids (§18.9): a written .md, a .zip, and one with tricky bits. */
export const SKILL_IDS = {
  written: "01JZ8S00000000000000000001",
  zip: "01JZ8S00000000000000000002",
  tricky: "01JZ8S00000000000000000003",
} as const;

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

/** The ten steps, with the labels the API and the agent write (docs/CONTRACTS.md §5, §8). Keep the three in step. */
export const STEP_LABELS: Record<StepKey, string> = {
  resolve: "Find the video",
  download: "Get the video",
  transcribe: "Write down the words",
  analyze: "Listen for big moments",
  watch: "Watch the video",
  select: "Pick the best moments",
  render: "Cut the clips",
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

/** `why` is the clip's `pickedFor` line; a moment without one shows no line (nothing stood out). */
const MOMENTS: { hook: string; summary: string; type: MomentType; score: number; why?: string }[] = [
  { hook: "He did NOT see that coming", summary: "A getaway goes wrong when the police helicopter lands on the roof.", type: "no_way", score: 9, why: "Big crash + Big reaction" },
  { hook: "Chat called it before he did", summary: "Chat predicts the betrayal two minutes before it happens.", type: "interaction", score: 8, why: "Back and forth" },
  { hook: "The calmest rage quit ever", summary: "A whispered meltdown after losing the race on the final corner.", type: "rage", score: 8 },
  { hook: "Twelve cars, one bridge", summary: "A pile-up on the bridge turns into a full server brawl.", type: "chaos", score: 9, why: "Loud laugh + Fast action" },
  { hook: "First time seeing the new map", summary: "Genuine first reaction to the new city reveal.", type: "first_reaction", score: 7 },
  { hook: "Speedrunners are not real gamers", summary: "A hot take on speedrunning that splits chat in half.", type: "hot_take", score: 7 },
  { hook: "The getaway driver is twelve", summary: "A kid in voice chat drives the best escape of the night.", type: "interaction", score: 8 },
  { hook: "One shot. Whole lobby gone.", summary: "A rocket at the gas station clears the lobby.", type: "chaos", score: 9 },
  { hook: "He finally lost it at 3 a.m.", summary: "The sixth failed heist ends with a desk slam.", type: "rage", score: 6 },
  { hook: "Police chase in reverse", summary: "The whole chase is driven backwards, on purpose.", type: "no_way", score: 8 },
  { hook: "This is why we don't trust Marco", summary: "Marco sells out the crew for 200 dollars.", type: "interaction", score: 7 },
  { hook: "Wait for the jump", summary: "A ramp jump over the river lands on a moving train.", type: "no_way", score: 9, why: "Chat went wild + Loud laugh" },
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
const STATS_INDEX: Record<Platform, number> = { youtube: 0, tiktok: 1, instagram: 2, facebook: 3, x: 4 };

/** Last week's clips (their own hooks, so no card repeats another). */
const OLDER: (typeof MOMENTS)[number][] = [
  { hook: "The bank job went perfectly. Then Marco spoke.", summary: "A flawless heist falls apart over the radio.", type: "interaction", score: 9 },
  { hook: "Ninety seconds of pure police chase", summary: "The longest chase of the weekend, start to finish.", type: "chaos", score: 8 },
  { hook: "He tried to park a plane", summary: "A landing on the motorway that nearly works.", type: "no_way", score: 7 },
  { hook: "Quiet. Too quiet.", summary: "The calm before the ambush at the docks.", type: "first_reaction", score: 6 },
];

export interface Store {
  jobs: Job[];
  clips: Clip[];
  posts: Post[];
  skills: MockSkill[];
  learnings: Learning[];
  settings: Settings;
  accounts: Account[];
  /** Sparkline points per post id, oldest first (the STAT# snapshots, §16.3). */
  snapshots: Record<string, SeriesPoint[]>;
  /** WEEK# items by "yyyy-Www". */
  weeks: Record<string, WeekItem>;
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
    pickedFor: m.why,
    createdAt: iso(ageMs),
    decidedAt: status === "review" ? undefined : iso(ageMs - 20 * MIN),
  };
}

/** A job the app picked back up on its own after it stopped partway (CONTRACTS §30): the steps already done stay
 * done, the progress does not go back, and the note says what is happening. Not in the seeded list. */
export function resumedJob(ageMs = 25 * MIN): Job {
  const done = STEP_KEYS.indexOf("render");
  return {
    jobId: ulid(Date.now() - ageMs),
    status: "queued",
    source: { type: "upload", platform: "upload", key: "uploads/u/1/stream.mp4", filename: "stream.mp4", title: "stream.mp4" },
    clipTarget: { min: 5, max: 10 },
    steps: stepsAt(done, "queued"),
    progress: 0.79,
    clipCount: 0,
    note: "Picking up where it stopped…",
    createdAt: iso(ageMs),
    updatedAt: iso(0),
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
    STEP_KEYS.indexOf("render"), // by key, never by position: the step list can grow
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
      model: "fable-5-1",
    },
    26 * HOUR,
    STEP_KEYS.length,
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
    STEP_KEYS.length,
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
    STEP_KEYS.indexOf("download"),
    "YouTube asked for a sign-in.",
  );
  const canceled = job(
    {
      status: "canceled",
      source: { type: "link", platform: "twitch", url: "https://www.twitch.tv/lamo", title: "Live channel: lamo", channel: "lamo", thumbnailUrl: thumbArt(4, "Live") },
    },
    5 * 24 * HOUR,
    STEP_KEYS.indexOf("transcribe"),
  );

  const clips: Clip[] = [];
  const twitchStatuses: Clip["status"][] = ["review", "review", "review", "review", "confirmed", "confirmed", "declined"];
  twitchStatuses.forEach((st, i) => clips.push(makeClip(twitch, i + 1, MOMENTS[i]!, st, i, "#gtarp #heist", 25 * HOUR - i * MIN)));
  const kickStatuses: Clip["status"][] = ["posted", "posted", "posted", "review", "declined"];
  kickStatuses.forEach((st, i) => clips.push(makeClip(kick, i + 1, MOMENTS[7 + i]!, st, i + 7, "#gaming", 4 * 24 * HOUR - i * MIN)));

  // One kept clip whose posting never started (the Keep stopped half way): the Library offers "Try again" for it.
  const stuck = clips.filter((c) => c.status === "confirmed").at(-1);
  const posts: Post[] = [];
  const snapshots: Store["snapshots"] = {};
  for (const c of clips.filter((x) => x.status === "confirmed" && x !== stuck)) {
    for (const platform of PLATFORMS) posts.push({ postId: ulid(), clipId: c.clipId, platform, status: "pending_integration" });
  }

  // Posted clips. This week's are spread over the days of the week so far (it may be Monday morning), last week's
  // over last week, so "This week" always has clips and "Earlier week" goes back to real ones.
  const now = Date.now();
  const thisWeek = isoWeek(new Date(now));
  const monday = weekStart(thisWeek).getTime();
  const sinceMonday = Math.max(now - monday, 6 * MIN);
  const lastWeek = shiftWeek(thisWeek, -1);

  type Plan = { platform: Platform; state: "numbers" | "private" | "waiting" | "failed" | "none" | "posting" | "fresh"; views?: number; insights?: boolean };
  const post = (c: Clip, at: number, plan: Plan, seedN: number) => {
    if (plan.state === "none") return;
    const id = ulid(at);
    const base: Post = { postId: id, clipId: c.clipId, platform: plan.platform, status: "posted" };
    if (plan.state === "waiting") return void posts.push({ ...base, status: "pending_integration" });
    if (plan.state === "posting") return void posts.push({ ...base, status: "queued" });
    if (plan.state === "failed")
      return void posts.push({ ...base, status: "failed", error: "Facebook said the video was too long for a Reel" });
    const p: Post = {
      ...base,
      url: `https://example.com/${plan.platform}/${c.clipId.slice(-6)}`,
      postedAt: new Date(at).toISOString(),
      perfCheckAt: new Date(at + 48 * HOUR).toISOString(),
    };
    if (plan.state === "private") p.privacy = "private";
    if (plan.state === "numbers" && plan.views) {
      const checked = now - ((seedN * 3 + 2) % 11) * MIN - 40_000;
      p.metrics = metricsFor(plan.platform, plan.views, c.durationSec, seedN, {
        insights: plan.insights !== false,
        checkedAt: new Date(checked).toISOString(),
        insightsAt: new Date(Math.max(at, now - 26 * HOUR)).toISOString(),
      });
      snapshots[id] = growth(at, checked, plan.views);
    }
    if (plan.platform === "tiktok") p.privacy = p.privacy ?? "public";
    posts.push(p);
  };

  const kickPosted = clips.filter((c) => c.status === "posted");
  const thisWeekPlans: Plan[][] = [
    [
      { platform: "youtube", state: "numbers", views: 48_210 },
      { platform: "tiktok", state: "numbers", views: 126_400 },
      { platform: "instagram", state: "numbers", views: 22_950 },
      { platform: "facebook", state: "numbers", views: 9_870 },
      { platform: "x", state: "numbers", views: 3_420 },
    ],
    [
      { platform: "youtube", state: "numbers", views: 12_905 },
      { platform: "tiktok", state: "private" },
      { platform: "instagram", state: "waiting" },
      { platform: "facebook", state: "failed" },
      { platform: "x", state: "none" },
    ],
    [
      { platform: "youtube", state: "posting" },
      { platform: "tiktok", state: "fresh" },
      { platform: "instagram", state: "numbers", views: 3_104, insights: false },
      { platform: "facebook", state: "numbers", views: 1_260 },
      { platform: "x", state: "numbers", views: 845 },
    ],
  ];
  kickPosted.forEach((c, ci) => {
    const at = now - (sinceMonday * (ci + 1)) / 4;
    c.decidedAt = new Date(Math.min(Date.parse(c.decidedAt ?? c.createdAt), at - 10 * MIN)).toISOString();
    (thisWeekPlans[ci] ?? thisWeekPlans[0]!).forEach((plan, pi) => post(c, at + pi * 40_000, plan, ci * 5 + pi));
  });

  // Last week: a finished job whose clips were all posted, one of them starred, with the learning it taught.
  const highlights = job(
    {
      status: "ready",
      source: {
        type: "link",
        platform: "youtube",
        url: "https://www.youtube.com/watch?v=Zi_XLOBDo_Y",
        title: "Weekend highlights: the bank job, take four",
        channel: "LamoPlays",
        durationSec: 5 * 3600 + 20 * 60,
        thumbnailUrl: thumbArt(5, "Bank job"),
      },
      notes: "#gtarp",
      clipCount: 4,
    },
    now - monday + 8 * 24 * HOUR,
    STEP_KEYS.length,
  );
  const older: Clip[] = OLDER.map((m, i) => {
    const c = makeClip(highlights, i + 1, m, "posted", 20 + i, "#gtarp", now - monday + 8 * 24 * HOUR - (i + 1) * MIN);
    return c;
  });
  const lastWeekViews = [61_300, 18_740, 7_215, 2_480];
  const lastMonday = weekStart(lastWeek).getTime();
  older.forEach((c, ci) => {
    const at = lastMonday + (ci * 1.4 + 0.6) * 24 * HOUR;
    c.decidedAt = new Date(at - 30 * MIN).toISOString();
    PLATFORMS.forEach((platform, pi) => {
      const share = [0.32, 0.38, 0.16, 0.09, 0.05][STATS_INDEX[platform]]!;
      post(c, at + pi * 50_000, { platform, state: "numbers", views: Math.round(lastWeekViews[ci]! * share * (1 + pi * 0.03)) }, 40 + ci * 5 + pi);
    });
  });
  const starred = older[1]!;
  starred.best = true;
  starred.bestWeek = lastWeek;
  clips.push(...older);
  // Fixed ids, so a skill page can be opened by its address and survives a reload (the mock keeps nothing else).
  const skills: Store["skills"] = [
    {
      skillId: "builtin-short-form-video-playbook",
      name: "short-form-video-playbook",
      title: "Short form video playbook",
      description:
        "Plan, script, hook, edit and package videos and clips for TikTok, Reels, Shorts and YouTube.",
      builtin: true,
      source: "builtin",
      format: "md",
      size: 7847,
      createdAt: "2026-11-15T00:00:00.000Z",
      updatedAt: "2026-11-15T00:00:00.000Z",
      version: 1,
      files: [],
      content:
        "---\nname: short-form-video-playbook\ndescription: Plan, script, hook, edit and package videos and clips.\n---\n\n# Short-form and YouTube video playbook\n\nA repeatable system for making videos and clips that people **click on** and *watch to the end*.\n\n## A. Clip\n\n1. Find the moment: a reaction, a fight, a fail, a hot take.\n2. Hook in the first second. Put the payoff on screen early.\n3. Captions big, centred, two to four words at a time.\n4. End on a loop so the replay feels seamless.\n\n> Short beats long when in doubt.\n\n```\nhook -> payoff -> loop\n```\n",
    },
    {
      skillId: SKILL_IDS.written,
      name: "gta-rp-hooks",
      title: "GTA RP hooks",
      description: "Every time it picks moments and writes hooks for my GTA roleplay clips.",
      builtin: false,
      source: "written",
      format: "md",
      size: 2310,
      createdAt: iso(6 * 24 * HOUR),
      updatedAt: iso(3 * 24 * HOUR),
      version: 2,
      files: [],
      content:
        '---\nname: gta-rp-hooks\ndescription: "Every time it picks moments and writes hooks for my GTA roleplay clips."\n---\n\n# GTA RP hooks\n\n- Lead with the character\'s name when the audience knows them.\n- Tease the betrayal, never reveal it in the hook.\n- Keep police chases under 40 seconds.\n',
    },
    {
      skillId: SKILL_IDS.zip,
      name: "brand-voice",
      title: "Brand voice",
      description: "The channel's tone: dry, quick, never mean. Banned words and the sign-off line.",
      builtin: false,
      source: "upload",
      format: "zip",
      size: 18_402,
      createdAt: iso(2 * 24 * HOUR),
      updatedAt: iso(2 * 24 * HOUR),
      version: 1,
      files: ["banned-words.txt", "examples/sign-off.txt"],
      content:
        "---\nname: brand-voice\ndescription: \"The channel's tone: dry, quick, never mean. Banned words and the sign-off line.\"\nlicense: Own words\n---\n\n# Brand voice\n\nDry, quick, never mean. See banned-words.txt for the words to leave out.\n",
    },
    {
      skillId: SKILL_IDS.tricky,
      name: "safety-test",
      title: "Safety test",
      description: "A skill with tricky bits in it, to show they stay plain words.",
      builtin: false,
      source: "upload",
      format: "md",
      size: 412,
      createdAt: iso(26 * HOUR),
      updatedAt: iso(26 * HOUR),
      version: 1,
      files: [],
      content:
        "---\nname: safety-test\ndescription: A skill with tricky bits in it, to show they stay plain words.\n---\n\n# Safety test\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\nDo not [tap this](javascript:alert(3)). A real link: [Clip Factory help](https://example.com/help).\n\n![a cat](https://example.com/cat.png)\n",
    },
  ];

  const posted = posts.filter((p) => p.metrics);
  const weekLearning: Learning = {
    learningId: ulid(lastMonday + 7 * 24 * HOUR - 2 * HOUR),
    kind: "week",
    week: lastWeek,
    title: `Best of week ${lastWeek}`,
    text: "Your pick opened on the chase in the first second and kept the betrayal for the end. Start on the action, and save the twist for the last few seconds.",
    createdAt: new Date(Math.min(now - 5 * MIN, lastMonday + 7 * 24 * HOUR - 2 * HOUR)).toISOString(),
    clipIds: [starred.clipId],
    postIds: posts.filter((p) => p.clipId === starred.clipId && p.status === "posted").map((p) => p.postId),
  };
  const learnings: Learning[] = [
    weekLearning,
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
    jobs: [queued, running, twitch, failed, kick, highlights, canceled],
    clips,
    posts,
    skills,
    learnings,
    snapshots,
    weeks: {
      [lastWeek]: {
        week: lastWeek,
        ...weekRange(lastWeek),
        clipIds: [starred.clipId],
        savedAt: new Date(lastMonday + 7 * 24 * HOUR - 3 * HOUR).toISOString(),
        learnState: "done",
        learningId: weekLearning.learningId,
        revision: 1,
      },
    },
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
      youtubePrivacy: "public",
      postPreset: presetOf(undefined),
      earningsRates: {},
      earningsPaid: {},
      setupSkipped: [],
      // No backgroundMode: like the server, absent until saved, so the device decides (§22.1).
      backgroundColours: ["#0f372b", "#efe7da", "#e8392b"],
      glassStrength: "clear",
      clipModel: "fable-5-1",
      followPaused: false,
      followDailyMax: 0,
      followMinMinutes: 30,
      notify: { ready: true, stopped: true, resumed: true, steps: false },
    },
    accounts: PLATFORMS.map((platform) => ({ platform, status: "not_connected" })),
  };
}

export { coverArt, thumbArt, MOMENTS, PLATFORMS };
