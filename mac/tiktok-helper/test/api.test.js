import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError, client } from "../src/api.js";

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
