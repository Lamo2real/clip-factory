// Lamo Stories' own device preferences (docs/CONTRACTS.md §45.34 "Lamo Stories' own device preferences"): Settings ›
// Storage and production › Sounds and motion writes cf.stories.prefs `sound.enabled` and `motion.reduce` as true or
// false and `sound.click` as a click sound's number (1..30), the shapes the shell's readers (stories/prefs.ts:
// storiesSoundOn, storiesClickSound, storiesMotionSetting) take; anything else is not kept, so a switch can never be
// saved in a shape the sounds then ignore. Clip Factory's cf.prefs is never touched.
import { beforeEach, describe, expect, it } from "vitest";
import { getPrefs } from "../src/lib/prefs.ts";
import { setStoriesDevicePref, storiesClickSound, storiesDeviceOwn, storiesMotionSetting, storiesSoundOn } from "../src/stories/prefs.ts";
import { resetWorkspaceMemory } from "../src/stories/workspace.ts";

const kept = () => (JSON.parse(localStorage.getItem("cf.stories.prefs") ?? "{}") as { more?: Record<string, unknown> }).more ?? {};
const setAny = setStoriesDevicePref as unknown as (key: string, value: unknown) => void;

beforeEach(() => {
  localStorage.clear();
  resetWorkspaceMemory();
});

describe("Sounds and motion's own keys", () => {
  it("follow Clip Factory's choices while unset, and Lamo Stories' own once set", () => {
    const cf = getPrefs();
    expect(storiesDeviceOwn()).toEqual({ sound: undefined, click: undefined, motion: undefined });
    expect(storiesSoundOn()).toBe(cf.soundEnabled);
    expect(storiesClickSound()).toBe(cf.clickSound);
    expect(storiesMotionSetting()).toBe(cf.reduceMotion);
    const clipsBefore = localStorage.getItem("cf.prefs");

    setStoriesDevicePref("sound.enabled", !cf.soundEnabled);
    setStoriesDevicePref("sound.click", cf.clickSound === 12 ? 13 : 12);
    setStoriesDevicePref("motion.reduce", !cf.reduceMotion);
    expect(kept()).toEqual({ "sound.enabled": !cf.soundEnabled, "sound.click": cf.clickSound === 12 ? 13 : 12, "motion.reduce": !cf.reduceMotion });
    expect(storiesSoundOn()).toBe(!cf.soundEnabled);
    expect(storiesClickSound()).toBe(cf.clickSound === 12 ? 13 : 12);
    expect(storiesMotionSetting()).toBe(!cf.reduceMotion);
    expect(localStorage.getItem("cf.prefs")).toBe(clipsBefore);

    // null forgets one: Clip Factory's applies again.
    setStoriesDevicePref("sound.click", null);
    expect(kept()).not.toHaveProperty("sound.click");
    expect(storiesClickSound()).toBe(cf.clickSound);
  });

  it("keeps only the shapes the readers take: the click sound is a number from 1 to 30, never on or off", () => {
    setStoriesDevicePref("sound.click", 7);
    setAny("sound.click", false);
    setAny("sound.click", 31);
    setAny("sound.click", 0);
    setAny("sound.click", "7");
    expect(kept()["sound.click"]).toBe(7);
    expect(storiesClickSound()).toBe(7);
    setAny("sound.enabled", 1);
    setAny("motion.reduce", "yes");
    setAny("sound.volume", true);
    expect(kept()).toEqual({ "sound.click": 7 });
    setStoriesDevicePref("sound.enabled", false);
    expect(storiesSoundOn()).toBe(false);
  });
});
