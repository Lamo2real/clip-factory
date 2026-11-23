// Lamo Stories' own device preferences (docs/CONTRACTS.md §45.34, §45.38 A2; request 2 §2 "Each application should
// remember its own ... User preferences", §9 "separate configuration namespaces"): cf.stories.prefs `sound.enabled`,
// `sound.click`, `sound.deny` and `motion.reduce`, each with Lamo Stories' own default while it is unset; Clip
// Factory's cf.prefs is never read (nor written) for them. While one of its pages is on screen, a click plays Lamo
// Stories' own sound and the app's click handler stays quiet.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrefs, setPrefs } from "../src/lib/prefs.ts";
import { installClickSounds, type SoundLogEntry } from "../src/lib/sound.ts";
import { sounds } from "../src/lib/sounds.ts";
import {
  calmPage,
  setStoriesDevicePref,
  storiesDeviceOwn,
  followStoriesClicks,
  followStoriesMotion,
  STORIES_PREF_KEYS,
  storiesClickSound,
  storiesDeniedSound,
  storiesErrorSound,
  storiesMotionSetting,
  storiesReduceMotion,
  storiesSound,
  storiesSoundOn,
} from "../src/stories/prefs.ts";
import { resetWorkspaceMemory, setStoriesPref, STORIES_PREFS_KEY } from "../src/stories/workspace.ts";

const CLIPS = { soundEnabled: true, clickSound: 4, errorSound: 6, reduceMotion: false };
const log = (): SoundLogEntry[] => window.__cfSoundLog ?? [];

let osReduce = false;
beforeEach(() => {
  localStorage.clear();
  resetWorkspaceMemory();
  setPrefs(CLIPS);
  window.__cfSoundLog = [];
  osReduce = false;
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") && osReduce, media: q, addEventListener() {}, removeEventListener() {} }));
  history.replaceState(null, "", "/");
  document.documentElement.classList.remove("reduce-motion");
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  history.replaceState(null, "", "/");
  document.body.innerHTML = "";
});

describe("the keys and their fallbacks", () => {
  it("uses the agreed keys in cf.stories.prefs", () => {
    expect(STORIES_PREF_KEYS).toEqual({ sound: "sound.enabled", click: "sound.click", deny: "sound.deny", motion: "motion.reduce" });
    setStoriesPref("sound.enabled", false);
    setStoriesPref("sound.click", 9);
    setStoriesPref("sound.deny", 3);
    setStoriesPref("motion.reduce", true);
    expect(JSON.parse(localStorage.getItem(STORIES_PREFS_KEY)!).more).toEqual({ "sound.enabled": false, "sound.click": 9, "sound.deny": 3, "motion.reduce": true });
  });

  it("while unset: Lamo Stories' own defaults, never Clip Factory's choices (§45.38 A2)", () => {
    expect([storiesSoundOn(), storiesClickSound(), storiesErrorSound(), storiesMotionSetting(), storiesReduceMotion()]).toEqual([true, 6, 5, false, false]);
    setPrefs({ soundEnabled: false, clickSound: 12, errorSound: 2, reduceMotion: true });
    expect([storiesSoundOn(), storiesClickSound(), storiesErrorSound(), storiesMotionSetting(), storiesReduceMotion()]).toEqual([true, 6, 5, false, false]);
  });

  it("once set, its own wins, and Clip Factory's later choice never changes it (nor is Clip Factory's ever written)", () => {
    setStoriesPref("sound.enabled", false);
    setStoriesPref("sound.click", 9);
    setStoriesPref("motion.reduce", false);
    setPrefs({ soundEnabled: true, clickSound: 2, reduceMotion: true });
    expect([storiesSoundOn(), storiesClickSound(), storiesMotionSetting(), storiesReduceMotion()]).toEqual([false, 9, false, false]);
    expect(getPrefs()).toMatchObject({ soundEnabled: true, clickSound: 2, reduceMotion: true });
    expect(JSON.parse(localStorage.getItem("cf.prefs")!)).toMatchObject({ soundEnabled: true, clickSound: 2, reduceMotion: true });
  });

  it("ignores a stored value of the wrong kind (a broken click sound falls back)", () => {
    setStoriesPref("sound.click", 99);
    setStoriesPref("sound.deny", 0);
    setStoriesPref("sound.enabled", "no");
    expect([storiesClickSound(), storiesErrorSound(), storiesSoundOn()]).toEqual([6, 5, true]);
  });

  it("calm motion: the system's setting always calms it, its own switch otherwise", () => {
    osReduce = true;
    expect(storiesReduceMotion()).toBe(true);
    setStoriesPref("motion.reduce", false);
    expect(storiesReduceMotion()).toBe(true);
    osReduce = false;
    expect(storiesReduceMotion()).toBe(false);
    setStoriesPref("motion.reduce", true);
    expect(storiesReduceMotion()).toBe(true);
  });
});

describe("the Settings card's writer (one file with the readers, builder W3c's exports)", () => {
  it("keeps only the right shape per key, null forgets, and the readers see it at once", () => {
    expect(storiesDeviceOwn()).toEqual({ sound: undefined, click: undefined, deny: undefined, motion: undefined });
    setStoriesDevicePref("sound.enabled", false);
    setStoriesDevicePref("sound.click", 12);
    setStoriesDevicePref("sound.deny", 7);
    setStoriesDevicePref("motion.reduce", true);
    expect(storiesDeviceOwn()).toEqual({ sound: false, click: 12, deny: 7, motion: true });
    expect([storiesSoundOn(), storiesClickSound(), storiesErrorSound(), storiesReduceMotion()]).toEqual([false, 12, 7, true]);
    (setStoriesDevicePref as (k: string, v: unknown) => void)("sound.click", 99);
    (setStoriesDevicePref as (k: string, v: unknown) => void)("sound.deny", true);
    (setStoriesDevicePref as (k: string, v: unknown) => void)("motion.reduce", "yes");
    (setStoriesDevicePref as (k: string, v: unknown) => void)("chat.enterSends", true);
    expect(storiesDeviceOwn()).toEqual({ sound: false, click: 12, deny: 7, motion: true });
    expect(JSON.parse(localStorage.getItem(STORIES_PREFS_KEY)!).more).toEqual({ "sound.enabled": false, "sound.click": 12, "sound.deny": 7, "motion.reduce": true });
    setStoriesDevicePref("motion.reduce", null);
    expect(storiesDeviceOwn().motion).toBeUndefined();
    expect(storiesReduceMotion()).toBe(false);
  });
});

describe("the page's calm-motion class", () => {
  it("is Clip Factory's on its pages (and always while Lamo Stories is off), Lamo Stories' own on its pages", () => {
    localStorage.setItem("cf.storiesPreview", "0");
    setStoriesPref("motion.reduce", true);
    history.replaceState(null, "", "/stories/ideas");
    expect(calmPage(false)).toBe(false); // switched off: /stories is not Lamo Stories
    localStorage.setItem("cf.storiesPreview", "1");
    expect(calmPage(false)).toBe(true);
    history.replaceState(null, "", "/library");
    expect(calmPage(false)).toBe(false);
    expect(calmPage(true)).toBe(true);
  });

  it("follows Lamo Stories' own switch the moment it changes", () => {
    localStorage.setItem("cf.storiesPreview", "1");
    history.replaceState(null, "", "/stories");
    const stop = followStoriesMotion(() => getPrefs().reduceMotion);
    expect(document.documentElement.classList.contains("reduce-motion")).toBe(false);
    setStoriesPref("motion.reduce", true);
    expect(document.documentElement.classList.contains("reduce-motion")).toBe(true);
    stop();
    setStoriesPref("motion.reduce", false);
    expect(document.documentElement.classList.contains("reduce-motion")).toBe(true);
  });
});

/** Only ever forward, across the tests too (the engine remembers its last sound). */
let clock = 1e9;

describe("sounds", () => {
  // These were written with Lamo Stories switched off by default (no page of it behind Clip Factory to keep quiet);
  // since the switch (STORIES_ON true) that state is chosen explicitly. The on-screen cases set "1" themselves.
  // Every Lamo Stories sound plays from its one engine now (§45.38 A2), which hears one sound of a kind per short
  // moment (two taps within 60 ms, two cheers within 300 ms): each sound here is a second after the one before.
  beforeEach(() => {
    localStorage.setItem("cf.storiesPreview", "0");
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 1000));
  });
  afterEach(() => vi.restoreAllMocks());

  it("unset: Lamo Stories' own engine plays, by its own default (never Clip Factory's engine)", () => {
    const play = vi.spyOn(sounds, "play");
    setPrefs({ soundEnabled: false });
    storiesSound("success");
    expect(play).not.toHaveBeenCalled();
    play.mockRestore();
    expect(log().at(-1)).toMatchObject({ kind: "success", muted: false });
  });

  it("set: Lamo Stories' own engine plays by its own setting, never Clip Factory's", () => {
    const play = vi.spyOn(sounds, "play");
    setStoriesPref("sound.enabled", false);
    storiesSound("success");
    expect(play).not.toHaveBeenCalled();
    expect(log().at(-1)).toMatchObject({ kind: "success", muted: true });
    setStoriesPref("sound.enabled", true);
    setStoriesPref("sound.click", 9);
    storiesSound("tap");
    expect(log().at(-1)).toMatchObject({ kind: "tap", sound: 9, muted: false });
    play.mockRestore();
  });

  it("on the next tap: the cheer waits for the owner's tap", () => {
    setStoriesPref("sound.enabled", false);
    storiesSound("success", { onNextTap: true });
    expect(log()).toEqual([]);
    document.body.click();
    expect(log()).toEqual([expect.objectContaining({ kind: "success", muted: true })]);
    document.body.click();
    expect(log()).toHaveLength(1);
  });

  it("an error toast's sound is Lamo Stories' own error sound by its own switch, and quiet behind Clip Factory", () => {
    localStorage.setItem("cf.storiesPreview", "1");
    history.replaceState(null, "", "/stories");
    storiesDeniedSound();
    expect(log().at(-1)).toMatchObject({ kind: "deny", sound: 5, muted: false });
    setStoriesPref("sound.deny", 11);
    storiesDeniedSound();
    expect(log().at(-1)).toMatchObject({ kind: "deny", sound: 11, muted: false });
    setStoriesPref("sound.enabled", false);
    storiesDeniedSound();
    expect(log().at(-1)).toMatchObject({ kind: "deny", sound: 11, muted: true });
    // Clip Factory on screen: Lamo Stories kept behind it makes no sound at all.
    window.__cfSoundLog = [];
    history.replaceState(null, "", "/jobs");
    storiesDeniedSound();
    expect(log()).toEqual([]);
  });

  it("clicks on a Lamo Stories page follow its own setting, and the app's click handler stays quiet for them", async () => {
    localStorage.setItem("cf.storiesPreview", "1");
    history.replaceState(null, "", "/stories/library");
    const offApp = installClickSounds(sounds);
    const offStories = followStoriesClicks();
    const button = document.createElement("button");
    button.textContent = "Videos";
    document.body.appendChild(button);
    try {
      // Unset: Lamo Stories' own click sound (its default), and only that one (Clip Factory's stays quiet).
      button.click();
      expect(log()).toEqual([expect.objectContaining({ kind: "tap", sound: 6, muted: false })]);
      expect(button.hasAttribute("data-sound")).toBe(false);
      window.__cfSoundLog = [];
      // Set: one sound, Lamo Stories' (muted, its own click sound); the button is left as it was.
      setStoriesPref("sound.enabled", false);
      setStoriesPref("sound.click", 9);
      button.click();
      expect(log()).toEqual([expect.objectContaining({ kind: "tap", sound: 9, muted: true })]);
      expect(button.hasAttribute("data-sound")).toBe(false);
      // A switched-off control denies, in Lamo Stories' voice too (its own error sound, not Clip Factory's 6).
      window.__cfSoundLog = [];
      setStoriesPref("sound.enabled", true);
      button.setAttribute("aria-disabled", "true");
      button.click();
      expect(log()).toEqual([expect.objectContaining({ kind: "deny", sound: 5, muted: false })]);
      // A Clip Factory page: the app's handler, Clip Factory's choice (a moment later: two taps within 60 ms are one).
      await new Promise((done) => setTimeout(done, 80));
      window.__cfSoundLog = [];
      button.removeAttribute("aria-disabled");
      history.replaceState(null, "", "/library");
      button.click();
      expect(log()).toEqual([expect.objectContaining({ kind: "tap", sound: 4, muted: false })]);
    } finally {
      offStories();
      offApp();
    }
  });

  it("a sound picker's preview plays the asked recipe in Lamo Stories' voice", () => {
    setStoriesPref("sound.click", 9);
    storiesSound("tap", { recipe: 17 });
    expect(log().at(-1)).toMatchObject({ kind: "tap", sound: 17 });
  });

  it("keeps an element's own data-sound as it was", () => {
    localStorage.setItem("cf.storiesPreview", "1");
    history.replaceState(null, "", "/stories");
    setStoriesPref("sound.click", 9);
    const offApp = installClickSounds(sounds);
    const offStories = followStoriesClicks();
    const quiet = document.createElement("button");
    quiet.setAttribute("data-sound", "off");
    document.body.appendChild(quiet);
    try {
      quiet.click();
      expect(log()).toEqual([]);
      expect(quiet.getAttribute("data-sound")).toBe("off");
    } finally {
      offStories();
      offApp();
    }
  });
});

describe("every Lamo Stories sound and calm-motion check goes through stories/prefs.ts", () => {
  const ROOT = join(import.meta.dirname, "../src/stories");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return name === "engine" ? [] : files(p);
      return /\.(ts|tsx)$/.test(name) && p !== join(ROOT, "prefs.ts") ? [p] : [];
    });

  it("no screen plays Clip Factory's sound engine or reads Clip Factory's calm-motion setting itself", () => {
    const bad: string[] = [];
    for (const f of files(ROOT)) {
      const text = readFileSync(f, "utf8");
      for (const [what, re] of [
        ["Clip Factory's sound engine", /lib\/sounds\.ts/],
        ["cheerOnNextTap (use storiesSound(kind, { onNextTap: true }))", /\bcheerOnNextTap\b/],
        ["prefersReducedMotion (use storiesReduceMotion())", /\bprefersReducedMotion\b/],
        ["Clip Factory's confetti, stilled by Clip Factory's calm setting (use ui.tsx starBurst)", /lib\/confetti\.ts/],
        ["the system's reduced-motion query (use storiesReduceMotion())", /prefers-reduced-motion/],
      ] as const)
        if (re.test(text)) bad.push(`${f.slice(ROOT.length + 1)}: ${what}`);
    }
    expect(bad).toEqual([]);
  });
});
