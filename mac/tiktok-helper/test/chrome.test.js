// §47.10 D1: each lane's Chrome has its own profile and port, and a Chrome already on the lane's port is reused only
// when its profile's DevToolsActivePort proves it is that profile's. No Chrome is started here.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "cf-chrome-test-"));
process.env.CF_TT_BASE = base;
delete process.env.CF_TT_PORT;
const { CLIPS_CHROME, PLAIN_FLAGS, flags, hardenProfile, proves } = await import("../src/chrome.js");
const { clipsLane, wsLane } = await import("../src/lanes.js");

const WS = "ws://127.0.0.1:9340/devtools/browser/4b1c6a2e-1f1e-4a3b-9b3c-2d3e4f5a6b7c";

test("DevToolsActivePort proves the Chrome on the port only with its port and its browser path", () => {
  assert.equal(proves("9340\n/devtools/browser/4b1c6a2e-1f1e-4a3b-9b3c-2d3e4f5a6b7c\n", 9340, WS), true);
  assert.equal(proves("9340\n/devtools/browser/4b1c6a2e-1f1e-4a3b-9b3c-2d3e4f5a6b7c", 9340, WS), true);
  assert.equal(proves("9339\n/devtools/browser/4b1c6a2e-1f1e-4a3b-9b3c-2d3e4f5a6b7c\n", 9340, WS), false); // another port
  assert.equal(proves("9340\n/devtools/browser/another\n", 9340, WS), false); // another Chrome
  assert.equal(proves("9340\n", 9340, WS), false);
  assert.equal(proves("", 9340, WS), false);
  assert.equal(proves("9340\n/devtools/browser/4b1c6a2e-1f1e-4a3b-9b3c-2d3e4f5a6b7c\n", 9340, "not a url"), false);
});

test("each lane's flags carry its own profile and port; the rest is the same for every lane", () => {
  const state = { device: "mac-1", ledger: {}, posted: [] };
  const clips = flags(clipsLane(state, {}));
  const ws = flags(wsLane(state, "stories", {}));
  assert.equal(clips[0], `--user-data-dir=${path.join(base, "chrome")}`);
  assert.equal(clips[1], "--remote-debugging-port=9339");
  assert.equal(ws[0], `--user-data-dir=${path.join(base, "chrome-ws-stories")}`);
  assert.equal(ws[1], "--remote-debugging-port=9340");
  assert.deepEqual(clips.slice(2), ws.slice(2));
  assert.ok(clips.includes("--remote-debugging-address=127.0.0.1"));
  assert.ok(!clips.some((f) => /enable-automation/.test(f)));
  // Clip Factory's default is 1.1.0's profile and port.
  assert.deepEqual(flags().slice(0, 2), clips.slice(0, 2));
  assert.equal(CLIPS_CHROME.port, 9339);
});

test("the owner's login window never saves a password or signs Chrome in to Google (its profile, merged)", () => {
  const profile = path.join(base, "chrome-ws-harden");
  fs.mkdirSync(path.join(profile, "Default"), { recursive: true });
  const file = path.join(profile, "Default", "Preferences");
  fs.writeFileSync(file, JSON.stringify({ intl: { accept_languages: "en-US" }, profile: { name: "Person 1", password_manager_enabled: true }, credentials_enable_service: true }));
  hardenProfile(profile);
  const prefs = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(prefs.credentials_enable_service, false);
  assert.equal(prefs.credentials_enable_autosignin, false);
  assert.deepEqual(prefs.profile, { name: "Person 1", password_manager_enabled: false });
  assert.equal(prefs.signin.allowed, false);
  assert.equal(prefs.autofill.profile_enabled, false);
  assert.deepEqual(prefs.intl, { accept_languages: "en-US" }); // the rest stays
  // A new profile gets the same, and a broken file is replaced.
  const fresh = path.join(base, "chrome-ws-new");
  hardenProfile(fresh);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fresh, "Default", "Preferences"), "utf8")).credentials_enable_service, false);
  fs.writeFileSync(file, "{not json");
  hardenProfile(profile);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).signin.allowed, false);
  assert.deepEqual(PLAIN_FLAGS, ["--disable-sync"]);
});
