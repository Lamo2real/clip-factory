// D6: the helper's stop reasons say what the Mac does and what the owner can tap now (Try again, It's on TikTok).
// They are stored word for word on the clip's TikTok post (Post.mac.reason).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.CF_TT_BASE = path.join(os.tmpdir(), "cf-tt-words-test");
process.env.CF_TT_DOWNLOADS = path.join(os.tmpdir(), "cf-tt-words-test-downloads");
const { REASONS } = await import("../src/tiktok.js");
const { THREE_TRIES } = await import("../src/run.js");

const SRC = new URL("../src/", import.meta.url);

test("no file in src/ says post it yourself or I posted it", () => {
  for (const name of fs.readdirSync(SRC)) {
    const text = fs.readFileSync(new URL(name, SRC), "utf8");
    assert.doesNotMatch(text, /post it yourself/i, name);
    assert.doesNotMatch(text, /i posted it/i, name);
  }
});

test("the reworded stop reasons, word for word", () => {
  assert.equal(REASONS.wrong, 'TikTok said "Something went wrong". Tap Try again in a few minutes.');
  assert.equal(REASONS.restricted, "TikTok said this video may be restricted. Check the clip, then tap Try again.");
  assert.equal(REASONS.noUpload, "TikTok's upload page looks different. Clip Factory will fix your Mac's helper; then tap Try again.");
  assert.equal(REASONS.uploadFailed, "TikTok couldn't take the video. Tap Try again.");
  assert.equal(REASONS.caption, "The caption didn't go in right on TikTok. Tap Try again.");
  assert.equal(REASONS.privacy("Everyone"), 'TikTok didn\'t keep "Everyone" for who can watch. Tap Try again.');
  assert.equal(REASONS.toggle("Comment"), "TikTok didn't keep Comment the way it should be. Tap Try again.");
  assert.equal(REASONS.noPost, "TikTok's Post button didn't work. Tap Try again.");
  assert.equal(THREE_TRIES, "Your Mac's helper ran into a problem three times. Tap Try again.");
});

test("the other reasons stay as they were", () => {
  assert.equal(REASONS.login, "TikTok logged your Mac out. Log in to TikTok again on your Mac.");
  assert.equal(REASONS.captcha, "TikTok wants a check (a puzzle or a code). Do it on your Mac, then tap Try again.");
  assert.equal(REASONS.popup("Hi"), 'TikTok showed something new: "Hi". Check it on your Mac, then tap Try again.');
  assert.equal(REASONS.slow, "TikTok took too long with the video. Try again later.");
  assert.equal(REASONS.toggleOff("Duet"), "TikTok has Duet turned off for your account. Turn it on in TikTok's settings, then tap Try again.");
  assert.equal(REASONS.noLoginPage, "TikTok's login page looks different. Log in on your Mac.");
  assert.equal(REASONS.limit, "TikTok says it's posting too much right now. The rest wait; Clip Factory tells you.");
});
