// The owner's TikTok login, kept in the Mac's login Keychain so the helper can log back in by itself.
// The owner, 22 Nov 2026: "Yes, use Keychain".
//
// Rules:
// - The login is asked for once, in two Mac dialogs (the password one hidden), shown with the yellow frame. It goes
//   from the dialog's answer (a pipe, never a file) into the Keychain (through security's stdin, never a command
//   line), under the helper's own service name. It is never logged, sent to Clip Factory, written to a file, put in a
//   notification or shown on a picture: every log line, event, notification and API body is scrubbed (notify.js
//   secrets) and the API client refuses a body that holds it.
// - A password log-in is tried at most twice in 24 hours, and never again after TikTok says the login is wrong or
//   locked, until the owner changes it (no lockouts). A code, a puzzle or a new-device check is handed to the owner.
// - 1.2.0 (§47.10, D6): the Keychain login is Clip Factory's lane's only. A Clips Funded lane has none
//   (``lane.keychain`` is null), so readLogin never falls back to Clip Factory's items for it: its login is the
//   owner's own, once, in a visible window on its own profile (loginWindow below), with no password anywhere.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { KEYCHAIN_SERVICE, SECURITY } from "./paths.js";
import { addSecret } from "./notify.js";
import { at, bare, sameAccount } from "./whoami.js";

const run = promisify(execFile);
/** Clip Factory's Keychain items (unchanged since 1.0). */
export const CLIPS_KEYCHAIN = Object.freeze({ user: "tiktok-username", pass: "tiktok-password" });
const USER_ACCOUNT = CLIPS_KEYCHAIN.user;
const PASS_ACCOUNT = CLIPS_KEYCHAIN.pass;
export const MAX_TRIES_PER_DAY = 2;
const DAY = 24 * 60 * 60_000;

// --- the Keychain -------------------------------------------------------------------------------------------------

const quoteKc = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Runs one ``security`` command given on stdin (so a secret never shows in a process list). */
function securityIn(line) {
  return new Promise((resolve, reject) => {
    const p = spawn(SECURITY, ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 && !/SecKeychain|error/i.test(err) ? resolve() : reject(new Error("The Keychain did not take it."))));
    p.stdin.end(`${line}\n`);
  });
}

async function readItem(account) {
  try {
    const { stderr } = await run(SECURITY, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-g"]);
    const line = String(stderr || "").split("\n").find((l) => l.startsWith("password:")) || "";
    const hex = /^password: 0x([0-9A-Fa-f]+)/.exec(line);
    if (hex) return Buffer.from(hex[1], "hex").toString("utf8");
    const m = /^password: "(.*)"$/.exec(line);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export async function saveLogin(username, password) {
  await securityIn(`add-generic-password -U -s ${quoteKc(KEYCHAIN_SERVICE)} -a ${quoteKc(USER_ACCOUNT)} -w ${quoteKc(username)}`);
  await securityIn(`add-generic-password -U -s ${quoteKc(KEYCHAIN_SERVICE)} -a ${quoteKc(PASS_ACCOUNT)} -w ${quoteKc(password)}`);
}

/**
 * The lane's saved login, or null. Registers both as secrets, so nothing the helper writes can ever hold them.
 * Without a lane it is Clip Factory's (as in 1.1.0); a lane without ``keychain`` (Clips Funded) has none at all.
 */
export async function readLogin(lane) {
  const keychain = lane === undefined ? CLIPS_KEYCHAIN : lane?.keychain;
  if (!keychain?.user || !keychain?.pass) return null;
  const username = await readItem(keychain.user);
  const password = await readItem(keychain.pass);
  if (!username || !password) return null;
  addSecret(password);
  return { username, password };
}

export async function hasLogin() {
  return Boolean((await readItem(USER_ACCOUNT)) && (await readItem(PASS_ACCOUNT)));
}

export async function forgetLogin() {
  for (const account of [USER_ACCOUNT, PASS_ACCOUNT]) {
    try {
      await run(SECURITY, ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account]);
    } catch {
      // not there
    }
  }
}

// --- asking the owner once ------------------------------------------------------------------------------------------

/** One Mac dialog; its answer comes back through osascript's stdout (never a file). null = Cancel or no answer. */
async function dialog(text, { hidden = false, title = "TikTok login for your Mac" } = {}) {
  const script = [
    `set r to display dialog ${JSON.stringify(text)} default answer "" ${hidden ? "with hidden answer " : ""}with title ${JSON.stringify(title)} buttons {"Cancel", "Save"} default button "Save" giving up after 600`,
    `if gave up of r then return ""`,
    `return text returned of r`,
  ];
  try {
    const { stdout } = await run("/usr/bin/osascript", script.flatMap((l) => ["-e", l]), { timeout: 660_000 });
    const answer = stdout.replace(/\n$/, "");
    return answer.trim() ? answer : null;
  } catch {
    return null; // Cancel (-128), or the dialog could not show
  }
}

/** Asks for the @lamo.clips login in two dialogs and saves it in the Keychain. Returns true when it was saved. */
export async function askAndSaveLogin() {
  // The owner (22 Nov): "the first one should be email and second is password". Anything half-saved goes first.
  await forgetLogin();
  const username = await dialog(
    "Email for TikTok\n\nThe email you log in to TikTok with (@lamo.clips). It is kept only in your Mac's Keychain, so your Mac can log back in to TikTok by itself.",
    { title: "Email for TikTok" }
  );
  if (!username) return false;
  const password = await dialog("Password for TikTok\n\nIt shows as dots. It is kept only in your Mac's Keychain, never sent anywhere.", {
    hidden: true,
    title: "Password for TikTok",
  });
  if (!password) return false;
  addSecret(password);
  await saveLogin(username.trim(), password);
  return true;
}

// --- when to try a password, and what TikTok answered ---------------------------------------------------------------

/** May the helper try the saved password now? At most twice in 24 hours, never after TikTok refused it. */
export function passwordAllowed(state, now = Date.now()) {
  if (state.loginRefused) return { ok: false, reason: "TikTok refused the saved login. Change it in Clip Factory, or log in on your Mac." };
  const recent = (state.loginTries || []).filter((t) => now - Date.parse(t) < DAY);
  if (recent.length >= MAX_TRIES_PER_DAY) return { ok: false, reason: "The helper already tried the saved login twice today. Log in on your Mac." };
  return { ok: true };
}

/** Records a try before it is made (so a crash mid-try still counts). */
export function countTry(state, now = Date.now()) {
  const recent = (state.loginTries || []).filter((t) => now - Date.parse(t) < DAY);
  state.loginTries = [...recent, new Date(now).toISOString()];
}

/**
 * What TikTok's page says after the password was sent: "ok" (logged in), "needs_you" (a code, a puzzle, a new-device
 * check: the owner's turn), "refused" (wrong login, or locked: never try it again) or "waiting" (nothing yet).
 */
const REFUSED = [
  /maximum number of attempts|too many attempts|account (is )?(locked|banned|suspended)|try again later/i,
  /incorrect (account|username|email|password)|wrong password|doesn.t match|account doesn.t exist|password is incorrect/i,
];
const NEEDS_YOU = [
  /enter (the )?(6-digit )?(verification )?code|we sent (a|the|you a) (verification )?code|code sent to/i,
  /new device|confirm it.s you|verify (it.s you|your identity)|security (check|verification)/i,
  /drag the (slider|puzzle)|select \d+ objects|rotate the|captcha|puzzle/i,
];

/** A pattern that matches the page now but did not before the password was sent (the login page's own words, like
 * "Log in with code", never count). */
const fresh = (re, text, before) => re.test(text) && !re.test(before);

export function loginOutcome({ loggedIn, text = "", before = "", url = "" }) {
  if (loggedIn) return "ok";
  const t = String(text);
  const b = String(before);
  if (REFUSED.some((re) => fresh(re, t, b))) return "refused";
  if (NEEDS_YOU.some((re) => fresh(re, t, b))) return "needs_you";
  if (/captcha|verify|challenge/i.test(String(url))) return "needs_you";
  return "waiting";
}

// --- a Clips Funded lane's login: the owner's own, once, in a visible window (§47.10, D6) ---------------------------

export const LOGIN_WINDOW_MS = 20 * 60_000;
export const QR_URL = "https://www.tiktok.com/login/qrcode?lang=en";
export const windowAsk = (target) => `Log in to TikTok as ${target} in the window. Scan the code with the TikTok app.`;
export const otherAsk = (seen, target) => `That's ${seen}. Log in as ${target}.`;

/**
 * The owner logs the lane's own Chrome profile in to TikTok as ``target``: a visible window at TikTok's QR code page
 * (Continue with Google works there too), with the yellow frame and one pop-up. The helper never attaches to the
 * window's page; it only watches for TikTok's session cookie, then closes the window, opens the profile headless
 * and reads who it is. The target is pinned only when the handle reads as the target (and is never Clip Factory's
 * handle or uid). Another account's login is wiped from that profile and the window opens once more, within the
 * same 20 minutes. Nothing is typed, no password is asked, read or kept.
 *
 * Every Mac action comes from ``d`` (run.js builds it; tests use fakes):
 *   closeAll(), openWindow(url), sessionSeen() → true | false | null (gone), closeWindow(),
 *   headless() → {seen, clear(), quit()}, ask(text) → close(), event(kind, fields), sleep(ms), now() → ms,
 *   clips → {handle?, uid?} (Clip Factory's account, which this lane must never be), pin(account)
 * @returns {Promise<{ok: boolean, outcome: "ok"|"timeout"|"closed"|"wrong"|"unknown"|"no_account"|"clips_account",
 *   handle?: string, uid?: string, seen?: string}>}
 */
export async function loginWindow(lane, target, d) {
  const want = at(target);
  const clips = d.clips || {};
  let outcome = "timeout";
  let result = { ok: false, outcome };
  if (!want) {
    result = { ok: false, outcome: "no_account" };
    d.event("login_window", { account: lane.id, outcome: result.outcome });
    return result;
  }
  if (clips.handle && bare(clips.handle) === bare(want)) {
    // Never set a Clips Funded lane up as Clip Factory's account.
    result = { ok: false, outcome: "clips_account" };
    d.event("login_window", { account: lane.id, outcome: result.outcome });
    return result;
  }
  const until = d.now() + LOGIN_WINDOW_MS;
  let close = d.ask(windowAsk(want));
  try {
    for (let opens = 0; opens < 2 && d.now() < until; opens++) {
      await d.closeAll();
      await d.openWindow(QR_URL);
      let got = null;
      while (d.now() < until) {
        got = await d.sessionSeen();
        if (got !== false) break;
        await d.sleep(3000);
      }
      if (got === null) {
        outcome = "closed"; // the owner closed the window
        break;
      }
      if (!got) {
        await d.closeWindow();
        outcome = "timeout";
        break;
      }
      await d.sleep(3000); // TikTok finishes its own redirects first
      await d.closeWindow();
      const look = await d.headless();
      try {
        const seen = look.seen || {};
        const clipsName = clips.handle ? bare(clips.handle) : "";
        const isClips = clipsName && (seen.handles || []).some((h) => bare(h) === clipsName);
        const res = isClips ? { verdict: "wrong", seen: at(clips.handle) } : sameAccount(seen, want, null, { notUid: clips.uid || null });
        if (res.verdict === "same") {
          d.pin({ handle: want, ...(res.uid ? { uid: res.uid } : {}) });
          outcome = "ok";
          result = { ok: true, outcome, handle: want, ...(res.uid ? { uid: res.uid } : {}) };
          d.event("setup", { account: lane.id, how: "owner" });
          return result;
        }
        if (res.verdict === "wrong") {
          await look.clear(); // that account's login leaves this profile only
          outcome = "wrong";
          result = { ok: false, outcome, seen: res.seen };
          close();
          close = d.ask(otherAsk(res.seen, want));
          continue;
        }
        outcome = "unknown";
        break;
      } finally {
        await look.quit();
      }
    }
    result = { ...result, ok: false, outcome };
    return result;
  } finally {
    close();
    d.event("login_window", { account: lane.id, outcome: result.ok ? "ok" : outcome });
  }
}
