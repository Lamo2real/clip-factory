import assert from "node:assert/strict";
import { test } from "node:test";

import { nextAction } from "../src/plan.js";

const settings = { trialLimit: 3, spacingMinutes: 30, onDemandSpacingMinutes: 5, paused: false };
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

test("a waiting clip is posted", () => {
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

test("30 minutes between posts of waiting and auto-posted clips", () => {
  const state = fresh();
  state.lastPressedAt = "2026-11-22T14:45:00Z";
  const r = nextAction({ on: true, queue: [job()], state, settings, device, now });
  assert.equal(r.action, "wait");
  assert.equal(r.until, "2026-11-22T15:15:00.000Z");
});

test("a clip he just uploaded by hand only waits 5 minutes", () => {
  const state = fresh();
  state.lastPressedAt = "2026-11-22T14:45:00Z";
  const r = nextAction({ on: true, queue: [job({ source: "upload" })], state, settings, device, now });
  assert.equal(r.action, "post");
});

test("the server's order decides which waiting clip goes first", () => {
  const r = nextAction({ on: true, queue: [job({ clipId: "a", source: "upload" }), job({ clipId: "b" })], state: fresh(), settings, device, now });
  assert.equal(r.job.clipId, "a");
});
