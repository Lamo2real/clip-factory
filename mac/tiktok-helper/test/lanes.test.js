// §47.10 D1: two lanes in one helper. Clip Factory's keeps exactly its 1.1.0 profile, port, Keychain items and the
// top-level state; each Clips Funded workspace gets its own profile, port and store, and no Keychain login at all.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "cf-lanes-test-"));
process.env.CF_TT_BASE = base;
delete process.env.CF_TT_PORT;
delete process.env.CF_TT_WS_PORT_BASE;
// A fake Keychain tool that holds Clip Factory's login and records every call (it must never be asked for a ws lane).
const calls = path.join(base, "security-calls.txt");
const fake = path.join(base, "security");
fs.writeFileSync(
  fake,
  `#!/bin/sh\necho "$@" >> "${calls}"\nif [ "$1" = "find-generic-password" ]; then echo 'password: "cf-secret-value"' >&2; fi\nexit 0\n`,
  { mode: 0o755 }
);
process.env.CF_TT_SECURITY = fake;

const { clipsLane, freePort, helperPorts, normalizeWsJob, otherAccounts, reasonFor, setUpFor, wsFileName, wsLane, WS_ID } = await import("../src/lanes.js");
const { readLogin } = await import("../src/login.js");
const { REASONS, WS_REASONS, refusedTarget } = await import("../src/tiktok.js");
const { postOpts } = await import("../src/run.js");
const { BASE, STATE } = await import("../src/paths.js");

const root = () => ({ device: "mac-1", ledger: {}, posted: [], lastPressedAt: null });

test("Clip Factory's lane is exactly 1.1.0's: chrome/, port 9339, its Keychain items, the top-level state", () => {
  const state = root();
  const lane = clipsLane(state, {});
  assert.equal(lane.id, "clips");
  assert.equal(lane.profile, path.join(BASE, "chrome"));
  assert.equal(lane.port, 9339);
  assert.deepEqual({ ...lane.keychain }, { user: "tiktok-username", pass: "tiktok-password" });
  assert.equal(lane.state, state); // the ledger, pacing, trial and backfill stay at the top of state.json
  lane.remember("c1", { step: "claimed" });
  assert.equal(state.ledger.c1.step, "claimed");
  assert.equal(JSON.parse(fs.readFileSync(STATE, "utf8")).ledger.c1.step, "claimed");
});

test("a Clips Funded lane: its own profile, the lowest free port of 9340–9349, its own store; nothing of Clip Factory's moves", () => {
  const state = root();
  state.ledger.c1 = { step: "done" };
  state.lastPressedAt = "2026-11-23T10:00:00Z";
  const a = wsLane(state, "stories", {});
  assert.equal(a.id, "ws:stories");
  assert.equal(a.profile, path.join(BASE, "chrome-ws-stories"));
  assert.equal(a.port, 9340);
  assert.equal(a.keychain, null);
  const b = wsLane(state, "second-one", {});
  assert.equal(b.port, 9341);
  assert.equal(wsLane(state, "stories", {}).port, 9340); // kept in state.json
  assert.deepEqual(helperPorts(state).sort(), [9339, 9340, 9341]);
  // Its writes go to state.ws[id] only.
  a.remember("pj-1", { step: "claimed" });
  a.state.lastPressedAt = "2026-11-23T11:00:00Z";
  a.state.posted.push({ publishingJobId: "pj-1" });
  assert.equal(state.ws.stories.ledger["pj-1"].step, "claimed");
  assert.equal(state.ws.stories.lastPressedAt, "2026-11-23T11:00:00Z");
  assert.equal(state.ledger["pj-1"], undefined);
  assert.equal(state.lastPressedAt, "2026-11-23T10:00:00Z");
  assert.deepEqual(state.posted, []);
  assert.equal(a.state.device, "mac-1"); // shared
  assert.deepEqual(a.otherPorts().sort(), [9339, 9341]);
});

test("ports: ten at most, never Clip Factory's", () => {
  const state = root();
  for (let i = 0; i < 10; i++) wsLane(state, `w${i}`, {});
  assert.equal(freePort(state), null);
  assert.throws(() => wsLane(state, "w10", {}), /No helper port/);
  assert.ok(!Object.values(state.ws).some((s) => s.port === 9339));
});

test("only a plain workspace id can be a lane (it names a folder)", () => {
  for (const ok of ["stories", "a", "w-2", "0abc", "01JZ0000000000000000000WS1"]) assert.ok(WS_ID.test(ok), ok);
  // The server's generated id (26 letters and digits, never I, L, O or U) is a lane too.
  assert.ok(!WS_ID.test("01JZ0000000000000000000WSI"));
  assert.equal(wsLane(root(), "01JZ0000000000000000000WS1", {}).profile, path.join(BASE, "chrome-ws-01JZ0000000000000000000WS1"));
  for (const bad of ["", "../x", "Stories", "-a", "a/b", "a".repeat(41), "clips funded"]) assert.ok(!WS_ID.test(bad), bad);
  assert.throws(() => wsLane(root(), "../chrome", {}));
});

test("a Clips Funded lane never reads Clip Factory's Keychain login; Clip Factory's lane still does", async () => {
  fs.rmSync(calls, { force: true });
  const state = root();
  assert.equal(await readLogin(wsLane(state, "stories", {})), null);
  assert.equal(fs.existsSync(calls), false); // the Keychain was never even asked
  const login = await readLogin(clipsLane(state, {}));
  assert.deepEqual(login, { username: "cf-secret-value", password: "cf-secret-value" });
  assert.match(fs.readFileSync(calls, "utf8"), /-a tiktok-username/);
});

test("a Clips Funded job always goes public, with Comments, Duet, Stitch and the AI label, whatever it says (D7)", () => {
  const job = normalizeWsJob({
    publishingJobId: "pj-1",
    storyId: "s1",
    privacy: "SELF_ONLY",
    comment: false,
    duet: false,
    stitch: false,
    aiLabel: false,
    source: "auto",
    account: { handle: "@clips.funded", openId: "o1" },
  });
  assert.equal(job.clipId, "pj-1");
  assert.deepEqual(
    [job.privacy, job.comment, job.duet, job.stitch, job.aiLabel, job.source],
    ["PUBLIC_TO_EVERYONE", true, true, true, true, "upload"]
  );
});

test("the account check: the job's own account is the only target; set up only while it reads the workspace's", () => {
  const state = root();
  const lane = wsLane(state, "stories", {});
  const job = { account: { handle: "@clips.funded" } };
  assert.equal(lane.target(job), "@clips.funded");
  assert.equal(lane.target({ account: { handle: "Clips Funded" } }), null);
  assert.equal(setUpFor(lane.store, "@clips.funded"), false);
  lane.onWho({ verdict: "same", uid: "7000000001" }, "@clips.funded");
  assert.equal(setUpFor(lane.store, "@Clips.Funded"), true);
  assert.equal(lane.pinnedUid(job), "7000000001");
  assert.equal(setUpFor(lane.store, "@other"), false);
  lane.onWho({ verdict: "wrong", seen: "@lamo.clips" }, "@clips.funded");
  assert.equal(setUpFor(lane.store, "@clips.funded"), false);
  assert.equal(lane.store.account.handle, "@lamo.clips");
  lane.pin({ handle: "@clips.funded", uid: "7000000001" });
  assert.equal(setUpFor(lane.store, "@clips.funded"), true);
  lane.loggedOut();
  assert.equal(setUpFor(lane.store, "@clips.funded"), false);
});

test("Clips Funded's words replace only Clip Factory's that name the app or its login", () => {
  const ws = wsLane(root(), "stories", {});
  const clips = clipsLane(root(), {});
  assert.equal(reasonFor(ws, REASONS.login), WS_REASONS.login);
  assert.equal(reasonFor(ws, REASONS.noUpload), WS_REASONS.noUpload);
  assert.equal(reasonFor(ws, REASONS.limit), WS_REASONS.limit);
  assert.equal(reasonFor(ws, REASONS.noLoginPage), WS_REASONS.login);
  assert.equal(reasonFor(ws, REASONS.caption), REASONS.caption);
  for (const key of ["login", "noUpload", "limit", "caption"]) assert.equal(reasonFor(clips, REASONS[key]), REASONS[key]);
});

test("Clips Funded's video file names always start clips-funded- and end .mp4", () => {
  assert.equal(wsFileName("clips-funded-the-heist.mp4"), "clips-funded-the-heist.mp4");
  assert.equal(wsFileName("../clips-funded-x.mp4"), "clips-funded-x.mp4");
  for (const odd of ["the-heist.mp4", "clips-funded-x.mov", "", null, "clip-factory-x.mp4"]) {
    assert.equal(wsFileName(odd), "clips-funded-story.mp4");
  }
});

test("rule 1 both ways: each lane refuses every other lane's account (never one only seen in a wrong login)", () => {
  const state = root();
  state.clipsAccount = { handle: "@lamo.clips", uid: "7000000000000000001" };
  const ws = wsLane(state, "stories", {});
  ws.store.connected = "@clips.funded";
  ws.store.account = { handle: "@clips.funded", uid: "7400000000000000001", setUpAt: "2026-11-23T20:00:00Z" };
  assert.deepEqual(otherAccounts(state, "clips"), { handles: ["@clips.funded"], uids: ["7400000000000000001"] });
  assert.deepEqual(otherAccounts(state, ws.id), { handles: ["@lamo.clips"], uids: ["7000000000000000001"] });
  // A profile once seen logged in to Clip Factory's account (a wrong login) never makes that account Clips Funded's.
  ws.store.account = { handle: "@lamo.clips", checkedAt: "2026-11-23T20:00:00Z" };
  assert.deepEqual(otherAccounts(state, "clips"), { handles: ["@clips.funded"], uids: [] });
  // Clip Factory's TikTok in Settings became the Clips Funded account: its clip is refused before anything is read.
  state.clipsAccount = { handle: "@clips.funded" };
  const clips = clipsLane(state, {});
  const opts = postOpts(clips, { clipId: "c1" });
  assert.deepEqual([opts.target, opts.notHandles], ["@clips.funded", ["@clips.funded"]]);
  const stop = refusedTarget(opts);
  assert.equal(stop.reason, REASONS.otherWorkspaceClips);
  assert.equal(stop.needsYou, true);
  // And a Clips Funded job whose account is Clip Factory's: refused too.
  state.clipsAccount = { handle: "@lamo.clips" };
  const wsStop = refusedTarget(postOpts(ws, { clipId: "pj-1", account: { handle: "@lamo.clips" } }));
  assert.equal(wsStop.reason, REASONS.otherWorkspace);
  // The right targets pass.
  assert.equal(refusedTarget(postOpts(clips, { clipId: "c1" })), null);
  assert.equal(refusedTarget(postOpts(ws, { clipId: "pj-1", account: { handle: "@clips.funded" } })), null);
});
