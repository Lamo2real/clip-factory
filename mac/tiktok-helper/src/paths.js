// Where the helper keeps its things on the Mac. Nothing here is inside the repo checkout, so removing a worktree
// never breaks the installed helper.
import os from "node:os";
import path from "node:path";

export const HOME = os.homedir();
export const BASE = process.env.CF_TT_BASE || path.join(HOME, "Library", "Application Support", "Clip Factory TikTok");
export const PROFILE = path.join(BASE, "chrome"); // the helper's own Chrome profile (TikTok login lives here)
export const STATE = path.join(BASE, "state.json"); // device id, the never-twice ledger, pacing, trial count
export const SETTINGS = path.join(BASE, "settings.json"); // trial limit, spacing (edit by hand or with the CLI)
export const LOG = path.join(BASE, "helper.log"); // one line per event
export const EVENTS = path.join(BASE, "events.log"); // only stops and posts: what the owner (or a session) acts on
export const LOCK = path.join(BASE, "run.lock");
export const DOWNLOADS = process.env.CF_TT_DOWNLOADS || path.join(HOME, "Downloads");
export const CHROME =
  process.env.CF_TT_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const CHROME_APP = process.env.CF_TT_CHROME_APP || "/Applications/Google Chrome.app";
export const APP_URL = process.env.CF_TT_APP_URL || "https://dglrbjmf28m6c.cloudfront.net";
export const CDP_PORT = Number(process.env.CF_TT_PORT || 9339);
export const KEYCHAIN_SERVICE = "Clip Factory TikTok helper";
export const VERSION = "1.1.0";
