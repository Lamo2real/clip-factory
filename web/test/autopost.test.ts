// Auto-posting's words and the mock's rules (docs/CONTRACTS.md §46.2–§46.9, §46.15): the result line for every pair
// 1..5 × 1..24, the warnings, the time words, the places, the Recent lines, Review's and Home's lines, the post words,
// and the mock's schedule, pick, runs and run-now limits on a fake clock.
import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { autoPostMock, CR_CANT_TAKE, HOLD_MS, PLANNED_FRESH_MS, shownNextRun, TICK_MAX_AGE_MS, NOTE_ALL_WAITING, NOTE_NO_PLACES, NOTE_NOTHING, NOTE_NOTHING_TO_TEST, PICK_CLIPS, PICK_HOURS, PICK_KIND, STILL_BEING_MADE, THREW_AWAY, NOT_AN_OBJECT, UNKNOWN_SETTING, UPLOADED_YOURSELF, VIDEO_MISSING, WAIT_A_MINUTE, type AutoPostDeps } from "../src/api/mock/autopost.ts";
import { mockApi } from "../src/api/mock/index.ts";
import { TIKTOK_PRIVATE_ONLY } from "../src/lib/tiktokYourself.ts";
import { seed } from "../src/api/mock/fixtures.ts";
import type { AutoRun, Clip, ClipPostOptions, Job, Platform, Post, Settings } from "../src/api/types.ts";
import {
  AUTO_ALREADY_SENT,
  AUTO_POST_DEFAULTS,
  autoPerfLabel,
  autoPostLabel,
  autoPostOf,
  canTryPlaceAgain,
  dayWarnings,
  EVERY_HOURS,
  floorHour,
  HOME_HINT,
  homeHint,
  isPrivateTest,
  leftOutLine,
  MORE_THAN_FIVE,
  NEXT_ALL_WAITING,
  NEXT_EMPTY,
  nextFullHour,
  NOWHERE_TO_POST,
  OFF_LINE,
  PER_RUN,
  perDay,
  placesLine,
  PRACTICE_IN_LINE,
  resultLine,
  REVIEW_LEDE,
  reviewLede,
  reviewLine,
  runLines,
  sentFirstLine,
  switchLine,
  timeWords,
  YOUTUBE_LIMIT,
} from "../src/lib/autopost.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A local time, so the words read the same in any time zone (the owner's own, §46.2). */
const local = (h: number, m = 0, day = 22) => new Date(2026, 10, day, h, m).getTime();
/** "Now" for the words, pinned to that same Sunday morning so a time a week away reads the same on any day. */
const NOW = local(9, 30);

describe("the result line (§46.2 item 2)", () => {
  it("has every pair 1..5 clips × 1..24 hours: whole days plain, the rest about and rounded half up", () => {
    expect(PER_RUN).toEqual([1, 2, 3, 4, 5]);
    expect(EVERY_HOURS).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    let lines = 0;
    for (const n of PER_RUN)
      for (const h of EVERY_HOURS) {
        const d = (n * 24) / h;
        const whole = Number.isInteger(d);
        const shown = whole ? d : Math.floor(d + 0.5);
        const clips = (k: number) => `${k} ${k === 1 ? "clip" : "clips"}`;
        const hours = `${h} ${h === 1 ? "hour" : "hours"}`;
        expect(resultLine(n, h), `${n} × ${h}`).toBe(`${clips(n)} every ${hours} = ${whole ? "" : "about "}${clips(shown)} a day per platform.`);
        expect(perDay(n, h)).toBeCloseTo(d, 10);
        lines++;
      }
    expect(lines).toBe(120);
  });

  it("says the contract's own examples word for word", () => {
    expect(resultLine(1, 24)).toBe("1 clip every 24 hours = 1 clip a day per platform.");
    expect(resultLine(1, 5)).toBe("1 clip every 5 hours = about 5 clips a day per platform.");
    expect(resultLine(2, 7)).toBe("2 clips every 7 hours = about 7 clips a day per platform.");
    expect(resultLine(1, 1)).toBe("1 clip every 1 hour = 24 clips a day per platform.");
    expect(resultLine(5, 1)).toBe("5 clips every 1 hour = 120 clips a day per platform.");
    // Half up: 1.5 is about 2, 2.5 about 3 (never banker's rounding).
    expect(resultLine(1, 16)).toBe("1 clip every 16 hours = about 2 clips a day per platform.");
    expect(resultLine(5, 16)).toBe("5 clips every 16 hours = about 8 clips a day per platform.");
    expect(resultLine(1, 17)).toBe("1 clip every 17 hours = about 1 clip a day per platform.");
  });
});

describe("the warnings (§46.2 item 2)", () => {
  it("warn only past 5 a day, and YouTube's 100 only past 100", () => {
    for (const n of PER_RUN)
      for (const h of EVERY_HOURS) {
        const d = (n * 24) / h;
        const want = d > 100 ? [MORE_THAN_FIVE, YOUTUBE_LIMIT] : d > 5 ? [MORE_THAN_FIVE] : [];
        expect(dayWarnings(n, h), `${n} × ${h}`).toEqual(want);
      }
    expect(MORE_THAN_FIVE).toBe("That's more than 5 clips a day on each platform.");
    expect(YOUTUBE_LIMIT).toBe("YouTube takes at most 100 uploads a day, so some would wait until the next day.");
    expect(dayWarnings(1, 5)).toEqual([]);
    expect(dayWarnings(5, 24)).toEqual([]);
    expect(dayWarnings(1, 4)).toEqual([MORE_THAN_FIVE]);
    expect(dayWarnings(4, 1)).toEqual([MORE_THAN_FIVE]);
    expect(dayWarnings(5, 1)).toEqual([MORE_THAN_FIVE, YOUTUBE_LIMIT]);
  });
});

describe("time words (§46.2)", () => {
  it("say the local weekday and 24-hour time, never Today or Tomorrow", () => {
    const mid = local(14, 0, 25);
    expect(timeWords(local(15), mid)).toBe("Sun 15:00");
    expect(timeWords(new Date(local(5, 7)).toISOString(), mid)).toBe("Sun 05:07");
    expect(timeWords(local(0, 0, 23), mid)).toBe("Mon 00:00");
    expect(timeWords(local(23, 59, 28), mid)).toBe("Sat 23:59");
    const week = Array.from({ length: 7 }, (_, i) => timeWords(local(12, 0, 22 + i), mid).slice(0, 3));
    expect(week).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    for (let i = 0; i < 48; i++) expect(timeWords(Date.now() + i * HOUR)).not.toMatch(/today|tomorrow/i);
    expect(timeWords("not a time")).toBe("");
  });

  it("6 days or more away, either way, they add the date as shortDate says it", () => {
    // Under 6 days: weekday and time only, both ways.
    expect(timeWords(local(15), NOW)).toBe("Sun 15:00");
    expect(timeWords(NOW + 6 * DAY - 60_000, NOW)).toBe("Sat 09:29");
    expect(timeWords(NOW - 6 * DAY + 60_000, NOW)).toBe("Mon 09:31");
    // From 6 days: the date too, so next Sunday never reads as this one.
    expect(timeWords(NOW + 6 * DAY, NOW)).toBe("Sat 28 Nov 09:30");
    expect(timeWords(local(15, 0, 29), NOW)).toBe("Sun 29 Nov 15:00");
    expect(timeWords(local(15, 0, 29), NOW)).not.toBe(timeWords(local(15), NOW));
    expect(timeWords(new Date(local(15, 0, 29)).toISOString(), NOW)).toBe("Sun 29 Nov 15:00");
    // Recent's old runs too.
    expect(timeWords(local(10, 0, 15), NOW)).toBe("Sun 15 Nov 10:00");
    // Another year: shortDate's year as well.
    expect(timeWords(new Date(2027, 0, 3, 8, 0).getTime(), NOW)).toBe("Sun 3 Jan 2027 08:00");
    // Next up, the Review line and Recent all say it.
    expect(switchLine({ on: true, practice: false }, new Date(local(15, 0, 29)).toISOString(), NOW)).toBe("On. Next: Sun 29 Nov 15:00.");
    expect(reviewLine({ on: true, practice: false }, { runAt: new Date(local(15, 0, 29)).toISOString() }, undefined, ["youtube"], NOW)).toBe(
      "Goes up by itself Sun 29 Nov 15:00. Throw it away to stop it.",
    );
    const old: AutoRun = { runId: "r", at: new Date(local(10, 0, 15)).toISOString(), kind: "scheduled", mode: "live", state: "done", note: NOTE_NOTHING, clips: [] };
    expect(runLines(old, NOW)[0]!.text).toBe("Sun 15 Nov 10:00 · Nothing in Review, so nothing posted.");
  });

  it("whole hours: the next one strictly after, the one at or before", () => {
    const at = Date.UTC(2026, 10, 22, 10, 20);
    expect(nextFullHour(at)).toBe(Date.UTC(2026, 10, 22, 11));
    expect(nextFullHour(Date.UTC(2026, 10, 22, 11))).toBe(Date.UTC(2026, 10, 22, 12));
    expect(floorHour(at)).toBe(Date.UTC(2026, 10, 22, 10));
    // Across midnight and a month end.
    expect(nextFullHour(Date.UTC(2026, 10, 30, 23, 59, 59))).toBe(Date.UTC(2026, 11, 1, 0));
  });

  it("the switch's line: off, on with the next run, practising", () => {
    expect(switchLine({ on: false, practice: false }, null)).toBe(OFF_LINE);
    expect(OFF_LINE).toBe("Off. Nothing posts by itself.");
    expect(switchLine({ on: true, practice: false }, new Date(local(15)).toISOString(), NOW)).toBe("On. Next: Sun 15:00.");
    expect(switchLine({ on: true, practice: true }, new Date(local(15)).toISOString(), NOW)).toBe("On, practising. Next practice: Sun 15:00. Nothing gets sent.");
    // The status not read yet: the next full hour (a whole UTC hour, so 14:30 in a half-hour time zone).
    const t = local(14, 20);
    expect(switchLine({ on: true, practice: false }, null, t)).toBe(`On. Next: ${timeWords(nextFullHour(t), t)}.`);
    const u = Date.UTC(2026, 10, 22, 14, 20);
    expect(switchLine({ on: true, practice: false }, null, u)).toBe(`On. Next: ${timeWords(Date.UTC(2026, 10, 22, 15), u)}.`);
  });
});

describe("settings (§46.3)", () => {
  it("an owner who never saved it reads it off, every 5 hours, 1 clip, no practice", () => {
    expect(AUTO_POST_DEFAULTS).toEqual({ on: false, everyHours: 5, perRun: 1, practice: false });
    expect(autoPostOf(undefined)).toEqual(AUTO_POST_DEFAULTS);
    expect(autoPostOf({ on: true, everyHours: 3, perRun: 2, practice: true, onAt: "x" })).toEqual({ on: true, everyHours: 3, perRun: 2, practice: true, onAt: "x" });
    // A stored value that no longer validates reads the default.
    expect(autoPostOf({ on: true, everyHours: 25, perRun: 0 })).toEqual({ ...AUTO_POST_DEFAULTS, on: true });
    expect(autoPostOf({ everyHours: 2.5, perRun: 6 } as never)).toEqual(AUTO_POST_DEFAULTS);
  });
});

describe("where they go (§46.2 item 3)", () => {
  it("names the places in the one order, or says nothing is set up", () => {
    expect(placesLine(["facebook", "youtube", "instagram"])).toBe("Goes to YouTube, Instagram and Facebook.");
    expect(placesLine(["youtube"])).toBe("Goes to YouTube.");
    expect(placesLine([])).toBe("Nothing is set up to post to. Set up a place first.");
    expect(leftOutLine("tiktok", "tiktok_yourself")).toBe("TikTok: you post it yourself (TikTok's rule). Each clip gets Post it yourself.");
    expect(leftOutLine("x", "not_set_up")).toBe("X: not set up yet.");
    expect(NEXT_EMPTY).toBe("Nothing in Review. New clips join the line when they are made.");
  });
});

describe("Recent (§46.2 item 8)", () => {
  const at = new Date(local(10)).toISOString();
  const run = (over: Partial<AutoRun>): AutoRun => ({ runId: "r", at, kind: "scheduled", mode: "live", state: "done", clips: [], ...over });
  it("a live run: each place posted ✓ or not ✗, with Open for the posted ones", () => {
    const lines = runLines(
      run({
        clips: [
          {
            clipId: "c1",
            hook: "hook",
            places: ["youtube", "instagram", "facebook"],
            outcome: "sent",
            posts: [
              { platform: "facebook", status: "failed", error: "No." },
              { platform: "instagram", status: "posted", url: "https://i/1" },
              { platform: "youtube", status: "posted", url: "https://y/1" },
            ],
          },
        ],
      }),
      NOW,
    );
    expect(lines.map((l) => l.text)).toEqual(["Sun 10:00 · “hook”: YouTube ✓ Instagram ✓ Facebook ✗"]);
    expect(lines[0]!.opens).toEqual([
      { platform: "youtube", url: "https://y/1" },
      { platform: "instagram", url: "https://i/1" },
    ]);
  });
  it("nothing, practice, a skipped clip and the Private test", () => {
    const five = new Date(local(5)).toISOString();
    expect(runLines(run({ at: five, note: "Nothing in Review, so nothing posted." }), NOW)[0]!.text).toBe("Sun 05:00 · Nothing in Review, so nothing posted.");
    expect(
      runLines(run({ at: five, mode: "practice", clips: [{ clipId: "c", hook: "hook", places: ["facebook", "youtube", "instagram"], outcome: "would_send", posts: [] }] }), NOW)[0]!
        .text,
    ).toBe("Sun 05:00 · Practice: would post “hook” to YouTube, Instagram and Facebook.");
    expect(runLines(run({ clips: [{ clipId: "c", hook: "hook", places: ["youtube"], outcome: "skipped", reason: THREW_AWAY, posts: [] }] }), NOW)[0]!.text).toBe(
      "Sun 10:00 · “hook”: You threw it away first.",
    );
    const test = runLines(
      run({
        kind: "private_now",
        mode: "private",
        clips: [
          {
            clipId: "c",
            hook: "hook",
            places: ["youtube", "instagram", "facebook"],
            outcome: "sent",
            posts: [
              { platform: "youtube", status: "posted", url: "https://y/2", test: "private" },
              { platform: "instagram", status: "posted", test: "private" },
              { platform: "facebook", status: "posted", test: "private" },
            ],
          },
        ],
      }),
    );
    // In §46.2's own order: YouTube, Facebook, Instagram (as the Private test run's line says them).
    expect(test[0]!.text).toBe("Private test · “hook”: YouTube (only you) · Facebook (draft) · Instagram (checked, not published)");
    expect(test[0]!.opens).toEqual([{ platform: "youtube", url: "https://y/2" }]);
    expect(runLines(run({ kind: "private_now", mode: "private", note: NOTE_NOTHING_TO_TEST }))[0]!.text).toBe("Private test · Nothing in Review to test with.");
  });
});

describe("Review's line and Home's hint (§46.2)", () => {
  const at = new Date(local(15)).toISOString();
  const places: Platform[] = ["youtube", "instagram", "facebook"];
  it("Review: only while on; goes up by itself, practice, or why it waits", () => {
    expect(reviewLine({ on: false, practice: false }, { runAt: at }, undefined, places, NOW)).toBeNull();
    expect(reviewLine({ on: true, practice: false }, { runAt: at }, undefined, places, NOW)).toBe("Goes up by itself Sun 15:00. Throw it away to stop it.");
    expect(reviewLine({ on: true, practice: true }, { runAt: at }, undefined, places, NOW)).toBe("Practice picks it Sun 15:00. Nothing gets sent.");
    expect(reviewLine({ on: true, practice: false }, undefined, { reason: STILL_BEING_MADE }, places, NOW)).toBe(
      "Auto-posting skips this one: It is still being made. Upload it yourself.",
    );
    expect(reviewLine({ on: true, practice: false }, undefined, undefined, places, NOW)).toBeNull();
  });
  it("Review: nowhere to post yet, a practice clip further down the line, and never an empty time", () => {
    expect(NOWHERE_TO_POST).toBe("Auto-posting has nowhere to post yet. Set up a place first.");
    expect(PRACTICE_IN_LINE).toBe("In line. Practice picks the first clips each time. Nothing gets sent.");
    // In Next up while nothing is set up: before the practice words, with or without a time.
    expect(reviewLine({ on: true, practice: false }, {}, undefined, [], NOW)).toBe(NOWHERE_TO_POST);
    expect(reviewLine({ on: true, practice: true }, {}, undefined, [], NOW)).toBe(NOWHERE_TO_POST);
    expect(reviewLine({ on: true, practice: false }, { runAt: at }, undefined, [], NOW)).toBe(NOWHERE_TO_POST);
    // A waiting clip still says why, set up or not; off says nothing.
    expect(reviewLine({ on: true, practice: false }, undefined, { reason: STILL_BEING_MADE }, [], NOW)).toMatch(/^Auto-posting skips this one: /);
    expect(reviewLine({ on: false, practice: false }, {}, undefined, [], NOW)).toBeNull();
    // Practising, a clip after the first perRun has no time: in line, never "Practice picks it ."
    expect(reviewLine({ on: true, practice: true }, {}, undefined, places, NOW)).toBe(PRACTICE_IN_LINE);
    // On with no time (a status from before it was switched on): no line rather than an empty time.
    expect(reviewLine({ on: true, practice: false }, {}, undefined, places, NOW)).toBeNull();
    for (const practice of [false, true])
      for (const p of [[], places])
        for (const next of [{}, { runAt: at }, { runAt: "not a time" }]) {
          const line = reviewLine({ on: true, practice }, next, undefined, p, NOW) ?? "";
          expect(line, JSON.stringify({ practice, p, next })).not.toMatch(/it \.|itself \.| {2}/);
        }
  });
  it("Review's page lede: unchanged while off or practising; on says the oldest clips go up by themselves", () => {
    expect(REVIEW_LEDE).toBe("Watch each clip. Tap Upload to post it, or Throw away if you do not like it. Nothing posts until you tap Upload.");
    expect(reviewLede({ on: false, practice: false, everyHours: 5 })).toBe(REVIEW_LEDE);
    expect(reviewLede({ on: true, practice: true, everyHours: 5 })).toBe(REVIEW_LEDE);
    expect(reviewLede(autoPostOf(undefined))).toBe(REVIEW_LEDE);
    expect(reviewLede({ on: true, practice: false, everyHours: 5 })).toBe(
      "Watch each clip. Tap Upload to post it now, or Throw away if you do not like it. Auto-posting is on: the oldest clips go up by themselves every 5 hours.",
    );
    expect(reviewLede({ on: true, practice: false, everyHours: 1 })).toBe(
      "Watch each clip. Tap Upload to post it now, or Throw away if you do not like it. Auto-posting is on: the oldest clips go up by themselves every 1 hour.",
    );
  });
  it("Review's Upload after a run took the clip: a calm note, never his own Upload's", () => {
    expect(sentFirstLine({})).toBeNull();
    expect(sentFirstLine({ auto: undefined })).toBeNull();
    expect(sentFirstLine({ auto: { runId: "r", at } })).toBe("Auto-posting sent this clip first.");
    expect(sentFirstLine({ auto: { runId: "r", at, test: "private" } })).toBe("Auto-posting sent this clip first, as a private test.");
    expect(AUTO_ALREADY_SENT).toBe("Auto-posting already sent this clip.");
  });
  it("Next up's words: empty, or every clip in Review waiting for him", () => {
    expect(NEXT_EMPTY).toBe("Nothing in Review. New clips join the line when they are made.");
    expect(NEXT_ALL_WAITING).toBe("Every clip in Review is waiting for you.");
    // The same sentence as a run's note when every clip waits.
    expect(NEXT_ALL_WAITING).toBe(NOTE_ALL_WAITING);
  });
  it("Home: unchanged while off or practising, else every hours, oldest first", () => {
    expect(HOME_HINT).toBe("Nothing gets posted until you tap Upload.");
    expect(homeHint(undefined)).toBe(HOME_HINT);
    expect(homeHint({ on: true, everyHours: 5, perRun: 1, practice: true })).toBe(HOME_HINT);
    expect(homeHint({ on: true, everyHours: 5, perRun: 1, practice: false })).toBe("Auto-posting is on: your clips go up by themselves every 5 hours, oldest first.");
    expect(homeHint({ on: true, everyHours: 1, perRun: 3, practice: false })).toBe("Auto-posting is on: your clips go up by themselves every 1 hour, oldest first.");
  });
});

describe("post words in Library and on the clip page (§46.2)", () => {
  it("an auto-posted post adds · by auto-posting; a Private test one says where it waits instead of Uploaded", () => {
    const p = (over: Partial<Post>) => ({ platform: "youtube" as Platform, status: "posted" as Post["status"], ...over });
    expect(autoPostLabel(p({}), "Uploaded")).toBe("Uploaded");
    expect(autoPostLabel(p({ auto: true }), "Uploaded")).toBe("Uploaded · by auto-posting");
    expect(autoPostLabel(p({ auto: true, status: "failed" }), "Didn't work")).toBe("Didn't work · by auto-posting");
    expect(autoPostLabel(p({ auto: true, test: "private" }), "Uploaded privately")).toBe("Private test · only you");
    expect(autoPostLabel(p({ auto: true, test: "private", platform: "facebook" }), "Uploaded privately")).toBe("Private test · draft on your Page");
    expect(autoPostLabel(p({ auto: true, test: "private", platform: "instagram" }), "Uploaded privately")).toBe("Private test · checked, not published");
    // A Private test post that did not go up (yet) is still auto-posted: it keeps the mark.
    expect(autoPostLabel(p({ auto: true, test: "private", status: "failed" }), "Didn't work")).toBe("Didn't work · by auto-posting");
    expect(autoPostLabel(p({ auto: true, test: "private", status: "queued" }), "Uploading…")).toBe("Uploading… · by auto-posting");
    expect(autoPostLabel(p({ platform: "tiktok", by: "you" }), "Uploaded")).toBe("Uploaded");
  });
  it("the clip page reads the clip's auto; a Private test stack has no numbers", () => {
    expect(autoPerfLabel("posted", "youtube", undefined, undefined, "Uploaded")).toBe("Uploaded");
    expect(autoPerfLabel("posted", "youtube", {}, undefined, "Uploaded")).toBe("Uploaded · by auto-posting");
    expect(autoPerfLabel("posting", "youtube", {}, undefined, "Uploading…")).toBe("Uploading… · by auto-posting");
    expect(autoPerfLabel("not_posted", "tiktok", {}, undefined, "Not posted")).toBe("Not posted");
    expect(autoPerfLabel("posted", "tiktok", {}, "you", "Uploaded")).toBe("Uploaded");
    expect(autoPerfLabel("posted_private", "facebook", { test: "private" }, undefined, "Uploaded privately")).toBe("Private test · draft on your Page");
    expect(autoPerfLabel("failed", "instagram", { test: "private" }, undefined, "Didn't work")).toBe("Didn't work · by auto-posting");
    expect(isPrivateTest("posted_private", { test: "private" }, undefined)).toBe(true);
    expect(isPrivateTest("posted", {}, undefined)).toBe(false);
    expect(isPrivateTest("failed", { test: "private" }, undefined)).toBe(false);
  });
});

describe("Didn't work's Try again (§46.2 item 6)", () => {
  const failed = { platform: "facebook" as Platform, status: "failed" as Post["status"], error: "Facebook said no." };
  it("only once the clip's other places are done, like the Library's", () => {
    expect(canTryPlaceAgain({ status: "posted" }, failed)).toBe(true);
    expect(canTryPlaceAgain({ status: "failed" }, failed)).toBe(true);
    // Still posting its other places: a retry would do nothing.
    expect(canTryPlaceAgain({ status: "publishing" }, failed)).toBe(false);
    expect(canTryPlaceAgain({ status: "confirmed" }, failed)).toBe(false);
    expect(canTryPlaceAgain({ status: "posted" }, { ...failed, status: "posted" })).toBe(false);
    // A public TikTok account: he posts it himself (§42), Try again would fail again.
    expect(canTryPlaceAgain({ status: "posted" }, { platform: "tiktok", status: "failed", error: TIKTOK_PRIVATE_ONLY })).toBe(false);
  });
});

// ---------- The mock's rules (§46.4–§46.9) ----------

type SendCall = { clipId: string; places: Platform[]; options: ClipPostOptions; auto: NonNullable<Clip["auto"]> };

function world(
  opts: {
    ready?: Platform[];
    clips?: Partial<Clip>[];
    jobs?: Partial<Job>[];
    /** Runs once, at the first send (a decision made while a run sends). */
    during?: (clips: Clip[]) => void;
    /** Upload refuses these clips with their sentence (the campaign way, §46.7 step 4). */
    refuse?: Record<string, string>;
    /** Campaign clips are taken (Content Rewards can take them by itself), going to these places. */
    campaignTakes?: Platform[];
    /** Each send waits for this first (a run that is still going). */
    gate?: Promise<void>;
  } = {},
) {
  const now = new Date().toISOString();
  const jobs = (opts.jobs ?? [{ jobId: "J1", status: "ready", createdAt: "2026-11-01T00:00:00.000Z" }]) as Job[];
  const clips = (opts.clips ?? [{ clipId: "C1", jobId: "J1", rank: 1, hook: "one" }]).map(
    (c) => ({ status: "review", createdAt: now, checklist: { items: [], fixes: [] }, captions: {}, ...c }) as Clip,
  );
  const posts: Post[] = [];
  const settings = { platforms: [], youtubePrivacy: "public", autoPost: { on: false, everyHours: 5, perRun: 1, practice: false } } as unknown as Settings;
  const sent: SendCall[] = [];
  const deps: AutoPostDeps = {
    clips: () => clips,
    jobs: () => jobs,
    posts: () => posts,
    settings: () => settings,
    ready: () => opts.ready ?? ["youtube", "tiktok", "instagram", "facebook"],
    campaign: () => (opts.campaignTakes ? { wait: null, places: opts.campaignTakes } : { wait: CR_CANT_TAKE, places: [] }),
    async send(c, places, options, auto) {
      await opts.gate;
      const during = opts.during;
      opts.during = undefined;
      during?.(clips);
      const refusal = opts.refuse?.[c.clipId];
      if (refusal) throw new ApiError(409, "conflict", refusal);
      sent.push({ clipId: c.clipId, places, options, auto });
      c.status = "confirmed";
      c.auto = auto;
      for (const platform of places) posts.push({ postId: `${c.clipId}-${platform}`, clipId: c.clipId, platform, status: "queued", auto: true, ...(auto.test ? { test: auto.test } : {}) });
    },
  };
  const m = autoPostMock(deps);
  const turnOn = (patch: Partial<Settings["autoPost"]> = {}) => {
    settings.autoPost = m.merge(settings.autoPost, { on: true, ...patch });
  };
  return { m, clips, posts, settings, sent, turnOn };
}

describe("the mock's schedule (§46.4)", () => {
  beforeEach(() => sessionStorage.clear());

  it("off: no next run, no run; on: the next full hour, then exactly everyHours apart, across midnight", async () => {
    const w = world({ clips: Array.from({ length: 12 }, (_, i) => ({ clipId: `C${String(i).padStart(2, "0")}`, jobId: "J1", rank: i + 1, hook: `h${i}` })) });
    w.m.controls.set("2026-11-22T20:20:00.000Z");
    expect((await w.m.status()).nextRunAt).toBeNull();
    expect(await w.m.controls.advance(3 * HOUR)).toEqual(["off", "off", "off"]);
    w.turnOn();
    expect(w.settings.autoPost!.onAt).toMatch(/^2026-11-22T23:20:00\./);
    expect((await w.m.status()).nextRunAt).toBe("2026-11-23T00:00:00.000Z");
    const ran = (await w.m.controls.advance(11 * HOUR)).filter((r) => r.includes("#"));
    expect(ran).toEqual(["2026-11-23T00:00:00.000Z#scheduled", "2026-11-23T05:00:00.000Z#scheduled", "2026-11-23T10:00:00.000Z#scheduled"]);
    expect(w.sent.map((s) => s.clipId)).toEqual(["C00", "C01", "C02"]);
    expect((await w.m.status()).nextRunAt).toBe("2026-11-23T15:00:00.000Z");
  });

  it("a changed everyHours counts from the last run; one already past runs at the next full hour", async () => {
    const w = world();
    w.m.controls.set("2026-11-22T09:30:00.000Z");
    w.turnOn({ everyHours: 10 });
    await w.m.controls.advance(HOUR); // 10:00 runs
    expect((await w.m.status()).nextRunAt).toBe("2026-11-22T20:00:00.000Z");
    w.settings.autoPost = w.m.merge(w.settings.autoPost, { everyHours: 2 });
    expect((await w.m.status()).nextRunAt).toBe("2026-11-22T12:00:00.000Z");
    w.m.controls.set("2026-11-22T13:10:00.000Z");
    // 12:00 is past and no tick ran: shown as the next full hour.
    expect((await w.m.status()).nextRunAt).toBe("2026-11-22T14:00:00.000Z");
  });

  it("the same slot twice runs once; a lost tick is caught up once; off and not due run nothing", async () => {
    const w = world({ clips: [{ clipId: "A", jobId: "J1", rank: 1, hook: "a" }, { clipId: "B", jobId: "J1", rank: 2, hook: "b" }] });
    w.m.controls.set("2026-11-22T10:20:00.000Z");
    w.turnOn();
    expect(await w.m.controls.tick("2026-11-22T10:59:00.000Z")).toBe("not_due");
    expect(await w.m.controls.tick("2026-11-22T11:00:00.000Z")).toBe("2026-11-22T11:00:00.000Z#scheduled");
    // A retry of the same delivery (a late one inside its hour too) resumes it: never a second run.
    expect(await w.m.controls.tick("2026-11-22T11:40:00.000Z")).toBe("done");
    expect(await w.m.controls.tick("2026-11-22T12:00:00.000Z")).toBe("not_due");
    expect(w.sent).toHaveLength(1);
    expect(w.m.controls.runs()).toHaveLength(1);
    // The ticks of 13:00 to 17:00 are lost: the next status read runs one, once.
    w.m.controls.skip(7 * HOUR + 10 * 60_000);
    await w.m.status();
    await w.m.status();
    expect(w.sent.map((s) => s.clipId)).toEqual(["A", "B"]);
    w.settings.autoPost = w.m.merge(w.settings.autoPost, { on: false });
    expect(await w.m.controls.tick("2026-11-23T03:00:00.000Z")).toBe("off");
  });
});

describe("the mock's pick and runs (§46.5–§46.8)", () => {
  beforeEach(() => sessionStorage.clear());

  it("oldest first by job, then rank; each waiting rule with its sentence; perRun at a time", async () => {
    const w = world({
      jobs: [
        { jobId: "OLD", status: "ready", createdAt: "2026-11-01T00:00:00.000Z" },
        { jobId: "NEW", status: "ready", createdAt: "2026-11-10T00:00:00.000Z" },
        { jobId: "RUN", status: "running", createdAt: "2026-10-01T00:00:00.000Z" },
      ],
      clips: [
        { clipId: "N1", jobId: "NEW", rank: 1, hook: "n1" },
        { clipId: "O2", jobId: "OLD", rank: 2, hook: "o2" },
        { clipId: "O1", jobId: "OLD", rank: 1, hook: "o1" },
        { clipId: "R1", jobId: "RUN", rank: 1, hook: "r1" },
        { clipId: "V1", jobId: "OLD", rank: 3, hook: "v1" },
        { clipId: "K1", jobId: "OLD", rank: 4, hook: "k1", checklist: { items: [{ key: "payoff", label: "It pays off", pass: false }], fixes: [] } },
        { clipId: "M1", jobId: "OLD", rank: 5, hook: "m1", checklist: { items: [{ key: "loop", label: "Loops", pass: false }], fixes: [] } },
        { clipId: "C1", jobId: "OLD", rank: 6, hook: "c1", campaignId: "camp" },
        { clipId: "D1", jobId: "OLD", rank: 7, hook: "d1", status: "declined" },
        { clipId: "G1", jobId: "GONE", rank: 1, hook: "g1", createdAt: "2026-10-15T00:00:00.000Z" },
      ],
    });
    w.m.controls.loseVideo("V1");
    w.m.controls.set("2026-11-22T10:20:00.000Z");
    w.turnOn({ perRun: 2 });
    const s = await w.m.status();
    expect(s.nextUp.map((c) => c.clipId)).toEqual(["G1", "O1", "O2", "M1", "N1"]);
    expect(s.nextUp.map((c) => c.runAt)).toEqual([
      "2026-11-22T11:00:00.000Z",
      "2026-11-22T11:00:00.000Z",
      "2026-11-22T16:00:00.000Z",
      "2026-11-22T16:00:00.000Z",
      "2026-11-22T21:00:00.000Z",
    ]);
    expect(s.waiting.map((c) => [c.clipId, c.reason])).toEqual([
      ["R1", STILL_BEING_MADE],
      ["V1", VIDEO_MISSING],
      ["K1", "A check didn't pass: It pays off."],
      ["C1", CR_CANT_TAKE],
    ]);
    expect(s.places).toEqual(["youtube", "instagram", "facebook"]);
    expect(s.leftOut).toEqual([
      { platform: "tiktok", reason: "tiktok_yourself" },
      { platform: "x", reason: "not_set_up" },
    ]);
    expect(s.perDay).toBeCloseTo(9.6);
    await w.m.controls.advance(HOUR);
    expect(w.sent.map((x) => [x.clipId, x.places])).toEqual([
      ["G1", ["youtube", "instagram", "facebook"]],
      ["O1", ["youtube", "instagram", "facebook"]],
    ]);
    // My settings, never made for kids; no TikTok options ever.
    expect(w.sent[0]!.options.youtube).toMatchObject({ privacy: "public", madeForKids: false });
    expect(Object.keys(w.sent[0]!.options).sort()).toEqual(["instagram", "youtube"]);
    // Off: no runAt.
    w.settings.autoPost = w.m.merge(w.settings.autoPost, { on: false });
    expect((await w.m.status()).nextUp.every((c) => c.runAt === undefined)).toBe(true);
  });

  it("notes: nothing in Review, every clip waiting, nothing set up; lastRunAt moves anyway", async () => {
    const empty = world({ clips: [] });
    empty.m.controls.set("2026-11-22T10:20:00.000Z");
    empty.turnOn();
    await empty.m.controls.advance(HOUR);
    expect(empty.m.controls.runs()[0]).toMatchObject({ note: NOTE_NOTHING, clips: [], state: "done" });
    expect((await empty.m.status()).nextRunAt).toBe("2026-11-22T16:00:00.000Z");

    const waiting = world({ clips: [{ clipId: "C", jobId: "J1", rank: 1, hook: "c", campaignId: "x" }] });
    waiting.m.controls.set("2026-11-22T10:20:00.000Z");
    waiting.turnOn();
    await waiting.m.controls.advance(HOUR);
    expect(waiting.m.controls.runs()[0]!.note).toBe(NOTE_ALL_WAITING);

    const nowhere = world({ ready: ["tiktok"] });
    nowhere.m.controls.set("2026-11-22T10:20:00.000Z");
    nowhere.turnOn();
    expect((await nowhere.m.status()).places).toEqual([]);
    await nowhere.m.controls.advance(HOUR);
    expect(nowhere.m.controls.runs()[0]!.note).toBe(NOTE_NO_PLACES);
    expect(nowhere.sent).toEqual([]);
  });

  it("notes follow the server's order (autopost/run.py _plan), and a Private test never takes a campaign clip", async () => {
    // Nothing set up and every clip waiting: the server says nothing is set up first.
    const both = world({ ready: [], clips: [{ clipId: "C", jobId: "J1", rank: 1, hook: "c", campaignId: "x" }] });
    both.m.controls.set("2026-11-22T10:20:00.000Z");
    both.turnOn();
    await both.m.controls.advance(HOUR);
    expect(both.m.controls.runs()[0]!.note).toBe(NOTE_NO_PLACES);

    // A Private test with nothing set up and nothing in Review: nothing to test with.
    const bare = world({ ready: [], clips: [] });
    bare.m.controls.set("2026-11-22T10:20:00.000Z");
    expect(await bare.m.runNow("private")).toMatchObject({ note: NOTE_NOTHING_TO_TEST, clips: [] });

    // A campaign clip that could go first: a scheduled run takes it, a Private test skips to the normal clip.
    const clips = [
      { clipId: "A", jobId: "J1", rank: 1, hook: "a", campaignId: "camp" },
      { clipId: "B", jobId: "J1", rank: 2, hook: "b" },
    ];
    const test = world({ ready: ["youtube", "instagram", "facebook"], clips, campaignTakes: ["youtube"] });
    test.m.controls.set("2026-11-22T10:20:00.000Z");
    const run = await test.m.runNow("private");
    expect(run.clips.map((c) => c.clipId)).toEqual(["B"]);
    expect(test.sent.map((x) => x.clipId)).toEqual(["B"]);

    const live = world({ ready: ["youtube", "instagram", "facebook"], clips, campaignTakes: ["youtube"] });
    live.m.controls.set("2026-11-22T10:20:00.000Z");
    live.turnOn();
    await live.m.controls.advance(HOUR);
    expect(live.m.controls.runs()[0]!.clips.map((c) => [c.clipId, c.places])).toEqual([["A", ["youtube"]]]);

    // Only campaign clips in Review: a Private test has nothing to test with.
    const onlyCampaign = world({ ready: ["youtube"], clips: [clips[0]!], campaignTakes: ["youtube"] });
    onlyCampaign.m.controls.set("2026-11-22T10:20:00.000Z");
    expect(await onlyCampaign.m.runNow("private")).toMatchObject({ note: NOTE_NOTHING_TO_TEST, clips: [] });
  });

  it("practice picks on time and sends nothing; the clips stay in Review", async () => {
    const w = world();
    w.m.controls.set("2026-11-22T10:20:00.000Z");
    w.turnOn({ practice: true });
    await w.m.controls.advance(HOUR);
    const [run] = w.m.controls.runs();
    expect(run).toMatchObject({ mode: "practice", kind: "scheduled", clips: [{ clipId: "C1", outcome: "would_send", posts: [] }] });
    expect(w.sent).toEqual([]);
    expect(w.clips[0]!.status).toBe("review");
  });

  it("a clip decided while the run sends is skipped with its sentence; the other clips still go", async () => {
    const w = world({
      clips: ["A", "B", "C", "D"].map((id, i) => ({ clipId: id, jobId: "J1", rank: i + 1, hook: id.toLowerCase() })),
      during: (clips) => {
        clips.find((c) => c.clipId === "B")!.status = "declined";
        clips.find((c) => c.clipId === "C")!.status = "confirmed";
      },
      refuse: { D: "Not yet for FaZe Clips: the logo is missing." },
    });
    w.m.controls.set("2026-11-22T10:20:00.000Z");
    w.turnOn({ perRun: 4 });
    await w.m.controls.advance(HOUR);
    const [run] = w.m.controls.runs();
    expect(run!.clips.map((c) => [c.clipId, c.outcome, c.reason])).toEqual([
      ["A", "sent", undefined],
      ["B", "skipped", THREW_AWAY],
      ["C", "skipped", UPLOADED_YOURSELF],
      ["D", "skipped", "Not yet for FaZe Clips: the logo is missing."],
    ]);
    expect(w.sent.map((x) => x.clipId)).toEqual(["A"]);
    expect(run!.clips[0]!.posts.map((p) => [p.platform, p.status])).toEqual([
      ["youtube", "queued"],
      ["instagram", "queued"],
      ["facebook", "queued"],
    ]);
    expect(runLines(run!).map((l) => l.text)).toEqual([
      "Sun 11:00 · “a”: YouTube … Instagram … Facebook …".replace("Sun 11:00", timeWords(Date.UTC(2026, 10, 22, 11))),
      `${timeWords(Date.UTC(2026, 10, 22, 11))} · “b”: You threw it away first.`,
      `${timeWords(Date.UTC(2026, 10, 22, 11))} · “c”: You uploaded it yourself.`,
      `${timeWords(Date.UTC(2026, 10, 22, 11))} · “d”: Not yet for FaZe Clips: the logo is missing.`,
    ]);
  });

  it("run-now: practice or private only, once a minute, whatever the switch; private posts one clip, never to X", async () => {
    const w = world({ ready: ["youtube", "instagram", "facebook", "x"], clips: [{ clipId: "A", jobId: "J1", rank: 1, hook: "a" }, { clipId: "B", jobId: "J1", rank: 2, hook: "b" }] });
    w.m.controls.set("2026-11-22T10:20:00.000Z");
    await expect(w.m.runNow("live")).rejects.toMatchObject({ status: 400, message: PICK_KIND });
    const practice = await w.m.runNow("practice");
    expect(practice).toMatchObject({ kind: "practice_now", mode: "practice", runId: "2026-11-22T10:20:00.000Z#practice_now", clips: [{ clipId: "A", outcome: "would_send" }] });
    await expect(w.m.runNow("private")).rejects.toMatchObject({ status: 409, message: WAIT_A_MINUTE });
    await w.m.controls.advance(61_000);
    const test = await w.m.runNow("private");
    expect(test).toMatchObject({ kind: "private_now", mode: "private", clips: [{ clipId: "A", outcome: "sent", places: ["youtube", "instagram", "facebook"] }] });
    expect(w.sent).toEqual([{ clipId: "A", places: ["youtube", "instagram", "facebook"], options: expect.any(Object), auto: { runId: test.runId, at: test.at, test: "private" } }]);
    // Run-now never moves the schedule (still off here).
    expect((await w.m.status()).nextRunAt).toBeNull();
    // Nothing left to test with.
    const none = world({ clips: [] });
    none.m.controls.set("2026-11-22T10:20:00.000Z");
    expect(await none.m.runNow("private")).toMatchObject({ note: NOTE_NOTHING_TO_TEST, clips: [] });
  });

  it("settings: each key merged, unknown keys and onAt refused, ranges checked, onAt kept while on", () => {
    const w = world();
    w.m.controls.set("2026-11-22T10:20:00.000Z");
    const bad = (raw: unknown, message: string) => {
      try {
        w.m.merge(undefined, raw);
        throw new Error("accepted");
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError);
        expect((e as ApiError).status).toBe(400);
        expect((e as ApiError).message).toBe(message);
      }
    };
    bad({ onAt: "x" }, UNKNOWN_SETTING);
    bad({ often: 3 }, UNKNOWN_SETTING);
    bad([], NOT_AN_OBJECT);
    bad("on", NOT_AN_OBJECT);
    bad({ everyHours: 0 }, PICK_HOURS);
    bad({ everyHours: 25 }, PICK_HOURS);
    bad({ everyHours: 2.5 }, PICK_HOURS);
    bad({ perRun: 6 }, PICK_CLIPS);
    bad({ perRun: 0 }, PICK_CLIPS);
    expect(w.m.merge(undefined, { perRun: 3 })).toEqual({ on: false, everyHours: 5, perRun: 3, practice: false });
    const on = w.m.merge(undefined, { on: true });
    expect(on.onAt).toMatch(/^2026-11-22T10:20:00\./);
    w.m.controls.set("2026-11-22T12:00:00.000Z");
    expect(w.m.merge(on, { on: true, everyHours: 3 }).onAt).toBe(on.onAt);
    const off = w.m.merge(on, { on: false });
    expect(w.m.merge(off, { on: true }).onAt).toMatch(/^2026-11-22T12:00:00\./);
  });
});

describe("the mock's holds and the server's latest rules (§46.4, §46.5, §46.13)", () => {
  beforeEach(() => sessionStorage.clear());
  const three = () => world({ clips: ["A", "B", "C"].map((id, i) => ({ clipId: id, jobId: "J1", rank: i + 1, hook: id.toLowerCase() })) });

  it("Throw away's hold: the pick skips the clip silently for 60 s, Undo lets it go again", async () => {
    const w = three();
    w.m.controls.set("2026-11-22T10:59:50.000Z");
    w.turnOn();
    w.m.hold("A");
    expect(w.m.controls.held()).toEqual(["A"]);
    const s = await w.m.status();
    // Neither in line nor waiting: it is on its way out (or back, if he taps Undo).
    expect(s.nextUp.map((c) => c.clipId)).toEqual(["B", "C"]);
    expect(s.waiting).toEqual([]);
    // The 11:00 tick inside the Undo window takes the next clip.
    expect(await w.m.controls.advance(15_000)).toEqual(["2026-11-22T11:00:00.000Z#scheduled"]);
    expect(w.sent.map((x) => x.clipId)).toEqual(["B"]);
    // Undo: back in line, first again.
    w.m.unhold("A");
    expect(w.m.controls.held()).toEqual([]);
    expect((await w.m.status()).nextUp.map((c) => c.clipId)).toEqual(["A", "C"]);
    // A hold ends by itself after 60 s.
    w.m.hold("A");
    w.m.controls.skip(HOLD_MS - 1000);
    expect((await w.m.status()).nextUp.map((c) => c.clipId)).toEqual(["C"]);
    w.m.controls.skip(1000);
    expect(w.m.controls.held()).toEqual([]);
    expect((await w.m.status()).nextUp.map((c) => c.clipId)).toEqual(["A", "C"]);
  });

  it("a run's send refuses a clip held after it planned: You threw it away first; the others still go", async () => {
    const w = world({
      clips: ["A", "B", "C"].map((id, i) => ({ clipId: id, jobId: "J1", rank: i + 1, hook: id.toLowerCase() })),
      during: () => w.m.hold("B"),
    });
    w.m.controls.set("2026-11-22T10:20:00.000Z");
    w.turnOn({ perRun: 3 });
    await w.m.controls.advance(HOUR);
    expect(w.m.controls.runs()[0]!.clips.map((c) => [c.clipId, c.outcome, c.reason])).toEqual([
      ["A", "sent", undefined],
      ["B", "skipped", THREW_AWAY],
      ["C", "sent", undefined],
    ]);
    expect(w.sent.map((x) => x.clipId)).toEqual(["A", "C"]);
    // Still in Review: Undo (or the decline) decides it.
    expect(w.clips.find((c) => c.clipId === "B")!.status).toBe("review");
  });

  it("practising, only the first perRun rows get a time; with nowhere to post, none does", async () => {
    const five = world({ clips: ["A", "B", "C", "D", "E"].map((id, i) => ({ clipId: id, jobId: "J1", rank: i + 1, hook: id })) });
    five.m.controls.set("2026-11-22T10:20:00.000Z");
    five.turnOn({ perRun: 2, practice: true });
    expect((await five.m.status()).nextUp.map((c) => c.runAt)).toEqual(["2026-11-22T11:00:00.000Z", "2026-11-22T11:00:00.000Z", undefined, undefined, undefined]);
    five.settings.autoPost = five.m.merge(five.settings.autoPost, { practice: false });
    expect((await five.m.status()).nextUp.map((c) => c.runAt)).toEqual([
      "2026-11-22T11:00:00.000Z",
      "2026-11-22T11:00:00.000Z",
      "2026-11-22T16:00:00.000Z",
      "2026-11-22T16:00:00.000Z",
      "2026-11-22T21:00:00.000Z",
    ]);

    const nowhere = world({ ready: ["tiktok"] });
    nowhere.m.controls.set("2026-11-22T10:20:00.000Z");
    nowhere.turnOn();
    const s = await nowhere.m.status();
    expect(s.places).toEqual([]);
    expect(s.nextUp.map((c) => [c.clipId, c.runAt])).toEqual([["C1", undefined]]);
    // The Review card says so instead of a time.
    expect(reviewLine(s.autoPost, s.nextUp[0], undefined, s.places)).toBe(NOWHERE_TO_POST);
  });

  it("the shown next run: this hour while its own tick may still come, then the next full hour", () => {
    const at = (h: number, m = 0) => Date.UTC(2026, 10, 22, h, m);
    // Still ahead: as it is.
    expect(shownNextRun(at(15), at(10), at(13, 10))).toBe(at(15));
    // Due by now and this hour's tick has not come: this hour, until EventBridge stops trying (3300 s).
    expect(shownNextRun(at(12), at(10), at(13, 10))).toBe(at(13));
    expect(shownNextRun(at(13), at(10), at(13))).toBe(at(13));
    expect(shownNextRun(at(12), at(10), at(13) + TICK_MAX_AGE_MS - 1)).toBe(at(13));
    expect(shownNextRun(at(12), at(10), at(13) + TICK_MAX_AGE_MS)).toBe(at(14));
    // This hour's tick came (it ran, or it was not due): the next full hour.
    expect(shownNextRun(at(12), at(13), at(13, 10))).toBe(at(14));
  });

  it("a tick that was not due is remembered (lastTickAt), so a shorter everyHours never shows an hour already gone", async () => {
    const w = world();
    w.m.controls.set("2026-11-22T09:30:00.000Z");
    w.turnOn({ everyHours: 10 });
    expect(await w.m.controls.advance(HOUR)).toEqual(["2026-11-22T10:00:00.000Z#scheduled"]);
    // 11:00, 12:00 and 13:00 come and are not due.
    expect(await w.m.controls.advance(3 * HOUR)).toEqual(["not_due", "not_due", "not_due"]);
    // Every 2 hours from the 10:00 run: 12:00 is past, and 13:00's tick already came, so the next one is 14:00.
    w.settings.autoPost = w.m.merge(w.settings.autoPost, { everyHours: 2 });
    expect((await w.m.status()).nextRunAt).toBe("2026-11-22T14:00:00.000Z");
    expect(await w.m.controls.advance(30 * 60_000)).toEqual(["2026-11-22T14:00:00.000Z#scheduled"]);
  });

  it("a run still going keeps its clips out of Next up for 15 minutes from when it planned, not from its slot", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = world({ clips: ["A", "B"].map((id, i) => ({ clipId: id, jobId: "J1", rank: i + 1, hook: id })), gate });
    w.m.controls.set("2026-11-22T11:20:00.000Z");
    w.turnOn();
    // A late delivery of 11:00's tick (its slot), planning at 11:20 and still sending.
    w.settings.autoPost = { ...w.settings.autoPost!, onAt: "2026-11-22T10:20:00.000Z" };
    const going = w.m.controls.tick("2026-11-22T11:00:00.000Z");
    await Promise.resolve();
    expect(w.m.controls.runs()[0]).toMatchObject({ runId: "2026-11-22T11:00:00.000Z#scheduled", state: "planned", clips: [{ clipId: "A" }] });
    // 25 minutes after its slot, 5 after it planned: A is still the run's.
    w.m.controls.skip(5 * 60_000);
    let s = await w.m.status();
    expect(s.nextUp.map((c) => c.clipId)).toEqual(["B"]);
    expect(s.waiting).toEqual([]);
    // Planned more than 15 minutes ago and still not done: it stopped, and A is in line again.
    w.m.controls.skip(PLANNED_FRESH_MS - 5 * 60_000 + 1000);
    s = await w.m.status();
    expect(s.nextUp.map((c) => c.clipId)).toEqual(["A", "B"]);
    release();
    await going;
    // plannedAt is the mock's own: never part of a run the page reads.
    expect(Object.keys(w.m.controls.runs()[0]!)).not.toContain("plannedAt");
    expect(Object.keys((await w.m.status()).runs[0]!)).not.toContain("plannedAt");
  });
});

describe("the mock api (wired like the other mock modules)", () => {
  beforeEach(() => sessionStorage.clear());

  it("starts off, refuses a bad save, and sends through Upload's own code with the run's marks", async () => {
    const a = mockApi(seed(), { keepStopsAfterSave: 0, resumeAfterMs: 60_000 });
    const s = await a.getSettings();
    expect(s.autoPost).toEqual({ on: false, everyHours: 5, perRun: 1, practice: false });
    await expect(a.putSettings({ autoPost: { everyHours: 30 } })).rejects.toMatchObject({ status: 400, message: PICK_HOURS });
    // One key at a time, merged over the stored value: a frequency change never sends (or changes) the switch.
    await a.putSettings({ autoPost: { on: true } });
    expect((await a.putSettings({ autoPost: { perRun: 3 } })).autoPost).toMatchObject({ on: true, everyHours: 5, perRun: 3, practice: false });
    expect((await a.putSettings({ autoPost: { on: false } })).autoPost).toMatchObject({ on: false, perRun: 3 });
    expect((await a.putSettings({ autoPost: { everyHours: 2 } })).autoPost).toMatchObject({ on: false, everyHours: 2, perRun: 3 });
    const status = await a.autoPostStatus();
    expect(status.nextRunAt).toBeNull();
    // Nothing is set up in a fresh mock: the places are empty and every place is left out.
    expect(status.places).toEqual([]);
    expect(status.leftOut.map((l) => l.platform)).toEqual(["youtube", "tiktok", "instagram", "facebook", "x"]);
    const review = (await a.listClips({ status: "review" })).length;
    expect(status.nextUp.length).toBe(Math.min(10, review));
    // A Private test with nothing set up sends nothing.
    const run = await a.autoPostRun("private");
    expect(run.note).toBe(NOTE_NO_PLACES);
  });

  it("hold: a clip in Review only; one auto-posting already sent says so; Undo's DELETE always answers", async () => {
    const a = mockApi(seed(), { keepStopsAfterSave: 0, resumeAfterMs: 60_000 });
    const [first, second] = await a.listClips({ status: "review" });
    expect((await a.holdClip(first!.clipId)).clipId).toBe(first!.clipId);
    await expect(a.unholdClip(first!.clipId)).resolves.toBeUndefined();
    await a.declineClip(second!.clipId);
    await expect(a.holdClip(second!.clipId)).rejects.toMatchObject({ status: 409, message: "This clip has already been confirmed or declined." });
    await expect(a.holdClip("nope")).rejects.toMatchObject({ status: 404 });
    // Sent by a run first (a Private test here, the one run that needs no switch).
    for (const p of ["youtube", "instagram", "facebook"] as const) (window as unknown as { __cfMock: { setup: { finish(p: string): void } } }).__cfMock.setup.finish(p);
    const test = await a.autoPostRun("private");
    const sent = test.clips[0]!.clipId;
    await expect(a.holdClip(sent)).rejects.toMatchObject({ status: 409, message: AUTO_ALREADY_SENT });
  });
});
