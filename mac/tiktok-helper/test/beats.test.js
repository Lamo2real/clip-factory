// D2: the per-job beat (src/beats.js). Clip Factory calls a Mac post stuck only once its own beat is 5 minutes old,
// so the helper re-sends the last step every minute while it works on a post.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError } from "../src/api.js";
import { findBeat, startBeats } from "../src/beats.js";
import { BEAT_EVERY_MS } from "../src/plan.js";

const device = "mac-1";
const flush = () => new Promise((r) => setImmediate(r));

/** A fake client whose step calls stay open until settled by hand (``hold``) or answer at once. */
function fakeApi() {
  const calls = [];
  let hold = false;
  const open = [];
  const answers = new Map(); // clipId -> error to throw
  return {
    calls,
    open,
    hold(on) {
      hold = on;
    },
    answer(clipId, error) {
      answers.set(clipId, error);
    },
    step: (clipId, dev, step, attempt) => {
      calls.push({ clipId, device: dev, step, attempt });
      const error = answers.get(clipId);
      if (hold) {
        return new Promise((resolve, reject) => open.push(() => (error ? reject(error) : resolve({}))));
      }
      return error ? Promise.reject(error) : Promise.resolve({});
    },
  };
}

function setup({ queue = [], sentStep } = {}) {
  const state = { device, ledger: { c1: { device, step: "claimed", ...(sentStep ? { sentStep } : {}) } } };
  const job = { clipId: "c1", attempt: 2 };
  const api = fakeApi();
  const logs = [];
  const records = [];
  const beats = startBeats({
    api,
    state,
    job,
    queue: [{ ...job, state: "working" }, ...queue],
    log: (name, fields) => logs.push({ name, ...fields }),
    record: (fields) => {
      records.push(fields);
      Object.assign(state.ledger.c1, fields);
    },
  });
  return { state, job, api, logs, records, beats };
}

test("every minute it re-sends the last step Clip Factory took, with the job's attempt, and the step records it", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { api, beats, records } = setup();
  t.mock.timers.tick(BEAT_EVERY_MS);
  await flush();
  assert.deepEqual(api.calls, [], "no beat before the first step (the claim is the first beat)");
  await beats.step("video");
  assert.deepEqual(records, [{ sentStep: "video" }]);
  await beats.step("uploading");
  api.calls.length = 0;
  t.mock.timers.tick(BEAT_EVERY_MS - 1);
  await flush();
  assert.deepEqual(api.calls, []);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(api.calls, [{ clipId: "c1", device, step: "uploading", attempt: 2 }]);
  t.mock.timers.tick(BEAT_EVERY_MS);
  await flush();
  assert.equal(api.calls.length, 2);
  await beats.stop();
});

test("this Mac's other pressed jobs get a finding beat too", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const queue = [
    { clipId: "p1", state: "working", pressedAt: "2026-11-23T06:00:00Z", attempt: 5 },
    { clipId: "p2", state: "working", pressedAt: "2026-11-23T06:00:00Z", attempt: 1 },
  ];
  const { api, beats, state } = setup({ queue, sentStep: "settings" });
  state.ledger.p1 = { device, step: "finding" };
  state.ledger.p2 = { device: "mac-other", step: "finding" };
  t.mock.timers.tick(BEAT_EVERY_MS);
  await flush();
  assert.deepEqual(api.calls, [
    { clipId: "c1", device, step: "settings", attempt: 2 },
    { clipId: "p1", device, step: "finding", attempt: 5 },
  ]);
  await beats.stop();
});

test("a beat is skipped while a step for that job is in flight, and a step waits for a beat in flight", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { api, beats } = setup({ sentStep: "video" });
  api.hold(true);
  const step = beats.step("uploading");
  await flush();
  assert.equal(api.calls.length, 1);
  t.mock.timers.tick(BEAT_EVERY_MS);
  await flush();
  assert.equal(api.calls.length, 1, "no beat on top of the step");
  api.open.shift()();
  await step;
  // Now a beat goes, and while it is in flight the next step waits for it.
  t.mock.timers.tick(BEAT_EVERY_MS);
  await flush();
  assert.deepEqual(api.calls.at(-1), { clipId: "c1", device, step: "uploading", attempt: 2 });
  let stepped = false;
  const next = beats.step("settings").then(() => (stepped = true));
  await flush();
  assert.equal(api.calls.length, 2, "the step is not sent while the beat is in flight");
  assert.equal(stepped, false);
  api.open.shift()();
  await flush();
  assert.equal(api.calls.at(-1).step, "settings");
  api.open.shift()();
  await next;
  await beats.stop();
});

test("beat errors are logged and never stop the post; a 409 on the job's beat stops its next step", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { api, beats, logs, records } = setup({ sentStep: "uploading" });
  api.answer("c1", new ApiError(503, "Clip Factory answered 503."));
  t.mock.timers.tick(BEAT_EVERY_MS);
  await flush();
  assert.deepEqual(logs, [{ name: "beat.failed", clipId: "c1", step: "uploading", status: 503, error: "Clip Factory answered 503." }]);
  await beats.ready(); // a failed beat that is not a 409 changes nothing
  api.answer("c1", new ApiError(409, "Your Mac posting TikTok was switched off."));
  t.mock.timers.tick(BEAT_EVERY_MS);
  await flush();
  await assert.rejects(beats.ready(), (e) => e.status === 409);
  const callsBefore = api.calls.length;
  await assert.rejects(beats.step("pressing"), (e) => e.status === 409);
  assert.equal(api.calls.length, callsBefore, "the step after a refused beat is never sent");
  assert.deepEqual(records, []);
  await beats.stop();
});

test("a 409 on another job's beat is only logged", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { api, beats, logs, state } = setup({ queue: [{ clipId: "p1", state: "working", pressedAt: "2026-11-23T06:00:00Z", attempt: 1 }] });
  state.ledger.p1 = { device, step: "finding" };
  api.answer("p1", new ApiError(409, "This clip just changed."));
  t.mock.timers.tick(BEAT_EVERY_MS);
  await flush();
  assert.equal(logs[0].name, "beat.failed");
  assert.equal(logs[0].clipId, "p1");
  await beats.step("video");
  await beats.stop();
});

test("a failed step is not recorded as the step Clip Factory took", async () => {
  const { api, beats, records } = setup();
  api.answer("c1", new ApiError(409, "Wait."));
  await assert.rejects(beats.step("video"), (e) => e.status === 409);
  assert.deepEqual(records, []);
  await beats.stop();
});

test("no beats once stopped", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { api, beats } = setup({ sentStep: "uploading" });
  await beats.stop();
  await beats.stop(); // stopping twice is fine
  t.mock.timers.tick(5 * BEAT_EVERY_MS);
  await flush();
  assert.deepEqual(api.calls, []);
});

test("doFind's beat: finding with the job's attempt; a 409 stops the look, other errors don't", async () => {
  const state = { device, ledger: {} };
  const job = { clipId: "c1", attempt: 3 };
  const logs = [];
  const log = (name, fields) => logs.push({ name, ...fields });
  const ok = fakeApi();
  assert.equal(await findBeat({ api: ok, state, job, log }), true);
  assert.deepEqual(ok.calls, [{ clipId: "c1", device, step: "finding", attempt: 3 }]);
  const refused = fakeApi();
  refused.answer("c1", new ApiError(409, "This clip just changed."));
  assert.equal(await findBeat({ api: refused, state, job, log }), false);
  const down = fakeApi();
  down.answer("c1", new ApiError(502, "Clip Factory answered 502."));
  assert.equal(await findBeat({ api: down, state, job, log }), true);
  assert.deepEqual(
    logs.map((l) => [l.name, l.status]),
    [
      ["beat.failed", 409],
      ["beat.failed", 502],
    ]
  );
});
