// One tick of the helper (launchd runs it every minute): sign in, check in, maybe post one clip.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ApiError, client } from "./api.js";
import { SignInNeeded, accessToken, appConfig } from "./auth.js";
import * as chrome from "./chrome.js";
import { freeName } from "./match.js";
import { event, log, notify } from "./notify.js";
import { DOWNLOADS, LOCK, VERSION } from "./paths.js";
import { nextAction } from "./plan.js";
import { loadSettings, loadState, remember, saveState } from "./store.js";
import { Stop, find, post } from "./tiktok.js";

const MAX_TRIES = 3; // tries before Post is pressed that end in an unexpected error; then it stops and asks
const FIND_FOR_MS = 30 * 60_000; // after a press with no proof, look this long before asking "Did it post?"

function takeLock() {
  try {
    fs.mkdirSync(LOCK);
    fs.writeFileSync(path.join(LOCK, "pid"), String(process.pid));
    return true;
  } catch {
    const pid = Number(fs.readFileSync(path.join(LOCK, "pid"), "utf8").trim() || 0);
    let alive = false;
    try {
      if (pid) process.kill(pid, 0);
      alive = Boolean(pid);
    } catch {
      alive = false;
    }
    if (alive) return false;
    fs.rmSync(LOCK, { recursive: true, force: true });
    return takeLock();
  }
}

function dropLock() {
  fs.rmSync(LOCK, { recursive: true, force: true });
}

async function download(api, job) {
  const { url, filename } = await api.file(job.clipId);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`The video did not download (${res.status}).`);
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  const name = freeName(filename || job.fileName, (n) => fs.existsSync(path.join(DOWNLOADS, n)));
  const file = path.join(DOWNLOADS, name);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

/** Keeps the Mac from idle-sleeping while a post runs (not through a lid close). */
function stayAwake() {
  try {
    const child = spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore", detached: false });
    return () => child.kill();
  } catch {
    return () => {};
  }
}

async function stopped(api, state, job, reason, needsYou) {
  const pressed = state.ledger[job.clipId]?.step === "pressing" || state.ledger[job.clipId]?.step === "finding";
  try {
    await api.stopped(job.clipId, state.device, reason, needsYou, job.attempt);
  } catch (e) {
    log("stopped.call_failed", { clipId: job.clipId, error: String(e.message || e) });
  }
  remember(state, job.clipId, { step: pressed ? "finding" : "stopped", reason });
  event("stopped", { clipId: job.clipId, hook: job.hook, reason, needsYou, pressed });
  await notify("TikTok: your Mac stopped", `${job.hook ? `“${job.hook}”: ` : ""}${reason}`);
}

async function finished(api, state, job, link, { counted }) {
  const answer = await api.done(job.clipId, state.device, link || undefined, job.attempt);
  remember(state, job.clipId, { step: "done", link: link || null });
  if (counted) {
    state.posted.push({ clipId: job.clipId, hook: job.hook, link: link || null, at: new Date().toISOString() });
    saveState(state);
  }
  event("posted", { clipId: job.clipId, hook: job.hook, link: link || null, note: answer?.note });
  await notify("On TikTok ✓", job.hook ? `“${job.hook}” is on TikTok for everyone.` : "Your clip is on TikTok for everyone.");
}

async function doPost(api, state, job, { fresh = false } = {}) {
  const mine = state.ledger[job.clipId] || {};
  // A fresh claim starts counting again; a resumed try counts on.
  const tries = (fresh ? 0 : mine.tries || 0) + 1;
  remember(state, job.clipId, { device: state.device, step: "claimed", tries });
  let file = null;
  let browser = null;
  const awake = stayAwake();
  try {
    await api.step(job.clipId, state.device, "video", job.attempt);
    file = await download(api, job);
    const opened = await chrome.open();
    browser = opened.browser;
    const onStep = async (step, extra = {}) => {
      if (step === "pressing") {
        // On disk first, then the server: if either fails, Post is not pressed. The ids already in Studio › Posts
        // are kept, so a later look finds only the new post.
        state.lastPressedAt = new Date().toISOString();
        remember(state, job.clipId, { step: "pressing", pressedAt: state.lastPressedAt, baseline: extra.baseline || [] });
      } else {
        remember(state, job.clipId, { step });
      }
      await api.step(job.clipId, state.device, step, job.attempt);
    };
    const result = await post(opened.page, job, file, onStep);
    if (result.link || result.sure) {
      await finished(api, state, job, result.link, { counted: !result.existing });
    } else {
      // Pressed, but no proof yet: later ticks only look for it in Studio › Posts (never press again), and after
      // 30 minutes without it the owner is asked "Did it post?".
      remember(state, job.clipId, { step: "finding" });
      log("post.unconfirmed", { clipId: job.clipId });
    }
  } catch (e) {
    const pressed = state.ledger[job.clipId]?.step === "pressing" || state.ledger[job.clipId]?.step === "finding";
    if (e instanceof Stop) {
      await stopped(api, state, job, e.reason, e.needsYou);
    } else if (!pressed && e instanceof ApiError && e.status === 409) {
      // Clip Factory said wait (its switch or auto-posting went off, or another try has it): nothing was pressed, so
      // stop quietly; the clip waits on the server and is not counted as a failed try.
      remember(state, job.clipId, { step: "waiting", tries: tries - 1 });
      log("post.refused", { clipId: job.clipId, error: String(e.message || e) });
    } else if (pressed) {
      // After the press: only look for it from now on (doFind), never press again.
      remember(state, job.clipId, { step: "finding" });
      log("post.error_after_press", { clipId: job.clipId, error: String(e.stack || e) });
    } else if (tries >= MAX_TRIES) {
      log("post.error", { clipId: job.clipId, error: String(e.stack || e) });
      await stopped(api, state, job, "Your Mac's helper ran into a problem three times. Post it yourself for now.", false);
    } else {
      // Before the press: try again on a later tick (the post stays with this Mac).
      log("post.retry_later", { clipId: job.clipId, tries, error: String(e.message || e) });
    }
  } finally {
    if (browser) await chrome.quit(browser);
    awake();
    if (file) fs.rmSync(file, { force: true }); // the owner's rule: the video leaves Downloads after every try
  }
}

async function doFind(api, state, job) {
  let browser = null;
  try {
    const opened = await chrome.open();
    browser = opened.browser;
    const link = await find(opened.page, job, state.ledger[job.clipId]?.baseline || []);
    if (link) return await finished(api, state, job, link, { counted: true });
    const pressedAt = Date.parse(job.pressedAt || state.ledger[job.clipId]?.pressedAt || 0);
    if (Date.now() - pressedAt > FIND_FOR_MS) {
      await stopped(api, state, job, "Your Mac pressed Post but couldn't confirm it.", false);
    }
  } catch (e) {
    if (e instanceof Stop) await stopped(api, state, job, e.reason, e.needsYou);
    else log("find.error", { clipId: job.clipId, error: String(e.message || e) });
  } finally {
    if (browser) await chrome.quit(browser);
  }
}

export async function tick() {
  if (!takeLock()) return { action: "busy" };
  try {
    const settings = loadSettings();
    const state = loadState();
    const config = await appConfig();
    let token;
    try {
      token = await accessToken(config);
    } catch (e) {
      if (e instanceof SignInNeeded) {
        if (state.lastSignInNotice !== new Date().toISOString().slice(0, 10)) {
          state.lastSignInNotice = new Date().toISOString().slice(0, 10);
          saveState(state);
          event("signin", { reason: e.message });
          await notify("Clip Factory TikTok helper", e.message);
        }
        return { action: "signin" };
      }
      throw e;
    }
    const api = client(config.apiUrl, token);
    const { on, helper, queue = [] } = await api.queue();
    const needsYou = helper?.state === "needs_you";
    const action = needsYou
      ? { action: "paused", reason: helper.reason || "Your Mac needs you." }
      : nextAction({ on, queue, state, settings, device: state.device, now: new Date() });
    const pingState = needsYou ? "needs_you" : action.action === "paused" ? "paused" : "ok";
    await api.ping({
      state: pingState,
      ...(pingState !== "ok" && action.reason ? { reason: action.reason } : {}),
      version: VERSION,
      device: state.device,
    });
    log("tick", { action: action.action, clipId: action.job?.clipId, waiting: queue.length, reason: action.reason });
    if (action.action === "post") {
      let job = action.job;
      try {
        const claimed = await api.claim(action.job.clipId, state.device);
        job = { ...action.job, ...(claimed?.job || {}) }; // its new attempt number
      } catch (e) {
        log("claim.refused", { clipId: action.job.clipId, error: String(e.message || e) });
        return { action: "claim_refused" };
      }
      await doPost(api, state, job, { fresh: true });
    } else if (action.action === "resume") {
      await doPost(api, state, action.job);
    } else if (action.action === "find") {
      await doFind(api, state, action.job);
    }
    return action;
  } finally {
    dropLock();
  }
}
