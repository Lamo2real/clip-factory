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

const { BACK_LINES, MAX_LOGIN_BACKS, WS_BACK_LINES, backLine, heldWords, loginBack, sendBack } = await import("../src/hold.js");
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
function world(lane, { seen = LAMO, loggedOut = false, answer = { outcome: "resumed" }, target = "@lamo.clips", pinnedUid = "7001", others = { handles: ["@clips.funded"], uids: ["7002"] }, now = NOW, capped } = {}) {
  const seenCalls = { looks: 0, calls: [], events: [], backsAtCall: null };
  const d = {
    look: async () => {
      seenCalls.looks++;
      return loggedOut ? { state: "logged_out" } : { state: "in", seen };
    },
    call: async (id) => {
      seenCalls.calls.push(id);
      seenCalls.backsAtCall = [...(lane.state.ledger[id]?.loginBacks || [])];
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

test("logged in to exactly Clip Factory's TikTok: one route call for the held clip, counted in the ledger first", async () => {
  const state = clipsState();
  const lane = clipsLane(state, null);
  const { d, seen } = world(lane);
  const back = await loginBack(lane, { id: "c1" }, d);
  assert.deepEqual(back, { outcome: "resumed" });
  assert.deepEqual(seen.calls, ["c1"]);
  assert.equal(seen.looks, 1);
  assert.deepEqual(seen.backsAtCall, [new Date(NOW).toISOString()]); // on disk before the call: a crash still counts
  assert.equal(state.ledger.c1.step, "stopped"); // the never-twice ledger is untouched
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
  }
});

test("pressed and cleared come back as the server said them", async () => {
  for (const outcome of ["pressed", "cleared"]) {
    const lane = clipsLane(clipsState(), null);
    const { d } = world(lane, { answer: { helper: { state: "ok" }, outcome } });
    assert.deepEqual(await loginBack(lane, { id: "c1" }, d), { outcome });
  }
});

test("a tick resumes one clip at most twice in 24 hours: then no Chrome, until the oldest is a day old", async () => {
  const state = clipsState();
  const lane = clipsLane(state, null);
  assert.equal(MAX_LOGIN_BACKS, 2);
  for (const at of [NOW, NOW + HOUR]) {
    const { d } = world(lane, { now: at });
    assert.equal((await loginBack(lane, { id: "c1" }, d)).outcome, "resumed");
  }
  assert.equal(state.ledger.c1.loginBacks.length, 2);
  const held = world(lane, { now: NOW + 2 * HOUR });
  assert.deepEqual(await loginBack(lane, { id: "c1" }, held.d), { outcome: "too_many" });
  assert.equal(held.seen.looks, 0);
  assert.deepEqual(held.seen.calls, []);
  const later = world(lane, { now: NOW + 24 * HOUR + 60_000 });
  assert.equal((await loginBack(lane, { id: "c1" }, later.d)).outcome, "resumed");
  assert.equal(later.seen.looks, 1);
  // The owner's own setup is never capped, and isn't counted.
  const his = world(lane, { now: NOW + 24 * HOUR + 120_000, capped: false });
  assert.equal((await loginBack(lane, { id: "c1" }, his.d)).outcome, "resumed");
  assert.equal(state.ledger.c1.loginBacks.length, 2);
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
