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
function clipFactory({ clipsQueue = [], wsQueue = [] } = {}) {
  const issued = new Map(); // each access token, and when Cognito gave it
  const calls = [];
  const lanes = { clips: { helper: null, queue: clipsQueue }, ws: { helper: null, queue: wsQueue } };
  const idOf = (job) => job.publishingJobId || job.clipId;
  const claim = (lane, id) => {
    const job = lane.queue.find((j) => idOf(j) === id);
    Object.assign(job, { state: "working", attempt: job.attempt + 1 });
    return { job };
  };
  const stop = (lane, id, body) => {
    lane.queue = lane.queue.filter((j) => idOf(j) !== id);
    if (body.needsYou) lane.helper = { seenAt: new Date().toISOString(), state: "needs_you", setUp: true, reason: body.reason, needsYouClipId: id };
    return { job: { state: "stopped" } };
  };
  const routes = {
    "GET /v1/tiktok/mac": () => ({ on: true, helper: lanes.clips.helper, queue: lanes.clips.queue }),
    "GET /v1/accounts": () => ({ accounts: [{ platform: "tiktok", status: "connected", handle: "@lamo.clips" }] }),
    "POST /v1/tiktok/mac/ping": () => ({ on: true }),
    "GET /v1/workspaces": () => ({ workspaces: [{ workspaceId: "clips", workspaceType: "clips" }, { workspaceId: "stories", workspaceType: "stories" }] }),
    "POST /v1/clips/c1/tiktok/mac/claim": () => claim(lanes.clips, "c1"),
    "GET /v1/clips/c1/file": () => ({ url: "https://files.example/c1.mp4", filename: "clip-factory-hi.mp4" }),
    "POST /v1/clips/c1/tiktok/mac/step": () => ({ job: {} }),
    "POST /v1/clips/c1/tiktok/mac/stopped": (body) => stop(lanes.clips, "c1", body),
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
    call.status = answer ? 200 : 404;
    return answer ? Response.json(answer(call.body)) : Response.json({ error: { message: "not here" } }, { status: 404 });
  };
  return { issued, calls, lanes };
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

function freshMac(state) {
  fs.rmSync(path.join(base, "state.json"), { force: true });
  fs.rmSync(process.env.CF_TT_DOWNLOADS, { recursive: true, force: true });
  fs.writeFileSync(path.join(base, "settings.json"), JSON.stringify({}));
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

  // The next tick: Clip Factory holds the clip for the owner, so it is not resumed and no window opens again.
  const seen = server.calls.length;
  const next = await onClock(t, tick);
  assert.equal(next.action, "paused");
  assert.equal(mac.opened.length, 2);
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
  assert.equal(mac.opened.length, opened);
  assert.equal(mac.windows.length, 1);
  const later = server.calls.slice(seen);
  assert.ok(!later.some((c) => /\/mac\/(claim|step|stopped)$/.test(c.route)), later.map((c) => c.route).join(", "));
  assert.equal(later.find((c) => c.route === `POST ${W}/tiktok/mac/ping`).body.state, "needs_you");
});
