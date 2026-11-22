// Mock mode's auto-posting (docs/CONTRACTS.md §46.3–§46.9): the same rules as the API's autopost/*.py and
// routes/autopost.py, with a fake clock the e2e tests can move (window.__cfMock.autopost). The hourly EventBridge
// tick is a tick at every whole hour the fake clock passes; a status read catches up a tick the clock passed by
// itself (one run, never two). Throw away's tap holds a clip for a day (§46.9, §46.13), so a run inside its Undo,
// or before a decline that comes late, leaves it alone. Only bundled into mock builds.
import { ApiError } from "../errors.ts";
import type { AutoPostSettings, AutoPostStatus, AutoRun, AutoRunClip, AutoRunKind, AutoRunMode, Clip, ClipPostOptions, Job, Platform, Post, Settings } from "../types.ts";
import { autoPostOf, floorHour, nextFullHour, perDay } from "../../lib/autopost.ts";
import { PLATFORM_ORDER } from "../../lib/format.ts";
import { campaignCardOptions, cardOptionsFrom, optionsFor, presetOf } from "../../lib/preset.ts";
import { tiktokState } from "../../lib/tiktokYourself.ts";
import { macInsteadOk, macOn } from "../../lib/tiktokMac.ts";

/** A Mac post he may take back now (waits or stopped, Post never pressed). */
function macHandable(posts: readonly Post[]): boolean {
  const mac = posts.find((p) => p.platform === "tiktok" && p.status === "mac")?.mac;
  return !!mac && macInsteadOk(mac);
}

const HOUR = 3_600_000;
const MINUTE = 60_000;
/**
 * Throw away's hold (the server's `clips.HOLD_FOR`, §46.9): a day, so a decline that comes late (a phone locked during
 * the 8 s Undo stops its timer) still finds the clip held; Undo lifts it at once.
 */
export const HOLD_MS = 24 * HOUR;
/** §46.5 rule 5: a run still `planned` this long after it planned has its clips; an older one has stopped. */
export const PLANNED_FRESH_MS = 15 * MINUTE;
/** How long EventBridge keeps trying to deliver one hour's tick (its maximum event age, §46.11). */
export const TICK_MAX_AGE_MS = 3300 * 1000;

/** §46.5 rule 3: a failed check with one of these keys makes the clip wait for him. */
export const IMPORTANT_CHECKS: readonly string[] = ["hear", "moving", "zero_context", "payoff", "campaign_rules", "logo", "disclosure"];

// The owner's sentences (§46.5, §46.7, §46.9), word for word.
export const STILL_BEING_MADE = "It is still being made.";
export const VIDEO_MISSING = "Its video is missing.";
export const CR_CANT_TAKE = "It's for a campaign, and Content Rewards can't take clips from Clip Factory by itself yet.";
export const CR_BY_HAND = "It's for a campaign you send by hand.";
export const NOTE_NOTHING = "Nothing in Review, so nothing posted.";
export const NOTE_ALL_WAITING = "Every clip in Review is waiting for you.";
export const NOTE_NO_PLACES = "Nothing is set up to post to.";
export const NOTE_NOTHING_TO_TEST = "Nothing in Review to test with.";
export const THREW_AWAY = "You threw it away first.";
export const UPLOADED_YOURSELF = "You uploaded it yourself.";
export const WAIT_A_MINUTE = "A test run just started. Wait a minute.";
export const PICK_KIND = "Pick practice or private.";
export const UNKNOWN_SETTING = "autoPost has a setting Clip Factory does not know.";
export const NOT_AN_OBJECT = "autoPost must be a JSON object.";
export const PICK_HOURS = "Pick 1 to 24 hours.";
export const PICK_CLIPS = "Pick 1 to 5 clips.";

const bad = (msg: string) => new ApiError(400, "bad_request", msg);
const iso = (t: number) => new Date(t).toISOString();

/**
 * The next run as the owner sees it (§46.4), from `due` (nextRunAt's rule) and `seen` (the last hour whose tick came:
 * max(lastRunAt, lastTickAt)): `due` while it is still ahead; once its hour is here or past, the current hour while
 * that hour's tick has not come yet (EventBridge may still deliver it, up to its 3300 s), else the next full hour.
 */
export function shownNextRun(due: number, seen: number, now: number): number {
  const cur = floorHour(now);
  if (due > cur) return due;
  if (seen < cur && now < cur + TICK_MAX_AGE_MS) return cur;
  return nextFullHour(now);
}
/** A run id's slot: ISO UTC to the second (the API's `{slot}#{kind}`). */

export interface AutoPostDeps {
  clips(): Clip[];
  jobs(): Job[];
  posts(): Post[];
  settings(): Settings;
  /** Places whose setup is ready, as Review's Upload to reads them (§46.6). */
  ready(): Platform[];
  /** A campaign clip (§46.5 rule 4): why it waits (null: it may go) and the places the campaign takes. */
  campaign(clip: Clip, places: Platform[]): { wait: string | null; places: Platform[] };
  /** Upload's own code (§46.7 step 4): confirms the clip and makes its posts, or throws Upload's refusal. */
  send(clip: Clip, places: Platform[], options: ClipPostOptions, auto: NonNullable<Clip["auto"]>): Promise<void>;
}

interface Picked {
  candidates: number;
  taken: Clip[];
  waiting: { clip: Clip; reason: string }[];
}

/** A stored run: its posts are read from the clips' posts each time (§46.9). `plannedAt` (internal, never shown):
 * when it planned, which rule 5 measures from (a late or resumed run's slot can be long before it). */
type StoredRun = Omit<AutoRun, "clips"> & { clips: Omit<AutoRunClip, "posts">[]; plannedAt: number };

/** The test knobs (window.__cfMock.autopost). */
export interface AutoPostControls {
  /** The fake clock, as ISO. */
  now(): string;
  /** Sets the fake clock (it keeps running from there). No tick runs, and none is owed. */
  set(at: string): void;
  /** Moves the fake clock on with every tick on the way lost: the next status read catches up, once (§46.13). */
  skip(ms: number): void;
  /** Moves the fake clock on; every whole hour it passes ticks, in order (EventBridge's hourly rule). */
  advance(ms: number): Promise<string[]>;
  /** One tick of the hourly rule at `at`'s hour (default: now's). Answers the run's outcome. */
  tick(at?: string): Promise<string>;
  /** The clip's video goes missing (§46.5 rule 2; mock clips carry no videoKey). */
  loseVideo(clipId: string): void;
  /** The clips Throw away holds right now (§46.13). */
  held(): string[];
  /** Every run, newest first. */
  runs(): AutoRun[];
  /** Forget the runs, the schedule and the clock (tests). */
  reset(): void;
}

export function autoPostMock(deps: AutoPostDeps) {
  let offset = 0;
  let lastRunAt: number | undefined;
  let lastNowAt: number | undefined;
  let runs: StoredRun[] = [];
  const lostVideo = new Set<string>();
  // Throw away's holds: clip id → until when (on the fake clock).
  const holds = new Map<string, number>();
  const clock = () => Date.now() + offset;
  // The last hour a tick ran for, so a status read only catches up a tick the clock passed by itself.
  let tickedSlot = floorHour(clock());
  // The server's AUTOPOST.lastTickAt: the last hour whose tick came and was not due. Setting the clock owes no tick,
  // so that hour counts as come too.
  let lastTickAt = tickedSlot;

  const isHeld = (clipId: string) => (holds.get(clipId) ?? 0) > clock();
  /** §46.5 rule 5: the clips of runs still going (planned, and planned in the last 15 minutes). */
  const busy = (): Set<string> => {
    const out = new Set<string>();
    for (const r of runs) if (r.state === "planned" && clock() - r.plannedAt <= PLANNED_FRESH_MS) for (const c of r.clips) out.add(c.clipId);
    return out;
  };

  const settingsNow = (): AutoPostSettings => autoPostOf(deps.settings().autoPost);

  /** §46.4: max(nextFullHour(onAt), lastRunAt + everyHours h); null while off. */
  function nextRunAt(s: AutoPostSettings): number | null {
    if (!s.on) return null;
    const onAt = s.onAt ? Date.parse(s.onAt) : clock();
    const first = nextFullHour(Number.isNaN(onAt) ? clock() : onAt);
    return lastRunAt === undefined ? first : Math.max(first, lastRunAt + s.everyHours * HOUR);
  }

  /** As shown (§46.4): nextRunAt; once past, this hour while its tick is still to come, else the next full hour. */
  function shownNext(s: AutoPostSettings): number | null {
    const next = nextRunAt(s);
    if (next === null) return null;
    return shownNextRun(next, Math.max(lastRunAt ?? lastTickAt, lastTickAt), clock());
  }

  /** A normal clip's places now (§46.6): every ready setup but TikTok, in STATS_ORDER. */
  const placesNow = (): Platform[] => {
    const ready = deps.ready();
    return PLATFORM_ORDER.filter((p) => p !== "tiktok" && ready.includes(p));
  };

  /** Why a clip in Review waits for him (§46.5, in order), or null when a run may take it. */
  function waitReason(c: Clip, places: Platform[]): string | null {
    const job = deps.jobs().find((j) => j.jobId === c.jobId);
    if (job && job.status !== "ready") return STILL_BEING_MADE;
    if (lostVideo.has(c.clipId)) return VIDEO_MISSING;
    const failed = c.checklist.items.find((i) => !i.pass && IMPORTANT_CHECKS.includes(i.key));
    if (failed) return `A check didn't pass: ${failed.label.replace(/[.!\s]+$/, "")}.`;
    if (c.campaignId) return deps.campaign(c, places).wait;
    return null;
  }

  /**
   * §46.5: the clips in Review, oldest first by their job, then rank, then id; taken or waiting. A clip Throw away
   * holds, or one a run still going has (rule 5), is left out silently: neither taken nor waiting.
   */
  function pick(): Picked {
    const jobs = deps.jobs();
    const age = (c: Clip) => jobs.find((j) => j.jobId === c.jobId)?.createdAt ?? c.createdAt;
    const candidates = deps
      .clips()
      .filter((c) => c.status === "review")
      .sort((a, b) => age(a).localeCompare(age(b)) || a.rank - b.rank || a.clipId.localeCompare(b.clipId));
    const places = placesNow();
    const taken = busy();
    const out: Picked = { candidates: candidates.length, taken: [], waiting: [] };
    for (const c of candidates) {
      if (isHeld(c.clipId) || taken.has(c.clipId)) continue;
      const reason = waitReason(c, places);
      if (reason) out.waiting.push({ clip: c, reason });
      else out.taken.push(c);
    }
    return out;
  }

  /** My settings for the places going (§46.6), never made for kids; a campaign clip gets the campaign's versions. */
  function optionsOf(c: Clip, places: Platform[]): ClipPostOptions {
    const s = deps.settings();
    const preset = presetOf(s.postPreset);
    return optionsFor(places, c.campaignId ? campaignCardOptions(preset) : cardOptionsFrom(preset, s.youtubePrivacy ?? "public"));
  }

  /** §46.7: one run. Scheduled runs check on and due first; run-now runs whatever the switch says. */
  async function runOnce(kind: AutoRunKind, slot: number): Promise<AutoRun | "off" | "not_due" | "done"> {
    const s = settingsNow();
    // The server's runId: the slot as its iso() writes it, milliseconds kept ("…T10:00:00.000Z#scheduled").
    const runId = `${iso(Math.floor(slot / 1000) * 1000)}#${kind}`;
    // The same event twice (a retry, two deliveries): the run item is there, so the second resumes it (here: done).
    if (runs.some((r) => r.runId === runId)) return "done";
    if (kind === "scheduled") {
      if (!s.on) return "off";
      const next = nextRunAt(s)!;
      if (slot < next) return "not_due";
    }
    const mode: AutoRunMode = kind === "private_now" ? "private" : kind === "practice_now" || s.practice ? "practice" : "live";
    const picked = pick();
    let places = placesNow();
    // X has no private posts (§46.8).
    if (mode === "private") places = places.filter((p) => p !== "x");
    // A Private test run never takes a campaign clip (its post would go to Content Rewards, §46.8).
    const taken = mode === "private" ? picked.taken.filter((c) => !c.campaignId) : picked.taken;
    // The note in the server's order (autopost/run.py _plan).
    let note: string | undefined;
    if (mode === "private" && !taken.length) note = NOTE_NOTHING_TO_TEST;
    else if (mode !== "private" && !picked.candidates) note = NOTE_NOTHING;
    else if (!places.length) note = NOTE_NO_PLACES;
    else if (!taken.length) note = NOTE_ALL_WAITING;
    const plan = note ? [] : taken.slice(0, kind === "private_now" ? 1 : s.perRun);
    // Claim: a scheduled run moves lastRunAt to its slot (a run that finds nothing counts too, §46.4).
    if (kind === "scheduled") lastRunAt = Math.max(lastRunAt ?? slot, slot);
    const run: StoredRun = {
      runId,
      at: iso(slot),
      plannedAt: clock(),
      kind,
      mode,
      state: "planned",
      ...(note ? { note } : {}),
      clips: plan.map((c) => ({ clipId: c.clipId, hook: c.hook, places: c.campaignId ? deps.campaign(c, places).places : [...places] })),
    };
    runs.unshift(run);
    for (const planned of run.clips) {
      if (mode === "practice") {
        planned.outcome = "would_send";
        continue;
      }
      const c = deps.clips().find((x) => x.clipId === planned.clipId);
      // Decided since the plan: thrown away (or its Undo still counting: held) or uploaded by hand (§46.13).
      if (!c || c.status !== "review" || isHeld(c.clipId)) {
        planned.outcome = "skipped";
        planned.reason = !c || c.status === "declined" || c.status === "review" ? THREW_AWAY : UPLOADED_YOURSELF;
        continue;
      }
      try {
        await deps.send(c, planned.places, optionsOf(c, planned.places), { runId, at: run.at, ...(mode === "private" ? { test: "private" as const } : {}) });
        planned.outcome = "sent";
      } catch (e) {
        planned.outcome = "skipped";
        planned.reason = e instanceof ApiError ? e.message : "Something went wrong. It goes next run.";
      }
    }
    run.state = "done";
    return withPosts(run);
  }

  function withPosts({ plannedAt: _internal, ...run }: StoredRun): AutoRun {
    const posts = deps.posts();
    return structuredClone({
      ...run,
      clips: run.clips.map((c) => ({
        ...c,
        posts:
          c.outcome === "sent"
            ? PLATFORM_ORDER.flatMap((p) =>
                posts
                  .filter((x) => x.clipId === c.clipId && x.platform === p && c.places.includes(p))
                  .map((x) => ({ platform: x.platform, status: x.status, ...(x.url ? { url: x.url } : {}), ...(x.error ? { error: x.error } : {}), ...(x.test ? { test: x.test } : {}) })),
              )
            : [],
      })),
    });
  }

  /** One tick of the hourly rule (§46.4): its slot is the event's own hour, never "now". */
  async function tick(at: number): Promise<string> {
    const slot = floorHour(at);
    tickedSlot = Math.max(tickedSlot, slot);
    const out = await runOnce("scheduled", slot);
    // The hour's tick came and found nothing due: the shown next run moves on from this hour (§46.4).
    if (out === "not_due") lastTickAt = Math.max(lastTickAt, slot);
    return typeof out === "string" ? out : out.runId;
  }

  /** The clock passed whole hours by itself (the pretend app open a long while): the next tick catches up, once. */
  async function catchUp() {
    const slot = floorHour(clock());
    if (slot > tickedSlot) await tick(slot);
  }

  const controls: AutoPostControls = {
    now: () => iso(clock()),
    set(at) {
      offset = Date.parse(at) - Date.now();
      tickedSlot = floorHour(clock());
      lastTickAt = tickedSlot;
    },
    skip(ms) {
      offset += ms;
    },
    async advance(ms) {
      const from = clock();
      offset += ms;
      const out: string[] = [];
      for (let slot = nextFullHour(from); slot <= clock(); slot += HOUR) out.push(await tick(slot));
      return out;
    },
    tick: (at) => tick(at ? Date.parse(at) : clock()),
    loseVideo(clipId) {
      lostVideo.add(clipId);
    },
    held: () => [...holds.keys()].filter(isHeld),
    runs: () => runs.map(withPosts),
    reset() {
      offset = 0;
      lastRunAt = undefined;
      lastNowAt = undefined;
      runs = [];
      lostVideo.clear();
      holds.clear();
      tickedSlot = floorHour(clock());
      lastTickAt = tickedSlot;
    },
  };

  return {
    controls,
    clock,
    /** POST /v1/clips/{clipId}/hold on a clip in Review (the route checks it): runs leave it alone for a day. */
    hold(clipId: string) {
      holds.set(clipId, clock() + HOLD_MS);
    },
    /** DELETE /v1/clips/{clipId}/hold: Undo lets runs take it again. */
    unhold(clipId: string) {
      holds.delete(clipId);
    },
    /**
     * PUT /v1/settings `autoPost` (§46.3): any of on, everyHours, perRun, practice, each merged over the stored value.
     * Switching on writes onAt; on while already on keeps it.
     */
    merge(stored: Partial<AutoPostSettings> | undefined, raw: unknown): AutoPostSettings {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw bad(NOT_AN_OBJECT);
      const patch = raw as Record<string, unknown>;
      if (Object.keys(patch).some((k) => !["on", "everyHours", "perRun", "practice"].includes(k))) throw bad(UNKNOWN_SETTING);
      const whole = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
      if ("everyHours" in patch && !whole(patch.everyHours, 1, 24)) throw bad(PICK_HOURS);
      if ("perRun" in patch && !whole(patch.perRun, 1, 5)) throw bad(PICK_CLIPS);
      for (const k of ["on", "practice"]) if (k in patch && typeof patch[k] !== "boolean") throw bad(`${k} must be true or false.`);
      const before = autoPostOf(stored);
      const next: AutoPostSettings = { ...before, ...(patch as Partial<AutoPostSettings>) };
      if (next.on && !before.on) next.onAt = iso(clock());
      return next;
    },
    /** GET /v1/autopost (§46.9). */
    async status(): Promise<AutoPostStatus> {
      await catchUp();
      const s = settingsNow();
      const next = shownNext(s);
      const picked = pick();
      const places = placesNow();
      // §46.5: a row gets its time only when it has somewhere to go; practising, only the first perRun (practice
      // runs send nothing, so they pick the same first clips each time).
      const hasPlaces = (c: Clip) => (c.campaignId ? deps.campaign(c, places).places.length > 0 : places.length > 0);
      const timed = (c: Clip, i: number) => next !== null && hasPlaces(c) && (!s.practice || i < s.perRun);
      const posts = deps.posts();
      const clips = deps.clips();
      const hookOf = (clipId: string) => clips.find((c) => c.clipId === clipId)?.hook ?? "";
      return structuredClone({
        autoPost: s,
        nextRunAt: next === null ? null : iso(next),
        perDay: perDay(s.perRun, s.everyHours),
        places,
        // §47.2: while the owner's Mac posts TikTok, TikTok is not left out: it is the Mac's place.
        leftOut: PLATFORM_ORDER.filter((p) => !places.includes(p) && !(p === "tiktok" && macOn(deps.settings()))).map((p) => ({
          platform: p,
          reason: p === "tiktok" ? ("tiktok_yourself" as const) : ("not_set_up" as const),
        })),
        macPlaces: macOn(deps.settings()) ? (["tiktok"] as Platform[]) : [],
        nextUp: picked.taken.slice(0, 10).map((c, i) => ({
          clipId: c.clipId,
          jobId: c.jobId,
          hook: c.hook,
          ...(c.coverUrl ? { coverUrl: c.coverUrl } : {}),
          ...(timed(c, i) ? { runAt: iso(next! + Math.floor(i / s.perRun) * s.everyHours * HOUR) } : {}),
        })),
        waiting: picked.waiting.slice(0, 20).map(({ clip: c, reason }) => ({ clipId: c.clipId, jobId: c.jobId, hook: c.hook, ...(c.coverUrl ? { coverUrl: c.coverUrl } : {}), reason })),
        runs: runs.slice(0, 10).map(withPosts),
        failed: posts
          .filter((p) => p.auto && p.status === "failed")
          .map((p) => ({ postId: p.postId, clipId: p.clipId, hook: hookOf(p.clipId), platform: p.platform, error: p.error ?? "", at: clips.find((c) => c.clipId === p.clipId)?.auto?.at ?? "" }))
          .sort((a, b) => b.at.localeCompare(a.at) || b.postId.localeCompare(a.postId))
          .slice(0, 20),
        // §47.2: while Your Mac posts TikTok is off, his Mac's posts that wait or stopped (never one it is posting or
        // pressed Post on) are his to post again: Post it yourself instead (`mac: true`).
        tiktokYourself: clips
          .filter((c) => {
            if (!c.auto || c.auto.test) return false;
            const own = posts.filter((p) => p.clipId === c.clipId);
            const state = tiktokState(own);
            if (state === "mac") return !macOn(deps.settings()) && macHandable(own);
            return state === "offer";
          })
          .sort((a, b) => b.auto!.at.localeCompare(a.auto!.at))
          .slice(0, 10)
          .map((c) => ({
            clipId: c.clipId,
            hook: c.hook,
            ...(c.coverUrl ? { coverUrl: c.coverUrl } : {}),
            ...(tiktokState(posts.filter((p) => p.clipId === c.clipId)) === "mac" ? { mac: true as const } : {}),
          })),
      });
    },
    /** POST /v1/autopost/run (§46.9): one run now, inline, whatever the switch says; one a minute. */
    async runNow(kind: unknown): Promise<AutoRun> {
      if (kind !== "practice" && kind !== "private") throw bad(PICK_KIND);
      const now = clock();
      if (lastNowAt !== undefined && now - lastNowAt < MINUTE) throw new ApiError(409, "conflict", WAIT_A_MINUTE);
      lastNowAt = now;
      const out = await runOnce(kind === "practice" ? "practice_now" : "private_now", Math.floor(now / 1000) * 1000);
      if (typeof out === "string") throw new ApiError(409, "conflict", WAIT_A_MINUTE);
      return out;
    },
  };
}
