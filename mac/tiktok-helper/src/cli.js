#!/usr/bin/env node
// Clip Factory TikTok helper (docs/CONTRACTS.md §47).
//   node src/cli.js run           one tick (launchd runs this every minute)
//   node src/cli.js setup         ON THE OWNER'S COMMAND ONLY: shows the helper's Chrome so he logs in to TikTok and
//                                 signs in to Clip Factory once; a clip stopped only for a TikTok login then carries
//                                 on by itself once the profile reads Clip Factory's TikTok (§47.11)
//   node src/cli.js status        what the helper sees
//   node src/cli.js off | on      pause or resume on this Mac (the switch in Clip Factory is the main one)
//   node src/cli.js trial <n|none>  posts before the trial pause (none = no limit)
//   node src/cli.js login          ON THE OWNER'S COMMAND: two Mac dialogs ask for the TikTok login once and keep it
//                                 in the Keychain, so the helper can log back in by itself (yellow frame meanwhile)
//   node src/cli.js forget-login   deletes the saved TikTok login from the Keychain
//   node src/cli.js probe <clipId>  a check run in the hidden Chrome: fills in TikTok Studio for that clip exactly as
//                                 for a post, reads every setting back, then stops before Post (nothing is posted,
//                                 nothing is claimed). Saves a picture of the filled-in page as probe.png.
//                                 1.3.0: --branded (Branded content, as every campaign clip), --your-brand, --privacy
//                                 <PUBLIC_TO_EVERYONE|MUTUAL_FOLLOW_FRIENDS|SELF_ONLY>, --caption <text> (a clip that
//                                 is on TikTok already), --quiet (no frame: nothing on screen at all). It prints the
//                                 disclosure TikTok reads back (label) and whether Studio shows "Paid partnership".
//   node src/cli.js whoami [--workspace <id>]  which TikTok the lane's Chrome is logged in to (Clip Factory's lane
//                                 without --workspace), and the account it may post to. Prints a handle, never a cookie.
//   node src/cli.js setup --workspace <id>  ON THE OWNER'S COMMAND ONLY: a Clips Funded workspace's one-time TikTok
//                                 login, in a window on its own profile (the QR code with the TikTok app)
//   node src/cli.js probe --workspace <id> --story <storyId>  the check run for a Clips Funded story, AI label
//                                 included; saves probe-ws-<id>.png and posts nothing
import { client, wsClient } from "./api.js";
import { frame, yourTurn } from "./frame.js";
import { askAndSaveLogin, forgetLogin, hasLogin, loginWindow } from "./login.js";
import { accessToken, appConfig, freshTokens, readRefreshToken, saveRefreshToken, tokenSource } from "./auth.js";
import * as chrome from "./chrome.js";
import { backLine, freshBacks, loginBack, sendBack } from "./hold.js";
import { WS_ID, clipsLane, normalizeWsJob, wsFileName, wsLane } from "./lanes.js";
import { event, log } from "./notify.js";
import { APP_URL, BASE } from "./paths.js";
import { loadSettings, loadState, saveSettings, saveState } from "./store.js";
import fs from "node:fs";
import path from "node:path";

import { freeName } from "./match.js";
import { DOWNLOADS } from "./paths.js";
import { loggedIn, post } from "./tiktok.js";
import { loginHold } from "./plan.js";
import { SESSION_SETTLE_MS, clipsBack, clipsTarget, lookHeadless, tick, windowDeps, withLock, wsBack } from "./run.js";
import { at, sameAccount } from "./whoami.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * The Clip Factory sign-in for a command: every call gets a fresh token when it needs one (auth.js tokenSource), since
 * setup --workspace can wait 20 minutes for a login, longer than one access token (15). The first token is fetched
 * here, so a sign-in problem shows at once, as before.
 */
async function signIn(config) {
  const tokens = tokenSource(() => freshTokens(config));
  await tokens.get();
  return tokens;
}

async function setup() {
  const config = await appConfig();
  const prefix = `CognitoIdentityServiceProvider.${config.userPoolClientId}.`;
  const { browser, page } = await chrome.open(clipsLane(loadState(), null), { visible: true });
  const context = page.context();
  let tiktok = await loggedIn(page);
  const wasIn = tiktok;
  let signedIn = Boolean(await readRefreshToken());
  if (!tiktok) await page.goto("https://www.tiktok.com/login?lang=en");
  let app = null;
  if (!signedIn) {
    app = await context.newPage();
    await app.goto(APP_URL);
  }
  console.log("In the Chrome window that opened:");
  if (!tiktok) console.log(" - log in to TikTok (the QR code with your phone is easiest)");
  if (!signedIn) console.log(" - sign in to Clip Factory in the second tab");
  const until = Date.now() + 20 * 60_000;
  while (Date.now() < until && !(tiktok && signedIn)) {
    await sleep(2000);
    if (!tiktok) tiktok = await loggedIn(page).catch(() => false);
    if (!signedIn && app) {
      const token = await app
        .evaluate((p) => {
          const key = Object.keys(localStorage).find((k) => k.startsWith(p) && k.endsWith(".refreshToken"));
          return key ? localStorage.getItem(key) : null;
        }, prefix)
        .catch(() => null);
      if (token) {
        await saveRefreshToken(token);
        // Only the helper refreshes it from now on: the page forgets this sign-in (rotation would undo one of them).
        await app
          .evaluate((p) => {
            for (const k of Object.keys(localStorage)) if (k.startsWith(p)) localStorage.removeItem(k);
          }, prefix)
          .catch(() => {});
        await app.close().catch(() => {});
        await accessToken(config); // checks it works and rotates it once
        signedIn = true;
        event("setup", { account: "clips", part: "clip_factory" });
      }
    }
  }
  if (tiktok) event("setup", { account: "clips", part: "tiktok" });
  console.log(`TikTok: ${tiktok ? "logged in" : "not yet"}. Clip Factory: ${signedIn ? "signed in" : "not yet"}.`);
  // D6 (§47.11): a login that just happened here gets TikTok's own redirects and its kept session first, as the
  // relogin window does, so afterLogin's hidden look right after reads it (24 Nov: logged out 7 seconds later).
  if (tiktok && !wasIn) await sleep(SESSION_SETTLE_MS);
  await chrome.quit(browser);
  return tiktok && signedIn;
}

/**
 * §47.11, after his own setup (still under run.lock): when Clip Factory's lane is held only for a TikTok login, the
 * helper looks at once (headless; never capped: it was his command) and, logged in to Clip Factory's TikTok, ends the
 * hold so the stopped clip carries on. Prints one line; false only when the profile is on another account.
 */
async function afterLogin() {
  try {
    const config = await appConfig();
    const api = client(config.apiUrl, await signIn(config));
    const state = loadState();
    const lane = clipsLane(state, api);
    delete state.loginCheckAt; // the next tick looks at once
    saveState(state);
    freshBacks(lane); // his own login: the tick's looks may end a login hold again
    const { helper } = (await api.queue()) || {};
    const hold = loginHold(helper, "clips");
    if (!hold) return true;
    const d = await clipsBack(api, state, lane, { capped: false });
    const back = await loginBack(lane, hold, d);
    const line = backLine(lane, back, d.target);
    if (line) console.log(line);
    return back.outcome !== "wrong";
  } catch (e) {
    log("setup.after_login_error", { error: String(e.stack || e) });
    return true;
  }
}

/** The signed-in API clients and a Clips Funded workspace's lane with its Mac status (the account it posts to). */
async function wsContext(workspaceId) {
  if (!WS_ID.test(String(workspaceId || ""))) throw new Error("--workspace takes a Clips Funded workspace id (like stories).");
  const config = await appConfig();
  const tokens = await signIn(config);
  const api = client(config.apiUrl, tokens);
  const state = loadState();
  const lane = wsLane(state, workspaceId, wsClient(config.apiUrl, tokens, workspaceId));
  const status = (await lane.api.queue()) || {};
  return { api, state, lane, status, target: at(status.account?.handle) };
}

/** A Clips Funded workspace's one-time TikTok login (§47.10, D6): the owner's own, in the lane's own window. */
async function wsSetup(workspaceId) {
  return withLock(async () => {
    const { api, state, lane, status, target } = await wsContext(workspaceId);
    if (!target) {
      console.log("Connect TikTok in Clips Funded › Social accounts first.");
      return false;
    }
    await clipsTarget(api, state);
    console.log(`A TikTok window opens. Log in as ${target}: scan the code with the TikTok app.`);
    const result = await loginWindow(lane, target, windowDeps(lane));
    console.log(result.ok ? `Logged in as ${result.handle}.` : `Not logged in (${result.outcome}).`);
    if (result.ok) {
      // §47.11: the window already read and pinned the account, so a post held only for a TikTok login carries on
      // now, with no second look (his command: never capped).
      delete lane.store.loginCheckAt;
      lane.save();
      freshBacks(lane);
      const hold = loginHold(status.helper, "ws");
      if (hold) {
        const line = backLine(lane, await sendBack(lane, hold, wsBack(lane, target, { capped: false })), target);
        if (line) console.log(line);
      }
    }
    return result.ok;
  });
}

/** Which TikTok the lane's Chrome is logged in to, and whether that is the account it may post to. No cookie. */
async function whoami(workspaceId) {
  return withLock(async () => {
    let lane;
    let target;
    if (workspaceId) {
      ({ lane, target } = await wsContext(workspaceId));
    } else {
      const config = await appConfig();
      const api = client(config.apiUrl, await signIn(config));
      const state = loadState();
      lane = clipsLane(state, api);
      target = await clipsTarget(api, state);
    }
    const look = await lookHeadless(lane);
    try {
      const res = target ? sameAccount(look.seen, target, null) : { verdict: "unknown" };
      console.log(
        JSON.stringify(
          { account: lane.id, loggedInAs: look.seen.handles, target: target || null, matches: res.verdict === "same", verdict: res.verdict },
          null,
          2
        )
      );
      return res.verdict === "same";
    } finally {
      await look.quit();
    }
  });
}

/** The check run for a Clips Funded story: everything up to Post, AI label included, then nothing. */
async function wsProbe(workspaceId, storyId) {
  if (!storyId) throw new Error("probe --workspace takes --story <storyId>");
  return withLock(async () => {
    const { api, state, lane, target } = await wsContext(workspaceId);
    if (!target) throw new Error("Connect TikTok in Clips Funded › Social accounts first.");
    await clipsTarget(api, state);
    const { story } = await lane.api.story(storyId);
    const title = String(story?.title || "");
    const slug = title.normalize("NFKD").replace(/[^\x00-\x7f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "story";
    const job = normalizeWsJob({
      publishingJobId: `probe-${storyId}`,
      storyId,
      hook: title,
      caption: String(story?.postCaptions?.tiktok || title).normalize("NFC"),
      fileName: `clips-funded-${slug}.mp4`,
      account: { handle: target },
    });
    const { url } = await lane.api.file(job);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`The video did not download (${res.status}).`);
    const file = path.join(DOWNLOADS, freeName(wsFileName(job.fileName), (n) => fs.existsSync(path.join(DOWNLOADS, n))));
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    const picture = path.join(BASE, `probe-ws-${workspaceId}.png`);
    const { browser, page } = await chrome.open(lane);
    try {
      const steps = [];
      const clips = state.clipsAccount || {};
      const result = await post(page, job, file, async (s) => void steps.push(s), {
        dryRun: true,
        kind: "ws",
        target,
        uid: lane.pinnedUid(job),
        notUid: clips.uid || null,
        notHandle: clips.handle || null,
      });
      await page.screenshot({ path: picture, fullPage: true }).catch(() => {});
      console.log(JSON.stringify({ ok: true, account: lane.id, target, steps, ...result, baseline: undefined }, null, 2));
    } catch (e) {
      await page.screenshot({ path: picture, fullPage: true }).catch(() => {});
      console.log(JSON.stringify({ ok: false, account: lane.id, stop: e.reason || String(e.message || e), detail: e.detail, url: page.url() }, null, 2));
    } finally {
      await chrome.quit(browser, lane);
      fs.rmSync(file, { force: true });
    }
  });
}

/** --quiet: the check run shows nothing at all (no frame, no notification), as a normal post. */
function quietFrame() {
  return { shown: true, on: async () => true, step: async () => {}, done: async () => {}, off: async () => {} };
}

async function probe(clipId, options = {}) {
  return withLock(() => clipsProbe(clipId, options));
}

const PROBE_PRIVACY = ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"];

async function clipsProbe(clipId, options = {}) {
  const config = await appConfig();
  const api = client(config.apiUrl, await signIn(config));
  const state = loadState();
  const lane = clipsLane(state, api);
  const target = await clipsTarget(api, state);
  const clip = (await api.clip(clipId)).clip;
  const privacy = typeof options.privacy === "string" ? options.privacy : "PUBLIC_TO_EVERYONE";
  if (!PROBE_PRIVACY.includes(privacy)) throw new Error(`--privacy takes ${PROBE_PRIVACY.join(", ")}`);
  const job = {
    clipId,
    hook: clip.hook || "",
    caption: typeof options.caption === "string" ? options.caption : clip.captions?.tiktok || "",
    privacy,
    comment: true,
    duet: true,
    stitch: true,
    brandContent: options.branded === true,
    brandOrganic: options["your-brand"] === true,
  };
  const { url, filename } = await api.file(clipId);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`The video did not download (${res.status}).`);
  const file = path.join(DOWNLOADS, freeName(filename, (n) => fs.existsSync(path.join(DOWNLOADS, n))));
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  const fr = options.quiet === true ? quietFrame() : frame();
  if (!(await fr.on(`Check run: filling in TikTok for “${job.hook}” (nothing is posted)`))) {
    fs.rmSync(file, { force: true });
    throw new Error("The red frame couldn't be shown, so the check didn't run.");
  }
  const { browser, page } = await chrome.open(lane);
  let ok = false;
  try {
    const steps = [];
    const result = await post(page, job, file, async (s) => { steps.push(s); await fr.step(`Check run: ${s}`); }, {
      dryRun: true,
      kind: "clips",
      target,
      uid: lane.pinnedUid(),
    });
    ok = true;
    await page.screenshot({ path: path.join(BASE, "probe.png"), fullPage: true }).catch(() => {});
    // A second picture with the settings in view: who can see it, Comment, Reuse of content.
    const heading = page.getByText(/^(Who can see this post|Who can watch this video)$/).first();
    await heading.scrollIntoViewIfNeeded().catch(() => {});
    await page.mouse.wheel(0, 200).catch(() => {});
    await new Promise((r) => setTimeout(r, 600));
    await page.screenshot({ path: path.join(BASE, "probe-settings.png") }).catch(() => {});
    console.log(JSON.stringify({ ok: true, steps, ...result, baseline: undefined }, null, 2));
  } catch (e) {
    await page.screenshot({ path: path.join(BASE, "probe.png"), fullPage: true }).catch(() => {});
    console.log(JSON.stringify({ ok: false, stop: e.reason || String(e.message || e), detail: e.detail, url: page.url() }, null, 2));
  } finally {
    await chrome.quit(browser, lane);
    fs.rmSync(file, { force: true });
    if (ok) await fr.done("Check run done: nothing was posted");
    else await fr.off();
  }
}

async function status() {
  const settings = loadSettings();
  const state = loadState();
  const out = { folder: BASE, settings, posted: state.posted, device: state.device };
  out.open = Object.entries(state.ledger)
    .filter(([, v]) => v.step !== "done")
    .map(([clipId, v]) => ({ clipId, ...v, baseline: undefined }));
  out.signedIn = Boolean(await readRefreshToken());
  if (out.signedIn) {
    try {
      const config = await appConfig();
      const tokens = await signIn(config);
      const api = client(config.apiUrl, tokens);
      const q = await api.queue();
      out.on = q.on;
      out.helper = q.helper;
      out.queue = q.queue.map((j) => ({ clipId: j.clipId, hook: j.hook, state: j.state, step: j.step, source: j.source }));
      out.clipsAccount = state.clipsAccount || null;
      // Every Clips Funded lane: its profile, port, the account it is logged in as, and its queue.
      out.lanes = [];
      const { workspaces = [] } = (await api.workspaces()) || {};
      for (const w of workspaces) {
        if (w?.workspaceType !== "stories" || !WS_ID.test(String(w.workspaceId || ""))) continue;
        const store = state.ws?.[w.workspaceId] || {};
        const lane = { account: `ws:${w.workspaceId}`, port: store.port ?? null, loggedInAs: store.account || null, posted: (store.posted || []).length };
        lane.open = Object.entries(store.ledger || {})
          .filter(([, v]) => v.step !== "done")
          .map(([publishingJobId, v]) => ({ publishingJobId, ...v, baseline: undefined }));
        try {
          const s = await wsClient(config.apiUrl, tokens, w.workspaceId).queue();
          lane.on = s.on;
          lane.helper = s.helper;
          lane.target = s.account?.handle ?? null;
          lane.queue = (s.queue || []).map((j) => ({ publishingJobId: j.publishingJobId, hook: j.hook, state: j.state, step: j.step }));
        } catch (e) {
          lane.error = String(e.message || e);
        }
        out.lanes.push(lane);
      }
    } catch (e) {
      out.error = String(e.message || e);
    }
  }
  console.log(JSON.stringify(out, null, 2));
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = {};
const plain = [];
for (let i = 1; i < argv.length; i++) {
  if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  else plain.push(argv[i]);
}
const arg = plain[0];
try {
  if (cmd === "run") {
    const result = await tick();
    if (process.env.CF_TT_VERBOSE) console.log(JSON.stringify(result));
  } else if (cmd === "setup" && flags.workspace) {
    process.exitCode = (await wsSetup(flags.workspace)) ? 0 : 1;
  } else if (cmd === "setup") {
    process.exitCode = (await withLock(async () => (await setup()) && (await afterLogin()))) ? 0 : 1;
  } else if (cmd === "whoami") {
    process.exitCode = (await whoami(flags.workspace === true ? undefined : flags.workspace)) ? 0 : 1;
  } else if (cmd === "status") {
    await status();
  } else if (cmd === "off" || cmd === "on") {
    saveSettings({ paused: cmd === "off" });
    console.log(cmd === "off" ? "Paused on this Mac." : "Running on this Mac.");
  } else if (cmd === "login") {
    const saved = await yourTurn("Type your TikTok login in the two Mac dialogs (kept only in your Keychain)", () => askAndSaveLogin());
    if (saved) {
      const state = loadState();
      delete state.loginRefused; // a new login may be tried again
      state.loginTries = [];
      saveState(state);
      event("login_saved", { account: "clips" });
    }
    console.log(saved ? "Saved in the Keychain." : "Not saved (cancelled or no answer).");
    process.exitCode = saved ? 0 : 1;
  } else if (cmd === "forget-login") {
    await forgetLogin();
    event("login_forgotten", { account: "clips" });
    console.log((await hasLogin()) ? "Still there?" : "Forgotten.");
  } else if (cmd === "backfill") {
    // node src/cli.js backfill on|burst|off: the owner's one-time backfill pace for the backlog (plan.js backfillAction).
    // "burst": the owner's one-time batch (22 Nov: "upload all videos ... right away"), back to back, stopping the
    // whole batch at the first limit, warning or puzzle.
    const burst = { everyMinutes: 1, quietMinutes: 1, maxPer24h: 10_000, totalMax24h: 10_000, haltOnStop: true };
    const paced = { everyMinutes: 120, quietMinutes: 60, maxPer24h: 7, totalMax24h: 11 };
    saveSettings({ backfill: arg === "off" ? null : arg === "burst" ? burst : paced });
    console.log(arg === "off" ? "Backfill off." : arg === "burst" ? "Backfill burst: back to back, stops at the first limit or warning." : "Backfill on: one every 2 hours, at most 7 a day, 11 TikTok posts a day in all.");
  } else if (cmd === "probe" && flags.workspace) {
    await wsProbe(flags.workspace, flags.story === true ? undefined : flags.story);
  } else if (cmd === "probe") {
    if (!arg) throw new Error("probe takes a clip id");
    await probe(arg, flags);
  } else if (cmd === "trial") {
    const n = arg === "none" ? null : Number(arg);
    if (n !== null && !(Number.isInteger(n) && n >= 0)) throw new Error("trial takes a whole number or none");
    saveSettings({ trialLimit: n });
    console.log(`Trial limit: ${n === null ? "none" : n}.`);
  } else {
    console.log(
      "Commands: run, setup [--workspace <id>], whoami [--workspace <id>], login, forget-login, status, off, on, trial <n|none>, backfill on|burst|off, probe <clipId>, probe --workspace <id> --story <storyId>"
    );
    process.exitCode = 2;
  }
} catch (e) {
  log("cli.error", { cmd, error: String(e.stack || e) });
  console.error(String(e.message || e));
  process.exitCode = 1;
}
