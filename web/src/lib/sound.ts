// Two synthesized sounds (no audio files): "tap" for clicks on things that work, "deny" for clicks on things that
// are switched off and for errors. Sounds are driven ONLY by the `click` event, which browsers fire for a tap but
// never for a scroll or a swipe, so scrolling on a phone is always silent.

import { isMock } from "./config.ts";

export type SoundKind = "tap" | "deny";

export interface SoundLogEntry {
  kind: SoundKind;
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

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private lastAt = 0;
  private lastKind: SoundKind | null = null;

  constructor(private readonly enabled: () => boolean) {}

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

  play(kind: SoundKind, target: EventTarget | null = null): void {
    const now = performance.now();
    // A click on a <label> also clicks its input: one sound per gesture. A deny right after a tap still plays,
    // because that is an error answering the click.
    if (now - this.lastAt < 60 && kind === this.lastKind) return;
    this.lastAt = now;
    this.lastKind = kind;
    const muted = !this.enabled();
    if (isMock || import.meta.env.DEV || import.meta.env.MODE === "test") {
      // Test hook only; capped so a long session cannot grow it without limit.
      const log = (window.__cfSoundLog ??= []);
      log.push({ kind, muted, at: Math.round(now), target: describe(target) });
      if (log.length > 200) log.splice(0, log.length - 200);
    }
    if (muted) return;
    if (isAndroid()) navigator.vibrate?.(kind === "tap" ? 8 : [14, 50, 14]);
    const ctx = this.context();
    if (!ctx) return;
    if (kind === "tap") this.tap(ctx);
    else this.deny(ctx);
  }

  private voice(ctx: AudioContext, type: OscillatorType, from: number, to: number, start: number, length: number, peak: number) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = type === "triangle" ? 4200 : 1400;
    osc.type = type;
    osc.frequency.setValueAtTime(from, start);
    osc.frequency.exponentialRampToValueAtTime(to, start + length);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
    osc.connect(filter).connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + length + 0.02);
  }

  /** A soft, bright "tick": a quick downward chirp. */
  private tap(ctx: AudioContext) {
    const t = ctx.currentTime;
    this.voice(ctx, "triangle", 1250, 620, t, 0.07, 0.16);
  }

  /** A low double "thud": clearly not the tap. */
  private deny(ctx: AudioContext) {
    const t = ctx.currentTime;
    this.voice(ctx, "square", 196, 150, t, 0.09, 0.07);
    this.voice(ctx, "square", 176, 130, t + 0.11, 0.11, 0.07);
  }
}

/** Listens for clicks in the capture phase so a handler that stops propagation cannot silence the sound. */
export function installClickSounds(engine: SoundEngine, root: Document = document): () => void {
  const onClick = (e: MouseEvent) => {
    const kind = classifyClick(e.target);
    if (kind) engine.play(kind, e.target);
  };
  root.addEventListener("click", onClick, { capture: true });
  return () => root.removeEventListener("click", onClick, { capture: true });
}
