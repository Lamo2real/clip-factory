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
  it("is not found while Lamo Stories is off", () => {
    expect(match("/stories").name).toBe("not_found");
    expect(match("/stories/ideas").name).toBe("not_found");
  });

  it("parses every /stories page once switched on, and Lamo Clips paths never change", () => {
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
    for (const path of ["/stories", "/stories/ideas", "/stories/characters/new", "/stories/production/new?idea=ab1", "/stories/library?kind=final_video&story=s1"]) {
      const [p, q = ""] = path.split("?");
      expect(storiesHref(matchStories(p!, q ? `?${q}` : ""))).toBe(path);
    }
    expect(matchStories("/stories/nope", "").name).toBe("not_found");
  });
});
