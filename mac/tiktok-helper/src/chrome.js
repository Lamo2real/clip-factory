// The helper's own Chrome: a separate profile, started hidden in the background (`open -g -j`), never the owner's
// everyday Chrome or Safari. The owner's mouse, keyboard and windows are never touched. Only `setup` shows the window.
import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

import { chromium } from "playwright-core";

import os from "node:os";
import path from "node:path";

import { CDP_PORT, CHROME_APP, PROFILE } from "./paths.js";

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FLAGS = [
  `--user-data-dir=${PROFILE}`,
  `--remote-debugging-port=${CDP_PORT}`,
  "--remote-debugging-address=127.0.0.1",
  "--no-first-run",
  "--no-default-browser-check",
  "--lang=en-US",
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

/**
 * Starts (or reuses) the helper's Chrome and connects to it. ``visible`` is only for setup, on the owner's command.
 * @returns {Promise<{browser: import("playwright-core").Browser, page: import("playwright-core").Page}>}
 */
export async function open({ visible = false } = {}) {
  fs.mkdirSync(PROFILE, { recursive: true });
  if (!(await cdpUp())) {
    const how = visible ? ["-n", "-a", CHROME_APP] : ["-g", "-j", "-n", "-a", CHROME_APP];
    const where = visible ? ["--window-position=80,60", "--window-size=1280,900"] : ["--window-position=-2600,40", "--window-size=1280,900"];
    await run("/usr/bin/open", [...how, "--args", ...FLAGS, ...where]);
    for (let i = 0; i < 60 && !(await cdpUp()); i++) await sleep(500);
    if (!(await cdpUp())) throw new Error("The helper's Chrome did not start.");
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const context = browser.contexts()[0];
  // Reuse the first tab: opening new windows could bring Chrome forward.
  const page = context.pages()[0] || (await context.newPage());
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

/**
 * Brings the helper's own Chrome window forward on the screen, as it is (a TikTok code page stays open), for the
 * owner's turn. Only the helper's Chrome (its own profile) is touched. Returns false when it could not.
 */
export async function show(browser) {
  try {
    const session = await browser.newBrowserCDPSession();
    const { targetInfos } = await session.send("Target.getTargets");
    const target = targetInfos.find((t) => t.type === "page");
    if (target) {
      const { windowId } = await session.send("Browser.getWindowForTarget", { targetId: target.targetId });
      await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
      await session.send("Browser.setWindowBounds", { windowId, bounds: { left: 80, top: 60, width: 1280, height: 900 } });
    }
  } catch {
    return false;
  }
  try {
    const { stdout } = await run("/bin/ps", ["-axo", "pid=,command="]);
    const main = stdout
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.includes(`--user-data-dir=${PROFILE}`) && !l.includes("--type="));
    const pid = main ? Number(main.split(/\s+/)[0]) : 0;
    if (!pid) return false;
    const aeosa = path.join(os.homedir(), ".claude-control", "aeosa");
    await run(aeosa, [
      "-e",
      `tell application "System Events" to set visible of (first process whose unix id is ${pid}) to true`,
      "-e",
      `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`,
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function running() {
  return cdpUp();
}
