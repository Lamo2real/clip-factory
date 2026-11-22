import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// The helper's folder (logs, events) in a throwaway place, read when its modules load.
const base = fs.mkdtempSync(path.join(os.tmpdir(), "cf-login-test-"));
process.env.CF_TT_BASE = base;
const { MAX_TRIES_PER_DAY, countTry, loginOutcome, passwordAllowed } = await import("../src/login.js");
const { addSecret, event, holdsSecret, log, scrub } = await import("../src/notify.js");
const { ApiError, client } = await import("../src/api.js");

const NOW = Date.parse("2026-11-22T20:00:00Z");
const ago = (h) => new Date(NOW - h * 3600_000).toISOString();

test("the saved password is tried at most twice in 24 hours", () => {
  assert.equal(MAX_TRIES_PER_DAY, 2);
  assert.equal(passwordAllowed({}, NOW).ok, true);
  assert.equal(passwordAllowed({ loginTries: [ago(1)] }, NOW).ok, true);
  const twice = passwordAllowed({ loginTries: [ago(3), ago(1)] }, NOW);
  assert.equal(twice.ok, false);
  assert.match(twice.reason, /twice today/);
  // Tries older than a day don't count any more.
  assert.equal(passwordAllowed({ loginTries: [ago(30), ago(26)] }, NOW).ok, true);
  const state = { loginTries: [ago(30), ago(2)] };
  countTry(state, NOW);
  assert.deepEqual(state.loginTries, [ago(2), new Date(NOW).toISOString()]);
  assert.equal(passwordAllowed(state, NOW).ok, false);
});

test("once TikTok refused the saved login it is never tried again (no lockouts)", () => {
  const refused = passwordAllowed({ loginRefused: ago(5) }, NOW);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /refused/);
});

test("TikTok's answer: logged in, refused, the owner's turn, or nothing yet", () => {
  const before = "Log in\nEmail or username\nPassword\nForgot password?\nLog in with code\nDon't have an account? Sign up";
  assert.equal(loginOutcome({ loggedIn: true, text: before, before }), "ok");
  assert.equal(loginOutcome({ loggedIn: false, text: before, before }), "waiting"); // the page's own words never count
  assert.equal(loginOutcome({ loggedIn: false, text: `${before}\nIncorrect account or password`, before }), "refused");
  assert.equal(loginOutcome({ loggedIn: false, text: `${before}\nMaximum number of attempts reached. Try again later.`, before }), "refused");
  // A code, a puzzle or a new-device check: hand it to the owner.
  assert.equal(loginOutcome({ loggedIn: false, text: "Enter 6-digit code\nWe sent a code to your email", before }), "needs_you");
  assert.equal(loginOutcome({ loggedIn: false, text: "Drag the slider to fit the puzzle", before }), "needs_you");
  assert.equal(loginOutcome({ loggedIn: false, text: "Verify it's you\nWe noticed a login from a new device", before }), "needs_you");
  assert.equal(loginOutcome({ loggedIn: false, text: before, before, url: "https://www.tiktok.com/login/verify?x=1" }), "needs_you");
});

test("the password never reaches a log line, an event or a notification text", () => {
  const secret = 'Pa"ss w\\rd-ü-2026';
  addSecret(secret);
  log("login.saved_try", { outcome: "refused", note: `typed ${secret}` });
  event("login_refused", { detail: secret });
  const logText = fs.readFileSync(path.join(base, "helper.log"), "utf8");
  const events = fs.readFileSync(path.join(base, "events.log"), "utf8");
  for (const text of [logText, events]) {
    assert.equal(text.includes(secret), false);
    assert.equal(text.includes(JSON.stringify(secret).slice(1, -1)), false);
    assert.equal(holdsSecret(text), false);
    assert.match(text, /•••/);
  }
  assert.equal(scrub(`a ${secret} b`), "a ••• b");
});

test("the password is never sent anywhere: a request that would carry it is refused before it goes out", async () => {
  const secret = "another-Secret-9";
  addSecret(secret);
  let sent = 0;
  const api = client("https://api.example", "tok", async () => {
    sent++;
    return { status: 200, ok: true, json: async () => ({}) };
  });
  await assert.rejects(api.stopped("c1", "mac-1", `oops ${secret}`), (e) => e instanceof ApiError && e.code === "secret");
  await assert.rejects(api.ping({ state: "ok", reason: secret, device: "mac-1" }), (e) => e instanceof ApiError);
  assert.equal(sent, 0);
  await api.ping({ state: "ok", device: "mac-1" });
  assert.equal(sent, 1);
});
