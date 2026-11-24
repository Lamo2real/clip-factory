// One tick of the helper (launchd runs it every minute): sign in, check in, maybe post one clip.
//
// 1.2.0 (§47.10, D1, D2): two lanes. Clip Factory's (clips) decides and checks in first, exactly as in 1.1.0. Then
// each Clips Funded workspace's lane (ws:{id}) reads its own queue and checks in. Then the tick does one thing:
// Clip Factory's post, resume or find; else a Clips Funded find, resume or post; else a Clips Funded login the owner
// asked for; else tidying. An error in a Clips Funded lane is logged (ws.error) and never reaches Clip Factory's.
//
// 1.2.2 (§47.11): a lane held only for a TikTok login (its stop carried code "login") looks, at most every 5 minutes,
// whether its Chrome is logged in to exactly its account again (headless, nothing on screen); then the hold ends and
// the stopped clip carries on by itself, as if the owner had tapped Try again (hold.js).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { ApiError, client, wsClient } from "./api.js";
import { SignInNeeded, appConfig, freshTokens, tokenSource } from "./auth.js";
import * as cdp from "./cdp.js";
import * as chrome from "./chrome.js";
import { ask, frame, yourTurn } from "./frame.js";
import { BACK_OUTCOMES, freshBacks, loginBack, sendBack } from "./hold.js";
import { WS_ID, clipsLane, helperPorts, jobIds, normalizeWsJob, otherAccounts, reasonFor, setUpFor, wsFileName, wsLane } from "./lanes.js";
import { freeName } from "./match.js";
import { event, log } from "./notify.js";
import { DOWNLOADS, LOCK, VERSION } from "./paths.js";
import { startBeats, findBeat } from "./beats.js";
import {
  BEAT_EVERY_MS,
  FIND_FOR_MS,
  applyRequests,
  beatTargets,
  claimFields,
  earlierIds,
  loginCheckDue,
  loginHold,
  nextAction,
  pickWork,
  pingExtras,
  triedHere,
  wsAction,
  wsPingBody,
} from "./plan.js";
import { loadSettings, loadState, saveSettings, saveState } from "./store.js";
import { askAndSaveLogin, countTry, forgetLogin, hasLogin, loginWindow, passwordAllowed, readLogin } from "./login.js";
import { LOGIN_URL, REASONS, Stop, WS_REASONS, find, goto, identify, loggedIn, loginReason, passwordLogin, post } from "./tiktok.js";
import { at, bare, linkHandle, sameAccount } from "./whoami.js";

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = () => new Date().toISOString();
const words = (e) => String(e?.message || e);

const MAX_TRIES = 3; // tries before Post is pressed that end in an unexpected error; then it stops and asks
export const THREE_TRIES = "Your Mac's helper ran into a problem three times. Tap Try again.";
// D3: Clip Factory's lane posts only once it knows which TikTok it may post to. Its ping then says paused, with this
// reason, so Clip Factory's rows say why its TikTok posts wait (never a silent stall).
export const WAIT_TARGET = "Your Mac can't tell which TikTok is Clip Factory's. Connect TikTok in Settings › Posting.";

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

/**
 * Runs ``fn`` holding run.lock (setup, whoami, probe and every login window), waiting up to ``waitMs`` for a running
 * tick to finish first. A launchd tick can never attach to the owner's login window meanwhile.
 */
export async function withLock(fn, { waitMs = 15 * 60_000 } = {}) {
  const until = Date.now() + waitMs;
  while (!takeLock()) {
    if (Date.now() > until) throw new Error("The helper is busy. Try again in a few minutes.");
    await sleep(2000);
  }
  try {
    return await fn();
  } finally {
    dropLock();
  }
}

/**
 * A file the helper may reuse or delete: one it wrote itself, directly in Downloads, named clip-factory-….mp4 (Clip
 * Factory) or clips-funded-….mp4 (Clips Funded).
 */
export function ownFile(file) {
  if (!file) return false;
  return (
    path.resolve(path.dirname(file)) === path.resolve(DOWNLOADS) &&
    /^(clip-factory-|clips-funded-).*\.mp4$/i.test(path.basename(file))
  );
}

/** The video for this post: the file kept from an earlier try when it is still there, else a fresh download. */
async function videoFile(lane, job) {
  const kept = lane.state.ledger[job.clipId]?.file;
  if (ownFile(kept) && fs.existsSync(kept) && fs.statSync(kept).size > 0) return kept;
  let url;
  let filename;
  if (lane.kind === "ws") {
    try {
      ({ url } = await lane.api.file(job));
    } catch (e) {
      // The story's video is gone (or no longer approved): nothing to post until it is made again.
      if (e instanceof ApiError && (e.status === 404 || e.status === 409)) throw new Stop(REASONS.videoGone);
      throw e;
    }
    filename = wsFileName(job.fileName);
  } else {
    ({ url, filename } = await lane.api.file(job.clipId));
    filename = filename || job.fileName;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`The video did not download (${res.status}).`);
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  const name = freeName(filename, (n) => fs.existsSync(path.join(DOWNLOADS, n)));
  const file = path.join(DOWNLOADS, name);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  lane.remember(job.clipId, { file });
  return file;
}

/** The owner's rule (22 Nov): the video leaves Downloads only once TikTok has the post (its link found), and only
 * the file the helper itself saved for it. Nothing else in Downloads is ever touched. */
function deleteVideo(lane, clipId) {
  const file = lane.state.ledger[clipId]?.file;
  if (ownFile(file)) fs.rmSync(file, { force: true });
  if (file) lane.remember(clipId, { file: null });
}

/** Keeps the Mac from idle-sleeping while a post runs (not through a lid close). */
function stayAwake() {
  try {
    const child = spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore", detached: false });
    child.on("error", () => {}); // no caffeinate there (tick-token.test.js on Linux CI): the post goes on, never a crash
    return () => child.kill();
  } catch {
    return () => {};
  }
}

const pressedIn = (lane, job) => {
  const step = lane.state.ledger[job.clipId]?.step;
  return step === "pressing" || step === "finding";
};

/**
 * The helper stops this job and tells the server why. ``code: "login"`` (§47.11) only for a stop that is a TikTok
 * login problem and nothing else (``isLogin``): then the hold may end by itself once the Mac is logged in again.
 */
async function stopped(lane, job, reason, needsYou, { code } = {}) {
  const said = reasonFor(lane, reason); // a Clips Funded lane's own words
  const pressed = pressedIn(lane, job);
  const send = (withCode) => lane.api.stopped(job.clipId, lane.state.device, said, needsYou, job.attempt, withCode);
  try {
    try {
      await send(code);
    } catch (e) {
      // A server from before §47.11 doesn't know the code: the stop goes once more without it, so it is never lost.
      if (!(code && e instanceof ApiError && e.status === 400)) throw e;
      log("stopped.code_refused", { account: lane.id, ...jobIds(lane, job) });
      await send(undefined);
    }
  } catch (e) {
    log("stopped.call_failed", { account: lane.id, ...jobIds(lane, job), error: words(e) });
  }
  lane.remember(job.clipId, { step: pressed ? "finding" : "stopped", reason: said });
  lane.event("stopped", { ...jobIds(lane, job), hook: job.hook, reason: said, needsYou, pressed, ...(code ? { code } : {}) });
  // The owner's one-time batch (22 Nov): "If TikTok shows a limit, a warning or a puzzle, stop at once, hold the
  // rest". Any stop during a batch pauses this Mac (cli.js on resumes it); the rest wait on the server. The batch is
  // Clip Factory's only.
  if (lane.kind === "clips" && loadSettings().backfill?.haltOnStop) {
    saveSettings({ paused: true });
    lane.event("batch_halted", { clipId: job.clipId, reason: said });
  }
  // On screen only when he is truly needed (yellow frame, one pop-up); otherwise the clip's row says it.
  if (needsYou) ask(`${job.hook ? `“${job.hook}”: ` : ""}${said}`);
}

/** The account this lane's job may go to ("@name"), and what post() needs to check it (D3). */
function postTarget(lane, job) {
  return lane.kind === "ws" ? lane.target(job) : lane.target();
}

export function postOpts(lane, job) {
  const target = postTarget(lane, job);
  // Rule 1 both ways: every other lane's account is refused (Clip Factory's for a Clips Funded job, Clips Funded's
  // for a Clip Factory clip).
  const others = otherAccounts(lane.root, lane.id);
  const earlier = lane.kind === "ws" && job.pressedBefore ? lane.state.ledger[job.clipId]?.earlier : null;
  return {
    kind: lane.kind,
    target,
    uid: lane.kind === "ws" ? lane.pinnedUid(job) : lane.pinnedUid(),
    notHandles: others.handles,
    notUids: others.uids,
    ...(Array.isArray(earlier) && earlier.length ? { earlier } : {}),
    onWho: (res) => lane.onWho(res, target),
  };
}

/** TikTok has it (its link was found): tell the server, then delete the helper's own video file. A link on another
 * account is never sent (D3): that stops the post instead. Returns whether it was done. */
async function finished(lane, job, link, { counted }) {
  const target = postTarget(lane, job);
  const on = linkHandle(link);
  if (!on || !target || bare(on) !== bare(target)) {
    lane.event("wrong_account", { ...jobIds(lane, job), link, target });
    await stopped(lane, job, REASONS.linkElsewhere(on || "another account", target || "your TikTok"), true);
    return false;
  }
  const answer = await lane.api.done(job.clipId, lane.state.device, link, job.attempt);
  lane.remember(job.clipId, { step: "done", link });
  if (counted) {
    lane.state.posted.push({ ...jobIds(lane, job), hook: job.hook, link, at: iso() });
    lane.save();
  }
  deleteVideo(lane, job.clipId);
  freshBacks(lane); // §47.11: the lane posts again, so its looks may end a login hold again
  // Nothing on screen (the owner's rule): the clip's row in Clip Factory and events.log say it.
  lane.event("posted", { ...jobIds(lane, job), hook: job.hook, link, note: answer?.note });
  return true;
}

const LOGIN_WAIT_MS = 20 * 60_000;
// D6 (§47.11): the owner's window stays this long after TikTok's session shows, before it closes.
export const SESSION_SETTLE_MS = 3000;
export const LOGIN_ASK = "TikTok logged the helper out: log in again in the helper window";
const CODE_ASK = "TikTok wants a code or a check for the helper's login: finish it in the helper window";

/**
 * Clip Factory's lane: TikTok logged the helper's Chrome out. First, under the red frame, the saved login
 * (Keychain) is tried, at most twice a day and never after TikTok refused it. If TikTok then asks for a code, a
 * puzzle or a new-device check, or there is no saved login, it is the owner's turn: the yellow frame and a pop-up,
 * and the helper's own window comes forward as it is (a code page stays open). The post waits, still this Mac's.
 * Once logged in, the frame goes red and the helper carries on. Returns false when no login came within 20 minutes.
 */
async function relogin(lane, fr, browser, page) {
  const { state } = lane;
  const allowed = passwordAllowed(state);
  const login = allowed.ok ? await readLogin(lane) : null;
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
      lane.event("setup", { part: "tiktok", again: true, how: "saved login" });
      await fr.step("Logged in to TikTok again, carrying on");
      return true;
    }
    if (outcome === "refused") {
      state.loginRefused = iso();
      saveState(state);
      lane.event("login_refused", {});
    }
    if (outcome === "needs_you") ask_ = CODE_ASK;
  } else if (!allowed.ok) {
    log("login.saved_not_tried", { reason: allowed.reason });
  }
  // The owner's turn: yellow frame, one pop-up, and the helper's window (visible only now) on TikTok's login. The
  // headless Chrome can't be shown, so it closes and a visible one opens with the same profile.
  const closeAsk = ask(ask_);
  lane.event("login_needed", { why: ask_ === CODE_ASK ? "code" : "logged_out" });
  await chrome.quit(browser, lane);
  const opened = await chrome.open(lane, { visible: true });
  const shownBrowser = opened.browser;
  const shownPage = opened.page;
  await shownPage.goto(LOGIN_URL).catch(() => {});
  try {
    const until = Date.now() + LOGIN_WAIT_MS;
    while (Date.now() < until) {
      if (await loggedIn(shownPage).catch(() => false)) {
        // D6 (§47.11): TikTok finishes its own redirects and keeps the session first (loginWindow waits the same),
        // so the hidden Chrome that opens next reads the login (24 Nov: it read logged out 7 seconds later).
        await sleep(SESSION_SETTLE_MS);
        closeAsk();
        lane.event("setup", { part: "tiktok", again: true, how: "owner" });
        await fr.step("Logged in to TikTok again, carrying on");
        return true;
      }
      await sleep(3000);
    }
    closeAsk();
    return false;
  } finally {
    await chrome.quit(shownBrowser, lane);
  }
}

/** The account states whose handle is still Clip Factory's TikTok (a token that needs renewing is the same account:
 * the Mac posts without it, so its posts must not wait for a reconnect). */
const KNOWN_ACCOUNT = ["connected", "needs_reconnect", "choose_account"];

/**
 * The account of the clips lane's own posts (state.posted's links, which 1.1.0 wrote too), when they all say one and
 * it is no Clips Funded lane's account; else null.
 */
export function postedHandle(state) {
  const names = [...new Set((state.posted || []).map((p) => bare(linkHandle(p?.link))).filter(Boolean))];
  if (names.length !== 1) return null;
  if (otherAccounts(state, "clips").handles.some((h) => bare(h) === names[0])) return null;
  return at(names[0]);
}

/**
 * Clip Factory's TikTok account (D3, the clips lane's target): GET /v1/accounts, cached in state.clipsAccount. When
 * that has no @name (TikTok not connected through the API, or only a nickname) and nothing is cached, it is the
 * account the helper has been posting Clip Factory's clips to (its own posted links), so a 1.1.0 Mac goes on as it
 * did. Never a guess: null when none of these says one account.
 */
export async function clipsTarget(api, state) {
  try {
    const { accounts = [] } = (await api.accounts()) || {};
    const tiktok = accounts.find((a) => a && a.platform === "tiktok" && KNOWN_ACCOUNT.includes(a.status) && a.handle);
    const handle = at(tiktok?.handle);
    if (handle) {
      const same = state.clipsAccount && bare(state.clipsAccount.handle) === bare(handle);
      state.clipsAccount = { ...(same ? state.clipsAccount : {}), handle, checkedAt: iso() };
      saveState(state);
      return handle;
    }
  } catch (e) {
    log("accounts.read_failed", { error: words(e) });
  }
  const cached = at(state.clipsAccount?.handle);
  if (cached) return cached;
  const posted = postedHandle(state);
  if (posted) {
    state.clipsAccount = { handle: posted, checkedAt: iso(), from: "posts" };
    saveState(state);
    log("accounts.from_posts", { handle: posted });
  }
  return posted;
}

/** What the owner's login window (login.js loginWindow) does on this Mac, for one Clips Funded lane. */
export function windowDeps(lane) {
  return {
    clips: lane.root.clipsAccount || {},
    closeAll: async () => {
      for (const port of helperPorts(lane.root)) await chrome.closePort(port);
    },
    openWindow: (url) => chrome.openPlain(lane, url),
    // The lane's cookies go before the window opens: a session TikTok ended on its side (its cookie still in the
    // profile) would otherwise read as a login at once, and the window would close by itself.
    forget: async () => {
      const { browser } = await chrome.open(lane);
      try {
        await cdp.clearCookies(lane.port);
      } finally {
        await chrome.quit(browser, lane);
      }
    },
    sessionSeen: () => cdp.sessionSeen(lane.port),
    closeWindow: async () => {
      await chrome.closePort(lane.port);
      await sleep(1000); // the window's Chrome lets go of the profile before the hidden one opens it
    },
    headless: () => lookHeadless(lane),
    ask,
    event,
    sleep,
    now: () => Date.now(),
    pin: (account) => lane.pin(account),
  };
}

/** The lane's profile in the hidden Chrome: who it is logged in as (nothing on screen). */
export async function lookHeadless(lane) {
  const { browser, page } = await chrome.open(lane);
  let seen = { handles: [], uids: [] };
  try {
    await goto(page, "content").catch(() => {}); // a login page reads as nobody
    await page.locator('a[href*="/video/"]').first().waitFor({ timeout: 15_000 }).catch(() => {}); // the rows, if any
    seen = (await identify(page)).seen;
  } catch (e) {
    log("whoami.error", { account: lane.id, error: words(e) });
  }
  return {
    seen,
    clear: () => cdp.clearCookies(lane.port).catch(() => {}),
    // A Google sign-in the owner may have used in the window: its cookies leave the profile once TikTok's login is in.
    forgetGoogle: () => page.context().clearCookies({ domain: /(^|\.)(google|youtube)\.[a-z.]+$/i }).catch(() => {}),
    quit: () => chrome.quit(browser, lane),
  };
}

/**
 * §47.11: the cheap look while a lane is held for a TikTok login. Headless, on the lane's own profile: no TikTok
 * session cookie at all is ``logged_out`` (no TikTok page is loaded). Else Studio › Posts as a post opens it: TikTok's
 * login there is ``logged_out`` too, even when the profile's own account data still names the account (a post would
 * stop on that login again); a puzzle, a code, any other stop or a page that didn't load is ``unknown``; only then who
 * it is logged in as, read as lookHeadless reads it. Chrome quits either way. Nothing on screen, no cookie cleared,
 * nothing typed.
 * @returns {Promise<{state: "logged_out"} | {state: "unknown"} | {state: "in", seen: object}>}
 */
export async function lookLogin(lane) {
  const { browser, page } = await chrome.open(lane);
  try {
    if (!(await loggedIn(page).catch(() => false))) return { state: "logged_out" };
    const stop = await goto(page, "content").then(
      () => null,
      (e) => e
    );
    if (stop) {
      log("login_back.look_stop", { account: lane.id, error: words(stop) });
      return { state: isLogin(stop) ? "logged_out" : "unknown" };
    }
    let seen = { handles: [], uids: [] };
    try {
      await page.locator('a[href*="/video/"]').first().waitFor({ timeout: 15_000 }).catch(() => {}); // the rows, if any
      seen = (await identify(page)).seen;
    } catch (e) {
      log("login_back.look_error", { account: lane.id, error: words(e) });
    }
    return { state: "in", seen };
  } finally {
    await chrome.quit(browser, lane);
  }
}

/** What hold.js loginBack needs for Clip Factory's lane: its account (GET /v1/accounts first), never another lane's. */
export async function clipsBack(api, state, lane, { capped = true } = {}) {
  const target = await clipsTarget(api, state);
  return {
    look: () => lookLogin(lane),
    call: (id) => api.loggedIn(id, state.device),
    now: () => Date.now(),
    event: (kind, fields) => lane.event(kind, fields),
    target,
    pinnedUid: state.clipsAccount?.uid || null,
    others: otherAccounts(state, "clips"),
    capped,
  };
}

/** The same for a Clips Funded lane: the workspace's account (``target``), never Clip Factory's or another lane's. */
export function wsBack(lane, target, { capped = true } = {}) {
  return {
    look: () => lookLogin(lane),
    call: (id) => lane.api.loggedIn(id, lane.state.device),
    now: () => Date.now(),
    event: (kind, fields) => lane.event(kind, fields),
    target: at(target),
    pinnedUid: lane.pinnedUid({ account: { handle: target } }),
    others: otherAccounts(lane.root, lane.id),
    capped,
  };
}

/** A Clips Funded lane logged out in the middle of a post: the owner's login window, once (D6). */
async function wsRelogin(lane, job) {
  lane.loggedOut();
  lane.event("login_needed", { ...jobIds(lane, job), why: "logged_out" });
  const result = await loginWindow(lane, postTarget(lane, job), windowDeps(lane));
  return result.ok;
}

const isLogin = (e) => e instanceof Stop && e.reason === REASONS.login;

async function doPost(lane, job, { fresh = false, fr, relogged = false, queue = [], beats = null } = {}) {
  const { state } = lane;
  const mine = state.ledger[job.clipId] || {};
  // A fresh claim starts counting again; a resumed try counts on. A fresh claim also forgets the last try's press,
  // baseline and step (claimFields).
  const tries = (fresh ? 0 : mine.tries || 0) + 1;
  lane.remember(job.clipId, claimFields({ device: state.device, tries, fresh, earlier: earlierIds(mine) }));
  // The job's beat, from the claim until doPost returns (a logged-out try handed on to the next doPost keeps it).
  const beat =
    beats ||
    startBeats({
      api: lane.api,
      state,
      job,
      queue,
      log: (name, fields) => log(name, { ...(lane.kind === "ws" ? { account: lane.id } : {}), ...fields }),
      record: (fields) => lane.remember(job.clipId, fields),
    });
  let browser = null;
  let page = null;
  let posted = false;
  let handedOn = false;
  const awake = stayAwake();
  try {
    await fr.step(`${STEP_WORDS.video}${quoteHook(job)}`);
    await beat.step("video");
    const file = await videoFile(lane, job);
    const opened = await chrome.open(lane);
    browser = opened.browser;
    page = opened.page;
    const onStep = async (step, extra = {}) => {
      // A beat in flight finishes first; a 409 on it (the server took the post back) stops here, before anything.
      await beat.ready();
      if (step === "pressing") {
        // On disk first, then the server: if either fails, Post is not pressed. The ids already in Studio › Posts
        // are kept, so a later look finds only the new post.
        state.lastPressedAt = iso();
        if (lane.kind === "clips") {
          // One backlog clip per auto-posting run, or the backfill's pace (plan.js): remember when each kind went.
          // Clip Factory's pacing only: a Clips Funded lane writes nothing of it.
          if (job.source !== "upload" && job.source !== "auto") {
            state.lastBacklogAt = state.lastPressedAt;
            if (loadSettings().backfill) {
              const keep = (state.backfillPosts || []).filter((t) => Date.now() - Date.parse(t) < 48 * 3_600_000);
              state.backfillPosts = [...keep, state.lastPressedAt];
            }
          } else {
            state.lastRunPressAt = state.lastPressedAt;
          }
        }
        lane.remember(job.clipId, { step: "pressing", pressedAt: state.lastPressedAt, baseline: extra.baseline || [] });
      } else {
        lane.remember(job.clipId, { step });
      }
      await beat.step(step);
      await fr.step(STEP_WORDS[step] || step);
    };
    const result = await post(opened.page, job, file, onStep, postOpts(lane, job));
    await beat.stop();
    if (result.link) {
      posted = await finished(lane, job, result.link, { counted: !result.existing });
    } else {
      // Pressed, but its link isn't in Studio › Posts yet: later ticks only look for it (never press again) and the
      // video stays in Downloads until it is found; after 30 minutes without it the owner is asked "Did it post?".
      lane.remember(job.clipId, { step: "finding" });
      log("post.unconfirmed", { account: lane.id, ...jobIds(lane, job), said: result.sure });
    }
  } catch (e) {
    const pressed = pressedIn(lane, job);
    if (isLogin(e) && !pressed && !relogged && browser) {
      // Logged out: hold this post, log back in (Clip Factory: saved login, else his turn; Clips Funded: his turn in
      // the lane's own window), then carry on with it. The beat goes on meanwhile: the post is still this Mac's.
      let back;
      if (lane.kind === "ws") {
        await chrome.quit(browser, lane);
        browser = null;
        back = await wsRelogin(lane, job);
      } else {
        back = await relogin(lane, fr, browser, page);
        await chrome.quit(browser, lane);
        browser = null;
      }
      if (back) {
        handedOn = true;
        return await doPost(lane, job, { fr, relogged: true, queue, beats: beat });
      }
      await beat.stop();
      await stopped(lane, job, e.reason, true, { code: "login" });
      return;
    }
    await beat.stop();
    if (e instanceof Stop && e.unknown && !pressed && tries < MAX_TRIES) {
      // The account couldn't be read this time (nothing was posted): try again on a later tick, then stop.
      log("post.who_unknown", { account: lane.id, ...jobIds(lane, job), tries });
    } else if (e instanceof Stop) {
      if (e.detail) log("post.stop_detail", { account: lane.id, ...jobIds(lane, job), ...e.detail });
      if (e.wrongAccount) lane.event("wrong_account", { ...jobIds(lane, job), seen: e.seen, target: postTarget(lane, job) });
      let reason = e.reason;
      if (lane.kind === "ws" && e.unknown && e.blank && !pressed) {
        // Nothing readable three times, though a TikTok cookie is there: TikTok ended the session on its side. The
        // lane is not set up any more, so its card and rows offer Log in on my Mac (which clears that cookie first).
        lane.loggedOut();
        reason = WS_REASONS.nobody;
      }
      // A logout right after a login (or after Post was pressed) is still only a login problem (§47.11).
      await stopped(lane, job, reason, e.needsYou, isLogin(e) ? { code: "login" } : {});
    } else if (!pressed && e instanceof ApiError && e.status === 409) {
      // The server said wait (its switch or auto-posting went off, or another try has it): nothing was pressed, so
      // stop quietly; the clip waits on the server and is not counted as a failed try.
      lane.remember(job.clipId, { step: "waiting", tries: tries - 1 });
      log("post.refused", { account: lane.id, ...jobIds(lane, job), error: words(e) });
    } else if (pressed) {
      // After the press: only look for it from now on (doFind), never press again.
      lane.remember(job.clipId, { step: "finding" });
      log("post.error_after_press", { account: lane.id, ...jobIds(lane, job), error: String(e.stack || e) });
    } else if (tries >= MAX_TRIES) {
      log("post.error", { account: lane.id, ...jobIds(lane, job), error: String(e.stack || e) });
      await stopped(lane, job, THREE_TRIES, false);
    } else {
      // Before the press: try again on a later tick (the post stays with this Mac, and so does its video).
      log("post.retry_later", { account: lane.id, ...jobIds(lane, job), tries, error: words(e) });
    }
  } finally {
    await beat.stop();
    if (browser) await chrome.quit(browser, lane);
    awake();
    if (!handedOn) {
      if (posted) await fr.done(`On TikTok ✓${quoteHook(job)}`);
      else await fr.off();
    }
  }
}

async function doFind(lane, job, { relogged = false, fr = frame(), queue = [], beats = null } = {}) {
  const { state } = lane;
  const api = lane.api;
  const beatLog = (name, fields) => log(name, { ...(lane.kind === "ws" ? { account: lane.id } : {}), ...fields });
  let browser = null;
  let page = null;
  let found = false;
  let handedOn = false;
  // The frame first: a beat says the Mac is still looking, so none goes out while it can't look (the job then goes
  // stuck after 5 minutes, which is the truth).
  if (!fr.shown && !(await fr.on(`Looking for${quoteHook(job)} on TikTok`))) return log("frame.missing", { clipId: job.clipId });
  // Then the beats (D2), for this job and every other pressed job of this Mac, now and every minute while it looks
  // (a login can take 20 minutes). A 409 on this job means the post is no longer this try's (the owner said it's on
  // TikTok, or tapped Try again): then it doesn't look for it this tick.
  const beat = beats || startBeats({ api, state, job, queue, log: beatLog, record: () => {}, current: "finding" });
  try {
    if (!relogged && !(await findBeat({ api, state, job, queue, log: beatLog }))) return;
    const opened = await chrome.open(lane);
    browser = opened.browser;
    page = opened.page;
    const link = await find(page, job, state.ledger[job.clipId]?.baseline || [], postOpts(lane, job));
    if (link) {
      await beat.stop();
      found = await finished(lane, job, link, { counted: true });
      return;
    }
    const pressedAt = Date.parse(job.pressedAt || state.ledger[job.clipId]?.pressedAt || 0);
    if (Date.now() - pressedAt > FIND_FOR_MS) {
      await beat.stop();
      await stopped(lane, job, "Your Mac pressed Post but couldn't confirm it.", false);
    }
  } catch (e) {
    if (isLogin(e) && !relogged && browser) {
      let back;
      if (lane.kind === "ws") {
        await chrome.quit(browser, lane);
        browser = null;
        back = await wsRelogin(lane, job);
      } else {
        back = await relogin(lane, fr, browser, page);
        await chrome.quit(browser, lane);
        browser = null;
      }
      if (back) {
        handedOn = true;
        return await doFind(lane, job, { relogged: true, fr, queue, beats: beat });
      }
      await beat.stop();
      await stopped(lane, job, e.reason, true, { code: "login" });
    } else if (e instanceof Stop && e.unknown) {
      // The account couldn't be read this time: no link is taken; it looks again next tick, within the find window.
      log("find.who_unknown", { account: lane.id, ...jobIds(lane, job) });
      const pressedAt = Date.parse(job.pressedAt || state.ledger[job.clipId]?.pressedAt || 0);
      if (Date.now() - pressedAt > FIND_FOR_MS) {
        await beat.stop();
        await stopped(lane, job, "Your Mac pressed Post but couldn't confirm it.", false);
      }
    } else if (e instanceof Stop) {
      await beat.stop();
      if (e.wrongAccount) lane.event("wrong_account", { ...jobIds(lane, job), seen: e.seen, target: postTarget(lane, job) });
      await stopped(lane, job, e.reason, e.needsYou, isLogin(e) ? { code: "login" } : {});
    } else log("find.error", { account: lane.id, ...jobIds(lane, job), error: words(e) });
  } finally {
    await beat.stop();
    if (browser) await chrome.quit(browser, lane);
    if (!handedOn) {
      if (found) await fr.done(`On TikTok ✓${quoteHook(job)}`);
      else await fr.off();
    }
  }
}

/** A video kept from a try that stopped: once that clip is on TikTok anyway (the owner's It's on TikTok, or a later
 * try), the helper's own file leaves Downloads. */
async function tidy(lane, queue) {
  const busy = new Set(queue.map((j) => j.clipId));
  for (const [clipId, entry] of Object.entries(lane.state.ledger)) {
    if (!entry.file || busy.has(clipId)) continue;
    try {
      const { posts = [] } = (await lane.api.posts(clipId)) || {};
      const tiktok = posts.find((p) => p.platform === "tiktok");
      if (tiktok && tiktok.status === "posted" && tiktok.privacy === "public") deleteVideo(lane, clipId);
    } catch (e) {
      log("tidy.error", { clipId, error: words(e) });
    }
  }
}

/** The same for a Clips Funded lane: a kept video whose TikTok job GET /publishing shows posted leaves Downloads. */
async function tidyWs({ lane, queue }) {
  const busy = new Set(queue.map((j) => j.clipId));
  const kept = Object.entries(lane.state.ledger).filter(([id, entry]) => entry.file && !busy.has(id));
  if (!kept.length) return;
  try {
    const { publishingJobs = [] } = (await lane.api.publishing()) || {};
    for (const [id] of kept) {
      const job = publishingJobs.find((j) => j && j.publishingJobId === id);
      if (job && job.platform === "tiktok" && job.publishingStatus === "posted") deleteVideo(lane, id);
    }
  } catch (e) {
    log("tidy.error", { account: lane.id, error: words(e) });
  }
}

/**
 * B. Each Clips Funded workspace's lane: its queue, what it would do, and its check-in. Read once per tick; a
 * failure to list the workspaces skips them all, and one lane's error skips only that lane. A lane held only for a
 * TikTok login looks whether it is logged in again (§47.11): at most one look per tick in all (none when Clip
 * Factory's lane looked, ``looked``), and only while Clip Factory's lane has nothing to do (``clipsBusy``): one thing
 * per tick, Clip Factory first.
 */
async function wsLanes({ api, state, settings: given, config, tokens, now, clipsBusy = false, looked: clipsLooked = false }) {
  let settings = given;
  let list;
  try {
    list = ((await api.workspaces()) || {}).workspaces || [];
  } catch (e) {
    log("ws.error", { part: "workspaces", error: words(e) });
    return [];
  }
  const out = [];
  let looked = clipsLooked;
  for (const w of list) {
    if (!w || w.workspaceType !== "stories" || !WS_ID.test(String(w.workspaceId || ""))) continue;
    try {
      const lane = wsLane(state, w.workspaceId, wsClient(config.apiUrl, tokens, w.workspaceId));
      let status = (await lane.api.queue()) || {};
      const hold = loginHold(status.helper, "ws");
      let heldReason = null;
      const due = hold && !clipsBusy && !looked && status.on === true && !settings.paused && triedHere(lane.state.ledger, hold);
      if (due && loginCheckDue(lane.store.loginCheckAt, Date.now())) {
        looked = true;
        lane.store.loginCheckAt = iso(); // before the look: a crash mid-look still waits 5 minutes
        lane.save();
        await clipsTarget(api, state); // Clip Factory's account, which this lane must never be
        const back = await loginBack(lane, hold, wsBack(lane, status.account?.handle));
        // Decide and check in on a fresh read only, whatever the look said (the hold ended, or the owner answered
        // while Chrome looked). A ping of the stale needs_you would put back a hold with no job and no code, which
        // nothing could end; so when that read fails, no ping for this lane this tick. The local pause is read again
        // too: `cli.js off` during the look (it takes no lock) means a paused Mac, so the job the look resumed waits.
        settings = loadSettings();
        try {
          status = (await lane.api.queue()) || {};
        } catch (e) {
          log("ws.error", { account: lane.id, part: "login_back_read", error: words(e) });
          continue;
        }
        if (back.words && loginHold(status.helper, "ws")?.id === hold.id) heldReason = back.words;
      }
      const queue = (Array.isArray(status.queue) ? status.queue : []).filter((j) => j && j.publishingJobId).map(normalizeWsJob);
      const target = at(status.account?.handle);
      // After a look that read another account (or no login), the check-in says so; the hold and its code stay.
      const helper = status.helper && heldReason ? { ...status.helper, reason: heldReason } : status.helper || null;
      // The account this workspace has connected: Clip Factory's lane never posts to it (rule 1, otherAccounts).
      if (target && lane.store.connected !== target) {
        lane.store.connected = target;
        lane.save();
      }
      // The owner's Start my Mac again in Clips Funded: this Mac's pause (settings.paused, every lane's) ends, as
      // Clip Factory's does; the ping says it was done, so the request is cleared.
      let resumeDone;
      if (helper?.resumeRequest?.at) {
        if (settings.paused) {
          saveSettings({ paused: false });
          settings = loadSettings();
        }
        resumeDone = helper.resumeRequest.at;
        lane.event("resumed", {});
      }
      const setUp = setUpFor(lane.store, target);
      const args = { on: status.on === true, helper, queue, view: lane.state, settings, device: state.device, now, setUp };
      const action = wsAction(args);
      const entry = { id: lane.id, lane, status, helper, queue, target, args, action, loginRequest: helper?.loginRequest?.at || null };
      await lane.api.ping(pingFor(entry, { resumeDone }));
      log("tick", { account: lane.id, action: action.action, publishingJobId: action.job?.clipId, waiting: queue.length, reason: action.reason, until: action.until });
      for (const skip of action.skipped || []) log("never_twice.skip", { account: lane.id, ...skip });
      out.push(entry);
    } catch (e) {
      log("ws.error", { account: `ws:${w.workspaceId}`, error: words(e) });
    }
  }
  return out;
}

/** A ws lane's check-in body. ``loginDone`` once the owner's Log in on my Mac was carried out; ``clearLogin`` when it
 * logged in as the target, which ends a needs-you that only a login could fix; ``released`` when the server's
 * logged-in route already ended the hold (§47.11), so this ping never puts it back. */
function pingFor(entry, { loginDone, resumeDone, clearLogin = false, released = false } = {}) {
  const needsYou = entry.helper?.state === "needs_you" && !released && !(clearLogin && loginReason(entry.helper?.reason));
  const action = needsYou || entry.helper?.state !== "needs_you" ? entry.action : wsAction({ ...entry.args, helper: null, setUp: true });
  return wsPingBody({
    action,
    needsYou,
    version: VERSION,
    device: entry.lane.state.device,
    setUp: setUpFor(entry.lane.store, entry.target),
    handle: at(entry.lane.store.account?.handle) || undefined,
    loginDone,
    resumeDone,
  });
}

/** C.3: the owner's Log in on my Mac for a Clips Funded lane. When the profile already reads the target nothing
 * opens; else his login window (D6). Either way the ping says it was done, so the request never opens it twice. */
async function wsLoginRequest(entry, api) {
  const { lane, target } = entry;
  await clipsTarget(api, lane.root); // Clip Factory's account, which this lane must never be set up as
  let ok = false;
  if (target) {
    const look = await lookHeadless(lane);
    try {
      const clips = lane.root.clipsAccount || {};
      const isClips = clips.handle && (look.seen.handles || []).some((h) => bare(h) === bare(clips.handle));
      const res = isClips ? { verdict: "wrong", seen: at(clips.handle) } : sameAccount(look.seen, target, null, { notUid: clips.uid || null });
      lane.onWho(res, target);
      ok = res.verdict === "same" && bare(target) !== bare(clips.handle);
      if (res.verdict === "wrong") await look.clear(); // another account's login leaves this profile first
    } finally {
      await look.quit();
    }
    if (ok) lane.event("login_window", { outcome: "already" });
    else ok = (await loginWindow(lane, target, windowDeps(lane))).ok;
  } else {
    lane.event("login_window", { outcome: "no_account" });
  }
  // §47.11: logged in as the target while held for a TikTok login: the stopped post carries on too (his own tap, so
  // never capped, and the lane's count starts again). The ping below still ends a wrong-account hold he fixed.
  let released = false;
  if (ok) freshBacks(lane);
  const hold = ok ? loginHold(entry.helper, "ws") : null;
  if (hold) released = BACK_OUTCOMES.includes((await sendBack(lane, hold, wsBack(lane, target, { capped: false }))).outcome);
  await lane.api.ping(pingFor(entry, { loginDone: entry.loginRequest, clearLogin: ok, released }));
}

/**
 * While Clip Factory's lane posts or looks, the Clips Funded posts this Mac pressed Post for get their "finding"
 * beat too (D2), now and every minute, through their own workspace's routes: they are still this Mac's to look for,
 * so their rows don't read "Not sure it posted" while Clip Factory's post goes first. Returns stop().
 */
export function wsBeats(lanes) {
  const flying = new Set();
  const send = () => {
    for (const { lane, queue } of lanes) {
      for (const t of beatTargets({ queue, state: lane.state, device: lane.state.device, current: null })) {
        const call = Promise.resolve()
          .then(() => lane.api.step(t.clipId, lane.state.device, t.step, t.attempt))
          .catch((e) => log("beat.failed", { account: lane.id, publishingJobId: t.clipId, step: t.step, status: e?.status, error: words(e) }));
        flying.add(call);
        call.then(() => flying.delete(call));
      }
    }
  };
  send();
  const timer = setInterval(send, BEAT_EVERY_MS);
  timer.unref?.();
  return async () => {
    clearInterval(timer);
    await Promise.all([...flying]);
  };
}

/** C.2: a Clips Funded lane's find, resume or post (only in a tick where Clip Factory's lane has none). */
async function wsWork(entry, what, api) {
  const { lane } = entry;
  if (what === "login") return wsLoginRequest(entry, api);
  const job = entry.action.job;
  if (!lane.target(job)) {
    log("ws.no_account", { account: lane.id, ...jobIds(lane, job) });
    return;
  }
  await clipsTarget(api, lane.root); // so the post can refuse Clip Factory's account by its uid too
  if (what === "find") return doFind(lane, job, { queue: entry.queue });
  const fr = frame();
  if (!(await fr.on(`Getting${quoteHook(job)} ready for TikTok`))) {
    log("frame.missing", { account: lane.id, ...jobIds(lane, job) });
    return;
  }
  let claimed = job;
  if (what === "post") {
    try {
      const answer = await lane.api.claim(job.clipId, lane.state.device);
      claimed = normalizeWsJob({ ...job, ...(answer?.job || {}) }); // its new attempt number
    } catch (e) {
      await fr.off();
      log("claim.refused", { account: lane.id, ...jobIds(lane, job), status: e?.status, code: e?.code, error: words(e) });
      return;
    }
  }
  await doPost(lane, claimed, { fresh: what === "post", fr, queue: entry.queue });
}

/** C.1: Clip Factory's post, resume or find, exactly as in 1.1.0. Returns the tick's answer. */
async function clipsWork({ api, state, clips, action, queue, what }) {
  if (what === "find") {
    await doFind(clips, action.job, { queue });
    return action;
  }
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
      log("claim.refused", { clipId: action.job.clipId, error: words(e) });
      return { action: "claim_refused" };
    }
  }
  await doPost(clips, job, { fresh: action.action === "post", fr, queue });
  return action;
}

export async function tick() {
  if (!takeLock()) return { action: "busy" };
  try {
    let settings = loadSettings();
    const state = loadState();
    const config = await appConfig();
    // One token source for the whole tick: a login wait (20 minutes) outlasts an access token (15), so every call
    // gets a fresh one when it needs it (24 Nov 2026: the beats and the stop of a tick that waited sent 401s).
    const tokens = tokenSource(() => freshTokens(config));
    try {
      await tokens.get();
    } catch (e) {
      if (e instanceof SignInNeeded) {
        if (state.lastSignInNotice !== new Date().toISOString().slice(0, 10)) {
          state.lastSignInNotice = new Date().toISOString().slice(0, 10);
          saveState(state);
          event("signin", { account: "clips", reason: e.message });
          ask(e.message);
        }
        return { action: "signin" };
      }
      throw e;
    }
    const api = client(config.apiUrl, tokens);
    const clips = clipsLane(state, api);
    // A. Clip Factory's lane, as in 1.1.0.
    let { on, helper, queue = [] } = await api.queue();
    // The owner's Start my Mac again and Let them go (D5): applied before anything is decided this tick; the ping
    // below says they are done. "Needs you" is never cleared here: only his answer on the stopped clip clears it, or
    // the helper's logged-in (§47.11, just below).
    const requests = applyRequests({ helper, settings, state });
    if (Object.keys(requests.patch).length) {
      saveSettings(requests.patch);
      settings = loadSettings();
    }
    if (requests.resumeDone) clips.event("resumed", {});
    if (requests.letGoDone) clips.event("hold_released", {});
    // §47.11: held only for a TikTok login, with the switch on and the Mac not paused: at most every 5 minutes a
    // headless look whether its Chrome is logged in to Clip Factory's TikTok again.
    let heldReason = null;
    let looked = false;
    const hold = loginHold(helper, "clips");
    if (hold && on === true && !settings.paused && triedHere(state.ledger, hold) && loginCheckDue(state.loginCheckAt, Date.now())) {
      looked = true;
      state.loginCheckAt = iso(); // before the look: a crash mid-look still waits 5 minutes
      saveState(state);
      const back = await loginBack(clips, hold, await clipsBack(api, state, clips));
      // Decide and check in on a fresh read only, whatever the look said: the hold may have ended (the resumed clip
      // may go in this same tick), or the owner may have answered while Chrome looked (his Try again, 24 Nov). A ping
      // of the stale needs_you would put back a hold with no clip and no code, which nothing could end; so when that
      // read fails, the tick ends here with no ping. The local pause is read again too: `cli.js off` during the look
      // (it takes no lock) means a paused Mac, so the clip the look resumed waits (review, 24 Nov).
      settings = loadSettings();
      try {
        ({ on, helper, queue = [] } = await api.queue());
      } catch (e) {
        log("login_back.read_failed", { error: words(e) });
        return { action: "login_back", outcome: back.outcome };
      }
      // The look's words only while that same login hold is still there (its code stays; the ping says why).
      if (back.words && loginHold(helper, "clips")?.id === hold.id) heldReason = back.words;
    }
    const needsYou = helper?.state === "needs_you";
    // Auto-posting's schedule, only needed while a backlog clip waits (it goes ~30 minutes after each run).
    let autopost = null;
    if (queue.some((j) => j.state === "waiting" && j.source !== "upload" && j.source !== "auto")) {
      try {
        const a = await api.autopost();
        const run = (a.runs || []).find((r) => r.kind === "scheduled" && r.mode === "live");
        autopost = { on: a.autoPost?.on === true, lastRunAt: run?.at ?? null, nextRunAt: a.nextRunAt ?? null };
      } catch (e) {
        log("autopost.read_failed", { error: words(e) });
      }
    }
    let action = needsYou
      ? { action: "paused", reason: heldReason || helper.reason || "Your Mac needs you." }
      : nextAction({ on, queue, state, settings, device: state.device, now: new Date(), autopost });
    // D3: Clip Factory's lane posts, resumes or looks only once it knows which TikTok is Clip Factory's.
    if (["post", "resume", "find"].includes(action.action) && !(await clipsTarget(api, state))) {
      action = { action: "wait", job: action.job, reason: WAIT_TARGET };
    }
    // §47.6: the owner's Change TikTok login / Forget TikTok login, done between posts (never in the middle of one).
    let loginDone;
    const request = helper?.loginRequest;
    if (request && !["post", "resume", "find"].includes(action.action)) {
      if (request.action === "forget") {
        await forgetLogin();
        clips.event("login_forgotten", {});
      } else if (request.action === "change") {
        const saved = await yourTurn("Type your TikTok login in the two Mac dialogs (kept only in your Keychain)", () =>
          askAndSaveLogin()
        );
        if (saved) {
          delete state.loginRefused; // a new login may be tried again
          state.loginTries = [];
          saveState(state);
          clips.event("login_saved", {});
        }
      }
      loginDone = request.at;
    }
    const pingState = needsYou ? "needs_you" : action.action === "paused" || action.reason === WAIT_TARGET ? "paused" : "ok";
    const checkIn = {
      state: pingState,
      ...(pingState !== "ok" && action.reason ? { reason: action.reason } : {}),
      version: VERSION,
      device: state.device,
    };
    // What the rows need to say without guessing (D4, D5): the first backlog clip's time, the hold, the backfill, and
    // the owner's requests done.
    const extras = pingExtras({ settings, state, autopost, resumeDone: requests.resumeDone, letGoDone: requests.letGoDone });
    try {
      await api.ping({ ...checkIn, login: (await hasLogin()) ? "saved" : "none", ...(loginDone ? { loginDone } : {}), ...extras });
    } catch (e) {
      // A Clip Factory from before §47.6 doesn't know these fields yet: check in without them.
      if (!(e instanceof ApiError && e.status === 400)) throw e;
      await api.ping(checkIn);
    }
    log("tick", { action: action.action, clipId: action.job?.clipId, waiting: queue.length, reason: action.reason, until: action.until });
    for (const skip of action.skipped || []) log("never_twice.skip", skip);
    // The one-time backfill ends by itself once no backlog clip is left (then the owner's rule again: runs and Uploads).
    // Only when the switch is on (an off switch reads as an empty queue) and the read really holds no backlog clip.
    if (settings.backfill && on === true && !queue.some((j) => j.source !== "upload" && j.source !== "auto")) {
      saveSettings({ backfill: null });
      clips.event("backfill_done", {});
    }
    // B. Clips Funded's lanes: their queues and check-ins (never in the way of Clip Factory's).
    let lanes = [];
    try {
      lanes = await wsLanes({ api, state, settings, config, tokens, now: new Date(), clipsBusy: ["post", "resume", "find"].includes(action.action), looked });
    } catch (e) {
      log("ws.error", { part: "lanes", error: words(e) });
    }
    // C. One thing: Clip Factory's first.
    const work = pickWork({ clips: action, lanes });
    if (work.lane === "clips" && (work.what === "post" || work.what === "resume" || work.what === "find")) {
      const stopWsBeats = wsBeats(lanes);
      try {
        return await clipsWork({ api, state, clips, action, queue, what: work.what });
      } finally {
        await stopWsBeats();
      }
    } else if (work.what === "tidy") {
      await tidy(clips, queue);
      for (const entry of lanes) await tidyWs(entry);
    } else {
      const entry = lanes[work.index];
      try {
        await wsWork(entry, work.what, api);
      } catch (e) {
        log("ws.error", { account: entry.id, what: work.what, error: String(e.stack || e) });
      }
      return { ...action, ws: { account: entry.id, action: work.what } };
    }
    return action;
  } finally {
    dropLock();
  }
}
