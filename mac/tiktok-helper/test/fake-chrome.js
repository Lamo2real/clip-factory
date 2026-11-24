// A helper Chrome for whole-tick tests, in place of src/chrome.js and src/cdp.js (tick-token.test.js swaps it in
// with a module hook): nothing starts, nothing shows, nothing is attached. By default its TikTok is logged out: every
// TikTok page lands on TikTok's login, no session cookie ever appears, and the owner never logs in. ``mac`` records
// what the tick asked of it, and a test may set:
//   mac.account  the account a lane's profile is logged in to: "@name", {handle, uid}, or {[laneId]: one of those}.
//                Its pages then have TikTok's session cookie and the passport answer names that account.
//   mac.text     what TikTok's page says (its visible text: "Verify to continue" is a puzzle).
//   mac.ownerLogsInAfterMs  a visible window (the owner's) has the session this long after it opened; a hidden
//                Chrome on the same profile still reads logged out (24 Nov 2026: the session wasn't kept).
//   mac.onOpen   called with {lane, visible} each time a Chrome opens (something the owner does meanwhile).
export const mac = { opened: [], windows: [], closedPorts: [], clearedPorts: [], quits: 0, quitsAt: [], visits: [], account: null, text: "", ownerLogsInAfterMs: null, sessionShownAt: null, onOpen: null };

export function resetMac() {
  Object.assign(mac, { opened: [], windows: [], closedPorts: [], clearedPorts: [], quits: 0, quitsAt: [], visits: [], account: null, text: "", ownerLogsInAfterMs: null, sessionShownAt: null, onOpen: null });
}

const one = (a) => (!a ? null : typeof a === "string" ? { handle: a } : a);
function accountOf(laneId) {
  const a = mac.account;
  if (!a || typeof a === "string" || a.handle) return one(a);
  return one(a[laneId]);
}

/** Every locator finds nothing (no dialog, no button, no rows). */
function nothing() {
  const none = {
    first: () => none,
    nth: () => none,
    filter: () => none,
    locator: () => none,
    getByRole: () => none,
    getByText: () => none,
    isVisible: async () => false,
    isEnabled: async () => false,
    isChecked: async () => false,
    count: async () => 0,
    innerText: async () => "",
    click: async () => {},
    scrollIntoViewIfNeeded: async () => {},
    waitFor: async () => {
      throw new Error("Nothing like that on this TikTok page.");
    },
  };
  return none;
}

/** A page of the lane's Chrome: logged out (every TikTok page is its login) unless the profile has an account. */
function tiktokPage(laneId, visible) {
  const openedAt = Date.now();
  let url = "about:blank";
  const session = () => {
    if (accountOf(laneId)) return true;
    if (visible && mac.ownerLogsInAfterMs !== null && Date.now() - openedAt >= mac.ownerLogsInAfterMs) {
      mac.sessionShownAt ??= Date.now();
      return true;
    }
    return false;
  };
  return {
    goto: async (to) => {
      mac.visits.push({ lane: laneId, visible, url: String(to) });
      url = /tiktok\.com/.test(String(to)) && !session() ? `https://www.tiktok.com/login?redirect_url=${encodeURIComponent(to)}` : String(to);
    },
    url: () => url,
    waitForLoadState: async () => {},
    getByRole: () => nothing(),
    getByText: () => nothing(),
    locator: () => nothing(),
    $$eval: async () => [],
    evaluate: async (fn) => {
      const code = String(fn);
      const account = accountOf(laneId);
      if (code.includes("/passport/")) {
        return account ? { data: { username: account.handle.replace(/^@/, ""), ...(account.uid ? { user_id_str: account.uid } : {}) } } : null;
      }
      if (code.includes("innerText")) return mac.text || "";
      return null;
    },
    screenshot: async () => {},
    setDefaultTimeout: () => {},
    mouse: { wheel: async () => {} },
    context: () => ({ cookies: async () => (session() ? [{ name: "sessionid", value: "fake-session" }] : []), clearCookies: async () => {} }),
  };
}

// chrome.js
export async function open(lane, { visible = false } = {}) {
  mac.opened.push({ lane: lane.id, visible });
  mac.onOpen?.({ lane: lane.id, visible });
  return { browser: { lane: lane.id, visible }, page: tiktokPage(lane.id, visible) };
}
export async function quit(browser) {
  mac.quits++;
  mac.quitsAt.push({ lane: browser?.lane, visible: Boolean(browser?.visible), at: Date.now() });
}
export async function closePort(port) {
  mac.closedPorts.push(port);
}
/** The owner's login window (a Clips Funded lane's): he never scans the code. */
export async function openPlain(lane, url) {
  mac.windows.push({ lane: lane.id, url });
}
export async function running() {
  return false;
}

// cdp.js
/** The window is open and has no TikTok session in it. */
export async function sessionSeen() {
  return false;
}
export async function clearCookies(port) {
  mac.clearedPorts.push(port);
}
export async function browserUrl() {
  return null;
}
export async function closeBrowser() {}
