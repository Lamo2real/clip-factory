import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// The helper's folder (logs, events) in a throwaway place, read when its modules load.
const base = fs.mkdtempSync(path.join(os.tmpdir(), "cf-login-test-"));
process.env.CF_TT_BASE = base;
const { LOGIN_WINDOW_MS, MAX_TRIES_PER_DAY, QR_URL, countTry, loginOutcome, loginWindow, passwordAllowed, readLogin } = await import(
  "../src/login.js"
);
const { wsLane } = await import("../src/lanes.js");
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

// §47.10 D6: a Clips Funded lane's login is the owner's own, once, in a window on its own profile. No password.

/** Fake Mac actions for loginWindow; ``logins`` is what each window ends with: a handle list, "none" or "closed". */
function fakeMac({ logins = [], clips = { handle: "@lamo.clips", uid: "7000000000000000001" } } = {}) {
  let clock = 0;
  let window = -1;
  const log = { opened: [], closed: 0, cleared: 0, asks: [], shut: 0, events: [], pinned: null, quits: 0 };
  const d = {
    clips,
    closeAll: async () => {},
    openWindow: async (url) => {
      window++;
      log.opened.push(url);
    },
    sessionSeen: async () => {
      const now = logins[window];
      if (now === "closed") return null;
      return Array.isArray(now);
    },
    closeWindow: async () => {
      log.closed++;
    },
    headless: async () => ({
      seen: { handles: logins[window] || [], uids: [] },
      clear: async () => {
        log.cleared++;
      },
      quit: async () => {
        log.quits++;
      },
    }),
    ask: (text) => {
      log.asks.push(text);
      return () => {
        log.shut++;
      };
    },
    event: (kind, fields) => log.events.push({ kind, ...fields }),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    pin: (account) => {
      log.pinned = account;
    },
  };
  return { d, log };
}

const lane = () => wsLane({ device: "mac-1", ledger: {}, posted: [] }, "stories", {});

test("the owner logs in as the workspace's TikTok: one window at the QR code, the account pinned, the pop-up gone", async () => {
  const { d, log } = fakeMac({ logins: [["@Clips.Funded"]] });
  const result = await loginWindow(lane(), "@clips.funded", d);
  assert.deepEqual(result, { ok: true, outcome: "ok", handle: "@clips.funded" });
  assert.deepEqual(log.opened, [QR_URL]);
  assert.equal(log.closed, 1);
  assert.deepEqual(log.pinned, { handle: "@clips.funded" });
  assert.deepEqual(log.asks, ["Log in to TikTok as @clips.funded in the window. Scan the code with the TikTok app."]);
  assert.equal(log.shut, 1);
  assert.equal(log.quits, 1);
  assert.deepEqual(log.events.map((e) => [e.kind, e.account, e.outcome ?? e.how]), [
    ["setup", "ws:stories", "owner"],
    ["login_window", "ws:stories", "ok"],
  ]);
});

test("another account's login is wiped from that profile and the window opens once more", async () => {
  const { d, log } = fakeMac({ logins: [["@lamo.clips"], ["@clips.funded"]] });
  const result = await loginWindow(lane(), "@clips.funded", d);
  assert.equal(result.ok, true);
  assert.equal(log.cleared, 1);
  assert.equal(log.opened.length, 2);
  assert.equal(log.asks[1], "That's @lamo.clips. Log in as @clips.funded.");
  // Twice wrong: no third window, nothing pinned.
  const twice = fakeMac({ logins: [["@someone"], ["@someone"]] });
  const no = await loginWindow(lane(), "@clips.funded", twice.d);
  assert.deepEqual([no.ok, no.outcome], [false, "wrong"]);
  assert.equal(twice.log.opened.length, 2);
  assert.equal(twice.log.cleared, 2);
  assert.equal(twice.log.pinned, null);
});

test("Clip Factory's account is never pinned for Clips Funded, by handle or by uid", async () => {
  const same = fakeMac();
  assert.deepEqual(await loginWindow(lane(), "@lamo.clips", same.d), { ok: false, outcome: "clips_account" });
  assert.equal(same.log.opened.length, 0);
  const { d, log } = fakeMac({ logins: [["@clips.funded"]] });
  d.headless = async () => ({ seen: { handles: [], uids: ["7000000000000000001"] }, clear: async () => {}, quit: async () => {} });
  const r = await loginWindow(lane(), "@clips.funded", d);
  assert.equal(r.ok, false);
  assert.equal(log.pinned, null);
});

test("no login within 20 minutes, or the window closed: nothing pinned, the window and the pop-up gone", async () => {
  const late = fakeMac({ logins: ["none"] });
  const r = await loginWindow(lane(), "@clips.funded", late.d);
  assert.deepEqual([r.ok, r.outcome], [false, "timeout"]);
  assert.ok(late.d.now() >= LOGIN_WINDOW_MS);
  assert.equal(late.log.closed, 1);
  assert.equal(late.log.shut, 1);
  assert.equal(late.log.pinned, null);
  const shut = fakeMac({ logins: ["closed"] });
  assert.deepEqual((await loginWindow(lane(), "@clips.funded", shut.d)).outcome, "closed");
  // No account to log in as: no window at all.
  const none = fakeMac();
  assert.deepEqual(await loginWindow(lane(), null, none.d), { ok: false, outcome: "no_account" });
  assert.equal(none.log.opened.length, 0);
});

test("a Clips Funded lane has no saved password: none is read, none is asked for", async () => {
  assert.equal(await readLogin(lane()), null);
  assert.equal(await readLogin({ keychain: null }), null);
});
