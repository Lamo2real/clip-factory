// The helper's small files: state.json (device id, ledger, pacing) and settings.json. Written atomically (temp file,
// then rename), so a crash mid-write never leaves half a ledger: the ledger is what stops a second press of Post.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { BASE, SETTINGS, STATE } from "./paths.js";

export const DEFAULT_SETTINGS = Object.freeze({
  // The owner's trial (22 Nov 2026): the first 3 posts, then a pause until their views are checked. null = no limit.
  trialLimit: 3,
  // Minutes between two TikTok posts the Mac makes (clips already waiting, auto-posting runs).
  spacingMinutes: 30,
  // A clip the owner just uploaded by hand goes first, with this smaller gap.
  onDemandSpacingMinutes: 5,
  // A local pause (cli.js off). The Settings switch in Clip Factory is the main off switch.
  paused: false,
});

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...readJson(SETTINGS, {}) };
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  writeJson(SETTINGS, next);
  return next;
}

export function emptyState() {
  return { device: `mac-${crypto.randomUUID()}`, ledger: {}, posted: [], lastPressedAt: null };
}

export function loadState() {
  fs.mkdirSync(BASE, { recursive: true });
  const state = readJson(STATE, null);
  if (state && state.device) return { ledger: {}, posted: [], lastPressedAt: null, ...state };
  const fresh = emptyState();
  writeJson(STATE, fresh);
  return fresh;
}

export function saveState(state) {
  writeJson(STATE, state);
}

/** Records a step for a clip in the ledger and saves at once (the ledger must be on disk before Post is pressed). */
export function remember(state, clipId, fields) {
  state.ledger[clipId] = { ...(state.ledger[clipId] || {}), ...fields, at: new Date().toISOString() };
  saveState(state);
  return state.ledger[clipId];
}
