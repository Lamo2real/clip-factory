// Synthesized sounds (no audio files): "tap" for clicks on things that work, "deny" for clicks on things
// that are switched off and for errors, and "success" (one fixed cheer) when something big worked, played on a tap. Which of the 30 recipes of each kind plays is the owner's choice
// (Settings > Look & feel > Sounds, docs/CONTRACTS.md §15.3). Sounds are driven ONLY by the `click` event, which
// browsers fire for a tap but never for a scroll or a swipe, so scrolling on a phone is always silent.

import { isMock } from "./config.ts";
import { DEFAULT_CLICK_SOUND, DEFAULT_ERROR_SOUND, recipeFor, SUCCESS_SOUND, type SoundRecipe } from "./soundCatalog.ts";

/** The two kinds the owner picks a sound for (Settings > Look & feel > Sounds). */
export type SoundKind = "tap" | "deny";
/** Everything the engine can play: the two picked kinds plus the fixed success cheer. */
export type PlayKind = SoundKind | "success";

export interface SoundLogEntry {
  kind: PlayKind;
  /** Which recipe (1..30 of that kind) played, or would have played when muted. */
  sound: number;
  muted: boolean;
  at: number;
  target: string;
}

declare global {
  interface Window {
    /** Test hook: every sound decision, in order. */
    __cfSoundLog?: SoundLogEntry[];
  }
}

const INTERACTIVE = [
  "button",
  "a[href]",
  "summary",
  "select",
  "label",
  'input[type="checkbox"]',
  'input[type="radio"]',
  'input[type="file"]',
  'input[type="range"]',
  'input[type="button"]',
  'input[type="submit"]',
  '[role="button"]',
  '[role="tab"]',
  '[role="switch"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="option"]',
  "[data-sound]",
].join(",");

/** Which sound a click on `target` deserves, or null for none (plain text, text fields, data-sound="off"). */
export function classifyClick(target: EventTarget | null): SoundKind | null {
  if (!target || !(target instanceof Element)) return null;
  const el = target.closest(INTERACTIVE);
  if (!el || el.getAttribute("data-sound") === "off") return null;
  const off =
    el.matches(":disabled") ||
    el.getAttribute("aria-disabled") === "true" ||
    !!el.closest('[aria-disabled="true"], fieldset:disabled') ||
    // A label for a switched-off control is itself switched off.
    (el instanceof HTMLLabelElement && !!el.control && (el.control as HTMLInputElement).disabled);
  return off ? "deny" : "tap";
}

function describe(target: EventTarget | null): string {
  if (!(target instanceof Element)) return "";
  const el = target.closest(INTERACTIVE) ?? target;
  return (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 40);
}

const isAndroid = () => typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

/** Which recipe plays for each kind: the owner's Click sound and Error sound settings (1..30). */
export interface SoundChoice {
  tap: number;
  deny: number;
}

/** Same-kind deny / success sounds closer than this are one sound (§20.8). */
export const DEDUP_MS = 300;

const DEFAULT_CHOICE: SoundChoice = { tap: DEFAULT_CLICK_SOUND, deny: DEFAULT_ERROR_SOUND };

export class SoundEngine {
  private ctx: AudioContext | null = null;
  /** Half a second of white noise, made once per context and shared by every noise voice. */
  private noise: AudioBuffer | null = null;
  private lastAt = 0;
  private lastKind: PlayKind | null = null;

  constructor(
    private readonly enabled: () => boolean,
    private readonly chosen: () => SoundChoice = () => DEFAULT_CHOICE,
  ) {}

  /** Called from inside a click handler: creating or resuming the context there is what unlocks audio on iOS. */
  private context(): AudioContext | null {
    const Ctor = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!Ctor) return null;
    try {
      this.ctx ??= new Ctor();
      // Not only "suspended": WebKit also has a non-standard "interrupted" state (a phone call, Siri, another app
      // taking the audio) that it does not always leave by itself.
      if (this.ctx.state !== "running" && this.ctx.state !== "closed") {
        // Called synchronously so it stays inside the click (the gesture is what lets iOS resume).
        const resumed: Promise<void> | undefined = this.ctx.resume();
        resumed?.catch(() => undefined);
      }
      return this.ctx;
    } catch {
      return null;
    }
  }

  /**
   * Builds the audio context ahead of the click, on the press that starts it (pointerdown, or keydown for a key that
   * clicks). Building one is slow the first time (100 ms in headless Chromium, far more on a busy machine), and done
   * inside the first click it held that click's frame: the first page change after load drew late and the menu
   * highlight started its slide late. The click still resumes it (the gesture iOS needs). Nothing when muted.
   */
  warm(): void {
    if (this.ctx || !this.enabled()) return;
    this.context();
  }

  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    if (!this.noise) {
      const buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * 0.5), ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      this.noise = buffer;
    }
    return this.noise;
  }

  /**
   * Plays the tap or deny sound. `recipe` picks one of the 30 sounds of that kind (the Sounds settings preview a
   * card this way); without it the owner's chosen sound plays.
   */
  play(kind: PlayKind, target: EventTarget | null = null, recipe?: number): void {
    const now = performance.now();
    // A click on a <label> also clicks its input: one sound per gesture. A deny right after a tap still plays,
    // because that is an error answering the click.
    // A deny or success that two things ask for at once (a failed action's shake and its error toast,
    // docs/CONTRACTS.md §20.8) is heard once: 300 ms for those, unless a sound card previews a recipe by number.
    const gap = kind !== "tap" && recipe === undefined ? DEDUP_MS : 60;
    if (now - this.lastAt < gap && kind === this.lastKind) return;
    this.lastAt = now;
    this.lastKind = kind;
    const muted = !this.enabled();
    const sound = kind === "success" ? SUCCESS_SOUND : recipeFor(kind, recipe ?? this.chosen()[kind]);
    if (isMock || import.meta.env.DEV || import.meta.env.MODE === "test") {
      // Test hook only; capped so a long session cannot grow it without limit.
      const log = (window.__cfSoundLog ??= []);
      log.push({ kind, sound: sound.id, muted, at: Math.round(now), target: describe(target) });
      if (log.length > 200) log.splice(0, log.length - 200);
    }
    if (muted) return;
    if (isAndroid()) navigator.vibrate?.(kind === "deny" ? [14, 50, 14] : kind === "success" ? [10, 40, 10, 40, 18] : 8);
    const ctx = this.context();
    if (!ctx) return;
    try {
      this.render(ctx, sound);
    } catch {
      // A browser with a partial Web Audio implementation: stay silent rather than break the click.
    }
  }

  /** Schedules every voice of a recipe, exactly as the owner's sound picker does. */
  private render(ctx: AudioContext, sound: SoundRecipe) {
    const start = ctx.currentTime + 0.01;
    for (const v of sound.voices) {
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      if (v[0] === "noise") {
        const [, type, hz, at, length, peak] = v;
        const src = ctx.createBufferSource();
        src.buffer = this.noiseBuffer(ctx);
        filter.type = type;
        filter.frequency.value = hz;
        envelope(gain, start + at, length, peak);
        src.connect(filter).connect(gain).connect(ctx.destination);
        src.start(start + at);
        src.stop(start + at + length + 0.02);
      } else {
        const [wave, from, to, at, length, peak, lowpass] = v;
        const osc = ctx.createOscillator();
        osc.type = wave;
        filter.type = "lowpass";
        filter.frequency.value = lowpass;
        osc.frequency.setValueAtTime(from, start + at);
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), start + at + length);
        envelope(gain, start + at, length, peak);
        osc.connect(filter).connect(gain).connect(ctx.destination);
        osc.start(start + at);
        osc.stop(start + at + length + 0.02);
      }
    }
  }
}

function envelope(gain: GainNode, at: number, length: number, peak: number) {
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
}

/**
 * Plays the success sound on the owner's next tap anywhere on the page (sounds only ever answer a tap, and a page
 * that just loaded cannot play audio yet). Returns a function that cancels it.
 */
export function cheerOnNextTap(engine: SoundEngine, root: Document = document): () => void {
  const onClick = (e: MouseEvent) => {
    root.removeEventListener("click", onClick, { capture: true });
    engine.play("success", e.target);
  };
  root.addEventListener("click", onClick, { capture: true });
  return () => root.removeEventListener("click", onClick, { capture: true });
}

/**
 * Listens for clicks in the capture phase so a handler that stops propagation cannot silence the sound. The press
 * before a click (pointerdown, or Enter / Space on a control) builds the audio context first (`warm`), so the click
 * itself stays cheap; presses make no sound.
 */
export function installClickSounds(engine: SoundEngine, root: Document = document): () => void {
  const onClick = (e: MouseEvent) => {
    const kind = classifyClick(e.target);
    if (kind) engine.play(kind, e.target);
  };
  const onPress = (e: Event) => {
    if (e instanceof KeyboardEvent && e.key !== "Enter" && e.key !== " ") return;
    if (classifyClick(e.target)) engine.warm();
  };
  root.addEventListener("click", onClick, { capture: true });
  root.addEventListener("pointerdown", onPress, { capture: true, passive: true });
  root.addEventListener("keydown", onPress, { capture: true, passive: true });
  return () => {
    root.removeEventListener("click", onClick, { capture: true });
    root.removeEventListener("pointerdown", onPress, { capture: true });
    root.removeEventListener("keydown", onPress, { capture: true });
  };
}
