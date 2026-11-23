// The character editor's sound samples (docs/CONTRACTS.md §45.40, ADR-88): every effect and every character noise,
// in both voices at every pitch stop, rendered ahead of time by the agent's own synth (stories/agent/.../samples.py)
// into the small MP3 files under web/public/sounds/stories/<recipe>/. What the owner hears here is the sound the videos
// use. They play through one AudioContext of this file's own, made and resumed inside the tap (iOS needs that), so they
// follow the iPhone's silent switch as the click sounds do. One sample plays at a time; a second tap on it stops it.
// Clips Funded's Sounds switch turns them off, and none plays while Clip Factory is on screen. Nothing of Clip
// Factory's main bundle imports this file.
import { useEffect, useSyncExternalStore } from "react";
import { isMock } from "../../lib/config.ts";
import type { NoiseId, SfxId } from "../engine/types.ts";
import { useAppActive } from "../pane.tsx";
import { storiesBehind, storiesSoundOn, useStoriesDevicePrefs } from "../prefs.ts";
import { SAMPLE_PITCHES, SAMPLE_ROOT } from "./samplesRoot.ts";

export type SampleRef = { kind: "sfx"; id: SfxId } | { kind: "noise"; id: NoiseId; voice: "babble" | "hum"; pitch: number };

/** ok: it plays; off: Clips Funded's Sounds switch is off; behind: Clip Factory is on screen. */
export type HearState = "ok" | "off" | "behind";

/** The effects a car picks from, first in its Sounds part (§45.41). */
export const CAR_SFX: readonly SfxId[] = ["engine", "honk", "brake_squeal", "skid", "screech", "tyre_burst", "beep", "click"];

export const SAMPLE_WORDS = {
  off: "Turn Sounds on first",
  quiet: "Pick Babble or Hum first",
  soundsOff: "Sounds are off. Turn them on to hear these.",
  turnOn: "Turn on",
  failed: "That sound didn't load. Tap again.",
  otherMaker: "Effects may sound a bit different in videos.",
} as const;

/** The slider's pitch at its nearest stop that has files: 0.5..2 in steps of 0.05. */
export function snapPitch(p: number): number {
  const n = Number.isFinite(p) ? p : 1;
  return Math.round(Math.min(2, Math.max(0.5, n)) * 20) / 20;
}

const pad3 = (n: number) => String(Math.round(n)).padStart(3, "0");

export function sampleUrl(r: SampleRef): string {
  if (r.kind === "sfx") return `${SAMPLE_ROOT}/sfx/${r.id}.mp3`;
  return `${SAMPLE_ROOT}/${r.voice}/p${pad3(snapPitch(r.pitch) * 100)}/${r.id}.mp3`;
}

/** Whether a sample can play now. */
export function hearState(): HearState {
  if (storiesBehind()) return "behind";
  return storiesSoundOn() ? "ok" : "off";
}

// ---------- the test hook ----------

export interface SampleLogEntry {
  at: number;
  url: string;
  action: "play" | "stop" | "off" | "error";
}

declare global {
  interface Window {
    /** Test hook: every sample played, stopped, refused or failed, in order (never __cfSoundLog: the tap tests count that). */
    __cfSampleLog?: SampleLogEntry[];
  }
}

function log(url: string, action: SampleLogEntry["action"]): void {
  if (typeof window === "undefined" || !(isMock || import.meta.env.DEV || import.meta.env.MODE === "test")) return;
  const list = (window.__cfSampleLog ??= []);
  list.push({ at: Math.round(performance.now()), url, action });
  if (list.length > 200) list.splice(0, list.length - 200);
}

// ---------- the one player ----------

interface Now {
  url: string;
  token: number;
  source: AudioBufferSourceNode | null;
}

let ctx: AudioContext | null = null;
let now: Now | null = null;
let failed: string | null = null;
let tokens = 0;
let watching = false;
const listeners = new Set<() => void>();
const buffers = new Map<string, Promise<AudioBuffer>>();
const KEEP = 48;

function emit(): void {
  for (const fn of listeners) fn();
}

/** Called inside the tap: making or resuming the context there is what lets iOS play it. */
function context(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx ??= new Ctor();
    // Not only "suspended": WebKit also has "interrupted" (a call, Siri, another app's audio).
    if (ctx.state !== "running" && ctx.state !== "closed") {
      const resumed: Promise<void> | undefined = ctx.resume();
      resumed?.catch(() => undefined);
    }
    return ctx;
  } catch {
    return null;
  }
}

/** A decoded file, cached by its address (the newest KEEP kept). A failed one is forgotten, so a tap tries again. */
function buffer(c: AudioContext, url: string): Promise<AudioBuffer> {
  const known = buffers.get(url);
  if (known) {
    buffers.delete(url);
    buffers.set(url, known);
    return known;
  }
  const made = fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error(`${r.status}`);
      return r.arrayBuffer();
    })
    .then((bytes) => c.decodeAudioData(bytes));
  made.catch(() => buffers.delete(url));
  buffers.set(url, made);
  while (buffers.size > KEEP) buffers.delete(buffers.keys().next().value!);
  return made;
}

function watchPage(): void {
  if (watching || typeof document === "undefined") return;
  watching = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") stopSample();
  });
}

/** Stops the sample that plays (nothing when none does). */
export function stopSample(): void {
  if (!now) return;
  const { url, source } = now;
  now = null;
  try {
    source?.stop();
  } catch {
    // It had not started yet, or it had ended.
  }
  log(url, "stop");
  emit();
}

/**
 * Plays one sample in place of the one that plays. False when it cannot play now (Sounds off, or Clip Factory on
 * screen). Call it from the tap itself. Without Web Audio (jsdom) it only logs, and plays until stopSample.
 */
export function playSample(r: SampleRef): boolean {
  const url = sampleUrl(r);
  if (hearState() !== "ok") {
    log(url, "off");
    return false;
  }
  stopSample();
  watchPage();
  failed = null;
  const token = ++tokens;
  const c = context();
  now = { url, token, source: null };
  log(url, "play");
  emit();
  if (!c) return true;
  buffer(c, url).then(
    (b) => {
      if (now?.token !== token) return;
      const src = c.createBufferSource();
      src.buffer = b;
      src.connect(c.destination);
      src.onended = () => {
        if (now?.token !== token) return;
        now = null;
        emit();
      };
      now.source = src;
      src.start();
    },
    () => {
      log(url, "error");
      if (now?.token !== token) return;
      now = null;
      failed = url;
      emit();
    },
  );
  return true;
}

const playingNow = () => now?.url ?? null;
const failedNow = () => failed;
function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * For components: what plays (its address, as sampleUrl gives it), whether samples can play, the address of the last
 * one that did not load, and toggle (a tap on the sample that plays stops it). It stops what plays when the component
 * goes (another part, the editor closed), when the app leaves the screen and when the Sounds switch goes off.
 */
export function useSamples(): { playing: string | null; state: HearState; failed: string | null; toggle(r: SampleRef): void; stop(): void } {
  const playing = useSyncExternalStore(subscribe, playingNow, () => null);
  const lastFailed = useSyncExternalStore(subscribe, failedNow, () => null);
  useStoriesDevicePrefs(); // the Sounds switch, changed here or on another screen
  const active = useAppActive();
  const state = active ? hearState() : "behind";
  useEffect(() => {
    if (state !== "ok") stopSample();
  }, [state]);
  useEffect(() => stopSample, []);
  return {
    playing,
    state,
    failed: lastFailed,
    toggle: (r) => {
      if (playingNow() === sampleUrl(r)) stopSample();
      else playSample(r);
    },
    stop: stopSample,
  };
}

/** Every file the editor can ask for, as sampleUrl gives it (the test checks each one is on disk). */
export function everySampleUrl(noises: readonly NoiseId[], sfx: readonly SfxId[]): string[] {
  const out = sfx.map((id) => sampleUrl({ kind: "sfx", id }));
  for (const voice of ["babble", "hum"] as const) for (const pitch of SAMPLE_PITCHES) for (const id of noises) out.push(sampleUrl({ kind: "noise", id, voice, pitch }));
  return out;
}

/** For tests: forget the player's state. */
export function resetSamplesForTests(): void {
  stopSample();
  failed = null;
  buffers.clear();
  ctx = null;
}
