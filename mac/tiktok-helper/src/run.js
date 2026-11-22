// One tick of the helper (launchd runs it every minute): sign in, check in, maybe post one clip.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ApiError, client } from "./api.js";
import { SignInNeeded, accessToken, appConfig } from "./auth.js";
import * as chrome from "./chrome.js";
import { ask, frame, yourTurn } from "./frame.js";
import { freeName } from "./match.js";
import { event, log } from "./notify.js";
import { DOWNLOADS, LOCK, VERSION } from "./paths.js";
import { nextAction } from "./plan.js";
import { loadSettings, loadState, remember, saveState } from "./store.js";
import { askAndSaveLogin, countTry, forgetLogin, hasLogin, passwordAllowed, readLogin } from "./login.js";
import { LOGIN_URL, REASONS, Stop, find, loggedIn, passwordLogin, post } from "./tiktok.js";

// What the notification says at each step (the red frame stays up the whole time).
const STEP_WORDS = {
  video: "Saving the video to Downloads",
  opening: "Opening TikTok Studio",
  uploading: "Uploading the video to TikTok",
  settings: "Caption, Everyone, Comment and Reuse of content",
  pressing: "Pressing Post",
  finding: "Finding the new post's link",
};
const quoteHook = (job) => (job.hook ? ` “${job.hook}”` : "");

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

/** A file the helper may reuse or delete: one it wrote itself, in Downloads, named clip-factory-….mp4. */
export function ownFile(file) {
  if (!file) return false;
  return path.resolve(path.dirname(file)) === path.resolve(DOWNLOADS) && /^clip-factory-.*\.mp4$/i.test(path.basename(file));
}

/** The video for this post: the file kept from an earlier try when it is still there, else a fresh download. */
async function videoFile(api, state, job) {
  const kept = state.ledger[job.clipId]?.file;
  if (ownFile(kept) && fs.existsSync(kept) && fs.statSync(kept).size > 0) return kept;
  const { url, filename } = await api.file(job.clipId);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`The video did not download (${res.status}).`);
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  const name = freeName(filename || job.fileName, (n) => fs.existsSync(path.join(DOWNLOADS, n)));
  const file = path.join(DOWNLOADS, name);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  remember(state, job.clipId, { file });
  return file;
}

/** The owner's rule (22 Nov): the video leaves Downloads only once TikTok has the post (its link found), and only
 * the file the helper itself saved for it. Nothing else in Downloads is ever touched. */
function deleteVideo(state, clipId) {
  const file = state.ledger[clipId]?.file;
  if (ownFile(file)) fs.rmSync(file, { force: true });
  if (file) remember(state, clipId, { file: null });
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
  // On screen only when he is truly needed (yellow frame, one pop-up); otherwise the clip's row says it.
  if (needsYou) ask(`${job.hook ? `“${job.hook}”: ` : ""}${reason}`);
}

/** TikTok has it (its link was found): tell Clip Factory, then delete the helper's own video file. */
async function finished(api, state, job, link, { counted }) {
  const answer = await api.done(job.clipId, state.device, link, job.attempt);
  remember(state, job.clipId, { step: "done", link });
  if (counted) {
    state.posted.push({ clipId: job.clipId, hook: job.hook, link, at: new Date().toISOString() });
    saveState(state);
  }
  deleteVideo(state, job.clipId);
  // Nothing on screen (the owner's rule): the clip's row in Clip Factory and events.log say it.
  event("posted", { clipId: job.clipId, hook: job.hook, link, note: answer?.note });
}

const LOGIN_WAIT_MS = 20 * 60_000;
export const LOGIN_ASK = "TikTok logged the helper out: log in again in the helper window";
const CODE_ASK = "TikTok wants a code or a check for the helper's login: finish it in the helper window";

/**
 * TikTok logged the helper's Chrome out. First, under the red frame, the saved login (Keychain) is tried, at most
 * twice a day and never after TikTok refused it. If TikTok then asks for a code, a puzzle or a new-device check, or
 * there is no saved login, it is the owner's turn: the yellow frame and a pop-up, and the helper's own window comes
 * forward as it is (a code page stays open). The post waits, still this Mac's. Once logged in, the frame goes red and
 * the helper carries on. Returns false when no login came within 20 minutes.
 */
async function relogin(fr, state, browser, page) {
  const allowed = passwordAllowed(state);
  const login = allowed.ok ? await readLogin() : null;
  let ask_ = LOGIN_ASK;
  if (login) {
    await fr.step("Logging back in to TikTok with your saved login");
    const outcome = await passwordLogin(page, login, {
      onTry: async () => {
        countTry(state);
        saveState(state);
      },
    }).catch((e) => (e instanceof Stop ? "needs_you" : "waiting"));
    log("login.saved_try", { outcome });
    if (outcome === "ok") {
      event("setup", { part: "tiktok", again: true, how: "saved login" });
      await fr.step("Logged in to TikTok again, carrying on");
      return true;
    }
    if (outcome === "refused") {
      state.loginRefused = new Date().toISOString();
      saveState(state);
      event("login_refused", {});
    }
    if (outcome === "needs_you") ask_ = CODE_ASK;
  } else if (!allowed.ok) {
    log("login.saved_not_tried", { reason: allowed.reason });
  }
  // The owner's turn: yellow frame, one pop-up, and the helper's window (visible only now) on TikTok's login. The
  // headless Chrome can't be shown, so it closes and a visible one opens with the same profile.
  const closeAsk = ask(ask_);
  event("login_needed", { why: ask_ === CODE_ASK ? "code" : "logged_out" });
  await chrome.quit(browser);
  const opened = await chrome.open({ visible: true });
  const shownBrowser = opened.browser;
  const shownPage = opened.page;
  await shownPage.goto(LOGIN_URL).catch(() => {});
  try {
    const until = Date.now() + LOGIN_WAIT_MS;
    while (Date.now() < until) {
      if (await loggedIn(shownPage).catch(() => false)) {
        closeAsk();
        event("setup", { part: "tiktok", again: true, how: "owner" });
        await fr.step("Logged in to TikTok again, carrying on");
        return true;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    closeAsk();
    return false;
  } finally {
    await chrome.quit(shownBrowser);
  }
}

const isLogin = (e) => e instanceof Stop && e.reason === REASONS.login;

async function doPost(api, state, job, { fresh = false, fr, relogged = false } = {}) {
  const mine = state.ledger[job.clipId] || {};
  // A fresh claim starts counting again; a resumed try counts on.
  const tries = (fresh ? 0 : mine.tries || 0) + 1;
  remember(state, job.clipId, { device: state.device, step: "claimed", tries });
  let browser = null;
  let page = null;
  let posted = false;
  let handedOn = false;
  const awake = stayAwake();
  try {
    await fr.step(`${STEP_WORDS.video}${quoteHook(job)}`);
    await api.step(job.clipId, state.device, "video", job.attempt);
    const file = await videoFile(api, state, job);
    const opened = await chrome.open();
    browser = opened.browser;
    page = opened.page;
    const onStep = async (step, extra = {}) => {
      if (step === "pressing") {
        // On disk first, then the server: if either fails, Post is not pressed. The ids already in Studio › Posts
        // are kept, so a later look finds only the new post.
        state.lastPressedAt = new Date().toISOString();
        // One backlog clip per auto-posting run (plan.js): remember when the last one went.
        if (job.source !== "upload" && job.source !== "auto") state.lastBacklogAt = state.lastPressedAt;
        remember(state, job.clipId, { step: "pressing", pressedAt: state.lastPressedAt, baseline: extra.baseline || [] });
      } else {
        remember(state, job.clipId, { step });
      }
      await api.step(job.clipId, state.device, step, job.attempt);
      await fr.step(STEP_WORDS[step] || step);
    };
    const result = await post(opened.page, job, file, onStep);
    if (result.link) {
      await finished(api, state, job, result.link, { counted: !result.existing });
      posted = true;
    } else {
      // Pressed, but its link isn't in Studio › Posts yet: later ticks only look for it (never press again) and the
      // video stays in Downloads until it is found; after 30 minutes without it the owner is asked "Did it post?".
      remember(state, job.clipId, { step: "finding" });
      log("post.unconfirmed", { clipId: job.clipId, said: result.sure });
    }
  } catch (e) {
    const pressed = state.ledger[job.clipId]?.step === "pressing" || state.ledger[job.clipId]?.step === "finding";
    if (isLogin(e) && !pressed && !relogged && browser) {
      // Logged out: hold this post, log back in (saved login, else his turn), then carry on with it.
      const back = await relogin(fr, state, browser, page);
      await chrome.quit(browser);
      browser = null;
      if (back) {
        handedOn = true;
        return await doPost(api, state, job, { fr, relogged: true });
      }
      await stopped(api, state, job, e.reason, true);
    } else if (e instanceof Stop) {
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
      // Before the press: try again on a later tick (the post stays with this Mac, and so does its video).
      log("post.retry_later", { clipId: job.clipId, tries, error: String(e.message || e) });
    }
  } finally {
    if (browser) await chrome.quit(browser);
    awake();
    if (!handedOn) {
      if (posted) await fr.done(`On TikTok ✓${quoteHook(job)}`);
      else await fr.off();
    }
  }
}

async function doFind(api, state, job, { relogged = false, fr = frame() } = {}) {
  let browser = null;
  let page = null;
  let found = false;
  let handedOn = false;
  if (!fr.shown && !(await fr.on(`Looking for${quoteHook(job)} on TikTok`))) return log("frame.missing", { clipId: job.clipId });
  try {
    const opened = await chrome.open();
    browser = opened.browser;
    page = opened.page;
    const link = await find(page, job, state.ledger[job.clipId]?.baseline || []);
    if (link) {
      found = true;
      return await finished(api, state, job, link, { counted: true });
    }
    const pressedAt = Date.parse(job.pressedAt || state.ledger[job.clipId]?.pressedAt || 0);
    if (Date.now() - pressedAt > FIND_FOR_MS) {
      await stopped(api, state, job, "Your Mac pressed Post but couldn't confirm it.", false);
    }
  } catch (e) {
    if (isLogin(e) && !relogged && browser) {
      const back = await relogin(fr, state, browser, page);
      await chrome.quit(browser);
      browser = null;
      if (back) {
        handedOn = true;
        return await doFind(api, state, job, { relogged: true, fr });
      }
      await stopped(api, state, job, e.reason, true);
    } else if (e instanceof Stop) await stopped(api, state, job, e.reason, e.needsYou);
    else log("find.error", { clipId: job.clipId, error: String(e.message || e) });
  } finally {
    if (browser) await chrome.quit(browser);
    if (!handedOn) {
      if (found) await fr.done(`On TikTok ✓${quoteHook(job)}`);
      else await fr.off();
    }
  }
}

/** A video kept from a try that stopped: once that clip is on TikTok anyway (he posted it himself, or a later try),
 * the helper's own file leaves Downloads. */
async function tidy(api, state, queue) {
  const busy = new Set(queue.map((j) => j.clipId));
  for (const [clipId, entry] of Object.entries(state.ledger)) {
    if (!entry.file || busy.has(clipId)) continue;
    try {
      const { posts = [] } = (await api.posts(clipId)) || {};
      const tiktok = posts.find((p) => p.platform === "tiktok");
      if (tiktok && tiktok.status === "posted" && tiktok.privacy === "public") deleteVideo(state, clipId);
    } catch (e) {
      log("tidy.error", { clipId, error: String(e.message || e) });
    }
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
          ask(e.message);
        }
        return { action: "signin" };
      }
      throw e;
    }
    const api = client(config.apiUrl, token);
    const { on, helper, queue = [] } = await api.queue();
    const needsYou = helper?.state === "needs_you";
    // Auto-posting's schedule, only needed while a backlog clip waits (it goes ~30 minutes after each run).
    let autopost = null;
    if (queue.some((j) => j.state === "waiting" && j.source !== "upload" && j.source !== "auto")) {
      try {
        const a = await api.autopost();
        const run = (a.runs || []).find((r) => r.kind === "scheduled" && r.mode === "live");
        autopost = { on: a.autoPost?.on === true, lastRunAt: run?.at ?? null, nextRunAt: a.nextRunAt ?? null };
      } catch (e) {
        log("autopost.read_failed", { error: String(e.message || e) });
      }
    }
    let action = needsYou
      ? { action: "paused", reason: helper.reason || "Your Mac needs you." }
      : nextAction({ on, queue, state, settings, device: state.device, now: new Date(), autopost });
    // §47.6: the owner's Change TikTok login / Forget TikTok login, done between posts (never in the middle of one).
    let loginDone;
    const request = helper?.loginRequest;
    if (request && !["post", "resume", "find"].includes(action.action)) {
      if (request.action === "forget") {
        await forgetLogin();
        event("login_forgotten", {});
      } else if (request.action === "change") {
        const saved = await yourTurn("Type your TikTok login in the two Mac dialogs (kept only in your Keychain)", () =>
          askAndSaveLogin()
        );
        if (saved) {
          delete state.loginRefused; // a new login may be tried again
          state.loginTries = [];
          saveState(state);
          event("login_saved", {});
        }
      }
      loginDone = request.at;
    }
    const pingState = needsYou ? "needs_you" : action.action === "paused" ? "paused" : "ok";
    const checkIn = {
      state: pingState,
      ...(pingState !== "ok" && action.reason ? { reason: action.reason } : {}),
      version: VERSION,
      device: state.device,
    };
    try {
      await api.ping({ ...checkIn, login: (await hasLogin()) ? "saved" : "none", ...(loginDone ? { loginDone } : {}) });
    } catch (e) {
      // A Clip Factory from before §47.6 doesn't know the login fields yet: check in without them.
      if (!(e instanceof ApiError && e.status === 400)) throw e;
      await api.ping(checkIn);
    }
    log("tick", { action: action.action, clipId: action.job?.clipId, waiting: queue.length, reason: action.reason });
    if (action.action === "post" || action.action === "resume") {
      // The red frame goes up before anything is claimed or driven; if it can't be shown, nothing happens.
      const fr = frame();
      if (!(await fr.on(`Getting${quoteHook(action.job)} ready for TikTok`))) {
        log("frame.missing", { clipId: action.job.clipId });
        return { action: "frame_missing" };
      }
      let job = action.job;
      if (action.action === "post") {
        try {
          const claimed = await api.claim(action.job.clipId, state.device);
          job = { ...action.job, ...(claimed?.job || {}) }; // its new attempt number
        } catch (e) {
          await fr.off();
          log("claim.refused", { clipId: action.job.clipId, error: String(e.message || e) });
          return { action: "claim_refused" };
        }
      }
      await doPost(api, state, job, { fresh: action.action === "post", fr });
    } else if (action.action === "find") {
      await doFind(api, state, action.job);
    } else {
      await tidy(api, state, queue);
    }
    return action;
  } finally {
    dropLock();
  }
}
