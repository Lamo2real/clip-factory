// Lamo Stories' own device preferences (docs/CONTRACTS.md §45.34; request 2 §2 "Each application should remember its
// own ... User preferences", §9 "separate configuration namespaces"): cf.stories.prefs `sound.enabled`, `sound.click`
// and `motion.reduce` are read first, Clip Factory's cf.prefs only while one is unset, and once set Clip Factory's
// choice never changes Lamo Stories'. Clip Factory's own preferences are never written. While Lamo Stories' own sound
// is set and one of its pages is on screen, a click plays Lamo Stories' sound and the app's click handler stays quiet.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrefs, setPrefs } from "../src/lib/prefs.ts";
import { installClickSounds, type SoundLogEntry } from "../src/lib/sound.ts";
import { sounds } from "../src/lib/sounds.ts";
import {
  calmPage,
  deniedSound,
  followStoriesClicks,
  followStoriesMotion,
  STORIES_PREF_KEYS,
  storiesClickSound,
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
    expect(STORIES_PREF_KEYS).toEqual({ sound: "sound.enabled", click: "sound.click", motion: "motion.reduce" });
    setStoriesPref("sound.enabled", false);
    setStoriesPref("sound.click", 9);
    setStoriesPref("motion.reduce", true);
    expect(JSON.parse(localStorage.getItem(STORIES_PREFS_KEY)!).more).toEqual({ "sound.enabled": false, "sound.click": 9, "motion.reduce": true });
  });

  it("follows Clip Factory's while unset", () => {
    expect([storiesSoundOn(), storiesClickSound(), storiesMotionSetting(), storiesReduceMotion()]).toEqual([true, 4, false, false]);
    setPrefs({ soundEnabled: false, clickSound: 12, reduceMotion: true });
    expect([storiesSoundOn(), storiesClickSound(), storiesMotionSetting(), storiesReduceMotion()]).toEqual([false, 12, true, true]);
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
    setStoriesPref("sound.enabled", "no");
    expect([storiesClickSound(), storiesSoundOn()]).toEqual([4, true]);
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

describe("the page's calm-motion class", () => {
  it("is Clip Factory's on its pages (and always while Lamo Stories is off), Lamo Stories' own on its pages", () => {
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
    const stop = followStoriesMotion();
    expect(document.documentElement.classList.contains("reduce-motion")).toBe(false);
    setStoriesPref("motion.reduce", true);
    expect(document.documentElement.classList.contains("reduce-motion")).toBe(true);
    stop();
    setStoriesPref("motion.reduce", false);
    expect(document.documentElement.classList.contains("reduce-motion")).toBe(true);
  });
});

describe("sounds", () => {
  it("unset: Clip Factory's sound engine plays, exactly as before", () => {
    const play = vi.spyOn(sounds, "play");
    storiesSound("success");
    expect(play).toHaveBeenCalledWith("success");
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

  it("an error toast's sound is Lamo Stories' own on its pages, Clip Factory's elsewhere", () => {
    localStorage.setItem("cf.storiesPreview", "1");
    setStoriesPref("sound.enabled", false);
    history.replaceState(null, "", "/stories");
    deniedSound();
    expect(log().at(-1)).toMatchObject({ kind: "deny", muted: true });
    history.replaceState(null, "", "/jobs");
    deniedSound();
    expect(log().at(-1)).toMatchObject({ kind: "deny", muted: false });
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
      // Unset: the app's own handler, Clip Factory's click sound.
      button.click();
      expect(log()).toEqual([expect.objectContaining({ kind: "tap", sound: 4, muted: false })]);
      window.__cfSoundLog = [];
      // Set: one sound, Lamo Stories' (muted, its own click sound); the button is left as it was.
      setStoriesPref("sound.enabled", false);
      setStoriesPref("sound.click", 9);
      button.click();
      expect(log()).toEqual([expect.objectContaining({ kind: "tap", sound: 9, muted: true })]);
      expect(button.hasAttribute("data-sound")).toBe(false);
      // A switched-off control denies, in Lamo Stories' voice too.
      window.__cfSoundLog = [];
      setStoriesPref("sound.enabled", true);
      button.setAttribute("aria-disabled", "true");
      button.click();
      expect(log()).toEqual([expect.objectContaining({ kind: "deny", sound: 6, muted: false })]);
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
        ["the system's reduced-motion query (use storiesReduceMotion())", /prefers-reduced-motion/],
      ] as const)
        if (re.test(text)) bad.push(`${f.slice(ROOT.length + 1)}: ${what}`);
    }
    expect(bad).toEqual([]);
  });
});
