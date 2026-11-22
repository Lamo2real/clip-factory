import assert from "node:assert/strict";
import { test } from "node:test";

import { nextAction } from "../src/plan.js";

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
