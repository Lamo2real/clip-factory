// §47.11: a hold that is only a TikTok login ends by itself once the lane's Chrome reads exactly its own account.
// loginBack with fakes only: the look, the server's logged-in route, the clock and the events are the test's.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "cf-hold-test-"));
process.env.CF_TT_BASE = base;
process.env.CF_TT_DOWNLOADS = path.join(base, "Downloads");

const { BACK_LINES, MAX_LOGIN_BACKS, WS_BACK_LINES, backLine, freshBacks, heldWords, lanesBacks, loginBack, sendBack } = await import("../src/hold.js");
const { clipsLane, wsLane } = await import("../src/lanes.js");
const { REASONS, WS_REASONS } = await import("../src/tiktok.js");
const { ApiError } = await import("../src/api.js");

const NOW = Date.parse("2026-11-24T09:00:00Z");
const HOUR = 3_600_000;
const LAMO = { handles: ["@lamo.clips"], own: ["@lamo.clips"], uids: ["7001"], uid: "7001" };
const FUNDED = { handles: ["@clips.funded"], own: ["@clips.funded"], uids: ["7002"], uid: "7002" };

function clipsState() {
  return { device: "mac-1", ledger: { c1: { step: "stopped", device: "mac-1" } }, posted: [], clipsAccount: { handle: "@lamo.clips", uid: "7001" } };
}

/** loginBack's world: a look that reads ``seen`` (or no session), a route that answers ``answer``, every call kept. */
function world(lane, { seen = LAMO, loggedOut = false, lookState, answer = { outcome: "resumed" }, target = "@lamo.clips", pinnedUid = "7001", others = { handles: ["@clips.funded"], uids: ["7002"] }, now = NOW, capped } = {}) {
  const seenCalls = { looks: 0, calls: [], events: [], backsAtCall: null };
  const d = {
    look: async () => {
      seenCalls.looks++;
      if (lookState) return { state: lookState };
      return loggedOut ? { state: "logged_out" } : { state: "in", seen };
    },
    call: async (id) => {
      seenCalls.calls.push(id);
      seenCalls.backsAtCall = [...lanesBacks(lane)];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    now: () => now,
    event: (kind, fields) => seenCalls.events.push({ kind, ...fields }),
    target,
    pinnedUid,
    others,
    ...(capped === undefined ? {} : { capped }),
  };
  return { d, seen: seenCalls };
}

test("logged in to exactly Clip Factory's TikTok: one route call for the held clip, counted in the lane first", async () => {
  const state = clipsState();
  const lane = clipsLane(state, null);
  const { d, seen } = world(lane);
  const back = await loginBack(lane, { id: "c1" }, d);
  assert.deepEqual(back, { outcome: "resumed" });
  assert.deepEqual(seen.calls, ["c1"]);
  assert.equal(seen.looks, 1);
  assert.deepEqual(seen.backsAtCall, [new Date(NOW).toISOString()]); // on disk before the call: a crash still counts
  assert.deepEqual(state.loginBacks, [new Date(NOW).toISOString()]); // the lane's count, not the clip's
  assert.deepEqual(state.ledger.c1, { step: "stopped", device: "mac-1" }); // the never-twice ledger is untouched
  assert.deepEqual(seen.events, [{ kind: "login_back", clipId: "c1", outcome: "resumed" }]);
});

test("@clips.funded in Clip Factory's lane: the hold stays, its words say so, and the server is never called", async () => {
  const lane = clipsLane(clipsState(), null);
  const { d, seen } = world(lane, { seen: FUNDED, others: { handles: [], uids: [] } });
  const back = await loginBack(lane, { id: "c1" }, d);
  assert.deepEqual(back, { outcome: "wrong", words: "Your Mac is logged in to TikTok as @clips.funded, not @lamo.clips. Nothing was posted." });
  assert.deepEqual(seen.calls, []);
  assert.deepEqual(seen.events.map((e) => [e.kind, e.seen]), [["wrong_account", "@clips.funded"], ["login_back", "@clips.funded"]]);
});

test("another lane's uid, or a uid that isn't the pinned one, is the wrong account too", async () => {
  for (const [seenAs, pinned] of [
    [{ handles: ["@lamo.clips"], own: ["@lamo.clips"], uids: ["7002"], uid: "7002" }, null], // Clips Funded's uid
    [{ handles: ["@lamo.clips"], own: ["@lamo.clips"], uids: ["7999"], uid: "7999" }, "7001"], // not the pinned one
  ]) {
    const lane = clipsLane(clipsState(), null);
    const { d, seen } = world(lane, { seen: seenAs, pinnedUid: pinned });
    assert.equal((await loginBack(lane, { id: "c1" }, d)).outcome, "wrong");
    assert.deepEqual(seen.calls, []);
  }
});

test("a target that is another lane's account is refused before any Chrome opens, in that refusal's own words", async () => {
  const clips = clipsLane(clipsState(), null);
  const one = world(clips, { target: "@clips.funded" });
  assert.deepEqual(await loginBack(clips, { id: "c1" }, one.d), { outcome: "wrong", words: REASONS.otherWorkspaceClips });
  assert.equal(one.seen.looks, 0);
  const root = { device: "mac-1", ledger: {}, posted: [], clipsAccount: { handle: "@lamo.clips", uid: "7001" } };
  const ws = wsLane(root, "stories", null);
  const two = world(ws, { target: "@lamo.clips", others: { handles: ["@lamo.clips"], uids: ["7001"] } });
  assert.deepEqual(await loginBack(ws, { id: "pj-1" }, two.d), { outcome: "wrong", words: REASONS.otherWorkspace });
  assert.equal(two.seen.looks, 0);
  assert.deepEqual(two.seen.calls, []);
});

test("no session, nobody readable, or no target: no call, and only logged out brings words", async () => {
  const lane = clipsLane(clipsState(), null);
  const out = world(lane, { loggedOut: true });
  assert.deepEqual(await loginBack(lane, { id: "c1" }, out.d), { outcome: "logged_out", words: REASONS.login });
  assert.deepEqual(out.seen.calls, []);
  const unknown = world(lane, { seen: { handles: [], uids: [] } });
  assert.deepEqual(await loginBack(lane, { id: "c1" }, unknown.d), { outcome: "unknown" });
  assert.deepEqual(unknown.seen.calls, []);
  const broken = world(lane);
  broken.d.look = async () => {
    throw new Error("The helper's Chrome did not start.");
  };
  assert.deepEqual(await loginBack(lane, { id: "c1" }, broken.d), { outcome: "unknown" });
  assert.deepEqual(broken.seen.calls, []);
  const none = world(lane, { target: null });
  assert.deepEqual(await loginBack(lane, { id: "c1" }, none.d), { outcome: "no_account" });
  assert.equal(none.seen.looks, 0); // no Chrome at all
  // The look saw TikTok stop on something that isn't its login (a puzzle, a code, a page that didn't load): no call.
  const stopped = world(lane, { lookState: "unknown" });
  assert.deepEqual(await loginBack(lane, { id: "c1" }, stopped.d), { outcome: "unknown" });
  assert.deepEqual(stopped.seen.calls, []);
  assert.equal(lane.state.loginBacks, undefined);
});

test("the server refuses (409) or doesn't know the route (404): the hold stays either way", async () => {
  for (const [answer, outcome] of [
    [new ApiError(409, "Your Mac isn't waiting for a TikTok login on this one.", "conflict"), "refused"],
    [new ApiError(404, "not here", "not_found"), "failed"],
    [new Error("offline"), "failed"],
    [{ helper: null }, "failed"],
  ]) {
    const lane = clipsLane(clipsState(), null);
    const { d, seen } = world(lane, { answer });
    assert.deepEqual(await loginBack(lane, { id: "c1" }, d), { outcome });
    assert.deepEqual(seen.calls, ["c1"]);
    assert.equal(seen.backsAtCall.length, 1); // counted while the call ran (a crash still counts)…
    assert.deepEqual(lanesBacks(lane), []); // …and taken off again: a call that didn't end the hold never counts
  }
});

test("pressed and cleared come back as the server said them", async () => {
  for (const outcome of ["pressed", "cleared"]) {
    const lane = clipsLane(clipsState(), null);
    const { d } = world(lane, { answer: { helper: { state: "ok" }, outcome } });
    assert.deepEqual(await loginBack(lane, { id: "c1" }, d), { outcome });
  }
});

test("a lane's looks end its holds at most twice in a row, every clip counted and no clock: then no Chrome until it posts or he logs in", async () => {
  const state = { ...clipsState(), ledger: { c1: { step: "stopped" }, c2: { step: "stopped" }, c3: { step: "stopped" } } };
  const lane = clipsLane(state, null);
  assert.equal(MAX_LOGIN_BACKS, 2);
  // Two clips, one resume each: the lane's count is 2, whichever clip held it.
  for (const [id, at] of [["c1", NOW], ["c2", NOW + HOUR]]) {
    const { d } = world(lane, { now: at });
    assert.equal((await loginBack(lane, { id }, d)).outcome, "resumed");
  }
  assert.equal(lanesBacks(lane).length, 2);
  assert.equal(state.ledger.c1.loginBacks, undefined);
  // A third clip, the next day, or the clock moved back: still too many, and no Chrome at all.
  for (const at of [NOW + 2 * HOUR, NOW + 48 * HOUR, NOW - 5 * HOUR]) {
    const held = world(lane, { now: at });
    assert.deepEqual(await loginBack(lane, { id: "c3" }, held.d), { outcome: "too_many" });
    assert.equal(held.seen.looks, 0);
    assert.deepEqual(held.seen.calls, []);
  }
  // The owner's own setup is never capped, and isn't counted.
  const his = world(lane, { now: NOW + 3 * HOUR, capped: false });
  assert.equal((await loginBack(lane, { id: "c3" }, his.d)).outcome, "resumed");
  assert.equal(lanesBacks(lane).length, 2);
  // A post on TikTok (or his own login) starts the count again: the next look may end a hold again.
  freshBacks(lane);
  assert.equal(state.loginBacks, undefined);
  const again = world(lane, { now: NOW + 4 * HOUR });
  assert.equal((await loginBack(lane, { id: "c3" }, again.d)).outcome, "resumed");
  assert.equal(again.seen.looks, 1);
});

test("a Clips Funded lane counts in its own store, apart from Clip Factory's", async () => {
  const root = { device: "mac-1", ledger: {}, posted: [], clipsAccount: { handle: "@lamo.clips", uid: "7001" }, loginBacks: ["x", "y"] };
  const lane = wsLane(root, "stories", null);
  const others = { handles: ["@lamo.clips"], uids: ["7001"] };
  for (const id of ["pj-1", "pj-2"]) {
    const { d } = world(lane, { seen: FUNDED, target: "@clips.funded", pinnedUid: null, others });
    assert.equal((await loginBack(lane, { id }, d)).outcome, "resumed");
  }
  const held = world(lane, { seen: FUNDED, target: "@clips.funded", pinnedUid: null, others });
  assert.equal((await loginBack(lane, { id: "pj-3" }, held.d)).outcome, "too_many");
  assert.equal(root.ws.stories.loginBacks.length, 2);
  assert.deepEqual(root.loginBacks, ["x", "y"]); // Clip Factory's count is untouched
  assert.equal(root.ws.stories.ledger["pj-1"], undefined);
});

test("a Clips Funded lane: its own target and pinned uid, set up on the right account, not set up on another", async () => {
  const root = { device: "mac-1", ledger: {}, posted: [], clipsAccount: { handle: "@lamo.clips", uid: "7001" } };
  const lane = wsLane(root, "stories", null);
  const others = { handles: ["@lamo.clips"], uids: ["7001"] };
  const right = world(lane, { seen: FUNDED, target: "@clips.funded", pinnedUid: null, others });
  assert.deepEqual(await loginBack(lane, { id: "pj-1" }, right.d), { outcome: "resumed" });
  assert.deepEqual(right.seen.calls, ["pj-1"]);
  assert.equal(root.ws.stories.account.handle, "@clips.funded");
  assert.ok(root.ws.stories.account.setUpAt);
  assert.deepEqual(right.seen.events, [{ kind: "login_back", publishingJobId: "pj-1", outcome: "resumed" }]);
  const wrong = world(lane, { seen: LAMO, target: "@clips.funded", pinnedUid: null, others });
  assert.deepEqual(await loginBack(lane, { id: "pj-1" }, wrong.d), {
    outcome: "wrong",
    words: "Your Mac is logged in to TikTok as @lamo.clips, not @clips.funded. Nothing was posted.",
  });
  assert.equal(root.ws.stories.account.setUpAt, undefined);
  const out = world(lane, { loggedOut: true, target: "@clips.funded", others });
  assert.deepEqual(await loginBack(lane, { id: "pj-1" }, out.d), { outcome: "logged_out", words: WS_REASONS.login });
});

test("sendBack (setup --workspace, after the window already read the account): no look, never counted", async () => {
  const root = { device: "mac-1", ledger: {}, posted: [] };
  const lane = wsLane(root, "stories", null);
  const { d, seen } = world(lane, { target: "@clips.funded", capped: false, others: { handles: [], uids: [] } });
  assert.deepEqual(await sendBack(lane, { id: "pj-1" }, d), { outcome: "resumed" });
  assert.equal(seen.looks, 0);
  assert.equal(root.ws.stories.ledger["pj-1"], undefined);
});

test("heldWords: wrong and logged out in each lane's words, nothing for the rest", () => {
  const clips = { kind: "clips" };
  const ws = { kind: "ws" };
  assert.equal(heldWords(clips, "wrong", { seen: "@clips.funded", target: "@lamo.clips" }), REASONS.wrongAccount("@clips.funded", "@lamo.clips"));
  assert.equal(heldWords(ws, "wrong", { seen: "@lamo.clips", target: "@clips.funded" }), REASONS.wrongAccount("@lamo.clips", "@clips.funded"));
  assert.equal(heldWords(clips, "wrong", { words: REASONS.otherWorkspaceClips }), REASONS.otherWorkspaceClips);
  assert.equal(heldWords(clips, "logged_out"), "TikTok logged your Mac out. Log in to TikTok again on your Mac.");
  assert.equal(heldWords(ws, "logged_out"), "TikTok logged your Mac out. Tap Log in on my Mac.");
  for (const outcome of ["unknown", "resumed", "too_many", "refused"]) {
    assert.equal(heldWords(clips, outcome), null);
    assert.equal(heldWords(ws, outcome), null);
  }
});

test("the setup lines, word for word, and Clips Funded's never say Clip Factory", () => {
  const clips = { kind: "clips" };
  const ws = { kind: "ws" };
  assert.equal(backLine(clips, { outcome: "resumed" }), "Your Mac carries on with the stopped clip now.");
  assert.equal(backLine(clips, { outcome: "pressed" }), "Your Mac goes on. The clip it stopped on may already be on TikTok: check it in Clip Factory.");
  assert.equal(backLine(clips, { outcome: "cleared" }), "Your Mac goes on.");
  assert.equal(backLine(clips, { outcome: "logged_out" }), "TikTok isn't logged in yet.");
  assert.equal(
    backLine(clips, { outcome: "wrong", words: REASONS.wrongAccount("@clips.funded", "@lamo.clips") }, "@lamo.clips"),
    "Your Mac is logged in to TikTok as @clips.funded, not @lamo.clips. Nothing was posted. Log in as @lamo.clips."
  );
  assert.equal(backLine(clips, { outcome: "unknown" }), null);
  assert.equal(backLine(ws, { outcome: "resumed" }), "Your Mac carries on with the stopped post now.");
  assert.equal(backLine(ws, { outcome: "pressed" }), "Your Mac goes on. The post it stopped on may already be on TikTok: check it in Clips Funded.");
  for (const text of Object.values(WS_BACK_LINES)) assert.doesNotMatch(text, /clip factory/i);
  for (const text of [...Object.values(BACK_LINES), ...Object.values(WS_BACK_LINES)]) {
    assert.ok(text.length <= 100, text);
    assert.doesNotMatch(text, /\b(API|CDP|cookie|session|handle|uid|Keychain)\b/i, text);
  }
});

test("hold.js never shows anything, types a login or clears a cookie", () => {
  const text = fs.readFileSync(new URL("../src/hold.js", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  for (const word of ["frame.js", "login.js", "cdp.js", "chrome.js", "ask(", "readLogin", "clearCookies", "countTry", "passwordLogin", "osascript", "loginRefused", "loginTries"]) {
    assert.ok(!text.includes(word), word);
  }
});

test("the lane's count starts again where a post goes on TikTok and where the owner logs in himself; setup waits for TikTok's session", () => {
  const body = (file, name) => {
    const text = fs.readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    const start = text.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${file} ${name}`);
    const next = text.indexOf("\nfunction ", start + 1);
    const nextAsync = text.indexOf("\nasync function ", start + 1);
    const ends = [next, nextAsync, text.indexOf("\nexport ", start + 1)].filter((i) => i > 0);
    return text.slice(start, Math.min(...ends, text.length));
  };
  assert.match(body("run.js", "finished"), /freshBacks\(lane\)/);
  assert.match(body("run.js", "wsLoginRequest"), /if \(ok\) freshBacks\(lane\)/);
  assert.match(body("cli.js", "afterLogin"), /freshBacks\(lane\)/);
  assert.match(body("cli.js", "wsSetup"), /freshBacks\(lane\)/);
  assert.match(body("cli.js", "setup"), /if \(tiktok && !wasIn\) await sleep\(SESSION_SETTLE_MS\);\s+await chrome\.quit\(browser\)/);
});
