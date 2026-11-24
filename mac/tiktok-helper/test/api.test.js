import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError, client, wsClient } from "../src/api.js";
import { tokenSource } from "../src/auth.js";
import { VERSION } from "../src/paths.js";

function fake(status = 200, body = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.Authorization });
    return { status, ok: status < 400, json: async () => body };
  };
  return { calls, fetchImpl };
}

test("steps carry the claim's attempt when there is one, and never a bad one", async () => {
  const { calls, fetchImpl } = fake();
  const api = client("https://api.example", "tok", fetchImpl);
  await api.step("c1", "mac-1", "uploading", 2);
  await api.step("c1", "mac-1", "uploading");
  await api.done("c1", "mac-1", "https://www.tiktok.com/@a/video/123456789", 2);
  await api.stopped("c1", "mac-1", "Why.", true, 0);
  assert.deepEqual(calls[0], {
    url: "https://api.example/v1/clips/c1/tiktok/mac/step",
    method: "POST",
    body: { device: "mac-1", step: "uploading", attempt: 2 },
    auth: "Bearer tok",
  });
  assert.deepEqual(calls[1].body, { device: "mac-1", step: "uploading" });
  assert.deepEqual(calls[2].body, { device: "mac-1", link: "https://www.tiktok.com/@a/video/123456789", attempt: 2 });
  assert.deepEqual(calls[3].body, { device: "mac-1", reason: "Why.", needsYou: true });
});

test("a refusal comes back as an ApiError with Clip Factory's own sentence", async () => {
  const { fetchImpl } = fake(409, { error: { code: "conflict", message: "Auto-posting is off, so this one waits." } });
  const api = client("https://api.example", "tok", fetchImpl);
  await assert.rejects(api.claim("c1", "mac-1"), (e) => e instanceof ApiError && e.status === 409 && /Auto-posting is off/.test(e.message));
});

test("Clip Factory's client is unchanged on the wire: the same paths and bodies as 1.1.0", async () => {
  const { calls, fetchImpl } = fake();
  const api = client("https://api.example", "tok", fetchImpl);
  await api.queue();
  await api.ping({ state: "ok", version: VERSION, device: "mac-1" });
  await api.claim("c1", "mac-1");
  await api.file("c1");
  await api.posts("c1");
  assert.deepEqual(
    calls.map((c) => [c.method, c.url, c.body]),
    [
      ["GET", "https://api.example/v1/tiktok/mac", undefined],
      ["POST", "https://api.example/v1/tiktok/mac/ping", { state: "ok", version: VERSION, device: "mac-1" }],
      ["POST", "https://api.example/v1/clips/c1/tiktok/mac/claim", { device: "mac-1" }],
      ["GET", "https://api.example/v1/clips/c1/file", undefined],
      ["GET", "https://api.example/v1/posts?clipId=c1", undefined],
    ]
  );
});

test("a Clips Funded workspace's client: its own paths, the version in the queue and the claim, never /clips/", async () => {
  const { calls, fetchImpl } = fake();
  const api = wsClient("https://api.example", "tok", "stories", fetchImpl);
  await api.queue();
  await api.ping({ state: "ok", version: VERSION, device: "mac-1", setUp: true, handle: "@clips.funded" });
  await api.login();
  await api.claim("pj-1", "mac-1");
  await api.step("pj-1", "mac-1", "uploading", 2);
  await api.done("pj-1", "mac-1", "https://www.tiktok.com/@clips.funded/video/7710644811602169121", 2);
  await api.stopped("pj-1", "mac-1", "Why.", true, 2);
  await api.file({ clipId: "pj-1", publishingJobId: "pj-1", storyId: "s1" });
  await api.story("s1");
  await api.publishing();
  const W = "https://api.example/v1/workspaces/stories";
  assert.deepEqual(
    calls.map((c) => [c.method, c.url, c.body]),
    [
      ["GET", `${W}/tiktok/mac?version=${VERSION}`, undefined],
      ["POST", `${W}/tiktok/mac/ping`, { state: "ok", version: VERSION, device: "mac-1", setUp: true, handle: "@clips.funded" }],
      ["POST", `${W}/tiktok/mac/login`, { action: "sign_in" }],
      ["POST", `${W}/publishing/pj-1/mac/claim`, { device: "mac-1", version: VERSION }],
      ["POST", `${W}/publishing/pj-1/mac/step`, { device: "mac-1", step: "uploading", attempt: 2 }],
      ["POST", `${W}/publishing/pj-1/mac/done`, { device: "mac-1", link: "https://www.tiktok.com/@clips.funded/video/7710644811602169121", attempt: 2 }],
      ["POST", `${W}/publishing/pj-1/mac/stopped`, { device: "mac-1", reason: "Why.", needsYou: true, attempt: 2 }],
      ["GET", `${W}/stories/s1/download`, undefined],
      ["GET", `${W}/stories/s1`, undefined],
      ["GET", `${W}/publishing`, undefined],
    ]
  );
  assert.ok(calls.every((c) => !c.url.includes("/clips/") && c.url.startsWith(`${W}/`)));
  assert.ok(calls.every((c) => c.auth === "Bearer tok"));
  // Its ids are escaped, so a job id can never reach another path.
  await api.claim("../../clips/c1", "mac-1");
  assert.equal(calls.at(-1).url, `${W}/publishing/..%2F..%2Fclips%2Fc1/mac/claim`);
});

test("a Clips Funded refusal comes back as an ApiError with its code", async () => {
  const { fetchImpl } = fake(409, { error: { code: "wrong_account", message: "That post is on another TikTok account." } });
  const api = wsClient("https://api.example", "tok", "stories", fetchImpl);
  await assert.rejects(
    api.done("pj-1", "mac-1", "https://www.tiktok.com/@x/video/7710644811602169121"),
    (e) => e instanceof ApiError && e.status === 409 && e.code === "wrong_account"
  );
});

test("a 401 gets one more try with a fresh token from the tick's source; a plain token is never renewed", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(init.headers.Authorization);
    const ok = init.headers.Authorization === "Bearer new";
    return { status: ok ? 200 : 401, ok, json: async () => ({}) };
  };
  const renewed = [];
  const source = { get: async () => "old", renew: async (stale) => (renewed.push(stale), "new") };
  await client("https://api.example", source, fetchImpl).step("c1", "mac-1", "opening", 2);
  assert.deepEqual(calls, ["Bearer old", "Bearer new"]);
  assert.deepEqual(renewed, ["old"]);
  calls.length = 0;
  await assert.rejects(client("https://api.example", "old", fetchImpl).step("c1", "mac-1", "opening"), (e) => e.status === 401);
  assert.deepEqual(calls, ["Bearer old"]);
  // Twice refused: the second 401 is the answer (no loop).
  calls.length = 0;
  const stuck = { get: async () => "old", renew: async () => "older" };
  await assert.rejects(client("https://api.example", stuck, fetchImpl).stopped("c1", "mac-1", "Why.", true), (e) => e.status === 401);
  assert.deepEqual(calls, ["Bearer old", "Bearer older"]);
});

test("the tick's token source renews before the token runs out, once at a time, and not again for a stale 401", async () => {
  let clock = 0;
  let n = 0;
  const fetchTokens = async () => ({ token: `t${++n}`, expiresIn: 900 });
  const tokens = tokenSource(fetchTokens, () => clock);
  assert.deepEqual(await Promise.all([tokens.get(), tokens.get(), tokens.renew(null)]), ["t1", "t1", "t1"]);
  clock = 12 * 60_000;
  assert.equal(await tokens.get(), "t1"); // 12 minutes in: still good
  clock = 13 * 60_000 + 1;
  assert.equal(await tokens.get(), "t2"); // 2 minutes before the 15: a new one
  assert.equal(await tokens.renew("t1"), "t2"); // a 401 on the old one: the newer one, no extra refresh
  assert.equal(await tokens.renew("t2"), "t3"); // a 401 on the current one: refreshed
  assert.equal(n, 3);
});

test("§47.11: a login stop carries code login (only when given), and both lanes' logged-in calls their own path", async () => {
  const { calls, fetchImpl } = fake();
  const api = client("https://api.example", "tok", fetchImpl);
  const ws = wsClient("https://api.example", "tok", "stories", fetchImpl);
  await api.stopped("c1", "mac-1", "Out.", true, 2, "login");
  await api.stopped("c1", "mac-1", "A puzzle.", true, 2);
  await api.loggedIn("c1", "mac-1");
  await ws.stopped("pj-1", "mac-1", "Out.", true, 2, "login");
  await ws.loggedIn("pj-1", "mac-1");
  const W = "https://api.example/v1/workspaces/stories";
  assert.deepEqual(
    calls.map((c) => [c.method, c.url, c.body]),
    [
      ["POST", "https://api.example/v1/clips/c1/tiktok/mac/stopped", { device: "mac-1", reason: "Out.", needsYou: true, attempt: 2, code: "login" }],
      ["POST", "https://api.example/v1/clips/c1/tiktok/mac/stopped", { device: "mac-1", reason: "A puzzle.", needsYou: true, attempt: 2 }],
      ["POST", "https://api.example/v1/clips/c1/tiktok/mac/logged-in", { device: "mac-1" }],
      ["POST", `${W}/publishing/pj-1/mac/stopped`, { device: "mac-1", reason: "Out.", needsYou: true, attempt: 2, code: "login" }],
      ["POST", `${W}/publishing/pj-1/mac/logged-in`, { device: "mac-1" }],
    ]
  );
});
