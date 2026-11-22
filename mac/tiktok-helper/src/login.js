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
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

import { KEYCHAIN_SERVICE } from "./paths.js";
import { addSecret } from "./notify.js";

const run = promisify(execFile);
const USER_ACCOUNT = "tiktok-username";
const PASS_ACCOUNT = "tiktok-password";
export const MAX_TRIES_PER_DAY = 2;
const DAY = 24 * 60 * 60_000;

// --- the Keychain -------------------------------------------------------------------------------------------------

const quoteKc = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Runs one ``security`` command given on stdin (so a secret never shows in a process list). */
function securityIn(line) {
  return new Promise((resolve, reject) => {
    const p = spawn("/usr/bin/security", ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 && !/SecKeychain|error/i.test(err) ? resolve() : reject(new Error("The Keychain did not take it."))));
    p.stdin.end(`${line}\n`);
  });
}

async function readItem(account) {
  try {
    const { stderr } = await run("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-g"]);
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

/** The saved login, or null. Registers both as secrets, so nothing the helper writes can ever hold them. */
export async function readLogin() {
  const username = await readItem(USER_ACCOUNT);
  const password = await readItem(PASS_ACCOUNT);
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
      await run("/usr/bin/security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account]);
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
