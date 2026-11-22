// The helper's own Chrome: a separate profile, never the owner's everyday Chrome or Safari.
//
// The owner, 22 Nov 2026: "i want that process to upload to tiktok to be done behind the scenes, it should not appear
// on my screen it should allow me to work like normal in parallel". So a normal run starts Chrome headless (new
// headless mode, the same profile and its TikTok login): macOS registers it BackgroundOnly, so there is no window on
// screen, no Dock icon, no Cmd-Tab entry, and it can never take his focus. It tells TikTok it is the Chrome he has
// (user agent and client hints without "HeadlessChrome", this Mac's screen size, a Retina pixel ratio). Only his own
// turn (setup, or a TikTok login the Keychain can't do) opens a visible window.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

import { chromium } from "playwright-core";

import { CDP_PORT, CHROME, CHROME_APP, PROFILE } from "./paths.js";

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FLAGS = [
  `--user-data-dir=${PROFILE}`,
  `--remote-debugging-port=${CDP_PORT}`,
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

async function cdpUp() {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
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
 * Starts (or reuses) the helper's Chrome and connects to it. ``visible`` is only for the owner's own turn (setup, or
 * a TikTok login), on his command; everything else is headless and never shows.
 * @returns {Promise<{browser: import("playwright-core").Browser, page: import("playwright-core").Page}>}
 */
export async function open({ visible = false } = {}) {
  fs.mkdirSync(PROFILE, { recursive: true });
  const full = await chromeVersion();
  const who = identity(full);
  let headless = false;
  if (!(await cdpUp())) {
    if (visible) {
      await run("/usr/bin/open", ["-n", "-a", CHROME_APP, "--args", ...FLAGS, "--window-position=80,60", "--window-size=1280,900"]);
    } else {
      // Started directly (not through `open`), so nothing is registered for the Dock; headless is BackgroundOnly.
      const child = spawn(
        CHROME,
        [...FLAGS, "--headless=new", "--window-size=1280,900", "--force-device-scale-factor=2", `--user-agent=${who.userAgent}`, "about:blank"],
        { detached: true, stdio: "ignore" }
      );
      child.unref();
      headless = true;
    }
    for (let i = 0; i < 60 && !(await cdpUp()); i++) await sleep(500);
    if (!(await cdpUp())) throw new Error("The helper's Chrome did not start.");
  } else {
    headless = !visible;
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
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

/** Quits the helper's Chrome (not just the connection), so nothing stays open between posts. */
export async function quit(browser) {
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
  for (let i = 0; i < 40 && (await cdpUp()); i++) await sleep(250);
}

export async function running() {
  return cdpUp();
}
