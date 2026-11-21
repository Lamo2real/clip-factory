// Auto-posting's words and the mock's rules (docs/CONTRACTS.md §46.2–§46.9, §46.15): the result line for every pair
// 1..5 × 1..24, the warnings, the time words, the places, the Recent lines, Review's and Home's lines, the post words,
// and the mock's schedule, pick, runs and run-now limits on a fake clock.
import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { autoPostMock, CR_CANT_TAKE, NOTE_ALL_WAITING, NOTE_NO_PLACES, NOTE_NOTHING, NOTE_NOTHING_TO_TEST, PICK_CLIPS, PICK_HOURS, PICK_KIND, STILL_BEING_MADE, THREW_AWAY, UNKNOWN_SETTING, UPLOADED_YOURSELF, VIDEO_MISSING, WAIT_A_MINUTE, type AutoPostDeps } from "../src/api/mock/autopost.ts";
import { mockApi } from "../src/api/mock/index.ts";
import { seed } from "../src/api/mock/fixtures.ts";
import type { AutoRun, Clip, ClipPostOptions, Job, Platform, Post, Settings } from "../src/api/types.ts";
import {
  AUTO_POST_DEFAULTS,
  autoPerfLabel,
  autoPostLabel,
  autoPostOf,
  dayWarnings,
  EVERY_HOURS,
  floorHour,
  HOME_HINT,
  homeHint,
  isPrivateTest,
  leftOutLine,
  MORE_THAN_FIVE,
  NEXT_EMPTY,
  nextFullHour,
  OFF_LINE,
  PER_RUN,
  perDay,
  placesLine,
  resultLine,
  reviewLine,
  runLines,
  switchLine,
  timeWords,
  YOUTUBE_LIMIT,
} from "../src/lib/autopost.ts";

const HOUR = 3_600_000;
/** A local time, so the words read the same in any time zone (the owner's own, §46.2). */
const local = (h: number, m = 0, day = 22) => new Date(2026, 10, day, h, m).getTime();

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
    expect(timeWords(local(15))).toBe("Sun 15:00");
    expect(timeWords(new Date(local(5, 7)).toISOString())).toBe("Sun 05:07");
    expect(timeWords(local(0, 0, 23))).toBe("Mon 00:00");
    expect(timeWords(local(23, 59, 28))).toBe("Sat 23:59");
    const week = Array.from({ length: 7 }, (_, i) => timeWords(local(12, 0, 22 + i)).slice(0, 3));
    expect(week).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    for (let i = 0; i < 48; i++) expect(timeWords(Date.now() + i * HOUR)).not.toMatch(/today|tomorrow/i);
    expect(timeWords("not a time")).toBe("");
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
    expect(switchLine({ on: true, practice: false }, new Date(local(15)).toISOString())).toBe("On. Next: Sun 15:00.");
    expect(switchLine({ on: true, practice: true }, new Date(local(15)).toISOString())).toBe("On, practising. Next practice: Sun 15:00. Nothing gets sent.");
    // The status not read yet: the next full hour.
    expect(switchLine({ on: true, practice: false }, null, local(14, 20))).toBe("On. Next: Sun 15:00.");
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
    );
    expect(lines.map((l) => l.text)).toEqual(["Sun 10:00 · “hook”: YouTube ✓ Instagram ✓ Facebook ✗"]);
    expect(lines[0]!.opens).toEqual([
      { platform: "youtube", url: "https://y/1" },
      { platform: "instagram", url: "https://i/1" },
    ]);
  });
  it("nothing, practice, a skipped clip and the Private test", () => {
    const five = new Date(local(5)).toISOString();
    expect(runLines(run({ at: five, note: "Nothing in Review, so nothing posted." }))[0]!.text).toBe("Sun 05:00 · Nothing in Review, so nothing posted.");
    expect(
      runLines(run({ at: five, mode: "practice", clips: [{ clipId: "c", hook: "hook", places: ["facebook", "youtube", "instagram"], outcome: "would_send", posts: [] }] }))[0]!
        .text,
    ).toBe("Sun 05:00 · Practice: would post “hook” to YouTube, Instagram and Facebook.");
    expect(runLines(run({ clips: [{ clipId: "c", hook: "hook", places: ["youtube"], outcome: "skipped", reason: THREW_AWAY, posts: [] }] }))[0]!.text).toBe(
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
    expect(test[0]!.text).toBe("Private test · “hook”: YouTube (only you) · Instagram (checked, not published) · Facebook (draft)");
    expect(test[0]!.opens).toEqual([{ platform: "youtube", url: "https://y/2" }]);
    expect(runLines(run({ kind: "private_now", mode: "private", note: NOTE_NOTHING_TO_TEST }))[0]!.text).toBe("Private test · Nothing in Review to test with.");
  });
});

describe("Review's line and Home's hint (§46.2)", () => {
  const at = new Date(local(15)).toISOString();
  it("Review: only while on; goes up by itself, practice, or why it waits", () => {
    expect(reviewLine({ on: false, practice: false }, { runAt: at }, undefined)).toBeNull();
    expect(reviewLine({ on: true, practice: false }, { runAt: at }, undefined)).toBe("Goes up by itself Sun 15:00. Throw it away to stop it.");
    expect(reviewLine({ on: true, practice: true }, { runAt: at }, undefined)).toBe("Practice picks it Sun 15:00. Nothing gets sent.");
    expect(reviewLine({ on: true, practice: false }, undefined, { reason: STILL_BEING_MADE })).toBe(
      "Auto-posting skips this one: It is still being made. Upload it yourself.",
    );
    expect(reviewLine({ on: true, practice: false }, undefined, undefined)).toBeNull();
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
    expect(autoPostLabel(p({ auto: true, test: "private", status: "failed" }), "Didn't work")).toBe("Didn't work");
    expect(autoPostLabel(p({ platform: "tiktok", by: "you" }), "Uploaded")).toBe("Uploaded");
  });
  it("the clip page reads the clip's auto; a Private test stack has no numbers", () => {
    expect(autoPerfLabel("posted", "youtube", undefined, undefined, "Uploaded")).toBe("Uploaded");
    expect(autoPerfLabel("posted", "youtube", {}, undefined, "Uploaded")).toBe("Uploaded · by auto-posting");
    expect(autoPerfLabel("posting", "youtube", {}, undefined, "Uploading…")).toBe("Uploading… · by auto-posting");
    expect(autoPerfLabel("not_posted", "tiktok", {}, undefined, "Not posted")).toBe("Not posted");
    expect(autoPerfLabel("posted", "tiktok", {}, "you", "Uploaded")).toBe("Uploaded");
    expect(autoPerfLabel("posted_private", "facebook", { test: "private" }, undefined, "Uploaded privately")).toBe("Private test · draft on your Page");
    expect(isPrivateTest("posted_private", { test: "private" }, undefined)).toBe(true);
    expect(isPrivateTest("posted", {}, undefined)).toBe(false);
    expect(isPrivateTest("failed", { test: "private" }, undefined)).toBe(false);
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
    campaign: () => ({ wait: CR_CANT_TAKE, places: [] }),
    async send(c, places, options, auto) {
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
    expect(ran).toEqual(["2026-11-23T00:00:00Z#scheduled", "2026-11-23T05:00:00Z#scheduled", "2026-11-23T10:00:00Z#scheduled"]);
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
    expect(await w.m.controls.tick("2026-11-22T11:00:00.000Z")).toBe("2026-11-22T11:00:00Z#scheduled");
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
    expect(practice).toMatchObject({ kind: "practice_now", mode: "practice", runId: "2026-11-22T10:20:00Z#practice_now", clips: [{ clipId: "A", outcome: "would_send" }] });
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
    bad([], UNKNOWN_SETTING);
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

describe("the mock api (wired like the other mock modules)", () => {
  beforeEach(() => sessionStorage.clear());

  it("starts off, refuses a bad save, and sends through Upload's own code with the run's marks", async () => {
    const a = mockApi(seed(), { keepStopsAfterSave: 0, resumeAfterMs: 60_000 });
    const s = await a.getSettings();
    expect(s.autoPost).toEqual({ on: false, everyHours: 5, perRun: 1, practice: false });
    await expect(a.putSettings({ autoPost: { everyHours: 30 } as never })).rejects.toMatchObject({ status: 400, message: PICK_HOURS });
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
});
