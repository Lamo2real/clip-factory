// A helper Chrome for whole-tick tests, in place of src/chrome.js and src/cdp.js (tick-token.test.js swaps it in
// with a module hook): nothing starts, nothing shows, nothing is attached. Its TikTok is logged out: every TikTok
// page lands on TikTok's login, no session cookie ever appears, and the owner never logs in. ``mac`` records what
// the tick asked of it.
export const mac = { opened: [], windows: [], closedPorts: [], clearedPorts: [], quits: 0 };

export function resetMac() {
  Object.assign(mac, { opened: [], windows: [], closedPorts: [], clearedPorts: [], quits: 0 });
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
    count: async () => 0,
    innerText: async () => "",
    click: async () => {},
    waitFor: async () => {
      throw new Error("Nothing like that on TikTok's login page.");
    },
  };
  return none;
}

/** A page of the logged-out Chrome: TikTok sends every page to its login, and there is no session cookie. */
function loggedOutPage() {
  let url = "about:blank";
  return {
    goto: async (to) => {
      url = /tiktok\.com/.test(String(to)) ? `https://www.tiktok.com/login?redirect_url=${encodeURIComponent(to)}` : String(to);
    },
    url: () => url,
    waitForLoadState: async () => {},
    getByRole: () => nothing(),
    getByText: () => nothing(),
    locator: () => nothing(),
    evaluate: async () => "",
    screenshot: async () => {},
    setDefaultTimeout: () => {},
    context: () => ({ cookies: async () => [], clearCookies: async () => {} }),
  };
}

// chrome.js
export async function open(lane, { visible = false } = {}) {
  mac.opened.push({ lane: lane.id, visible });
  return { browser: { lane: lane.id }, page: loggedOutPage() };
}
export async function quit() {
  mac.quits++;
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
