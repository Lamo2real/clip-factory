import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLICK_SOUNDS,
  DEFAULT_CLICK_SOUND,
  DEFAULT_ERROR_SOUND,
  ERROR_SOUNDS,
  isSoundId,
  recipeFor,
  type SoundRecipe,
} from "../src/lib/soundCatalog.ts";

// The owner's picker page, copied as data (test/fixtures/picker-sounds.json): [name, feel, voices] in card order.
type PickerSound = [string, string, unknown[][]];
const picker = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "picker-sounds.json"), "utf8")) as {
  tap: PickerSound[];
  deny: PickerSound[];
};

const WAVES = ["sine", "triangle", "square", "sawtooth"];
const FILTERS = ["bandpass", "highpass", "lowpass"];

function checkRecipe(r: SoundRecipe) {
  expect(r.name.trim()).not.toBe("");
  expect(r.feel.trim()).not.toBe("");
  expect(r.voices.length).toBeGreaterThan(0);
  let end = 0;
  for (const v of r.voices) {
    if (v[0] === "noise") {
      expect(v).toHaveLength(6);
      const [, type, hz, at, length, peak] = v;
      expect(FILTERS).toContain(type);
      expect(hz).toBeGreaterThan(20);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(length).toBeGreaterThan(0);
      expect(peak).toBeGreaterThan(0);
      expect(peak).toBeLessThanOrEqual(0.5);
      end = Math.max(end, at + length);
    } else {
      expect(v).toHaveLength(7);
      const [wave, from, to, at, length, peak, lowpass] = v;
      expect(WAVES).toContain(wave);
      expect(from).toBeGreaterThan(20);
      expect(to).toBeGreaterThan(20);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(length).toBeGreaterThan(0);
      expect(peak).toBeGreaterThan(0);
      expect(peak).toBeLessThanOrEqual(0.5);
      expect(lowpass).toBeGreaterThan(20);
      end = Math.max(end, at + length);
    }
  }
  // Short sounds only: a tap never drags on.
  expect(end).toBeLessThanOrEqual(0.5);
}

describe("sound catalog", () => {
  it("has 30 click sounds and 30 error sounds, numbered 1 to 30", () => {
    expect(CLICK_SOUNDS).toHaveLength(30);
    expect(ERROR_SOUNDS).toHaveLength(30);
    expect(CLICK_SOUNDS.map((s) => s.id)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(ERROR_SOUNDS.map((s) => s.id)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });

  it("every recipe is a valid, short, quiet sound", () => {
    for (const r of [...CLICK_SOUNDS, ...ERROR_SOUNDS]) checkRecipe(r);
  });

  // Sound 1 of each kind was "The app's sound today" on the picker page. That stopped being true once the owner
  // picked 6 and 5, so those two cards describe the sound instead. Everything else is the picker's, word for word.
  const RENAMED_FEELS: Record<string, string> = { "Glass tick": "Light glassy tick", "Double thud": "Two low thuds" };
  const expected = (list: PickerSound[]) => list.map(([name, feel, voices]) => [name, RENAMED_FEELS[name] ?? feel, voices]);

  it("matches the owner's picker: same order, names, feels and numbers (sound 1's feel aside)", () => {
    expect(CLICK_SOUNDS.map((s) => [s.name, s.feel, s.voices])).toEqual(expected(picker.tap));
    expect(ERROR_SOUNDS.map((s) => [s.name, s.feel, s.voices])).toEqual(expected(picker.deny));
  });

  it("no card claims to be the app's current sound (the Pick badge says which one is)", () => {
    for (const s of [...CLICK_SOUNDS, ...ERROR_SOUNDS]) expect(s.feel).not.toMatch(/today|current|default/i);
    expect(CLICK_SOUNDS[0]!.feel).toBe("Light glassy tick");
    expect(ERROR_SOUNDS[0]!.feel).toBe("Two low thuds");
  });

  it("names are unique within each kind", () => {
    expect(new Set(CLICK_SOUNDS.map((s) => s.name)).size).toBe(30);
    expect(new Set(ERROR_SOUNDS.map((s) => s.name)).size).toBe(30);
  });

  it("defaults to the owner's picks: click 6 Water drop, error 5 Nope nope nope", () => {
    expect(DEFAULT_CLICK_SOUND).toBe(6);
    expect(DEFAULT_ERROR_SOUND).toBe(5);
    expect(recipeFor("tap", DEFAULT_CLICK_SOUND).name).toBe("Water drop");
    expect(recipeFor("deny", DEFAULT_ERROR_SOUND).name).toBe("Nope nope nope");
  });

  it("falls back to the default for anything that is not 1..30", () => {
    for (const bad of [0, 31, 2.5, -1, Number.NaN, "6", null, undefined]) {
      expect(isSoundId(bad)).toBe(false);
      expect(recipeFor("tap", bad).id).toBe(6);
      expect(recipeFor("deny", bad).id).toBe(5);
    }
    expect(recipeFor("tap", 30).name).toBe("Feather");
    expect(recipeFor("deny", 1).name).toBe("Double thud");
  });
});
