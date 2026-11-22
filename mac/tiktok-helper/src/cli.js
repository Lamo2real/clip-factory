#!/usr/bin/env node
// Clip Factory TikTok helper (docs/CONTRACTS.md §47).
//   node src/cli.js run           one tick (launchd runs this every minute)
//   node src/cli.js setup         ON THE OWNER'S COMMAND ONLY: shows the helper's Chrome so he logs in to TikTok and
//                                 signs in to Clip Factory once
//   node src/cli.js status        what the helper sees
//   node src/cli.js off | on      pause or resume on this Mac (the switch in Clip Factory is the main one)
//   node src/cli.js trial <n|none>  posts before the trial pause (none = no limit)
import { client } from "./api.js";
import { accessToken, appConfig, readRefreshToken, saveRefreshToken } from "./auth.js";
import * as chrome from "./chrome.js";
import { event, log } from "./notify.js";
import { APP_URL, BASE } from "./paths.js";
import { loadSettings, loadState, saveSettings } from "./store.js";
import { loggedIn } from "./tiktok.js";
import { tick } from "./run.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  const config = await appConfig();
  const prefix = `CognitoIdentityServiceProvider.${config.userPoolClientId}.`;
  const { browser, page } = await chrome.open({ visible: true });
  const context = page.context();
  let tiktok = await loggedIn(page);
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
        event("setup", { part: "clip_factory" });
      }
    }
  }
  if (tiktok) event("setup", { part: "tiktok" });
  console.log(`TikTok: ${tiktok ? "logged in" : "not yet"}. Clip Factory: ${signedIn ? "signed in" : "not yet"}.`);
  await chrome.quit(browser);
  return tiktok && signedIn;
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
      const api = client(config.apiUrl, await accessToken(config));
      const q = await api.queue();
      out.on = q.on;
      out.helper = q.helper;
      out.queue = q.queue.map((j) => ({ clipId: j.clipId, hook: j.hook, state: j.state, step: j.step, source: j.source }));
    } catch (e) {
      out.error = String(e.message || e);
    }
  }
  console.log(JSON.stringify(out, null, 2));
}

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === "run") {
    const result = await tick();
    if (process.env.CF_TT_VERBOSE) console.log(JSON.stringify(result));
  } else if (cmd === "setup") {
    process.exitCode = (await setup()) ? 0 : 1;
  } else if (cmd === "status") {
    await status();
  } else if (cmd === "off" || cmd === "on") {
    saveSettings({ paused: cmd === "off" });
    console.log(cmd === "off" ? "Paused on this Mac." : "Running on this Mac.");
  } else if (cmd === "trial") {
    const n = arg === "none" ? null : Number(arg);
    if (n !== null && !(Number.isInteger(n) && n >= 0)) throw new Error("trial takes a whole number or none");
    saveSettings({ trialLimit: n });
    console.log(`Trial limit: ${n === null ? "none" : n}.`);
  } else {
    console.log("Commands: run, setup, status, off, on, trial <n|none>");
    process.exitCode = 2;
  }
} catch (e) {
  log("cli.error", { cmd, error: String(e.stack || e) });
  console.error(String(e.message || e));
  process.exitCode = 1;
}
