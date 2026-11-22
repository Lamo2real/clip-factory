// Telling the owner: a Mac notification, and one line in events.log (which the Claude sessions watch and relay).
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { BASE, EVENTS, LOG } from "./paths.js";

const run = promisify(execFile);
// Apple events go through Claude's helper app when it is there (it holds the permissions); else plain osascript.
const AEOSA = path.join(os.homedir(), ".claude-control", "aeosa");

function quote(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export async function notify(title, text) {
  const script = `display notification ${quote(text)} with title ${quote(title)}`;
  const tool = fs.existsSync(AEOSA) ? AEOSA : "/usr/bin/osascript";
  try {
    await run(tool, ["-e", script], { timeout: 10_000 });
  } catch {
    // A missed notification never stops a post; events.log still has it.
  }
}

export function log(message, fields = {}) {
  fs.mkdirSync(BASE, { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), message, ...fields });
  fs.appendFileSync(LOG, line + "\n");
  if (process.env.CF_TT_VERBOSE) console.log(line);
}

/** Stops, posts and sign-in problems: what someone has to read. */
export function event(kind, fields = {}) {
  fs.mkdirSync(BASE, { recursive: true });
  fs.appendFileSync(EVENTS, JSON.stringify({ at: new Date().toISOString(), kind, ...fields }) + "\n");
  log(`event.${kind}`, fields);
}
