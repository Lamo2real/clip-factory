// The helper's own Chrome: a separate profile per lane (Clip Factory's chrome/, one chrome-ws-{id}/ per Clips Funded
// workspace), never the owner's everyday Chrome or Safari.
//
// The owner, 22 Nov 2026: "i want that process to upload to tiktok to be done behind the scenes, it should not appear
// on my screen it should allow me to work like normal in parallel". So a normal run starts Chrome headless (new
// headless mode, the same profile and its TikTok login): macOS registers it BackgroundOnly, so there is no window on
// screen, no Dock icon, no Cmd-Tab entry, and it can never take his focus. It tells TikTok it is the Chrome he has
// (user agent and client hints without "HeadlessChrome", this Mac's screen size, a Retina pixel ratio). Only his own
// turn (setup, or a TikTok login the Keychain can't do) opens a visible window.
//
// 1.2.0 (§47.10): each lane has its own --user-data-dir and --remote-debugging-port; only one helper Chrome runs at a
// time (a helper Chrome on another lane's port is closed first); and a Chrome already on the lane's port is reused
// only when its profile's DevToolsActivePort proves it is that lane's profile.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { chromium } from "playwright-core";

import { browserUrl, closeBrowser } from "./cdp.js";
import { CDP_PORT, CHROME, CHROME_APP, PROFILE } from "./paths.js";

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Clip Factory's lane as chrome.js needs it (its profile and port, exactly as 1.1.0). */
export const CLIPS_CHROME = Object.freeze({ id: "clips", profile: PROFILE, port: CDP_PORT });

const COMMON = [
  "--remote-debugging-address=127.0.0.1",
  "--no-first-run",
  "--no-default-browser-check",
  "--lang=en-US",
  // Nothing of Chrome's own may reach the owner's screen: no web notifications, and not macOS's notification system
  // (its alert helper made macOS ask about notifications once, during the first headless post on 22 Nov).
  "--disable-notifications",
  "--disable-features=NativeNotifications,SystemNotifications",
  // A hidden window still renders and runs timers at full speed (TikTok's uploader needs both).
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
];

/** The lane's Chrome flags: its own profile and port, then the rest (the same for every lane). */
export function flags(lane = CLIPS_CHROME) {
  return [`--user-data-dir=${lane.profile}`, `--remote-debugging-port=${lane.port}`, ...COMMON];
}

async function cdpUp(port = CDP_PORT) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Does the profile's DevToolsActivePort prove that the Chrome on ``port`` is this profile's? Line 1 is the port,
 * line 2 the path of the browser target's WebSocket (``/json/version``'s webSocketDebuggerUrl).
 */
export function proves(fileText, port, wsUrl) {
  const [first = "", second = ""] = String(fileText || "").split("\n").map((l) => l.trim());
  if (first !== String(port) || !second) return false;
  try {
    return new URL(String(wsUrl)).pathname === second;
  } catch {
    return false;
  }
}

async function proven(lane) {
  const url = await browserUrl(lane.port);
  if (!url) return false;
  let text = "";
  try {
    text = fs.readFileSync(path.join(lane.profile, "DevToolsActivePort"), "utf8");
  } catch {
    return false;
  }
  return proves(text, lane.port, url);
}

async function waitDown(port, tries = 40) {
  for (let i = 0; i < tries && (await cdpUp(port)); i++) await sleep(250);
}

/** Closes the helper Chrome on this port (Browser.close), if there is one, and waits until it has gone. */
export async function closePort(port) {
  if (!(await cdpUp(port))) return;
  await closeBrowser(port);
  await waitDown(port);
}

/** One helper Chrome at a time: every other lane's Chrome closes before this lane's opens. */
async function closeOthers(lane) {
  const others = typeof lane.otherPorts === "function" ? lane.otherPorts() : [];
  for (const port of others) if (port !== lane.port) await closePort(port);
}

// What the helper's headless Chrome tells TikTok: the installed Chrome's own version, this Mac's screen.
export const SCREEN = { width: 1512, height: 982 };

async function chromeVersion() {
  try {
    const { stdout } = await run(CHROME, ["--version"]);
    return (/(\d+)\.(\d+)\.(\d+)\.(\d+)/.exec(stdout) || [])[0] || "157.0.8103.80";
  } catch {
    return "157.0.8103.80";
  }
}

export function identity(full) {
  const major = String(full).split(".")[0];
  return {
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    acceptLanguage: "en-US,en",
    platform: "MacIntel",
    userAgentMetadata: {
      brands: [
        { brand: "Google Chrome", version: major },
        { brand: "Chromium", version: major },
        { brand: "Not/A)Brand", version: "24" },
      ],
      fullVersionList: [
        { brand: "Google Chrome", version: full },
        { brand: "Chromium", version: full },
        { brand: "Not/A)Brand", version: "24.0.0.0" },
      ],
      fullVersion: full,
      platform: "macOS",
      platformVersion: "15.7.0",
      architecture: "arm",
      bitness: "64",
      model: "",
      mobile: false,
      wow64: false,
    },
  };
}

/** Every page of the headless Chrome tells TikTok the same as the visible one would. */
async function dressPage(page, who) {
  try {
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setUserAgentOverride", who);
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: 0,
      height: 0,
      deviceScaleFactor: 0,
      mobile: false,
      screenWidth: SCREEN.width,
      screenHeight: SCREEN.height,
    });
  } catch {
    // a page that closed meanwhile
  }
}

/**
 * Starts (or reuses) the lane's Chrome and connects to it. ``visible`` is only for the owner's own turn (setup, or
 * a TikTok login), on his command; everything else is headless and never shows.
 * @param {{profile: string, port: number, otherPorts?: () => number[]}} [lane] Clip Factory's when not given
 * @returns {Promise<{browser: import("playwright-core").Browser, page: import("playwright-core").Page}>}
 */
export async function open(lane = CLIPS_CHROME, { visible = false } = {}) {
  fs.mkdirSync(lane.profile, { recursive: true });
  await closeOthers(lane);
  const full = await chromeVersion();
  const who = identity(full);
  let headless = false;
  // A Chrome already on this port is reused only when it is provably this lane's profile; any other is closed.
  if ((await cdpUp(lane.port)) && !(await proven(lane))) await closePort(lane.port);
  if (!(await cdpUp(lane.port))) {
    if (visible) {
      await run("/usr/bin/open", ["-n", "-a", CHROME_APP, "--args", ...flags(lane), "--window-position=80,60", "--window-size=1280,900"]);
    } else {
      // Started directly (not through `open`), so nothing is registered for the Dock; headless is BackgroundOnly.
      const child = spawn(
        CHROME,
        [...flags(lane), "--headless=new", "--window-size=1280,900", "--force-device-scale-factor=2", `--user-agent=${who.userAgent}`, "about:blank"],
        { detached: true, stdio: "ignore" }
      );
      child.unref();
      headless = true;
    }
    for (let i = 0; i < 60 && !(await cdpUp(lane.port)); i++) await sleep(500);
    if (!(await cdpUp(lane.port))) throw new Error("The helper's Chrome did not start.");
  } else {
    headless = !visible;
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${lane.port}`);
  const context = browser.contexts()[0];
  let page = context.pages()[0];
  if (!page) page = await context.newPage();
  if (headless) {
    await dressPage(page, who);
    context.on("page", (p) => void dressPage(p, who));
  }
  page.setDefaultTimeout(30_000);
  return { browser, page };
}

/**
 * The owner's window never keeps a password or a Google sign-in (§47.10, D6, rule 5): before it opens, the lane's
 * profile has Chrome's password saving, auto sign-in, autofill and browser sign-in turned off (its Preferences file,
 * merged; Chrome is closed then). Sync is off by a flag too.
 */
export function hardenProfile(profile) {
  const file = path.join(profile, "Default", "Preferences");
  let prefs = {};
  try {
    const read = JSON.parse(fs.readFileSync(file, "utf8"));
    if (read && typeof read === "object" && !Array.isArray(read)) prefs = read;
  } catch {
    prefs = {};
  }
  const part = (key) => (prefs[key] && typeof prefs[key] === "object" && !Array.isArray(prefs[key]) ? prefs[key] : {});
  const next = {
    ...prefs,
    credentials_enable_service: false,
    credentials_enable_autosignin: false,
    profile: { ...part("profile"), password_manager_enabled: false },
    autofill: { ...part("autofill"), enabled: false, profile_enabled: false, credit_card_enabled: false },
    signin: { ...part("signin"), allowed: false },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next));
}

/** The window's own flags: the lane's, and no sync. */
export const PLAIN_FLAGS = ["--disable-sync"];

/**
 * The owner's TikTok login window for a lane (§47.10, D6): a visible Chrome on the lane's profile and port, at
 * ``url``, that Playwright never connects to (no --enable-automation, no page attached). Only the browser target
 * is used, through cdp.js.
 */
export async function openPlain(lane, url) {
  fs.mkdirSync(lane.profile, { recursive: true });
  await closeOthers(lane);
  await closePort(lane.port);
  hardenProfile(lane.profile);
  await run("/usr/bin/open", ["-n", "-a", CHROME_APP, "--args", ...flags(lane), ...PLAIN_FLAGS, "--window-position=80,60", "--window-size=1100,860", url]);
  for (let i = 0; i < 60 && !(await cdpUp(lane.port)); i++) await sleep(500);
  if (!(await cdpUp(lane.port))) throw new Error("The helper's Chrome did not start.");
}

/** Quits the lane's Chrome (not just the connection), so nothing stays open between posts. */
export async function quit(browser, lane = CLIPS_CHROME) {
  try {
    const session = await browser.newBrowserCDPSession();
    await session.send("Browser.close");
  } catch {
    // already gone
  }
  try {
    await browser.close();
  } catch {
    // disconnected
  }
  // Wait until it has really gone, so the next open (maybe visible, for a login) starts a fresh window.
  await waitDown(lane.port);
}

export async function running(lane = CLIPS_CHROME) {
  return cdpUp(lane.port);
}
