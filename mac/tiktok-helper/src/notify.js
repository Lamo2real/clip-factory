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

// Secrets the helper holds in memory (the saved TikTok password). Nothing it writes or sends may contain them.
const SECRETS = new Set();
export function addSecret(value) {
  if (typeof value === "string" && value.length >= 3) SECRETS.add(value);
}
/** ``text`` with every secret replaced by •••. */
// Each secret as written plainly and as it looks inside JSON (quotes and backslashes escaped).
const forms = (s) => [...new Set([s, JSON.stringify(s).slice(1, -1)])];
export function scrub(text) {
  let out = String(text);
  for (const s of SECRETS) for (const f of forms(s)) out = out.split(f).join("•••");
  return out;
}
export function holdsSecret(text) {
  const t = String(text);
  for (const s of SECRETS) for (const f of forms(s)) if (t.includes(f)) return true;
  return false;
}

function quote(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export async function notify(title, text) {
  const script = `display notification ${quote(scrub(text))} with title ${quote(scrub(title))}`;
  const tool = fs.existsSync(AEOSA) ? AEOSA : "/usr/bin/osascript";
  try {
    await run(tool, ["-e", script], { timeout: 10_000 });
  } catch {
    // A missed notification never stops a post; events.log still has it.
  }
}

export function log(message, fields = {}) {
  fs.mkdirSync(BASE, { recursive: true });
  const line = scrub(JSON.stringify({ at: new Date().toISOString(), message, ...fields }));
  fs.appendFileSync(LOG, line + "\n");
  if (process.env.CF_TT_VERBOSE) console.log(line);
}

/** Stops, posts and sign-in problems: what someone has to read. */
export function event(kind, fields = {}) {
  fs.mkdirSync(BASE, { recursive: true });
  fs.appendFileSync(EVENTS, scrub(JSON.stringify({ at: new Date().toISOString(), kind, ...fields })) + "\n");
  log(`event.${kind}`, fields);
}
