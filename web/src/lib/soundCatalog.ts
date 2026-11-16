// The 30 click sounds and 30 error sounds from the owner's sound picker (docs/CONTRACTS.md §15.3), as data.
// Every sound is a short list of voices synthesized with Web Audio (no audio files):
//   oscillator voice: [wave, startHz, endHz, at (s), length (s), peak gain, lowpassHz]
//   noise voice:      ["noise", filterType, filterHz, at (s), length (s), peak gain]
// The numbers are the owner's: keep them exactly as they are (test/soundCatalog.test.ts checks them).

export type OscVoice = readonly ["sine" | "triangle" | "square" | "sawtooth", number, number, number, number, number, number];
export type NoiseVoice = readonly ["noise", "bandpass" | "highpass" | "lowpass", number, number, number, number];
export type Voice = OscVoice | NoiseVoice;

export interface SoundRecipe {
  /** 1..30, the number on the card. */
  readonly id: number;
  readonly name: string;
  /** A few words on how it sounds. */
  readonly feel: string;
  readonly voices: readonly Voice[];
}

/** The owner's picks (§15.3): click sound 6 "Water drop", error sound 5 "Nope nope nope". */
export const DEFAULT_CLICK_SOUND = 6;
export const DEFAULT_ERROR_SOUND = 5;
export const SOUND_COUNT = 30;

/** "When it works": plays on every button you can press. */
export const CLICK_SOUNDS: readonly SoundRecipe[] = [
  { id: 1, name: "Glass tick", feel: "Light glassy tick", voices: [["triangle", 1250, 620, 0, 0.07, 0.16, 4200]] },
  { id: 2, name: "Soft pop", feel: "Round and quick", voices: [["sine", 900, 300, 0, 0.06, 0.3, 3000]] },
  { id: 3, name: "Bubble", feel: "Rises a little", voices: [["sine", 400, 1200, 0, 0.08, 0.25, 3000]] },
  { id: 4, name: "Wood block", feel: "Dry and woody", voices: [["triangle", 820, 800, 0, 0.05, 0.22, 3000], ["noise", "bandpass", 2000, 0, 0.012, 0.25]] },
  { id: 5, name: "Marimba", feel: "Warm mallet note", voices: [["sine", 880, 878, 0, 0.18, 0.22, 3000], ["sine", 2640, 2600, 0, 0.05, 0.05, 6000]] },
  { id: 6, name: "Water drop", feel: "Plip-plop", voices: [["sine", 1500, 500, 0, 0.05, 0.2, 4000], ["sine", 2200, 900, 0.03, 0.04, 0.12, 5000]] },
  { id: 7, name: "Bell ting", feel: "Tiny bell", voices: [["sine", 2093, 2090, 0, 0.25, 0.12, 8000], ["sine", 4186, 4180, 0, 0.12, 0.04, 9000]] },
  { id: 8, name: "Key clack", feel: "Mechanical keyboard", voices: [["noise", "highpass", 3000, 0, 0.015, 0.3], ["triangle", 300, 200, 0, 0.02, 0.2, 2000]] },
  { id: 9, name: "Pluck", feel: "A plucked string", voices: [["sawtooth", 660, 650, 0, 0.12, 0.12, 1800]] },
  { id: 10, name: "Kalimba", feel: "Thumb piano", voices: [["triangle", 1046, 1044, 0, 0.2, 0.18, 5000], ["sine", 3138, 3130, 0, 0.06, 0.05, 8000]] },
  { id: 11, name: "Micro click", feel: "Barely there", voices: [["square", 2000, 1800, 0, 0.008, 0.08, 6000]] },
  { id: 12, name: "Coin", feel: "Two quick notes up", voices: [["square", 988, 988, 0, 0.06, 0.06, 5000], ["square", 1319, 1319, 0.06, 0.16, 0.06, 5000]] },
  { id: 13, name: "Chirp up", feel: "Small and happy", voices: [["sine", 600, 1400, 0, 0.07, 0.2, 4000]] },
  { id: 14, name: "Soft thump", feel: "Deep and gentle", voices: [["sine", 220, 120, 0, 0.05, 0.45, 1200]] },
  { id: 15, name: "Glass ping", feel: "Clear and high", voices: [["sine", 2637, 2630, 0, 0.3, 0.1, 9000], ["triangle", 5274, 5260, 0, 0.1, 0.03, 10000]] },
  { id: 16, name: "Pebble", feel: "Little stone tap", voices: [["noise", "bandpass", 1200, 0, 0.02, 0.5]] },
  { id: 17, name: "Toggle", feel: "Switch flick", voices: [["triangle", 1600, 1600, 0, 0.02, 0.18, 6000], ["triangle", 1100, 1100, 0.03, 0.03, 0.16, 5000]] },
  { id: 18, name: "Bloop", feel: "Playful", voices: [["sine", 300, 900, 0, 0.1, 0.25, 2000]] },
  { id: 19, name: "Sparkle", feel: "Three rising notes", voices: [["sine", 1568, 1568, 0, 0.1, 0.1, 8000], ["sine", 2093, 2093, 0.04, 0.1, 0.09, 8000], ["sine", 2637, 2637, 0.08, 0.12, 0.08, 8000]] },
  { id: 20, name: "Mallet", feel: "Soft and round", voices: [["sine", 523, 522, 0, 0.2, 0.25, 3000], ["sine", 1046, 1044, 0, 0.1, 0.08, 5000]] },
  { id: 21, name: "Snap", feel: "Finger snap", voices: [["noise", "highpass", 4000, 0, 0.01, 0.5], ["sine", 1800, 900, 0, 0.02, 0.15, 6000]] },
  { id: 22, name: "Cushion", feel: "Pillowy press", voices: [["sine", 160, 110, 0, 0.08, 0.45, 600]] },
  { id: 23, name: "Tink", feel: "Tiny and sharp", voices: [["triangle", 3000, 2800, 0, 0.04, 0.1, 9000]] },
  { id: 24, name: "Two-step", feel: "Two notes up", voices: [["sine", 784, 784, 0, 0.07, 0.18, 5000], ["sine", 1175, 1175, 0.06, 0.1, 0.16, 5000]] },
  { id: 25, name: "Harp", feel: "Gentle strum", voices: [["triangle", 1318, 1316, 0, 0.3, 0.12, 5000], ["triangle", 1976, 1972, 0.02, 0.25, 0.1, 6000]] },
  { id: 26, name: "Cork pop", feel: "Pop!", voices: [["noise", "bandpass", 800, 0, 0.03, 0.4], ["sine", 500, 150, 0, 0.05, 0.25, 2000]] },
  { id: 27, name: "Crystal", feel: "Glassy shimmer", voices: [["sine", 3520, 3510, 0, 0.2, 0.07, 10000], ["sine", 4699, 4690, 0, 0.15, 0.04, 10000]] },
  { id: 28, name: "Thock", feel: "Deep keyboard", voices: [["sine", 180, 140, 0, 0.03, 0.4, 1500], ["noise", "bandpass", 2500, 0, 0.01, 0.2]] },
  { id: 29, name: "Chime", feel: "Little chord", voices: [["sine", 1760, 1758, 0, 0.35, 0.08, 8000], ["sine", 2217, 2215, 0, 0.3, 0.06, 8000], ["sine", 2637, 2635, 0, 0.25, 0.05, 8000]] },
  { id: 30, name: "Feather", feel: "Softest of all", voices: [["sine", 1100, 1000, 0, 0.04, 0.08, 4000]] },
];

/** "When it can't": plays on switched-off buttons and when something fails. */
export const ERROR_SOUNDS: readonly SoundRecipe[] = [
  { id: 1, name: "Double thud", feel: "Two low thuds", voices: [["square", 196, 150, 0, 0.09, 0.07, 1400], ["square", 176, 130, 0.11, 0.11, 0.07, 1400]] },
  { id: 2, name: "Buzz", feel: "Short low buzz", voices: [["sawtooth", 110, 108, 0, 0.18, 0.1, 900]] },
  { id: 3, name: "Step down", feel: "Two notes falling", voices: [["triangle", 440, 440, 0, 0.1, 0.16, 3000], ["triangle", 330, 330, 0.11, 0.14, 0.16, 3000]] },
  { id: 4, name: "Bonk", feel: "Cartoon bonk", voices: [["sine", 180, 90, 0, 0.15, 0.4, 1500]] },
  { id: 5, name: "Nope nope nope", feel: "Three quick blips", voices: [["square", 150, 150, 0, 0.05, 0.06, 1500], ["square", 150, 150, 0.08, 0.05, 0.06, 1500], ["square", 150, 150, 0.16, 0.05, 0.06, 1500]] },
  { id: 6, name: "Low hum", feel: "Grumbly", voices: [["sawtooth", 80, 80, 0, 0.25, 0.12, 500]] },
  { id: 7, name: "Wrong note", feel: "Two clashing notes", voices: [["triangle", 466, 466, 0, 0.2, 0.12, 3000], ["triangle", 494, 494, 0, 0.2, 0.12, 3000]] },
  { id: 8, name: "Slide down", feel: "Falls away", voices: [["sawtooth", 400, 120, 0, 0.2, 0.08, 1200]] },
  { id: 9, name: "Soft double", feel: "Two soft knocks", voices: [["sine", 120, 110, 0, 0.07, 0.4, 800], ["sine", 120, 110, 0.1, 0.07, 0.4, 800]] },
  { id: 10, name: "Error beep", feel: "Classic beep-beep", voices: [["square", 220, 220, 0, 0.12, 0.06, 1600], ["square", 220, 220, 0.16, 0.12, 0.06, 1600]] },
  { id: 11, name: "Clunk", feel: "Dull and heavy", voices: [["noise", "bandpass", 300, 0, 0.06, 0.5], ["sine", 100, 90, 0, 0.08, 0.3, 800]] },
  { id: 12, name: "Wobble", feel: "Wobbly no", voices: [["sine", 200, 200, 0, 0.25, 0.18, 1500], ["sine", 213, 213, 0, 0.25, 0.18, 1500]] },
  { id: 13, name: "Minor fall", feel: "Three sad notes", voices: [["triangle", 523, 523, 0, 0.08, 0.13, 3000], ["triangle", 466, 466, 0.08, 0.08, 0.13, 3000], ["triangle", 392, 392, 0.16, 0.14, 0.13, 3000]] },
  { id: 14, name: "Muffled knock", feel: "Knock knock, no", voices: [["sine", 90, 70, 0, 0.1, 0.5, 700], ["sine", 90, 70, 0.12, 0.1, 0.5, 700]] },
  { id: 15, name: "Rasp", feel: "Scratchy", voices: [["noise", "lowpass", 800, 0, 0.15, 0.25]] },
  { id: 16, name: "Bass drop", feel: "Deep fall", voices: [["sine", 150, 50, 0, 0.3, 0.4, 800]] },
  { id: 17, name: "Tsk tsk", feel: "Two dry clicks", voices: [["noise", "highpass", 5000, 0, 0.02, 0.3], ["noise", "highpass", 5000, 0.07, 0.02, 0.3]] },
  { id: 18, name: "Stab", feel: "Sharp and sour", voices: [["square", 233, 233, 0, 0.15, 0.05, 1000], ["square", 247, 247, 0, 0.15, 0.05, 1000]] },
  { id: 19, name: "Deflate", feel: "Air going out", voices: [["triangle", 600, 200, 0, 0.25, 0.12, 2500]] },
  { id: 20, name: "Locked", feel: "Latch, then thud", voices: [["square", 1000, 1000, 0, 0.02, 0.05, 4000], ["square", 120, 110, 0.06, 0.08, 0.08, 900]] },
  { id: 21, name: "Two-tone down", feel: "Uh-oh", voices: [["sine", 660, 660, 0, 0.1, 0.2, 4000], ["sine", 440, 440, 0.1, 0.16, 0.2, 4000]] },
  { id: 22, name: "Growl", feel: "Low rumble", voices: [["sawtooth", 70, 60, 0, 0.2, 0.12, 400], ["noise", "lowpass", 300, 0, 0.2, 0.2]] },
  { id: 23, name: "Rubber", feel: "Bouncy no", voices: [["sine", 260, 180, 0, 0.12, 0.35, 1500], ["sine", 240, 160, 0.12, 0.12, 0.3, 1500]] },
  { id: 24, name: "Hollow block", feel: "Two wooden knocks", voices: [["triangle", 300, 300, 0, 0.06, 0.2, 2000], ["triangle", 250, 250, 0.09, 0.08, 0.2, 2000]] },
  { id: 25, name: "Fizzle", feel: "Spark that dies", voices: [["noise", "bandpass", 1500, 0, 0.2, 0.2], ["sine", 300, 100, 0, 0.2, 0.15, 1500]] },
  { id: 26, name: "Honk", feel: "Little horn", voices: [["sawtooth", 196, 196, 0, 0.12, 0.07, 1400], ["sawtooth", 185, 185, 0, 0.12, 0.07, 1400]] },
  { id: 27, name: "Glitch", feel: "Steps tumbling down", voices: [["square", 400, 400, 0, 0.025, 0.05, 3000], ["square", 300, 300, 0.03, 0.025, 0.05, 3000], ["square", 200, 200, 0.06, 0.025, 0.05, 3000], ["square", 150, 150, 0.09, 0.04, 0.05, 3000]] },
  { id: 28, name: "Mini trombone", feel: "Wah-wah-wah", voices: [["sawtooth", 392, 392, 0, 0.12, 0.08, 1200], ["sawtooth", 370, 370, 0.13, 0.12, 0.08, 1200], ["sawtooth", 349, 330, 0.26, 0.22, 0.08, 1200]] },
  { id: 29, name: "Plunk", feel: "Low and short", voices: [["sine", 130, 125, 0, 0.2, 0.45, 700]] },
  { id: 30, name: "Muted double", feel: "Two padded taps", voices: [["noise", "bandpass", 600, 0, 0.02, 0.5], ["noise", "bandpass", 600, 0.09, 0.02, 0.5], ["sine", 140, 130, 0, 0.04, 0.2, 800]] },
];

/**
 * The success cheer (§17.1: "connected" → success sound): one fixed sound, not one of the owner's 30 picks, so it is
 * never mistaken for a plain click. Three rising notes and a little shimmer.
 */
export const SUCCESS_SOUND: SoundRecipe = {
  id: 0,
  name: "Hooray",
  feel: "Three happy notes up",
  voices: [
    ["sine", 1047, 1047, 0, 0.12, 0.16, 8000],
    ["sine", 1319, 1319, 0.09, 0.12, 0.15, 8000],
    ["sine", 1568, 1568, 0.18, 0.28, 0.15, 8000],
    ["triangle", 3136, 3130, 0.18, 0.2, 0.04, 10000],
  ],
};

/** True for a whole number from 1 to 30. */
export function isSoundId(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= SOUND_COUNT;
}

/** The click (tap) or error (deny) recipe numbered `id`; anything out of range falls back to the default. */
export function recipeFor(kind: "tap" | "deny", id: unknown): SoundRecipe {
  const list = kind === "tap" ? CLICK_SOUNDS : ERROR_SOUNDS;
  const fallback = kind === "tap" ? DEFAULT_CLICK_SOUND : DEFAULT_ERROR_SOUND;
  return list[(isSoundId(id) ? id : fallback) - 1]!;
}
