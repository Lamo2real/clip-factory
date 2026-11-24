// Lamo Stories routing behind its switch (docs/CONTRACTS.md §45.1, §45.17): with the switch off, /stories is
// "not found" like any unknown page and every Lamo Clips path parses exactly as before.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { match } from "../src/lib/router.ts";
import { matchStories, storiesHref } from "../src/stories/routes.ts";
import { storiesTitle } from "../src/stories/workspace.ts";

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

describe("Vehicles' addresses and a saved video draft (§45.47)", () => {
  const ID = "01JSTCH0000000000000000005";

  it("opens Vehicles at /stories/vehicles…, keeps /stories/cars… working, and always links to the Vehicles address", () => {
    for (const [path, page] of [
      ["/stories/vehicles", { name: "cars" }],
      ["/stories/vehicles/new", { name: "car_new" }],
      [`/stories/vehicles/${ID}`, { name: "car", characterId: ID }],
    ] as const) {
      expect(matchStories(path, "")).toEqual(page);
      expect(matchStories(path.replace("/vehicles", "/cars"), "")).toEqual(page);
      expect(storiesHref(page)).toBe(path);
      expect(storiesHref(matchStories(path.replace("/vehicles", "/cars"), ""))).toBe(path);
    }
    expect(matchStories("/stories/vehicles/new/x", "").name).toBe("not_found");
    expect(matchStories("/stories/vehicles/../x", "").name).toBe("not_found");
    expect(match("/stories/vehicles")).toEqual({ name: "stories", page: { name: "cars" } });
  });

  it("titles the pages Vehicles, New vehicle and Vehicle", () => {
    expect(storiesTitle({ name: "cars" })).toBe("Vehicles · Clips Funded");
    expect(storiesTitle({ name: "car_new" })).toBe("New vehicle · Clips Funded");
    expect(storiesTitle({ name: "car", characterId: ID })).toBe("Vehicle · Clips Funded");
  });

  it("reads ?draft= on Make a new video (an id only), and leaves the key out without one", () => {
    expect(matchStories("/stories/production/new", "?draft=d1")).toEqual({ name: "production_new", ideaId: null, refIds: [], castIds: [], durationSec: null, draftId: "d1" });
    expect(matchStories("/stories/production/new", "")).not.toHaveProperty("draftId");
    expect(matchStories("/stories/production/new", "?draft=../x")).not.toHaveProperty("draftId");
    expect(storiesHref({ name: "production_new", ideaId: null, draftId: "d1" })).toBe("/stories/production/new?draft=d1");
    expect(storiesHref(matchStories("/stories/production/new", "?idea=i1&draft=d1"))).toBe("/stories/production/new?idea=i1&draft=d1");
  });
});

describe("Social accounts and each platform's own page (CONTRACTS §45.16.2)", () => {
  it("opens a platform's own page at /stories/connections/<platform>, for each of the five", () => {
    for (const p of ["youtube", "tiktok", "instagram", "facebook", "x"] as const) {
      expect(matchStories(`/stories/connections/${p}`, "")).toEqual({ name: "connection", platform: p, result: null, ws: null });
      expect(matchStories(`/stories/connections/${p}/`, "")).toEqual({ name: "connection", platform: p, result: null, ws: null });
      expect(storiesHref(matchStories(`/stories/connections/${p}`, ""))).toBe(`/stories/connections/${p}`);
    }
    // The list page itself is as before.
    expect(matchStories("/stories/connections", "")).toEqual({ name: "connections", platform: null, result: null, ws: null });
    expect(storiesHref(matchStories("/stories/connections", ""))).toBe("/stories/connections");
  });

  it("lands the OAuth return on the platform's own page, with its result and workspace", () => {
    expect(matchStories("/stories/connections", "?platform=youtube&result=connected&ws=stories")).toEqual({ name: "connection", platform: "youtube", result: "connected", ws: "stories" });
    expect(matchStories("/stories/connections", "?platform=facebook&result=choose&ws=stories")).toEqual({ name: "connection", platform: "facebook", result: "choose", ws: "stories" });
    expect(matchStories("/stories/connections/x", "?result=denied&ws=st-2")).toEqual({ name: "connection", platform: "x", result: "denied", ws: "st-2" });
    // A platform it does not know stays the list page, as before.
    expect(matchStories("/stories/connections", "?platform=myspace&result=connected")).toEqual({ name: "connections", platform: "myspace", result: "connected", ws: null });
  });

  it("an unknown platform's page is not found, and the page's address never keeps the result or the workspace", () => {
    expect(matchStories("/stories/connections/myspace", "").name).toBe("not_found");
    expect(matchStories("/stories/connections/YouTube", "").name).toBe("not_found");
    expect(matchStories("/stories/connections/youtube/more", "").name).toBe("not_found");
    expect(storiesHref({ name: "connection", platform: "tiktok", result: "connected", ws: "stories" })).toBe("/stories/connections/tiktok");
    expect(storiesHref(matchStories("/stories/connections", "?platform=tiktok&result=connected&ws=stories"))).toBe("/stories/connections/tiktok");
  });

  it("titles the platform's page Social accounts, and the rail marks Social accounts there", () => {
    expect(storiesTitle({ name: "connection", platform: "youtube", result: null, ws: null })).toBe("Social accounts · Clips Funded");
    expect(storiesTitle({ name: "connections", platform: null, result: null, ws: null })).toBe("Social accounts · Clips Funded");
    const app = readFileSync(join(import.meta.dirname, "..", "src", "stories", "StoriesApp.tsx"), "utf8");
    expect(app).toMatch(/label: "Social accounts",[\s\S]{0,160}match: \["connections", "connection"\]/);
    expect(app).toContain('case "connection":\n      return <ConnectionScreen {...props} />;');
    // The OAuth return's workspace is read on both pages.
    expect(app).toContain('const fromAddress = page.name === "connections" || page.name === "connection" ? page.ws : null;');
  });
});

