// Lamo Stories routing behind its switch (docs/CONTRACTS.md §45.1, §45.17): with the switch off, /stories is
// "not found" like any unknown page and every Lamo Clips path parses exactly as before.
import { afterEach, describe, expect, it } from "vitest";
import { match } from "../src/lib/router.ts";
import { matchStories, storiesHref } from "../src/stories/routes.ts";

const CLIPS_PATHS = [
  "/",
  "/jobs",
  "/jobs/01JZ0000000000000000000000",
  "/review",
  "/library",
  "/money",
  "/campaigns",
  "/settings",
  "/settings/posting/setup/youtube",
  "/get-app",
  "/clips/01JZ0000000000000000000000",
];

afterEach(() => localStorage.removeItem("cf.storiesPreview"));

describe("the stories route", () => {
  it("is on for everyone now (STORIES_ON, CONTRACTS §45.36)", () => {
    expect(match("/stories")).toEqual({ name: "stories", page: { name: "dashboard" } });
  });

  it("is not found while Lamo Stories is off", () => {
    localStorage.setItem("cf.storiesPreview", "0");
    expect(match("/stories").name).toBe("not_found");
    expect(match("/stories/ideas").name).toBe("not_found");
  });

  it("parses every /stories page once switched on, and Lamo Clips paths never change", () => {
    localStorage.setItem("cf.storiesPreview", "0");
    const before = CLIPS_PATHS.map((p) => match(p));
    localStorage.setItem("cf.storiesPreview", "1");
    expect(match("/stories")).toEqual({ name: "stories", page: { name: "dashboard" } });
    expect(match("/stories/review/01JZ0000000000000000000000")).toEqual({
      name: "stories",
      page: { name: "review_story", storyId: "01JZ0000000000000000000000" },
    });
    expect(match("/storiesx").name).toBe("not_found");
    expect(CLIPS_PATHS.map((p) => match(p))).toEqual(before);
  });

  it("round-trips its own addresses", () => {
    for (const path of ["/stories", "/stories/ideas", "/stories/characters/new", "/stories/production/new?idea=ab1", "/stories/library?kind=final_video&story=s1", "/stories/settings/agents", "/stories/settings/look", "/stories/chat/c1", "/stories/references/r1", "/stories/setup"]) {
      const [p, q = ""] = path.split("?");
      expect(storiesHref(matchStories(p!, q ? `?${q}` : ""))).toBe(path);
    }
    expect(matchStories("/stories/nope", "").name).toBe("not_found");
    // Settings › Look is its own page, deep links and the phone pills alike.
    expect(matchStories("/stories/settings/look", "")).toEqual({ name: "settings", section: "look" });
    expect(matchStories("/stories/settings/look/", "")).toEqual({ name: "settings", section: "look" });
  });

  it("has the series pages, ?series=, ?ask=1 and ?kind=car, each key left out when its query is (§45.44, §45.42)", () => {
    const ID = "01JSTSR0000000000000000001";
    expect(matchStories("/stories/series", "")).toEqual({ name: "series" });
    expect(matchStories(`/stories/series/${ID}`, "")).toEqual({ name: "series_one", seriesId: ID });
    expect(matchStories("/stories/series/none", "").name).toBe("not_found");
    expect(matchStories("/stories/ideas", "")).toEqual({ name: "ideas" });
    expect(matchStories("/stories/ideas", `?series=${ID}&ask=1`)).toEqual({ name: "ideas", seriesId: ID, ask: true });
    expect(matchStories("/stories/ideas", "?series=none")).toEqual({ name: "ideas", seriesId: "none" });
    expect(matchStories("/stories/ideas", "?series=../x&ask=yes")).toEqual({ name: "ideas" });
    expect(matchStories("/stories/production", "")).toEqual({ name: "production" });
    expect(matchStories("/stories/production", `?series=${ID}`)).toEqual({ name: "production", seriesId: ID });
    expect(matchStories("/stories/review", "?series=none")).toEqual({ name: "review", seriesId: "none" });
    expect(matchStories("/stories/review", "")).toEqual({ name: "review" });
    expect(matchStories("/stories/library", `?series=${ID}`)).toEqual({ name: "library", kind: null, storyId: null, seriesId: ID });
    expect(matchStories("/stories/library", "")).toEqual({ name: "library", kind: null, storyId: null });
    expect(matchStories("/stories/production/new", `?cast=c1&cast=c2&series=${ID}`)).toEqual({
      name: "production_new",
      ideaId: null,
      refIds: [],
      castIds: ["c1", "c2"],
      durationSec: null,
      seriesId: ID,
    });
    expect(matchStories("/stories/production/new", "?series=none")).not.toHaveProperty("seriesId");
    expect(matchStories("/stories/production/new", "")).not.toHaveProperty("seriesId");
    expect(matchStories("/stories/characters/new", "?kind=car")).toEqual({ name: "character_new", kind: "car" });
    expect(matchStories("/stories/characters/new", "")).toEqual({ name: "character_new" });
    expect(matchStories("/stories/characters/new", "?kind=boat")).toEqual({ name: "character_new" });
    for (const path of [
      "/stories/series",
      `/stories/series/${ID}`,
      `/stories/ideas?series=${ID}&ask=1`,
      "/stories/ideas?series=none",
      `/stories/production?series=${ID}`,
      "/stories/review?series=none",
      `/stories/library?kind=cover&series=${ID}`,
      `/stories/production/new?cast=c1&series=${ID}`,
      "/stories/characters/new?kind=car",
    ]) {
      const [p, q = ""] = path.split("?");
      expect(storiesHref(matchStories(p!, q ? `?${q}` : ""))).toBe(path);
    }
  });
});
