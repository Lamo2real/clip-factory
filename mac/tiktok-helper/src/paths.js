// Where the helper keeps its things on the Mac. Nothing here is inside the repo checkout, so removing a worktree
// never breaks the installed helper.
import os from "node:os";
import path from "node:path";

export const HOME = os.homedir();
export const BASE = process.env.CF_TT_BASE || path.join(HOME, "Library", "Application Support", "Clip Factory TikTok");
export const PROFILE = path.join(BASE, "chrome"); // Clip Factory's Chrome profile (the @lamo.clips TikTok login lives here)
// Clips Funded's lanes (§47.10): one Chrome profile per workspace, "chrome-ws-{workspaceId}", never Clip Factory's.
export const wsProfile = (workspaceId) => path.join(BASE, `chrome-ws-${workspaceId}`);
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
// Each Clips Funded workspace gets the lowest free port of these ten (9340–9349), kept in state.json.
export const WS_PORT_BASE = Number(process.env.CF_TT_WS_PORT_BASE || 9340);
export const WS_PORT_COUNT = 10;
export const KEYCHAIN_SERVICE = "Clip Factory TikTok helper";
// macOS's Keychain tool (a fake one in tests).
export const SECURITY = process.env.CF_TT_SECURITY || "/usr/bin/security";
// 1.2.0: Clips Funded's lanes, the handle check before every post, and the AI label (the server's MAC_WS_FROM).
// 1.2.1: a fresh Clip Factory token for every call (auth.js tokenSource), so a 20-minute login wait ends with its stop.
// 1.2.2: a hold that is only a TikTok login ends by itself once the lane's Chrome reads its own account again (§47.11).
// 1.2.3: a pause during a login look wins, only the Mac that stopped looks, and a pause since the lane decided wins.
// 1.3.0: Clip Factory's posts get TikTok's Branded content / Your brand disclosure from the job, read back before Post
// (the server's MAC_BRAND_FROM: a post with a label is only claimed by this version or newer), and the claim says it.
export const VERSION = "1.3.0";
