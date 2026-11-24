// A whole tick through a 20-minute TikTok login wait, on a faked clock (24 Nov 2026). An access token lasts 15
// minutes, and tick() bound one to every client: the beats from minute 15 and the needs-you stop at minute 20 got
// 401 from API Gateway, so the job stayed the Mac's and the next tick resumed it and opened the login window again,
// every ~21 minutes all night. Here the real tick() runs against a fake Clip Factory behind its JWT authorizer (a
// token 15 minutes old gets 401), a fake Cognito (a new token on each refresh), and a fake helper Chrome whose TikTok
// is logged out (test/fake-chrome.js, swapped in for chrome.js and cdp.js by a module hook: nothing starts or shows).
import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const src = (name) => new URL(`../src/${name}`, import.meta.url).href;
const FAKE_CHROME = new URL("./fake-chrome.js", import.meta.url).href;
const SWAP = new Map([
  [src("chrome.js"), FAKE_CHROME],
  [src("cdp.js"), FAKE_CHROME],
]);
registerHooks({
  resolve(specifier, context, next) {
    const found = next(specifier, context);
    return SWAP.has(found.url) ? { ...found, url: SWAP.get(found.url) } : found;
  },
});

const base = fs.mkdtempSync(path.join(os.tmpdir(), "cf-tick-token-test-"));
process.env.CF_TT_BASE = base;
process.env.CF_TT_DOWNLOADS = path.join(base, "Downloads");
process.env.CF_TT_CONTROL = path.join(base, "control"); // no frame app, no pop-ups
process.env.CF_TT_APP_URL = "https://app.example";
// The Keychain: Clip Factory's sign-in, and no saved TikTok login.
const security = path.join(base, "security");
fs.writeFileSync(security, `#!/bin/sh\ncase "$*" in *refresh-token*-w*) echo "refresh-1";; *) exit 44;; esac\n`, { mode: 0o755 });
process.env.CF_TT_SECURITY = security;

const { tick } = await import("../src/run.js");
const { mac, resetMac } = await import("./fake-chrome.js");
const { VERSION } = await import("../src/paths.js");
const { QR_URL } = await import("../src/login.js");
const { REASONS, WS_REASONS } = await import("../src/tiktok.js");

const API = "https://api.example";
const W = "/v1/workspaces/stories";
const MIN = 60_000;
const START = Date.parse("2026-11-24T03:00:00Z");
const realTimeout = globalThis.setTimeout; // the clock is faked inside each test

const clipsJob = { clipId: "c1", postId: "p1", hook: "Hi", caption: "hi", state: "waiting", source: "upload", since: "2026-11-24T02:50:00Z", attempt: 0 };
const wsJob = {
  workspaceId: "stories",
  publishingJobId: "pj-1",
  storyId: "s1",
  hook: "The heist",
  caption: "the heist",
  fileName: "clips-funded-the-heist.mp4",
  account: { handle: "@clips.funded", openId: "o1" },
  aiLabel: true,
  privacy: "PUBLIC_TO_EVERYONE",
  comment: true,
  duet: true,
  stitch: true,
  source: "upload",
  since: "2026-11-24T02:51:00Z",
  state: "waiting",
  attempt: 0,
};

/**
 * Clip Factory behind API Gateway, with Cognito. Every API call is recorded with its bearer and its answer. A claim
 * makes the job working (attempt 1); a stop takes it out of the queue, and one with needsYou holds the lane
 * (helper needs_you), as tiktok_mac.stopped does. A call refused with 401 changes nothing.
 */
function clipFactory({ clipsQueue = [], wsQueue = [], clipsHelper = null, wsHelper = null, stopped = {}, on = true, oldServer = false } = {}) {
  const issued = new Map(); // each access token, and when Cognito gave it
  const calls = [];
  const lanes = {
    clips: { helper: clipsHelper, queue: clipsQueue, stopped: { ...stopped } },
    ws: { helper: wsHelper, queue: wsQueue, stopped: { ...stopped } },
  };
  const knobs = { failQueueAfterLoggedIn: false, loggedIn: false };
  const idOf = (job) => job.publishingJobId || job.clipId;
  const claim = (lane, id) => {
    const job = lane.queue.find((j) => idOf(j) === id);
    Object.assign(job, { state: "working", attempt: job.attempt + 1 });
    return { job };
  };
  const stop = (lane, id, body) => {
    // A server from before §47.11 refuses a key it doesn't know.
    if (oldServer && "code" in body) return { status: 400, body: { error: { code: "bad_request", message: "Unknown field: code." } } };
    const job = lane.queue.find((j) => idOf(j) === id);
    if (job) lane.stopped[id] = { ...job, state: "stopped" };
    lane.queue = lane.queue.filter((j) => idOf(j) !== id);
    if (body.needsYou) {
      lane.helper = {
        seenAt: new Date().toISOString(),
        state: "needs_you",
        setUp: true,
        reason: body.reason,
        [lane === lanes.ws ? "needsYouJobId" : "needsYouClipId"]: id,
        ...(body.code === "login" ? { needsYouCode: "login" } : {}),
      };
    }
    return { job: { state: "stopped" } };
  };
  /** §47.11's route, as tiktok_mac.logged_in: only this lane's login hold on this clip; it waits for the Mac again. */
  const loggedIn = (lane, id, key) => {
    const h = lane.helper;
    if (!(h?.state === "needs_you" && h.needsYouCode === "login" && h[key] === id)) {
      return { status: 409, body: { error: { code: "conflict", message: "Your Mac isn't waiting for a TikTok login on this one." } } };
    }
    lane.helper = { seenAt: h.seenAt, state: "ok", setUp: true };
    const back = lane.stopped[id];
    delete lane.stopped[id];
    if (back) lane.queue.push({ ...back, state: "waiting" });
    knobs.loggedIn = true;
    return { helper: lane.helper, outcome: back ? "resumed" : "cleared" };
  };
  const routes = {
    "GET /v1/tiktok/mac": () =>
      knobs.failQueueAfterLoggedIn && knobs.loggedIn
        ? { status: 500, body: { error: { message: "Clip Factory is down." } } }
        : { on, helper: lanes.clips.helper, queue: lanes.clips.queue },
    "GET /v1/accounts": () => ({ accounts: [{ platform: "tiktok", status: "connected", handle: "@lamo.clips" }] }),
    "POST /v1/tiktok/mac/ping": () => ({ on: true }),
    "GET /v1/workspaces": () => ({ workspaces: [{ workspaceId: "clips", workspaceType: "clips" }, { workspaceId: "stories", workspaceType: "stories" }] }),
    "POST /v1/clips/c1/tiktok/mac/claim": () => claim(lanes.clips, "c1"),
    "GET /v1/clips/c1/file": () => ({ url: "https://files.example/c1.mp4", filename: "clip-factory-hi.mp4" }),
    "POST /v1/clips/c1/tiktok/mac/step": () => ({ job: {} }),
    "POST /v1/clips/c1/tiktok/mac/stopped": (body) => stop(lanes.clips, "c1", body),
    "POST /v1/clips/c1/tiktok/mac/logged-in": () => loggedIn(lanes.clips, "c1", "needsYouClipId"),
    "GET /v1/posts?clipId=c1": () => ({ posts: [] }),
    [`GET ${W}/tiktok/mac?version=${VERSION}`]: () => ({
      on: true,
      helper: lanes.ws.helper,
      account: { handle: "@clips.funded", accountName: "Clips Funded", status: "connected" },
      queue: lanes.ws.queue,
    }),
    [`POST ${W}/tiktok/mac/ping`]: () => ({ on: true }),
    [`POST ${W}/publishing/pj-1/mac/claim`]: () => claim(lanes.ws, "pj-1"),
    [`GET ${W}/stories/s1/download`]: () => ({ url: "https://files.example/s1.mp4" }),
    [`POST ${W}/publishing/pj-1/mac/step`]: () => ({ job: {} }),
    [`POST ${W}/publishing/pj-1/mac/stopped`]: (body) => stop(lanes.ws, "pj-1", body),
    [`POST ${W}/publishing/pj-1/mac/logged-in`]: () => loggedIn(lanes.ws, "pj-1", "needsYouJobId"),
    [`GET ${W}/publishing`]: () => ({ publishingJobs: [] }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === "https://app.example/config.json") return Response.json({ region: "eu-west-1", userPoolClientId: "client", apiUrl: API });
    if (u.startsWith("https://cognito-idp.")) {
      const token = `access-${issued.size + 1}`;
      issued.set(token, Date.now());
      return Response.json({ AuthenticationResult: { AccessToken: token, ExpiresIn: 900 } });
    }
    if (u.startsWith("https://files.example/")) return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]));
    const token = String(init.headers?.Authorization || "").replace(/^Bearer /, "");
    const call = { at: Date.now(), route: `${init.method || "GET"} ${u.slice(API.length)}`, token, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    // API Gateway's JWT authorizer: a token 15 minutes old or older is refused before Clip Factory sees the call.
    if (!(issued.has(token) && Date.now() - issued.get(token) < 15 * MIN)) {
      call.status = 401;
      return Response.json({ message: "Unauthorized" }, { status: 401 });
    }
    const answer = routes[call.route];
    if (!answer) {
      call.status = 404;
      return Response.json({ error: { message: "not here" } }, { status: 404 });
    }
    const out = answer(call.body);
    const status = Number.isInteger(out?.status) && out.body ? out.status : 200;
    call.status = status;
    return Response.json(status === 200 ? out : out.body, { status });
  };
  return { issued, calls, lanes, knobs };
}

/** Runs ``work`` on the faked clock, a second of it after each real millisecond (the Keychain tool runs for real). */
async function onClock(t, work) {
  let done = false;
  const run = work().finally(() => {
    done = true;
  });
  while (!done) {
    await new Promise((r) => realTimeout(r, 1));
    t.mock.timers.tick(1000);
  }
  return run;
}

function freshMac(state, settings = {}) {
  fs.rmSync(path.join(base, "state.json"), { force: true });
  fs.rmSync(process.env.CF_TT_DOWNLOADS, { recursive: true, force: true });
  fs.writeFileSync(path.join(base, "settings.json"), JSON.stringify(settings));
  fs.writeFileSync(path.join(base, "state.json"), JSON.stringify({ device: "mac-tick-token", ledger: {}, posted: [], ...state }));
  resetMac();
}

test("Clip Factory's post through a 20-minute TikTok login wait: every beat and the needs-you stop get 200, the stop with a renewed token, and the next tick holds it", async (t) => {
  // TikTok refused the saved login before, so it is the owner's turn at once: his window, and he never logs in.
  freshMac({ loginRefused: "2026-11-23T20:00:00.000Z" });
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: START });
  const server = clipFactory({ clipsQueue: [{ ...clipsJob }] });
  const result = await onClock(t, tick);
  assert.equal(result.action, "post");
  assert.deepEqual(server.calls.filter((c) => c.status !== 200), []);
  assert.deepEqual(mac.opened, [
    { lane: "clips", visible: false },
    { lane: "clips", visible: true }, // the helper's window on TikTok's login, for 20 minutes
  ]);
  const [first] = server.issued.keys(); // the tick's sign-in
  const stops = server.calls.filter((c) => c.route === "POST /v1/clips/c1/tiktok/mac/stopped");
  assert.equal(stops.length, 1);
  const [stop] = stops;
  assert.deepEqual([stop.status, stop.body.needsYou, stop.body.attempt, stop.body.reason], [200, true, 1, REASONS.login]);
  assert.equal(stop.body.code, "login"); // §47.11: only a TikTok login problem, so the hold may end by itself
  assert.ok(stop.at - START >= 20 * MIN, "the stop came after the whole 20-minute wait");
  assert.notEqual(stop.token, first);
  assert.ok(server.issued.get(stop.token) - START >= 13 * MIN, "a token renewed before the first one ran out");
  // Its two steps, then its beat every minute of the wait, past the first token's 15 minutes (each 200, above).
  const steps = server.calls.filter((c) => c.route === "POST /v1/clips/c1/tiktok/mac/step");
  assert.deepEqual(steps.slice(0, 2).map((c) => c.body.step), ["video", "opening"]);
  const beats = steps.slice(2);
  assert.ok(beats.length >= 15 && beats.every((c) => c.body.step === "opening" && c.body.attempt === 1), `${beats.length} beats`);
  assert.ok(beats.some((c) => c.at - START >= 15 * MIN && c.token !== first));
  assert.equal(server.lanes.clips.helper.state, "needs_you");

  // The next tick: Clip Factory holds the clip for the owner, so it is not resumed and no window opens again. Its
  // stop was only a login problem, so the tick looks (headless, §47.11): still logged out, it stays held.
  const seen = server.calls.length;
  const next = await onClock(t, tick);
  assert.equal(next.action, "paused");
  assert.deepEqual(mac.opened.slice(2), [{ lane: "clips", visible: false }]);
  const later = server.calls.slice(seen);
  assert.ok(!later.some((c) => /\/mac\/(claim|step|stopped)$/.test(c.route)), later.map((c) => c.route).join(", "));
  assert.equal(later.find((c) => c.route === "POST /v1/tiktok/mac/ping").body.state, "needs_you");
});

test("a Clips Funded post through its 20-minute login window (wsLanes): every beat and the needs-you stop get 200, the stop with a renewed token, and the next tick holds it", async (t) => {
  // The lane was set up as @clips.funded; TikTok logged it out since, and the owner never scans the code.
  freshMac({
    clipsAccount: { handle: "@lamo.clips", checkedAt: "2026-11-24T02:00:00.000Z" },
    ws: { stories: { port: 9340, ledger: {}, posted: [], lastPressedAt: null, account: { handle: "@clips.funded", setUpAt: "2026-11-23T20:00:00.000Z" } } },
  });
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: START });
  const server = clipFactory({ wsQueue: [{ ...wsJob }] });
  const result = await onClock(t, tick);
  assert.deepEqual(result.ws, { account: "ws:stories", action: "post" });
  assert.deepEqual(server.calls.filter((c) => c.status !== 200), []);
  assert.deepEqual(mac.windows, [{ lane: "ws:stories", url: QR_URL }]); // the lane's own window, once
  assert.ok(mac.opened.every((o) => o.lane === "ws:stories" && !o.visible));
  const [first] = server.issued.keys();
  const stops = server.calls.filter((c) => c.route === `POST ${W}/publishing/pj-1/mac/stopped`);
  assert.equal(stops.length, 1);
  const [stop] = stops;
  assert.deepEqual([stop.status, stop.body.needsYou, stop.body.attempt, stop.body.reason], [200, true, 1, WS_REASONS.login]);
  assert.equal(stop.body.code, "login");
  assert.ok(stop.at - START >= 20 * MIN, "the stop came after the whole 20-minute window");
  assert.notEqual(stop.token, first);
  assert.ok(server.issued.get(stop.token) - START >= 13 * MIN, "a token renewed before the first one ran out");
  const steps = server.calls.filter((c) => c.route === `POST ${W}/publishing/pj-1/mac/step`);
  assert.deepEqual(steps.slice(0, 2).map((c) => c.body.step), ["video", "opening"]);
  const beats = steps.slice(2);
  assert.ok(beats.length >= 15 && beats.every((c) => c.body.step === "opening" && c.body.attempt === 1), `${beats.length} beats`);
  assert.ok(beats.some((c) => c.at - START >= 15 * MIN && c.token !== first));
  // Nothing of it went through Clip Factory's own routes.
  assert.ok(!server.calls.some((c) => c.route.includes("/clips/")));
  assert.equal(server.lanes.ws.helper.state, "needs_you");

  // The next tick: the lane is held for the owner (Log in on my Mac), so nothing is resumed and no window opens.
  const seen = server.calls.length;
  const opened = mac.opened.length;
  const next = await onClock(t, tick);
  assert.equal(next.ws, undefined);
  assert.deepEqual(mac.opened.slice(opened), [{ lane: "ws:stories", visible: false }]); // §47.11's headless look
  assert.equal(mac.windows.length, 1);
  const later = server.calls.slice(seen);
  assert.ok(!later.some((c) => /\/mac\/(claim|step|stopped)$/.test(c.route)), later.map((c) => c.route).join(", "));
  assert.equal(later.find((c) => c.route === `POST ${W}/tiktok/mac/ping`).body.state, "needs_you");
});

// --- §47.11: a hold that is only a TikTok login ends by itself ------------------------------------------------------

const LOGIN_HOLD = { seenAt: "2026-11-24T02:59:00.000Z", state: "needs_you", reason: REASONS.login, needsYouCode: "login", needsYouClipId: "c1" };
const WS_LOGIN_HOLD = { seenAt: "2026-11-24T02:59:00.000Z", state: "needs_you", setUp: false, reason: WS_REASONS.login, needsYouCode: "login", needsYouJobId: "pj-1", needsYouStoryId: "s1" };
const STOPPED = { c1: { ...clipsJob, state: "stopped", attempt: 1 }, "pj-1": { ...wsJob, state: "stopped", attempt: 1 } };
const CF_ACCOUNT = { clipsAccount: { handle: "@lamo.clips", checkedAt: "2026-11-24T02:00:00.000Z" } };
const routesOf = (calls) => calls.map((c) => c.route);
const pings = (calls, route = "POST /v1/tiktok/mac/ping") => calls.filter((c) => c.route === route).map((c) => c.body);

test("held for a TikTok login, still logged out: one headless look, no route call, the login words, and no look again for 5 minutes", async (t) => {
  freshMac({ ...CF_ACCOUNT });
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: START });
  const server = clipFactory({ clipsHelper: { ...LOGIN_HOLD }, stopped: STOPPED });
  const result = await onClock(t, tick);
  assert.equal(result.action, "paused");
  assert.deepEqual(mac.opened, [{ lane: "clips", visible: false }]); // the look: hidden, nothing on screen
  assert.deepEqual(mac.visits, []); // no session cookie: no TikTok page is loaded at all
  assert.deepEqual(mac.windows, []);
  assert.ok(!routesOf(server.calls).some((r) => r.endsWith("/logged-in")));
  const [ping] = pings(server.calls);
  assert.deepEqual([ping.state, ping.reason], ["needs_you", REASONS.login]);
  // A minute later: not due yet. Five minutes after the look: it looks again.
  t.mock.timers.tick(60_000);
  await onClock(t, tick);
  assert.equal(mac.opened.length, 1);
  t.mock.timers.tick(4 * MIN);
  await onClock(t, tick);
  assert.equal(mac.opened.length, 2);
});

test("held for a TikTok login, now logged in as @lamo.clips: the route, a fresh read, an ok check-in, and the clip goes in the same tick", async (t) => {
  freshMac({ ...CF_ACCOUNT, ledger: { c1: { step: "stopped", device: "mac-tick-token", tries: 1 } } });
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: START });
  mac.account = { clips: { handle: "@lamo.clips", uid: "7001000001" } };
  const server = clipFactory({ clipsHelper: { ...LOGIN_HOLD }, stopped: STOPPED });
  const result = await onClock(t, tick);
  assert.equal(result.action, "post");
  const routes = routesOf(server.calls);
  const back = routes.indexOf("POST /v1/clips/c1/tiktok/mac/logged-in");
  assert.ok(back > 0, routes.join(", "));
  assert.equal(server.calls[back].body.device, "mac-tick-token");
  assert.equal(routes.indexOf("GET /v1/tiktok/mac", back) > back, true, "the queue is read again after the route");
  const [ping] = pings(server.calls);
  assert.equal(ping.state, "ok");
  assert.equal(ping.reason, undefined);
  assert.ok(routes.indexOf("POST /v1/clips/c1/tiktok/mac/claim") > back, "claimed in the same tick");
  // This try went on to TikTok's upload page (the fake has none): a plain stop, never a login code.
  const stops = server.calls.filter((c) => c.route === "POST /v1/clips/c1/tiktok/mac/stopped");
  assert.deepEqual(stops.map((c) => [c.body.reason, c.body.code]), [[REASONS.noUpload, undefined]]);
  assert.ok(mac.opened.every((o) => !o.visible));
  const state = JSON.parse(fs.readFileSync(path.join(base, "state.json"), "utf8"));
  assert.equal(state.ledger.c1.loginBacks.length, 1);
  assert.equal(state.clipsAccount.uid, "7001000001"); // pinned on its first same
  const events = fs.readFileSync(path.join(base, "events.log"), "utf8");
  assert.match(events, /"kind":"login_back","account":"clips","clipId":"c1","outcome":"resumed"/);
});

test("held for a TikTok login, logged in as @clips.funded in Clip Factory's lane: no route call, and the check-in says it's the wrong account", async (t) => {
  freshMac({ ...CF_ACCOUNT });
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: START });
  mac.account = { clips: "@clips.funded" };
  const server = clipFactory({ clipsHelper: { ...LOGIN_HOLD }, stopped: STOPPED });
  const result = await onClock(t, tick);
  assert.equal(result.action, "paused");
  assert.ok(!routesOf(server.calls).some((r) => r.endsWith("/logged-in") || r.endsWith("/claim")));
  const [ping] = pings(server.calls);
  assert.deepEqual([ping.state, ping.reason], ["needs_you", "Your Mac is logged in to TikTok as @clips.funded, not @lamo.clips. Nothing was posted."]);
});

test("the route ended the hold but the second read fails: no check-in at all this tick (never a stale needs_you)", async (t) => {
  freshMac({ ...CF_ACCOUNT });
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: START });
  mac.account = { clips: { handle: "@lamo.clips", uid: "7001000001" } };
  const server = clipFactory({ clipsHelper: { ...LOGIN_HOLD }, stopped: STOPPED });
  server.knobs.failQueueAfterLoggedIn = true;
  const result = await onClock(t, tick);
  assert.deepEqual(result, { action: "login_back", outcome: "resumed" });
  assert.deepEqual(pings(server.calls), []);
  assert.ok(!routesOf(server.calls).some((r) => r.endsWith("/claim")));
});

test("a puzzle, a limit, an older helper's hold (no code), the switch off or the Mac paused: the helper never looks", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: START });
  const holds = [
    { ...LOGIN_HOLD, needsYouCode: undefined, reason: REASONS.captcha },
    { ...LOGIN_HOLD, needsYouCode: undefined, reason: REASONS.limit },
    { ...LOGIN_HOLD, needsYouCode: undefined },
  ];
  for (const [helper, on, settings] of [...holds.map((h) => [h, true, {}]), [LOGIN_HOLD, false, {}], [LOGIN_HOLD, true, { paused: true }]]) {
    freshMac({ ...CF_ACCOUNT }, settings);
    mac.account = { clips: { handle: "@lamo.clips", uid: "7001000001" } };
    const server = clipFactory({ clipsHelper: { ...helper }, stopped: STOPPED, on });
    await onClock(t, tick);
    assert.deepEqual(mac.opened, [], JSON.stringify({ helper, on, settings }));
    assert.ok(!routesOf(server.calls).some((r) => r.endsWith("/logged-in")));
  }
});

test("a Clips Funded login hold: no look while Clip Factory posts; when Clip Factory is idle, a look and the Clips Funded route", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: START });
  const wsState = { ws: { stories: { port: 9340, ledger: {}, posted: [], lastPressedAt: null, account: { handle: "@clips.funded" } } } };
  freshMac({ ...CF_ACCOUNT, ...wsState });
  mac.account = { clips: { handle: "@lamo.clips", uid: "7001000001" }, "ws:stories": { handle: "@clips.funded", uid: "7002000002" } };
  let server = clipFactory({ clipsQueue: [{ ...clipsJob }], wsHelper: { ...WS_LOGIN_HOLD }, stopped: STOPPED });
  const busy = await onClock(t, tick);
  assert.equal(busy.action, "post");
  assert.ok(!routesOf(server.calls).some((r) => r.endsWith("/logged-in")));
  assert.ok(!mac.opened.some((o) => o.lane === "ws:stories"));
  assert.equal(pings(server.calls, `POST ${W}/tiktok/mac/ping`)[0].state, "needs_you");

  freshMac({ ...CF_ACCOUNT, ...wsState });
  mac.account = { clips: { handle: "@lamo.clips", uid: "7001000001" }, "ws:stories": { handle: "@clips.funded", uid: "7002000002" } };
  server = clipFactory({ wsHelper: { ...WS_LOGIN_HOLD }, stopped: STOPPED });
  await onClock(t, tick);
  const routes = routesOf(server.calls);
  const back = routes.indexOf(`POST ${W}/publishing/pj-1/mac/logged-in`);
  assert.ok(back > 0, routes.join(", "));
  assert.ok(routes.indexOf(`GET ${W}/tiktok/mac?version=${VERSION}`, back) > back, "the lane's queue is read again");
  const [ping] = pings(server.calls, `POST ${W}/tiktok/mac/ping`);
  assert.equal(ping.state, "ok");
  assert.ok(!routes.some((r) => r.includes("/clips/c1/")));
  // The look, then the resumed post itself in the same tick: hidden, never a window.
  const wsOpens = mac.opened.filter((o) => o.lane === "ws:stories");
  assert.ok(wsOpens.length >= 1 && wsOpens.every((o) => !o.visible), JSON.stringify(wsOpens));
  assert.ok(routes.indexOf(`POST ${W}/publishing/pj-1/mac/claim`) > back, "the resumed post is claimed in the same tick");
  assert.deepEqual(mac.windows, []);
});

test("a Clips Funded login hold logged in as Clip Factory's @lamo.clips: no route call, and its check-in says so", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: START });
  freshMac({ ...CF_ACCOUNT, ws: { stories: { port: 9340, ledger: {}, posted: [], lastPressedAt: null, account: null } } });
  mac.account = { "ws:stories": { handle: "@lamo.clips" } };
  const server = clipFactory({ wsHelper: { ...WS_LOGIN_HOLD }, stopped: STOPPED });
  await onClock(t, tick);
  assert.ok(!routesOf(server.calls).some((r) => r.endsWith("/logged-in")));
  const [ping] = pings(server.calls, `POST ${W}/tiktok/mac/ping`);
  assert.deepEqual([ping.state, ping.reason], ["needs_you", "Your Mac is logged in to TikTok as @lamo.clips, not @clips.funded. Nothing was posted."]);
});

test("logged out again right after the owner's login (24 Nov): the stop carries the login code, and the window closes 3 seconds after the session shows", async (t) => {
  freshMac({ ...CF_ACCOUNT, loginRefused: "2026-11-23T20:00:00.000Z" });
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: START });
  mac.ownerLogsInAfterMs = 5000; // he logs in in the window; the hidden Chrome still reads logged out
  const server = clipFactory({ clipsQueue: [{ ...clipsJob }] });
  await onClock(t, tick);
  assert.deepEqual(mac.opened, [
    { lane: "clips", visible: false },
    { lane: "clips", visible: true },
    { lane: "clips", visible: false }, // the second try, after his login
  ]);
  const stops = server.calls.filter((c) => c.route === "POST /v1/clips/c1/tiktok/mac/stopped");
  assert.deepEqual(stops.map((c) => [c.body.reason, c.body.needsYou, c.body.code]), [[REASONS.login, true, "login"]]);
  assert.ok(stops[0].at - START < 5 * MIN, "the second try's stop, not the 20-minute wait");
  // D6: the window stays 3 seconds after TikTok's session shows.
  const shown = mac.sessionShownAt;
  const closed = mac.quitsAt.find((q) => q.visible);
  assert.ok(shown && closed, JSON.stringify(mac.quitsAt));
  assert.ok(closed.at - shown >= 3000, `${closed.at - shown} ms`);
  assert.equal(server.lanes.clips.helper.needsYouCode, "login");
});

test("a puzzle while logged in is a stop with no code; a server from before §47.11 still gets the login stop, without its code", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: START });
  freshMac({ ...CF_ACCOUNT });
  mac.account = { clips: { handle: "@lamo.clips", uid: "7001000001" } };
  mac.text = "Verify to continue";
  let server = clipFactory({ clipsQueue: [{ ...clipsJob }] });
  await onClock(t, tick);
  let stops = server.calls.filter((c) => c.route === "POST /v1/clips/c1/tiktok/mac/stopped");
  assert.deepEqual(stops.map((c) => [c.body.reason, c.body.needsYou, c.body.code]), [[REASONS.captcha, true, undefined]]);
  assert.equal(server.lanes.clips.helper.needsYouCode, undefined);

  freshMac({ ...CF_ACCOUNT, loginRefused: "2026-11-23T20:00:00.000Z" });
  mac.ownerLogsInAfterMs = 5000;
  server = clipFactory({ clipsQueue: [{ ...clipsJob }], oldServer: true });
  await onClock(t, tick);
  stops = server.calls.filter((c) => c.route === "POST /v1/clips/c1/tiktok/mac/stopped");
  assert.deepEqual(stops.map((c) => [c.status, c.body.code]), [[400, "login"], [200, undefined]]);
  assert.equal(server.lanes.clips.helper.state, "needs_you");
});
