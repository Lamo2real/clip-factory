// D6: the helper's stop reasons say what the Mac does and what the owner can tap now (Try again, It's on TikTok).
// They are stored word for word on the clip's TikTok post (Post.mac.reason).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.CF_TT_BASE = path.join(os.tmpdir(), "cf-tt-words-test");
process.env.CF_TT_DOWNLOADS = path.join(os.tmpdir(), "cf-tt-words-test-downloads");
const { REASONS, WS_REASONS, laneWords, loginReason } = await import("../src/tiktok.js");
const { windowAsk, otherAsk } = await import("../src/login.js");
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

test("1.2.0's new reasons, word for word, kid-proof", () => {
  assert.equal(REASONS.wrongAccount("@lamo.clips", "@clips.funded"), "Your Mac is logged in to TikTok as @lamo.clips, not @clips.funded. Nothing was posted.");
  assert.equal(REASONS.linkElsewhere("@lamo.clips", "@clips.funded"), "The post showed up on @lamo.clips, not @clips.funded. Look on your TikTok.");
  assert.equal(REASONS.whoUnknown, "Your Mac couldn't see which TikTok it's logged in to. Nothing was posted. Tap Try again.");
  assert.equal(REASONS.aiLabel, "Your Mac couldn't turn on TikTok's AI label, so it didn't post. Tap Try again.");
  assert.equal(REASONS.videoGone, "The video is gone. Make it again, then tap Try again.");
  assert.equal(WS_REASONS.login, "TikTok logged your Mac out. Tap Log in on my Mac.");
  assert.equal(WS_REASONS.noUpload, "TikTok's upload page looks different. Your Mac's helper needs a fix. Then tap Try again.");
  assert.equal(WS_REASONS.limit, "TikTok says it's posting too much right now. The rest wait.");
  assert.equal(windowAsk("@clips.funded"), "Log in to TikTok as @clips.funded in the window. Scan the code with the TikTok app.");
  assert.equal(otherAsk("@lamo.clips", "@clips.funded"), "That's @lamo.clips. Log in as @clips.funded.");
  for (const text of [REASONS.whoUnknown, REASONS.aiLabel, REASONS.videoGone, REASONS.otherWorkspace, WS_REASONS.login]) {
    assert.ok(text.length <= 120, text);
    assert.doesNotMatch(text, /\b(API|CDP|cookie|session|handle|uid|Keychain)\b/i, text);
  }
});

test("a Clips Funded lane's words never say Clip Factory; Clip Factory's stay as they are", () => {
  for (const [key, value] of Object.entries(WS_REASONS)) {
    const text = typeof value === "function" ? value("@a", "@b") : value;
    assert.doesNotMatch(text, /clip factory/i, key);
  }
  // Every Clip Factory text a Clips Funded stop could carry comes out in Clips Funded's words.
  for (const [key, value] of Object.entries(REASONS)) {
    const text = typeof value === "function" ? value("@a", "@b") : value;
    assert.doesNotMatch(laneWords("ws", text), /clip factory/i, key);
  }
  for (const [key, value] of Object.entries(REASONS)) {
    if (typeof value === "string") assert.equal(laneWords("clips", value), value, key);
  }
});

test("the login reasons are the ones Log in on my Mac fixes", () => {
  assert.equal(loginReason(WS_REASONS.login), true);
  assert.equal(loginReason(REASONS.wrongAccount("@lamo.clips", "@clips.funded")), true);
  assert.equal(loginReason(REASONS.aiLabel), false);
  assert.equal(loginReason(undefined), false);
});

test('nothing the helper says or writes calls the second workspace "Funded Clips"', () => {
  for (const name of fs.readdirSync(SRC)) {
    assert.doesNotMatch(fs.readFileSync(new URL(name, SRC), "utf8"), /funded clips/i, name);
  }
  for (const file of ["../README.md", "../install.sh", "../uninstall.sh", "../package.json"]) {
    assert.doesNotMatch(fs.readFileSync(new URL(file, import.meta.url), "utf8"), /funded clips/i, file);
  }
});
