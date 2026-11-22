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

/** A frame for one run of the helper: red while it drives, green when done, back as it was otherwise. */
export function frame() {
  const before = readState();
  // Another session's frame (its own control, or the owner's turn) comes back when the helper is done.
  const restore = before.mode === "control" || before.mode === "yourturn" ? before : null;
  let shown = false;
  return {
    /** Turns the frame red and waits until it is up. Returns false when it could not be shown (then: no post). */
    async on(step) {
      if (!frameAvailable()) return false;
      fs.writeFileSync(LAST_STEP(), step);
      writeState("control", step);
      if (!(await appRunning())) {
        try {
          await run("/usr/bin/open", ["-g", APP()]);
        } catch {
          return false;
        }
      }
      for (let i = 0; i < 20 && !(await appRunning()); i++) await sleep(250);
      shown = await appRunning();
      if (shown) await notifyStep(step);
      return shown;
    },
    /** A new step: the frame stays red and a notification names it. */
    async step(step) {
      if (!shown) return;
      fs.writeFileSync(LAST_STEP(), step);
      writeState("control", step);
      await notifyStep(step);
    },
    /** Finished: green for 20 s (the app closes itself), or the earlier session's frame back. */
    async done(message) {
      if (!shown) return;
      shown = false;
      if (restore) writeState(restore.mode, restore.message);
      else writeState("done", message);
    },
    /** Stopped or failed: the frame comes down (or the earlier session's frame comes back). */
    async off() {
      if (!shown) return;
      shown = false;
      if (restore) writeState(restore.mode, restore.message);
      else writeState("off", "");
    },
    get shown() {
      return shown;
    },
  };
}
