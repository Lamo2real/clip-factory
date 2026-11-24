import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FIND_FOR_MS,
  LOGIN_CHECK_EVERY_MS,
  applyRequests,
  backlogAt,
  beatTargets,
  claimFields,
  earlierIds,
  loginCheckDue,
  loginHold,
  neverTwice,
  nextAction,
  pickWork,
  pingExtras,
  triedHere,
  wsAction,
  wsPingBody,
} from "../src/plan.js";

const settings = { trialLimit: 3, autoSpacingMinutes: 1, backlogAfterRunMinutes: 30, onDemandSpacingMinutes: 1, paused: false };
const now = new Date("2026-11-22T15:00:00Z");
const device = "mac-1";
const fresh = () => ({ device, ledger: {}, posted: [], lastPressedAt: null });
const job = (over = {}) => ({ clipId: "c1", state: "waiting", source: "auto", since: "2026-11-22T12:00:00Z", ...over });

test("off in Clip Factory: nothing happens", () => {
  assert.equal(nextAction({ on: false, queue: [job()], state: fresh(), settings, device, now }).action, "idle");
});

test("paused on the Mac: nothing happens", () => {
  const r = nextAction({ on: true, queue: [job()], state: fresh(), settings: { ...settings, paused: true }, device, now });
  assert.equal(r.action, "paused");
});

test("an auto-posting run's own clip is posted at once", () => {
  const r = nextAction({ on: true, queue: [job()], state: fresh(), settings, device, now });
  assert.deepEqual([r.action, r.job.clipId], ["post", "c1"]);
});

test("never twice: a pressed job is only looked for, even when the server shows no pressedAt yet", () => {
  const state = fresh();
  state.ledger.c1 = { device, step: "pressing" };
  const r = nextAction({ on: true, queue: [job({ state: "working" }), job({ clipId: "c2" })], state, settings, device, now });
  assert.deepEqual([r.action, r.job.clipId], ["find", "c1"]);
});

test("never twice: a job the server says was pressed is only looked for", () => {
  const state = fresh();
  state.ledger.c1 = { device, step: "finding" };
  const r = nextAction({ on: true, queue: [job({ state: "working", pressedAt: "2026-11-22T14:00:00Z" })], state, settings, device, now });
  assert.equal(r.action, "find");
});

test("a job this Mac claimed but never pressed is done again", () => {
  const state = fresh();
  state.ledger.c1 = { device, step: "uploading" };
  const r = nextAction({ on: true, queue: [job({ state: "working" })], state, settings, device, now });
  assert.equal(r.action, "resume");
});

test("another Mac's working job is left alone", () => {
  const r = nextAction({ on: true, queue: [job({ state: "working" })], state: fresh(), settings, device, now });
  assert.equal(r.action, "idle");
});

test("the trial pauses after 3 posts, even with clips waiting", () => {
  const state = fresh();
  state.posted = [{}, {}, {}];
  const r = nextAction({ on: true, queue: [job()], state, settings, device, now });
  assert.equal(r.action, "paused");
  assert.match(r.reason, /3 trial posts/);
});

test("no trial limit: keeps going", () => {
  const state = fresh();
  state.posted = [{}, {}, {}];
  const r = nextAction({ on: true, queue: [job()], state, settings: { ...settings, trialLimit: null }, device, now });
  assert.equal(r.action, "post");
});

// The owner (22 Nov): TikTok follows auto-posting, and his own Upload goes at once.
const run = (at, next = "2026-11-22T21:00:00Z") => ({ on: true, lastRunAt: at, nextRunAt: next });
const sent = (over = {}) => job({ clipId: "b1", source: "sent", ...over });

test("a clip he uploads goes at once, ahead of everything else", () => {
  const state = fresh();
  state.lastPressedAt = "2026-11-22T14:58:00Z"; // two minutes ago
  const r = nextAction({ on: true, queue: [sent(), job({ clipId: "u1", source: "upload" })], state, settings, device, now, autopost: run("2026-11-22T14:00:00Z") });
  assert.deepEqual([r.action, r.job.clipId], ["post", "u1"]);
});

test("a run's own clips go one right after the other (a minute apart)", () => {
  const state = fresh();
  state.lastPressedAt = "2026-11-22T14:59:40Z";
  const r = nextAction({ on: true, queue: [job({ clipId: "a2" })], state, settings, device, now });
  assert.equal(r.action, "wait");
  assert.equal(r.until, "2026-11-22T15:00:40.000Z");
});

test("a backlog clip waits for an auto-posting run, and goes 30 minutes after it", () => {
  const atRun = nextAction({ on: true, queue: [sent()], state: fresh(), settings, device, now, autopost: run("2026-11-22T14:45:00Z") });
  assert.equal(atRun.action, "wait");
  assert.equal(atRun.until, "2026-11-22T15:15:00.000Z");
  const later = nextAction({ on: true, queue: [sent()], state: fresh(), settings, device, now, autopost: run("2026-11-22T14:00:00Z") });
  assert.deepEqual([later.action, later.job.clipId], ["post", "b1"]);
});

test("only one backlog clip per run: the next waits for the next run", () => {
  const state = fresh();
  state.lastBacklogAt = "2026-11-22T14:31:00Z";
  state.lastPressedAt = state.lastBacklogAt;
  const r = nextAction({ on: true, queue: [sent()], state, settings, device, now, autopost: run("2026-11-22T14:00:00Z", "2026-11-22T20:00:00Z") });
  assert.equal(r.action, "wait");
  assert.equal(r.until, "2026-11-22T20:30:00.000Z");
});

test("with auto-posting off, or its schedule unknown, the backlog waits (nothing drips)", () => {
  for (const autopost of [null, { on: false, lastRunAt: "2026-11-22T14:00:00Z", nextRunAt: null }]) {
    const r = nextAction({ on: true, queue: [sent()], state: fresh(), settings, device, now, autopost });
    assert.equal(r.action, "wait");
  }
});

test("a run's own clip goes before the backlog", () => {
  const r = nextAction({ on: true, queue: [sent(), job({ clipId: "a1" })], state: fresh(), settings, device, now, autopost: run("2026-11-22T14:00:00Z") });
  assert.equal(r.job.clipId, "a1");
});

test("of several clips a run sent, the server's order decides which goes first", () => {
  const r = nextAction({ on: true, queue: [job({ clipId: "a" }), job({ clipId: "b" })], state: fresh(), settings, device, now });
  assert.equal(r.job.clipId, "a");
});

// The owner's one-time backfill (22 Nov): one every 2 hours, never within an hour of a run or an Upload, at most 7
// backfill posts and 11 posts in all in any 24 hours.
const fill = { ...settings, trialLimit: null, backfill: { everyMinutes: 120, quietMinutes: 60, maxPer24h: 7, totalMax24h: 11 } };
const sched = (last, next) => ({ on: true, lastRunAt: last, nextRunAt: next });

test("backfill: two hours after the last backfill post, and not before", () => {
  const state = fresh();
  state.backfillPosts = ["2026-11-22T13:30:00Z"];
  state.lastBacklogAt = "2026-11-22T13:30:00Z";
  const r = nextAction({ on: true, queue: [sent()], state, settings: fill, device, now, autopost: sched("2026-11-22T09:00:00Z", "2026-11-22T21:00:00Z") });
  assert.equal(r.action, "wait");
  assert.equal(r.until, "2026-11-22T15:30:00.000Z");
  state.backfillPosts = ["2026-11-22T12:59:00Z"];
  state.lastBacklogAt = "2026-11-22T12:59:00Z";
  const ok = nextAction({ on: true, queue: [sent()], state, settings: fill, device, now, autopost: sched("2026-11-22T09:00:00Z", "2026-11-22T21:00:00Z") });
  assert.equal(ok.action, "post");
});

test("backfill: never within an hour after a run's post or an Upload, nor an hour before the next run", () => {
  const after = fresh();
  after.lastRunPressAt = "2026-11-22T14:30:00Z";
  const r1 = nextAction({ on: true, queue: [sent()], state: after, settings: fill, device, now, autopost: sched("2026-11-22T09:00:00Z", "2026-11-22T21:00:00Z") });
  assert.deepEqual([r1.action, r1.until], ["wait", "2026-11-22T15:30:00.000Z"]);
  const before = nextAction({ on: true, queue: [sent()], state: fresh(), settings: fill, device, now, autopost: sched("2026-11-22T09:00:00Z", "2026-11-22T15:40:00Z") });
  assert.deepEqual([before.action, before.until], ["wait", "2026-11-22T16:40:00.000Z"]);
});

test("backfill: at most 7 backfill posts in 24 hours", () => {
  const state = fresh();
  state.backfillPosts = ["2026-11-21T16:00:00Z", "2026-11-21T18:00:00Z", "2026-11-21T20:00:00Z", "2026-11-21T22:00:00Z", "2026-11-22T00:00:00Z", "2026-11-22T02:00:00Z", "2026-11-22T04:00:00Z"];
  state.lastBacklogAt = "2026-11-22T04:00:00Z";
  const r = nextAction({ on: true, queue: [sent()], state, settings: fill, device, now, autopost: sched("2026-11-22T03:00:00Z", "2026-11-22T21:00:00Z") });
  assert.deepEqual([r.action, r.until], ["wait", "2026-11-22T16:00:00.000Z"]);
});

test("backfill: at most 11 TikTok posts in all in 24 hours, runs included", () => {
  const state = fresh();
  state.posted = Array.from({ length: 11 }, (_, i) => ({ at: new Date(Date.parse("2026-11-21T16:00:00Z") + i * 3_600_000).toISOString() }));
  const r = nextAction({ on: true, queue: [sent()], state, settings: fill, device, now, autopost: sched("2026-11-22T03:00:00Z", "2026-11-22T21:00:00Z") });
  assert.deepEqual([r.action, r.until], ["wait", "2026-11-22T16:00:00.000Z"]);
});

test("backfill never holds up a run's clip or his Upload", () => {
  const state = fresh();
  state.backfillPosts = ["2026-11-22T14:59:00Z"];
  state.lastPressedAt = "2026-11-22T14:58:00Z";
  for (const source of ["auto", "upload"]) {
    const r = nextAction({ on: true, queue: [sent(), job({ clipId: "x", source })], state, settings: fill, device, now, autopost: sched("2026-11-22T15:00:00Z", "2026-11-22T21:00:00Z") });
    assert.deepEqual([r.action, r.job.clipId], ["post", "x"]);
  }
});

test("auto-posting clips made before the hold time wait; later runs and Uploads post as usual", () => {
  const held = { ...settings, holdAutoBefore: "2026-11-23T02:55:00Z" };
  const early = job({ clipId: "early", since: "2026-11-22T21:40:00Z" });
  const r1 = nextAction({ on: true, queue: [early], state: fresh(), settings: held, device, now });
  assert.equal(r1.action, "wait");
  const later = job({ clipId: "run", since: "2026-11-23T03:00:05Z" });
  assert.equal(nextAction({ on: true, queue: [early, later], state: fresh(), settings: held, device, now }).job.clipId, "run");
  const up = job({ clipId: "up", source: "upload", since: "2026-11-22T21:41:00Z" });
  assert.equal(nextAction({ on: true, queue: [early, up], state: fresh(), settings: held, device, now }).job.clipId, "up");
});

test("his Upload goes before a backlog clip is resumed or looked for (never twice either way)", () => {
  const state = fresh();
  state.ledger.b1 = { device, step: "finding", pressedAt: "2026-11-22T14:50:00Z" };
  state.lastPressedAt = "2026-11-22T14:50:00Z";
  const r = nextAction({ on: true, queue: [sent({ state: "working", pressedAt: "2026-11-22T14:50:00Z" }), job({ clipId: "u1", source: "upload" })], state, settings: fill, device, now });
  assert.deepEqual([r.action, r.job.clipId], ["post", "u1"]);
  // With nothing else waiting, it goes back to looking for its pressed post (never posts it again).
  const alone = nextAction({ on: true, queue: [sent({ state: "working", pressedAt: "2026-11-22T14:50:00Z" })], state, settings: fill, device, now });
  assert.equal(alone.action, "find");
});

test("paced backfill waits when auto-posting's schedule is unknown; the burst doesn't need it", () => {
  const paced = nextAction({ on: true, queue: [sent()], state: fresh(), settings: fill, device, now, autopost: null });
  assert.equal(paced.action, "wait");
  const burst = { ...fill, backfill: { everyMinutes: 1, quietMinutes: 1, maxPer24h: 10000, totalMax24h: 10000, haltOnStop: true } };
  assert.equal(nextAction({ on: true, queue: [sent()], state: fresh(), settings: burst, device, now, autopost: null }).action, "post");
});

// D4: the first backlog clip's time, which the ping reports (backlogAt) and nextAction waits for: one rule.
test("backlogAt: none during a backfill or while auto-posting's schedule is unknown", () => {
  assert.equal(backlogAt({ settings: fill, state: fresh(), autopost: run("2026-11-22T14:00:00Z") }), null);
  assert.equal(backlogAt({ settings, state: fresh(), autopost: null }), null);
});

test("backlogAt: no run yet (or auto-posting off): 30 minutes after the next run, none without a next run", () => {
  assert.equal(backlogAt({ settings, state: fresh(), autopost: { on: true, lastRunAt: null, nextRunAt: "2026-11-22T21:00:00Z" } }), "2026-11-22T21:30:00.000Z");
  assert.equal(backlogAt({ settings, state: fresh(), autopost: { on: false, lastRunAt: "2026-11-22T14:00:00Z", nextRunAt: "2026-11-22T21:00:00Z" } }), "2026-11-22T21:30:00.000Z");
  assert.equal(backlogAt({ settings, state: fresh(), autopost: { on: true, lastRunAt: null, nextRunAt: null } }), null);
  assert.equal(backlogAt({ settings, state: fresh(), autopost: { on: false, lastRunAt: "2026-11-22T14:00:00Z", nextRunAt: null } }), null);
});

test("backlogAt: the last run's slot is used: 30 minutes after the next run, none without a next run", () => {
  const state = fresh();
  state.lastBacklogAt = "2026-11-22T14:31:00Z";
  assert.equal(backlogAt({ settings, state, autopost: run("2026-11-22T14:00:00Z", "2026-11-22T20:00:00Z") }), "2026-11-22T20:30:00.000Z");
  assert.equal(backlogAt({ settings, state, autopost: run("2026-11-22T14:00:00Z", null) }), null);
  // Exactly at the run counts as used too.
  state.lastBacklogAt = "2026-11-22T14:00:00Z";
  assert.equal(backlogAt({ settings, state, autopost: run("2026-11-22T14:00:00Z", "2026-11-22T20:00:00Z") }), "2026-11-22T20:30:00.000Z");
});

test("backlogAt: the last run's slot is unused: 30 minutes after that run, even when that time has passed", () => {
  const state = fresh();
  state.lastBacklogAt = "2026-11-22T08:31:00Z"; // the run before
  assert.equal(backlogAt({ settings, state, autopost: run("2026-11-22T14:45:00Z") }), "2026-11-22T15:15:00.000Z");
  assert.equal(backlogAt({ settings, state: fresh(), autopost: run("2026-11-22T14:00:00Z") }), "2026-11-22T14:30:00.000Z");
});

test("backlogAt follows the backlog setting's minutes (30 when it is not set)", () => {
  const { backlogAfterRunMinutes: _, ...noAfter } = settings;
  assert.equal(backlogAt({ settings: { ...settings, backlogAfterRunMinutes: 45 }, state: fresh(), autopost: run("2026-11-22T14:00:00Z") }), "2026-11-22T14:45:00.000Z");
  assert.equal(backlogAt({ settings: noAfter, state: fresh(), autopost: run("2026-11-22T14:00:00Z") }), "2026-11-22T14:30:00.000Z");
});

test("nextAction's backlog wait ends exactly at backlogAt in every branch; once it has passed, the clip goes", () => {
  const used = fresh();
  used.lastBacklogAt = "2026-11-22T14:31:00Z";
  used.lastPressedAt = used.lastBacklogAt;
  const cases = [
    { state: fresh(), autopost: null },
    { state: fresh(), autopost: { on: false, lastRunAt: "2026-11-22T14:00:00Z", nextRunAt: "2026-11-22T21:00:00Z" } },
    { state: fresh(), autopost: { on: true, lastRunAt: null, nextRunAt: null } },
    { state: used, autopost: run("2026-11-22T14:00:00Z", "2026-11-22T20:00:00Z") },
    { state: used, autopost: run("2026-11-22T14:00:00Z", null) },
    { state: fresh(), autopost: run("2026-11-22T14:45:00Z") },
    { state: fresh(), autopost: run("2026-11-22T14:55:00Z"), settings: { ...settings, backlogAfterRunMinutes: 10 } },
  ];
  for (const c of cases) {
    const s = c.settings || settings;
    const r = nextAction({ on: true, queue: [sent()], state: c.state, settings: s, device, now, autopost: c.autopost });
    assert.equal(r.action, "wait");
    assert.equal(r.until ?? null, backlogAt({ settings: s, state: c.state, autopost: c.autopost }));
  }
  const due = backlogAt({ settings, state: fresh(), autopost: run("2026-11-22T14:00:00Z") });
  assert.ok(Date.parse(due) <= now.getTime());
  assert.equal(nextAction({ on: true, queue: [sent()], state: fresh(), settings, device, now, autopost: run("2026-11-22T14:00:00Z") }).action, "post");
});

// D2: never twice. Post was pressed for a job: it is only ever looked for. Pressed on an earlier try: it goes again
// only when the owner's Try again came after the 30-minute find window.
const pressedBefore = "2026-11-22T13:00:00Z";
const later = (ms) => new Date(Date.parse(pressedBefore) + ms).toISOString();

test("never twice: a waiting job with pressedAt is never posted, and it is reported as skipped", () => {
  const r = nextAction({ on: true, queue: [job({ pressedAt: "2026-11-22T14:00:00Z" }), job({ clipId: "c2" })], state: fresh(), settings, device, now });
  assert.deepEqual([r.action, r.job.clipId], ["post", "c2"]);
  assert.deepEqual(r.skipped, [{ clipId: "c1", why: "pressed" }]);
  const alone = nextAction({ on: true, queue: [job({ source: "upload", pressedAt: "2026-11-22T14:00:00Z" })], state: fresh(), settings, device, now });
  assert.equal(alone.action, "idle");
  assert.deepEqual(alone.skipped, [{ clipId: "c1", why: "pressed" }]);
});

test("never twice: a working job with pressedAt is never resumed, whatever the ledger's step", () => {
  for (const step of ["claimed", "video", "uploading", "settings", "waiting"]) {
    const state = fresh();
    state.ledger.c1 = { device, step };
    const r = nextAction({ on: true, queue: [job({ state: "working", pressedAt: "2026-11-22T14:00:00Z" })], state, settings, device, now });
    assert.equal(r.action, "find", step);
  }
});

test("never twice: pressed on an earlier try and no Try again after the window: skipped, never claimed", () => {
  for (const againAt of [undefined, later(0), later(FIND_FOR_MS - 60_000), later(FIND_FOR_MS - 1)]) {
    for (const source of ["upload", "auto", "sent"]) {
      const j = job({ source, pressedBefore, ...(againAt ? { againAt } : {}) });
      const r = nextAction({ on: true, queue: [j], state: fresh(), settings, device, now, autopost: run("2026-11-22T14:00:00Z") });
      assert.equal(r.action, "idle", `${source} ${againAt}`);
      assert.deepEqual(r.skipped, [{ clipId: "c1", why: "pressed_before" }]);
    }
  }
});

test("never twice: the owner's Try again after the window lets it go again", () => {
  for (const againAt of [later(FIND_FOR_MS), later(2 * FIND_FOR_MS)]) {
    const r = nextAction({ on: true, queue: [job({ pressedBefore, againAt })], state: fresh(), settings, device, now });
    assert.deepEqual([r.action, r.job.clipId], ["post", "c1"]);
    assert.equal(r.skipped, undefined);
  }
});

test("never twice: a claimed job pressed on an earlier try without a late Try again is not resumed either", () => {
  const state = fresh();
  state.ledger.c1 = { device, step: "uploading" };
  const early = nextAction({ on: true, queue: [job({ state: "working", pressedBefore, againAt: later(60_000) })], state, settings, device, now });
  assert.equal(early.action, "idle");
  assert.deepEqual(early.skipped, [{ clipId: "c1", why: "pressed_before" }]);
  const late = nextAction({ on: true, queue: [job({ state: "working", pressedBefore, againAt: later(FIND_FOR_MS) })], state, settings, device, now });
  assert.equal(late.action, "resume");
});

test("never twice: his Upload ahead of a busy backlog clip still waits for a late Try again", () => {
  const state = fresh();
  state.ledger.b1 = { device, step: "finding", pressedAt: "2026-11-22T14:50:00Z" };
  const queue = [sent({ state: "working", pressedAt: "2026-11-22T14:50:00Z" }), job({ clipId: "u1", source: "upload", pressedBefore, againAt: later(60_000) })];
  const r = nextAction({ on: true, queue, state, settings, device, now });
  assert.deepEqual([r.action, r.job.clipId], ["find", "b1"]);
  assert.deepEqual(r.skipped, [{ clipId: "u1", why: "pressed_before" }]);
});

test("neverTwice: the reasons, and an unreadable time never lets it go", () => {
  assert.equal(neverTwice(job()), null);
  assert.equal(neverTwice(job({ pressedAt: "2026-11-22T14:00:00Z", pressedBefore, againAt: later(FIND_FOR_MS) })), "pressed");
  assert.equal(neverTwice(job({ pressedBefore, againAt: "soon" })), "pressed_before");
  assert.equal(neverTwice(job({ pressedBefore: "earlier", againAt: later(FIND_FOR_MS) })), "pressed_before");
});

test("a fresh claim forgets the last try's press, baseline and step; a resumed try keeps them", () => {
  assert.deepEqual(claimFields({ device, tries: 1, fresh: true }), { device, step: "claimed", tries: 1, pressedAt: null, baseline: null, sentStep: null });
  assert.deepEqual(claimFields({ device, tries: 2, fresh: false }), { device, step: "claimed", tries: 2 });
});

test("a fresh claim after a press keeps the Studio ids from before that press (a Try again can find the first post)", () => {
  const ids = earlierIds({ pressedAt: "2026-11-23T20:00:00Z", baseline: ["v1", "v2"], earlier: ["v0"] });
  assert.deepEqual(ids, ["v0", "v1", "v2"]);
  assert.deepEqual(claimFields({ device, tries: 1, fresh: true, earlier: ids }), { device, step: "claimed", tries: 1, pressedAt: null, baseline: null, sentStep: null, earlier: ids });
  // Never pressed: no ids; a resumed try writes none either.
  assert.deepEqual(earlierIds({ baseline: ["v1"] }), []);
  assert.deepEqual(earlierIds(undefined), []);
  assert.deepEqual(claimFields({ device, tries: 2, fresh: false, earlier: ids }), { device, step: "claimed", tries: 2 });
});

// D2: the beat. The job being posted gets its last acknowledged step; this Mac's other pressed jobs get "finding".
test("beatTargets: the current job with its last step and attempt, and this Mac's other pressed working jobs", () => {
  const state = fresh();
  state.ledger.c1 = { device, step: "uploading", sentStep: "uploading" };
  state.ledger.p1 = { device, step: "finding" };
  state.ledger.p2 = { device: "mac-other", step: "finding" };
  state.ledger.w1 = { device, step: "uploading" };
  const current = job({ state: "working", attempt: 2 });
  const queue = [
    current,
    job({ clipId: "p1", state: "working", pressedAt: "2026-11-22T14:40:00Z", attempt: 1 }),
    job({ clipId: "p2", state: "working", pressedAt: "2026-11-22T14:40:00Z", attempt: 1 }), // another Mac's
    job({ clipId: "p3", state: "working", pressedAt: "2026-11-22T14:40:00Z", attempt: 1 }), // not in this ledger
    job({ clipId: "w1", state: "working", attempt: 3 }), // not pressed: not beaten while another job runs
    job({ clipId: "x1", pressedAt: "2026-11-22T14:40:00Z" }), // waiting
  ];
  assert.deepEqual(beatTargets({ queue, state, device, current }), [
    { clipId: "c1", step: "uploading", attempt: 2 },
    { clipId: "p1", step: "finding", attempt: 1 },
  ]);
});

test("beatTargets: no beat for the current job before its first step; never twice for it; no current job", () => {
  const state = fresh();
  state.ledger.c1 = { device, step: "claimed", sentStep: null };
  const current = job({ state: "working", pressedAt: "2026-11-22T14:40:00Z", attempt: 4 });
  assert.deepEqual(beatTargets({ queue: [current], state, device, current }), []);
  state.ledger.c1.sentStep = "finding";
  assert.deepEqual(beatTargets({ queue: [current], state, device, current }), [{ clipId: "c1", step: "finding", attempt: 4 }]);
  state.ledger.c1.device = device;
  assert.deepEqual(beatTargets({ queue: [current], state, device, current: null }), [{ clipId: "c1", step: "finding", attempt: 4 }]);
  assert.deepEqual(beatTargets({ queue: undefined, state, device, current: null }), []);
});

// D5: the owner's Start my Mac again and Let them go.
test("applyRequests: nothing asked, nothing changes", () => {
  assert.deepEqual(applyRequests({ helper: null, settings, state: fresh() }), { patch: {} });
  assert.deepEqual(applyRequests({ helper: { state: "paused" }, settings, state: fresh() }), { patch: {} });
});

test("applyRequests: Start my Mac again unpauses this Mac and says it is done", () => {
  const r = applyRequests({ helper: { state: "paused", resumeRequest: { at: "2026-11-23T07:00:00Z" } }, settings: { ...settings, paused: true }, state: fresh() });
  assert.deepEqual(r, { patch: { paused: false }, resumeDone: "2026-11-23T07:00:00Z" });
  // The paused Mac posts again once the patch is in.
  assert.equal(nextAction({ on: true, queue: [job()], state: fresh(), settings: { ...settings, paused: true, ...r.patch }, device, now }).action, "post");
});

test("applyRequests: Start my Mac again ends the trial pause only when that is what holds it", () => {
  const helper = { state: "paused", resumeRequest: { at: "2026-11-23T07:00:00Z" } };
  const done = fresh();
  done.posted = [{}, {}, {}];
  const r = applyRequests({ helper, settings, state: done });
  assert.deepEqual(r.patch, { paused: false, trialLimit: null });
  assert.equal(nextAction({ on: true, queue: [job()], state: done, settings: { ...settings, ...r.patch }, device, now }).action, "post");
  const two = fresh();
  two.posted = [{}, {}];
  assert.deepEqual(applyRequests({ helper, settings, state: two }).patch, { paused: false });
  assert.deepEqual(applyRequests({ helper, settings: { ...settings, trialLimit: null }, state: done }).patch, { paused: false });
});

test("applyRequests: Let them go lifts the hold and says it is done; both at once; never touches needs you", () => {
  const held = { ...settings, holdAutoBefore: "2026-11-23T02:55:00Z" };
  const r = applyRequests({ helper: { state: "ok", letGoRequest: { at: "2026-11-23T07:01:00Z" } }, settings: held, state: fresh() });
  assert.deepEqual(r, { patch: { holdAutoBefore: null }, letGoDone: "2026-11-23T07:01:00Z" });
  const early = job({ clipId: "early", since: "2026-11-22T21:40:00Z" });
  assert.equal(nextAction({ on: true, queue: [early], state: fresh(), settings: { ...held, ...r.patch }, device, now }).action, "post");
  const both = applyRequests({
    helper: { state: "needs_you", resumeRequest: { at: "a" }, letGoRequest: { at: "b" } },
    settings: { ...held, paused: true },
    state: fresh(),
  });
  assert.deepEqual(both, { patch: { paused: false, holdAutoBefore: null }, resumeDone: "a", letGoDone: "b" });
});

// D4, D5: what the ping adds, each only when set.
test("pingExtras: the first backlog clip's time, the hold, the backfill and the requests done", () => {
  assert.deepEqual(pingExtras({ settings, state: fresh(), autopost: null }), {});
  assert.deepEqual(
    pingExtras({ settings: { ...settings, holdAutoBefore: "2026-11-23T02:55:00Z" }, state: fresh(), autopost: run("2026-11-22T14:45:00Z"), resumeDone: "r", letGoDone: "l" }),
    { backlogAt: "2026-11-22T15:15:00.000Z", holdBefore: "2026-11-23T02:55:00.000Z", resumeDone: "r", letGoDone: "l" }
  );
  // A backfill has its own pace: no backlog time, and the rows say "in line".
  assert.deepEqual(pingExtras({ settings: fill, state: fresh(), autopost: run("2026-11-22T14:45:00Z") }), { backfill: true });
  // An unreadable hold is not sent (the server would refuse the whole ping).
  assert.deepEqual(pingExtras({ settings: { ...settings, holdAutoBefore: "tomorrow" }, state: fresh(), autopost: null }), {});
});

// §47.10 (D1, D2): a Clips Funded lane runs the same rules on its own view; Clip Factory's lane goes first.
const wsJob = (over = {}) => ({ clipId: "pj-1", publishingJobId: "pj-1", state: "waiting", source: "upload", since: "2026-11-22T14:00:00Z", ...over });
const wsView = () => ({ device, ledger: {}, posted: [], lastPressedAt: null });

test("a Clips Funded lane reuses nextAction: post, find a pressed job, resume its own claim", () => {
  const view = wsView();
  const post = wsAction({ on: true, helper: null, queue: [wsJob()], view, settings, device, now });
  assert.deepEqual([post.action, post.job.clipId], ["post", "pj-1"]);
  view.ledger["pj-1"] = { device, step: "pressing" };
  const look = wsAction({ on: true, helper: null, queue: [wsJob({ state: "working" })], view, settings, device, now });
  assert.equal(look.action, "find");
  view.ledger["pj-1"] = { device, step: "uploading" };
  const again = wsAction({ on: true, helper: null, queue: [wsJob({ state: "working" })], view, settings, device, now });
  assert.equal(again.action, "resume");
  const pressed = wsAction({ on: true, helper: null, queue: [wsJob({ pressedAt: "2026-11-22T14:10:00Z" })], view: wsView(), settings, device, now });
  assert.equal(pressed.action, "idle"); // never twice, as for Clip Factory
});

test("a new Clips Funded post waits until the lane is logged in to the workspace's TikTok; one under way goes on", () => {
  const r = wsAction({ on: true, helper: null, queue: [wsJob()], view: wsView(), settings, device, now, setUp: false });
  assert.deepEqual([r.action, r.reason, r.job.clipId], ["wait", "Not logged in to TikTok on this Mac yet.", "pj-1"]);
  const view = wsView();
  view.ledger["pj-1"] = { device, step: "pressing" };
  assert.equal(wsAction({ on: true, helper: null, queue: [wsJob({ state: "working" })], view, settings, device, now, setUp: false }).action, "find");
});

test("Clip Factory's trial, backfill and hold never hold a Clips Funded post; its own last press spaces it", () => {
  const view = wsView();
  view.posted = [{}, {}, {}, {}];
  const held = { ...settings, trialLimit: 3, holdAutoBefore: "2026-11-23T00:00:00Z", backfill: { everyMinutes: 120 } };
  assert.equal(wsAction({ on: true, helper: null, queue: [wsJob()], view, settings: held, device, now }).action, "post");
  view.lastPressedAt = "2026-11-22T14:59:30Z";
  const r = wsAction({ on: true, helper: null, queue: [wsJob()], view, settings, device, now });
  assert.equal(r.action, "wait");
});

test("needs you is per lane: Clips Funded's pauses only its lane; the Mac's own pause stops every lane", () => {
  const helper = { state: "needs_you", reason: "TikTok logged your Mac out. Tap Log in on my Mac." };
  const ws = wsAction({ on: true, helper, queue: [wsJob()], view: wsView(), settings, device, now });
  assert.deepEqual([ws.action, ws.reason], ["paused", helper.reason]);
  // Clip Factory's lane decides from its own helper item only, so it still posts.
  assert.equal(nextAction({ on: true, queue: [job()], state: fresh(), settings, device, now }).action, "post");
  // And Clip Factory's needs-you never reaches the Clips Funded lane (it has its own helper item).
  assert.equal(wsAction({ on: true, helper: { state: "ok" }, queue: [wsJob()], view: wsView(), settings, device, now }).action, "post");
  const paused = { ...settings, paused: true };
  assert.equal(wsAction({ on: true, helper: null, queue: [wsJob()], view: wsView(), settings: paused, device, now }).action, "paused");
  assert.equal(wsAction({ on: false, helper: null, queue: [wsJob()], view: wsView(), settings, device, now }).action, "idle");
});

test("one thing per tick, Clip Factory first; then a Clips Funded find, resume, post; then a login it asked for", () => {
  const lanes = [
    { id: "ws:a", action: { action: "post" }, loginRequest: "2026-11-23T20:00:00Z" },
    { id: "ws:b", action: { action: "resume" } },
    { id: "ws:c", action: { action: "find" } },
  ];
  for (const what of ["post", "resume", "find"]) assert.deepEqual(pickWork({ clips: { action: what }, lanes }), { lane: "clips", what });
  for (const idle of ["idle", "wait", "paused"]) {
    assert.deepEqual(pickWork({ clips: { action: idle }, lanes }), { lane: "ws:c", what: "find", index: 2 });
  }
  assert.deepEqual(pickWork({ clips: { action: "idle" }, lanes: lanes.slice(0, 2) }), { lane: "ws:b", what: "resume", index: 1 });
  assert.deepEqual(pickWork({ clips: { action: "idle" }, lanes: lanes.slice(0, 1) }), { lane: "ws:a", what: "post", index: 0 });
  const asked = [{ id: "ws:a", action: { action: "paused" }, loginRequest: "2026-11-23T20:00:00Z" }];
  assert.deepEqual(pickWork({ clips: { action: "idle" }, lanes: asked }), { lane: "ws:a", what: "login", index: 0 });
  // No request: no login window, ever (only the owner's Log in on my Mac, or a post that found TikTok logged out).
  assert.deepEqual(pickWork({ clips: { action: "idle" }, lanes: [{ id: "ws:a", action: { action: "idle" }, loginRequest: null }] }), {
    lane: "clips",
    what: "tidy",
  });
  assert.deepEqual(pickWork({ clips: { action: "post" }, lanes: asked }), { lane: "clips", what: "post" });
});

test("a Clips Funded check-in carries exactly the keys its server knows", () => {
  const base = { version: "1.2.0", device };
  assert.deepEqual(wsPingBody({ ...base, action: { action: "post" }, needsYou: false, setUp: true, handle: "@clips.funded" }), {
    state: "ok",
    version: "1.2.0",
    device,
    setUp: true,
    handle: "@clips.funded",
  });
  assert.deepEqual(wsPingBody({ ...base, action: { action: "paused", reason: "Paused on your Mac." }, needsYou: false, setUp: false }), {
    state: "paused",
    reason: "Paused on your Mac.",
    version: "1.2.0",
    device,
    setUp: false,
  });
  const ny = wsPingBody({ ...base, action: { action: "paused", reason: "x".repeat(300) }, needsYou: true, setUp: false, handle: "bad handle", loginDone: "2026-11-23T20:00:00Z" });
  assert.equal(ny.state, "needs_you");
  assert.equal(ny.reason.length, 200);
  assert.equal(ny.handle, undefined);
  assert.equal(ny.loginDone, "2026-11-23T20:00:00Z");
  assert.deepEqual(Object.keys(ny).sort(), ["device", "loginDone", "reason", "setUp", "state", "version"]);
});

test("a Clips Funded check-in says when the owner's Start my Mac again was done", () => {
  const body = wsPingBody({ version: "1.2.0", device, action: { action: "idle" }, needsYou: false, setUp: true, resumeDone: "2026-11-23T21:00:00Z" });
  assert.equal(body.resumeDone, "2026-11-23T21:00:00Z");
  assert.equal(wsPingBody({ version: "1.2.0", device, action: { action: "idle" }, needsYou: false, setUp: true }).resumeDone, undefined);
});

// --- §47.11: a hold that is only a TikTok login ---------------------------------------------------------------------

test("loginHold: only a needs-you whose code is login, with the id of its own lane", () => {
  const clips = { seenAt: "2026-11-24T08:28:43Z", state: "needs_you", reason: "TikTok logged your Mac out.", needsYouCode: "login", needsYouClipId: "c1" };
  const ws = { seenAt: "2026-11-24T08:28:43Z", state: "needs_you", setUp: false, needsYouCode: "login", needsYouJobId: "pj-1", needsYouStoryId: "s1" };
  assert.deepEqual(loginHold(clips, "clips"), { id: "c1" });
  assert.deepEqual(loginHold(ws, "ws"), { id: "pj-1" });
  assert.equal(loginHold(clips, "ws"), null); // no job id: never another lane's id
  assert.equal(loginHold(ws, "clips"), null);
  // A puzzle or a code, a limit, an older helper's hold (no code), a pause, ok: never.
  for (const helper of [
    { ...clips, needsYouCode: undefined, reason: "TikTok wants a check (a puzzle or a code). Do it on your Mac, then tap Try again." },
    { ...clips, needsYouCode: undefined, reason: "TikTok says it's posting too much right now. The rest wait; Clip Factory tells you." },
    { ...clips, needsYouCode: undefined },
    { ...clips, needsYouCode: "captcha" },
    { ...clips, state: "paused" },
    { ...clips, state: "ok" },
    { ...clips, needsYouClipId: undefined },
    null,
  ]) {
    assert.equal(loginHold(helper, "clips"), null, JSON.stringify(helper));
  }
});

test("loginCheckDue: no stamp, 5 minutes or more, or a stamp in the future", () => {
  const at = Date.parse("2026-11-24T09:00:00Z");
  const stamp = new Date(at).toISOString();
  assert.equal(LOGIN_CHECK_EVERY_MS, 5 * 60_000);
  assert.equal(loginCheckDue(undefined, at), true);
  assert.equal(loginCheckDue("not a time", at), true);
  assert.equal(loginCheckDue(stamp, at + 4 * 60_000 + 59_000), false); // 4:59
  assert.equal(loginCheckDue(stamp, at + 5 * 60_000), true); // 5:00
  assert.equal(loginCheckDue(stamp, new Date(at + 5 * 60_000)), true);
  assert.equal(loginCheckDue(stamp, at - 60_000), true); // the clock moved back
});

test("triedHere: only a Mac whose ledger has the held clip or job looks (a second Mac never does)", () => {
  const ledger = { c1: { step: "stopped", device: "mac-a", tries: 1 }, "pj-1": { step: "finding" } };
  assert.equal(triedHere(ledger, { id: "c1" }), true);
  assert.equal(triedHere(ledger, { id: "pj-1" }), true); // a pressed post's stop: the hold may end ("pressed")
  assert.equal(triedHere(ledger, { id: "c2" }), false);
  assert.equal(triedHere({}, { id: "c1" }), false);
  assert.equal(triedHere(ledger, null), false);
  assert.equal(triedHere(undefined, { id: "c1" }), false);
  assert.equal(triedHere(ledger, { id: "constructor" }), false); // never an inherited key
});

test("pickWork is the same with a login hold: Clip Factory first, one thing per tick", () => {
  const lanes = [{ id: "ws:stories", action: { action: "paused" }, loginRequest: null }];
  assert.deepEqual(pickWork({ clips: { action: "post" }, lanes }), { lane: "clips", what: "post" });
  assert.deepEqual(pickWork({ clips: { action: "paused" }, lanes }), { lane: "clips", what: "tidy" });
});
