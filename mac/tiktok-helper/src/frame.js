// The red frame around the owner's screens while the helper drives Chrome or TikTok Studio. Owner, 22 Nov 2026:
// "make sure to indicate with red when you are in control so i know you have full conrtol".
//
// The frame is ~/.claude-control/Claude In Control.app. It reads ~/.claude-control/state.txt (line 1: control |
// yourturn | done | off; line 2: the message), shows red for control, green for done (it closes itself after 20 s)
// and quits on off. The helper turns it red before it touches anything, names each step in a notification, and
// turns it green at the end or takes it down on a stop. No frame, no post: if the frame can't be shown, the clip
// waits (frameReady). When a Claude session had the frame up before (its own control), that state comes back after.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const CONTROL = process.env.CF_TT_CONTROL || path.join(os.homedir(), ".claude-control");
const STATE = () => path.join(CONTROL, "state.txt");
const LAST_STEP = () => path.join(CONTROL, "last-step");
const APP = () => path.join(CONTROL, "Claude In Control.app");
const AEOSA = () => path.join(CONTROL, "aeosa");

function readState() {
  try {
    const [mode = "off", message = ""] = fs.readFileSync(STATE(), "utf8").split("\n");
    return { mode: mode.trim() || "off", message: message.trim() };
  } catch {
    return { mode: "off", message: "" };
  }
}

function writeState(mode, message = "") {
  fs.writeFileSync(STATE(), `${mode}\n${message}\n`);
}

async function appRunning() {
  try {
    await run("/usr/bin/pgrep", ["-q", "ClaudeInControl"]);
    return true;
  } catch {
    return false;
  }
}

function quote(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function notifyStep(step) {
  const script = `display notification ${quote(step)} with title "Clip Factory is posting on TikTok" subtitle "Your Mac's helper is in control"`;
  const tool = fs.existsSync(AEOSA()) ? AEOSA() : "/usr/bin/osascript";
  try {
    await run(tool, ["-e", script], { timeout: 10_000 });
  } catch {
    // the frame is the sign; a missed notification never stops anything
  }
}

/** The yellow frame and a pop-up that asks the owner for something (say.sh ask: it waits for OK in the background,
 * then the frame goes back to red). Never waited for: the helper carries on as soon as what it needs is there. */
export function ask(message) {
  const say = path.join(CONTROL, "say.sh");
  if (!fs.existsSync(say)) return () => {};
  try {
    const child = spawn("/bin/sh", [say, "ask", message], { detached: true, stdio: "ignore" });
    child.unref();
    // Closes the pop-up (its whole process group) so it can't turn the frame red again later.
    return () => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // already answered
      }
    };
  } catch {
    return () => {};
  }
}

/** The yellow frame (the owner's turn) while ``fn`` runs, then the frame as it was before. */
export async function yourTurn(message, fn) {
  const before = readState();
  if (frameAvailable()) {
    writeState("yourturn", message);
    if (!(await appRunning())) await run("/usr/bin/open", ["-g", APP()]).catch(() => {});
  }
  try {
    return await fn();
  } finally {
    if (frameAvailable()) {
      if (before.mode === "control" || before.mode === "yourturn") writeState(before.mode, before.message);
      else writeState("off", "");
    }
  }
}

/** Is the frame there to be shown? (No frame app: the helper does not post.) */
export function frameAvailable() {
  return fs.existsSync(APP());
}

/**
 * A normal run shows nothing on the owner's screen. The owner, 22 Nov 2026: "it should not appear on my screen it
 * should allow me to work like normal in parallel" (this replaced his earlier red-frame rule for the helper). So the
 * run's "frame" is silent: no frame, no notification, no sound. Only his own turn (ask, yourTurn) shows the yellow
 * frame and one pop-up.
 */
export function frame() {
  return {
    async on() {
      return true;
    },
    async step() {},
    async done() {},
    async off() {},
    get shown() {
      return true;
    },
  };
}
