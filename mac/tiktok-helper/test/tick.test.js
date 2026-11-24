// §47.10.7 and D2: one whole tick against a fake server (no Chrome, no real Keychain, a throwaway folder).
// Clip Factory's lane checks in exactly as 1.1.0 did and goes first; Clips Funded's lane checks in after it, with
// its own keys, and acts only when Clip Factory's lane has nothing to do; a Clips Funded error never reaches it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "cf-tick-test-"));
process.env.CF_TT_BASE = base;
process.env.CF_TT_DOWNLOADS = path.join(base, "Downloads");
process.env.CF_TT_CONTROL = path.join(base, "control"); // no frame app, no pop-ups
process.env.CF_TT_APP_URL = "https://app.example";
// The Keychain: a Clip Factory sign-in, and no saved TikTok login.
const fake = path.join(base, "security");
fs.writeFileSync(
  fake,
  `#!/bin/sh\ncase "$*" in *refresh-token*-w*) echo "refresh-1";; *) exit 44;; esac\n`,
  { mode: 0o755 }
);
process.env.CF_TT_SECURITY = fake;

const { tick } = await import("../src/run.js");
const { VERSION } = await import("../src/paths.js");

const API = "https://api.example";
const W = `${API}/v1/workspaces/stories`;

/** A fake server: ``routes`` maps "METHOD url" to a body (or {status, body}); every call is recorded. */
function serve(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    calls.push({ method, url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
    if (String(url) === "https://app.example/config.json") {
      return Response.json({ region: "eu-west-1", userPoolClientId: "client", apiUrl: API });
    }
    if (String(url).startsWith("https://cognito-idp.")) return Response.json({ AuthenticationResult: { AccessToken: "tok" } });
    const hit = routes[`${method} ${url}`];
    if (hit === undefined) return Response.json({ error: { message: "not here" } }, { status: 404 });
    const { status = 200, body = hit } = hit && hit.status ? hit : {};
    return Response.json(body, { status });
  };
  return calls;
}

const clipsJob = { clipId: "c1", postId: "p1", hook: "Hi", caption: "hi", state: "waiting", source: "upload", since: "2026-11-23T20:00:00Z", attempt: 0 };
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
  since: "2026-11-23T20:01:00Z",
  state: "waiting",
  attempt: 0,
};
const common = (clipsQueue, wsStatus) => ({
  [`GET ${API}/v1/tiktok/mac`]: { on: true, helper: null, queue: clipsQueue },
  [`GET ${API}/v1/accounts`]: { accounts: [{ platform: "tiktok", status: "connected", handle: "@lamo.clips" }] },
  [`POST ${API}/v1/tiktok/mac/ping`]: {},
  [`GET ${API}/v1/workspaces`]: { workspaces: [{ workspaceId: "clips", workspaceType: "clips" }, { workspaceId: "stories", workspaceType: "stories" }] },
  [`GET ${W}/tiktok/mac?version=${VERSION}`]: wsStatus,
  [`POST ${W}/tiktok/mac/ping`]: { on: true },
  [`POST ${API}/v1/clips/c1/tiktok/mac/claim`]: { status: 409, body: { error: { message: "Another try already has this clip." } } },
  [`POST ${W}/publishing/pj-1/mac/claim`]: { status: 409, body: { error: { message: "Your Mac isn't posting this one." } } },
});
const wsOn = (over = {}) => ({ on: true, helper: null, account: { handle: "@clips.funded", accountName: "Clips Funded", status: "connected" }, queue: [wsJob], ...over });
const paths = (calls) => calls.filter((c) => c.url.startsWith(API)).map((c) => `${c.method} ${c.url.slice(API.length)}`);

test("Clip Factory's clip goes first: its check-in is 1.1.0's, Clips Funded checks in after it, and waits", async () => {
  const calls = serve(common([clipsJob], wsOn()));
  const result = await tick();
  assert.equal(result.action, "claim_refused"); // Clip Factory's claim was tried; nothing of Clips Funded's
  assert.deepEqual(paths(calls), [
    "GET /v1/tiktok/mac",
    "GET /v1/accounts",
    "POST /v1/tiktok/mac/ping",
    "GET /v1/workspaces",
    `GET /v1/workspaces/stories/tiktok/mac?version=${VERSION}`,
    "POST /v1/workspaces/stories/tiktok/mac/ping",
    "POST /v1/clips/c1/tiktok/mac/claim",
  ]);
  const clipsPing = calls.find((c) => c.url === `${API}/v1/tiktok/mac/ping`).body;
  assert.deepEqual(Object.keys(clipsPing).sort(), ["device", "login", "state", "version"]);
  assert.deepEqual([clipsPing.state, clipsPing.version, clipsPing.login], ["ok", VERSION, "none"]);
  // 1.3.0: the claim also says the helper's version (MAC_BRAND_FROM: only it gets posts with TikTok's label).
  assert.deepEqual(calls.find((c) => c.url === `${API}/v1/clips/c1/tiktok/mac/claim`).body, { device: clipsPing.device, version: VERSION });
  const wsPing = calls.find((c) => c.url === `${W}/tiktok/mac/ping`).body;
  assert.deepEqual(wsPing, { state: "ok", version: VERSION, device: clipsPing.device, setUp: false });
  // Clip Factory's account is known now (D3), and Clips Funded's lane has its own port and store.
  const state = JSON.parse(fs.readFileSync(path.join(base, "state.json"), "utf8"));
  assert.equal(state.clipsAccount.handle, "@lamo.clips");
  assert.equal(state.ws.stories.port, 9340);
  assert.deepEqual(state.ledger, {});
});

test("with nothing for Clip Factory, Clips Funded's job waits until the Mac is logged in to it, then is claimed", async () => {
  const before = serve(common([], wsOn()));
  const waiting = await tick();
  assert.equal(waiting.ws, undefined);
  assert.ok(!before.some((c) => c.url.endsWith("/mac/claim")));
  // The owner logged the lane in (its profile reads @clips.funded): now it is claimed, with this helper's version.
  const file = path.join(base, "state.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.ws.stories.account = { handle: "@clips.funded", setUpAt: "2026-11-23T20:00:00Z" };
  fs.writeFileSync(file, JSON.stringify(state));
  const calls = serve(common([], wsOn()));
  const result = await tick();
  const ping = calls.find((c) => c.url === `${W}/tiktok/mac/ping`).body;
  assert.deepEqual([ping.setUp, ping.handle], [true, "@clips.funded"]);
  assert.deepEqual(result.ws, { account: "ws:stories", action: "post" });
  const claim = calls.find((c) => c.url === `${W}/publishing/pj-1/mac/claim`);
  assert.deepEqual(claim.body, { device: claim.body.device, version: VERSION });
  assert.ok(!calls.some((c) => c.url.includes("/clips/")));
});

test("Clips Funded's own needs-you holds only its lane; its errors never stop Clip Factory's", async () => {
  const held = serve(common([], wsOn({ helper: { seenAt: "2026-11-23T20:00:00Z", state: "needs_you", setUp: true, reason: "TikTok logged your Mac out. Tap Log in on my Mac." } })));
  const r = await tick();
  assert.equal(r.ws, undefined);
  assert.ok(!held.some((c) => c.url.endsWith("/mac/claim")));
  const ping = held.find((c) => c.url === `${W}/tiktok/mac/ping`).body;
  assert.deepEqual([ping.state, ping.reason], ["needs_you", "TikTok logged your Mac out. Tap Log in on my Mac."]);
  // Its queue read fails: Clip Factory's lane still checks in and claims.
  const routes = common([clipsJob], wsOn());
  routes[`GET ${W}/tiktok/mac?version=${VERSION}`] = { status: 500, body: { error: { message: "down" } } };
  const broken = serve(routes);
  assert.equal((await tick()).action, "claim_refused");
  assert.ok(broken.some((c) => c.url === `${API}/v1/clips/c1/tiktok/mac/claim`));
  // The workspace list fails: the same.
  const routes2 = common([clipsJob], wsOn());
  delete routes2[`GET ${API}/v1/workspaces`];
  const noList = serve(routes2);
  assert.equal((await tick()).action, "claim_refused");
  assert.ok(!noList.some((c) => c.url.startsWith(W)));
  const log = fs.readFileSync(path.join(base, "helper.log"), "utf8");
  assert.match(log, /"message":"ws.error"/);
});

test("without Clip Factory's TikTok account, its clip waits (no claim, no stop): it never posts to an unknown account", async () => {
  fs.rmSync(path.join(base, "state.json"), { force: true }); // no cached account, no posts either
  const routes = common([clipsJob], wsOn({ queue: [] }));
  routes[`GET ${API}/v1/accounts`] = { accounts: [{ platform: "tiktok", status: "not_connected" }] };
  const calls = serve(routes);
  const r = await tick();
  assert.deepEqual([r.action, r.reason], ["wait", "Your Mac can't tell which TikTok is Clip Factory's. Connect TikTok in Settings › Posting."]);
  assert.ok(!calls.some((c) => c.url.endsWith("/claim") || c.url.endsWith("/stopped")));
  // Never silent: Clip Factory's rows say why its TikTok posts wait.
  const ping = calls.find((c) => c.url === `${API}/v1/tiktok/mac/ping`).body;
  assert.deepEqual([ping.state, ping.reason], ["paused", r.reason]);
});

test("1.1.0's Mac with no @name in Settings goes on as before: the account of its own posts is Clip Factory's", async () => {
  const file = path.join(base, "state.json");
  fs.rmSync(file, { force: true });
  serve(common([], wsOn({ queue: [] })));
  await tick(); // a state.json with this Mac's device
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  delete state.clipsAccount;
  state.posted = [
    { clipId: "a", link: "https://www.tiktok.com/@lamo.clips/video/7710644811602169121", at: "2026-11-22T12:00:00Z" },
    { clipId: "b", link: "https://www.tiktok.com/@lamo.clips/video/7710644811602169122", at: "2026-11-22T18:00:00Z" },
  ];
  fs.writeFileSync(file, JSON.stringify(state));
  const routes = common([clipsJob], wsOn({ queue: [] }));
  routes[`GET ${API}/v1/accounts`] = { accounts: [{ platform: "tiktok", status: "connected", handle: "Lamo Clips" }] };
  const calls = serve(routes);
  assert.equal((await tick()).action, "claim_refused"); // its clip is claimed, as in 1.1.0
  assert.ok(calls.some((c) => c.url === `${API}/v1/clips/c1/tiktok/mac/claim`));
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).clipsAccount.handle, "@lamo.clips");
  assert.equal(calls.find((c) => c.url === `${API}/v1/tiktok/mac/ping`).body.state, "ok");
});

test("posts on two accounts, or on a Clips Funded account, never become Clip Factory's account", async () => {
  const { postedHandle } = await import("../src/run.js");
  const link = (h, n) => ({ link: `https://www.tiktok.com/@${h}/video/77106448116021691${n}` });
  assert.equal(postedHandle({ posted: [link("lamo.clips", 21), link("lamo.clips", 22)] }), "@lamo.clips");
  assert.equal(postedHandle({ posted: [link("lamo.clips", 21), link("clips.funded", 22)] }), null);
  assert.equal(postedHandle({ posted: [] }), null);
  assert.equal(postedHandle({ posted: [link("clips.funded", 21)], ws: { stories: { connected: "@clips.funded" } } }), null);
});

test("the owner's Start my Mac again in Clips Funded ends this Mac's pause, and its ping says it was done", async () => {
  fs.writeFileSync(path.join(base, "settings.json"), JSON.stringify({ paused: true }));
  const at = "2026-11-23T21:00:00.000Z";
  const calls = serve(common([], wsOn({ queue: [], helper: { seenAt: "2026-11-23T20:59:00Z", state: "paused", setUp: true, version: VERSION, resumeRequest: { at } } })));
  await tick();
  assert.equal(JSON.parse(fs.readFileSync(path.join(base, "settings.json"), "utf8")).paused, false);
  const ping = calls.find((c) => c.url === `${W}/tiktok/mac/ping`).body;
  assert.deepEqual([ping.state, ping.resumeDone], ["ok", at]);
  // The workspace's connected account is kept: Clip Factory's lane never posts to it.
  assert.equal(JSON.parse(fs.readFileSync(path.join(base, "state.json"), "utf8")).ws.stories.connected, "@clips.funded");
});

test("while Clip Factory's clip goes first, Clips Funded's pressed post still gets its beat", async () => {
  const file = path.join(base, "state.json");
  fs.writeFileSync(path.join(base, "settings.json"), JSON.stringify({}));
  serve(common([], wsOn({ queue: [] })));
  await tick();
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.ws.stories.ledger["pj-1"] = { device: state.device, step: "finding", pressedAt: "2026-11-23T20:10:00Z" };
  fs.writeFileSync(file, JSON.stringify(state));
  const pressed = { ...wsJob, state: "working", pressedAt: "2026-11-23T20:10:00Z", attempt: 1 };
  const calls = serve({ ...common([clipsJob], wsOn({ queue: [pressed] })), [`POST ${W}/publishing/pj-1/mac/step`]: { job: {} } });
  assert.equal((await tick()).action, "claim_refused");
  const beat = calls.find((c) => c.url === `${W}/publishing/pj-1/mac/step`);
  assert.deepEqual(beat.body, { device: state.device, step: "finding", attempt: 1 });
});

test("a TikTok token that needs renewing is still Clip Factory's account: its Mac posts don't wait for a reconnect", async () => {
  const { clipsTarget } = await import("../src/run.js");
  const state = {};
  const api = (accounts) => ({ accounts: async () => ({ accounts }) });
  assert.equal(await clipsTarget(api([{ platform: "tiktok", status: "needs_reconnect", handle: "@lamo.clips" }]), state), "@lamo.clips");
  assert.equal(state.clipsAccount.handle, "@lamo.clips");
  // Not connected (no handle) or a nickname: the cached handle stays the target, never a guess.
  assert.equal(await clipsTarget(api([{ platform: "tiktok", status: "not_connected" }]), state), "@lamo.clips");
  assert.equal(await clipsTarget(api([{ platform: "tiktok", status: "connected", handle: "Lamo Clips" }]), state), "@lamo.clips");
  assert.equal(await clipsTarget(api([{ platform: "youtube", status: "connected", handle: "@lamo" }]), {}), null);
});

test("a tick that outlasts its token gets a fresh one for every call, Clip Factory's and Clips Funded's: no 401", async (t) => {
  // 24 Nov 2026: tick() bound one 15-minute token to every client, so after a 20-minute TikTok login wait its beats
  // and its stop got 401 and never reached Clip Factory. Here each call takes 16 minutes of a faked clock, so a token
  // bound once, by tick() or by wsLanes(), is refused (as API Gateway's JWT authorizer does) from the next call on.
  fs.rmSync(path.join(base, "state.json"), { force: true });
  fs.writeFileSync(path.join(base, "settings.json"), JSON.stringify({}));
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-24T03:00:00Z") });
  const routes = common([clipsJob], wsOn({ queue: [] }));
  const issued = new Map(); // each access token, and when Cognito gave it
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    if (String(url) === "https://app.example/config.json") {
      return Response.json({ region: "eu-west-1", userPoolClientId: "client", apiUrl: API });
    }
    if (String(url).startsWith("https://cognito-idp.")) {
      const token = `tok-${issued.size + 1}`;
      issued.set(token, Date.now());
      return Response.json({ AuthenticationResult: { AccessToken: token, ExpiresIn: 900 } });
    }
    const token = init.headers.Authorization.replace(/^Bearer /, "");
    const fresh = Date.now() - issued.get(token) < 15 * 60_000;
    calls.push({ method, url: String(url), token, status: fresh ? 200 : 401 });
    t.mock.timers.tick(16 * 60_000);
    if (!fresh) return Response.json({ message: "Unauthorized" }, { status: 401 });
    const hit = routes[`${method} ${url}`];
    if (hit === undefined) return Response.json({ error: { message: "not here" } }, { status: 404 });
    const { status = 200, body = hit } = hit && hit.status ? hit : {};
    return Response.json(body, { status });
  };
  const result = await tick();
  assert.equal(result.action, "claim_refused");
  assert.deepEqual(paths(calls), [
    "GET /v1/tiktok/mac",
    "GET /v1/accounts",
    "POST /v1/tiktok/mac/ping",
    "GET /v1/workspaces",
    `GET /v1/workspaces/stories/tiktok/mac?version=${VERSION}`,
    "POST /v1/workspaces/stories/tiktok/mac/ping",
    "POST /v1/clips/c1/tiktok/mac/claim",
  ]);
  assert.deepEqual(calls.filter((c) => c.status === 401), []);
  // Every call came 16 minutes after the one before, so each went with its own token, renewed before it ran out.
  assert.equal(new Set(calls.map((c) => c.token)).size, calls.length);
});
