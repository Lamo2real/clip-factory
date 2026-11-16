import { describe, expect, it } from "vitest";
import { match } from "../src/lib/router.ts";
import {
  appleCount,
  findApple,
  legacySettingsRedirect,
  searchSettings,
  settingsPath,
  TREES,
  visibleTrees,
} from "../src/lib/settingsTree.ts";
import { BRANCH_ROUTES } from "../src/screens/settings/Settings.tsx";
import { titleFor } from "../src/app/App.tsx";

describe("the settings tree", () => {
  it("has the four trees and eleven branches of §15.1, in order", () => {
    expect(TREES.map((t) => t.slug)).toEqual(["clip-making", "posting", "look-and-feel", "app"]);
    expect(TREES.map((t) => t.branches.map((b) => b.slug))).toEqual([
      ["clips", "skills", "youtube"],
      ["accounts", "where"],
      ["sounds", "motion", "background"],
      ["get-the-app", "updates", "account"],
    ]);
  });

  it("every apple has a unique id, a name and one short leaf", () => {
    const ids = TREES.flatMap((t) => t.branches.flatMap((b) => b.apples.map((a) => a.id)));
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TREES)
      for (const b of t.branches) {
        expect(b.apples.length).toBeGreaterThan(0);
        for (const a of b.apples) {
          expect(a.name.trim()).not.toBe("");
          // One short line; the Add a skill leaf is the contract's own words (§18.7), 103 letters.
          expect(a.leaf.length).toBeLessThanOrEqual(110);
          expect(a.leaf).toMatch(/\.$/);
        }
      }
  });

  it("the Sounds branch has Sounds, Click sound, Error sound and Try it", () => {
    const sounds = TREES[2]!.branches[0]!;
    expect(sounds.apples.map((a) => a.name)).toEqual(["Sounds", "Click sound", "Error sound", "Try it"]);
  });

  it("the Skills branch has Your skills, then Add a skill, with no switch words (§18.7)", () => {
    const skills = TREES[0]!.branches[1]!;
    expect(skills.apples.map((a) => a.id)).toEqual(["your-skills", "add-skill"]);
    expect(skills.apples[0]!.leaf).toBe("Clip Factory uses every skill here, every time it makes or checks anything.");
    expect(JSON.stringify(skills)).not.toMatch(/switch|turn off/i);
  });

  it("hides Get the app once the app is installed", () => {
    const app = (installed: boolean) => visibleTrees(installed).find((t) => t.slug === "app")!;
    expect(app(false).branches.map((b) => b.slug)).toContain("get-the-app");
    expect(app(true).branches.map((b) => b.slug)).not.toContain("get-the-app");
    expect(appleCount(app(true))).toBe(appleCount(app(false)) - 1);
  });
});

describe("routes", () => {
  it("every branch has a page, and every page is a branch", () => {
    const all = TREES.flatMap((t) => t.branches.map((b) => `${t.slug}/${b.slug}`));
    expect([...BRANCH_ROUTES].sort()).toEqual([...all].sort());
  });

  it("the router knows every tree and branch, and nothing else", () => {
    expect(match("/settings")).toEqual({ name: "settings", tree: null, branch: null });
    expect(match("/settings/")).toEqual({ name: "settings", tree: null, branch: null });
    for (const t of TREES) {
      expect(match(settingsPath(t.slug))).toEqual({ name: "settings", tree: t.slug, branch: null });
      for (const b of t.branches) expect(match(settingsPath(t.slug, b.slug))).toEqual({ name: "settings", tree: t.slug, branch: b.slug });
    }
    expect(match("/settings/nope")).toEqual({ name: "not_found" });
    expect(match("/settings/look-and-feel/nope")).toEqual({ name: "not_found" });
    expect(match("/settings/posting/sounds")).toEqual({ name: "not_found" });
    expect(match("/settings/a/b/c")).toEqual({ name: "not_found" });
    expect(match("/get-app")).toEqual({ name: "get_app" });
  });

  it("builds paths with an optional apple anchor", () => {
    expect(settingsPath()).toBe("/settings");
    expect(settingsPath("look-and-feel")).toBe("/settings/look-and-feel");
    expect(settingsPath("look-and-feel", "sounds", "click-sound")).toBe("/settings/look-and-feel/sounds#click-sound");
  });

  it("titles say where you are", () => {
    expect(titleFor({ name: "settings", tree: null, branch: null })).toBe("Settings");
    expect(titleFor({ name: "settings", tree: "look-and-feel", branch: null })).toBe("Look & feel · Settings");
    expect(titleFor({ name: "settings", tree: "look-and-feel", branch: "sounds" })).toBe("Sounds · Settings");
  });
});

describe("old links", () => {
  it("send the one-page anchors to their branch", () => {
    const go = (hash: string, search = "") => legacySettingsRedirect("/settings", search, hash);
    expect(go("#skills")).toBe("/settings/clip-making/skills");
    expect(go("#clips")).toBe("/settings/clip-making/clips");
    expect(go("#accounts")).toBe("/settings/posting/accounts");
    expect(go("#appearance")).toBe("/settings/look-and-feel");
    expect(go("#app")).toBe("/settings/app");
    expect(go("#get-app")).toBe("/settings/app/get-the-app");
    expect(go("#click-sound")).toBe("/settings/look-and-feel/sounds#click-sound");
    expect(go("#skills", "?update=1")).toBe("/settings/clip-making/skills?update=1");
    expect(go("#nothing-here")).toBeNull();
    expect(go("")).toBeNull();
  });

  it("send the hooks API's coming-soon return to Accounts, keeping the query", () => {
    expect(legacySettingsRedirect("/settings", "?account=instagram&status=coming_soon", "")).toBe(
      "/settings/posting/accounts?account=instagram&status=coming_soon",
    );
  });

  it("leave every other page alone", () => {
    expect(legacySettingsRedirect("/settings/look-and-feel/sounds", "", "#click-sound")).toBeNull();
    expect(legacySettingsRedirect("/", "", "#skills")).toBeNull();
  });
});

describe("Find a setting", () => {
  const names = (q: string, installed = false) => searchSettings(q, installed).map((h) => h.apple.name);

  it("finds apples by name, best match first", () => {
    expect(names("click sound")[0]).toBe("Click sound");
    expect(names("error")[0]).toBe("Error sound");
    expect(names("Sign OUT")[0]).toBe("Sign out");
    expect(names("skill")).toEqual(expect.arrayContaining(["Add a skill", "Your skills"]));
    expect(names("write a skill")[0]).toBe("Add a skill");
    expect(names("always used")[0]).toBe("Your skills");
  });

  it("finds apples by their leaf, and says so", () => {
    const hits = searchSettings("scroll");
    expect(hits.map((h) => h.apple.id)).toContain("sounds-on");
    expect(hits.find((h) => h.apple.id === "sounds-on")!.found).toBe("leaf");
    expect(searchSettings("confetti")[0]!.apple.id).toBe("reduce-motion");
    expect(searchSettings("wallpaper")[0]!.apple.id).toBe("background-picture");
  });

  it("links straight to the apple", () => {
    const hit = searchSettings("click sound")[0]!;
    expect(hit.href).toBe("/settings/look-and-feel/sounds#click-sound");
    expect(hit.found).toBe("apple");
    expect(findApple(hit.apple.id)?.branch.slug).toBe("sounds");
  });

  it("needs every word, ignores case, accents and apostrophes", () => {
    expect(names("CAN'T")).toContain("Error sound");
    expect(names("sóund")).toContain("Click sound");
    expect(names("sound zebra")).toEqual([]);
    expect(names("   ")).toEqual([]);
    expect(names("look & feel").length).toBeGreaterThan(0);
  });

  it("the app's own name in a help line is not a match", () => {
    const clip = names("clip");
    expect(clip).not.toContain("Sign out");
    expect(clip).not.toContain("Get the app");
    expect(clip).toEqual(expect.arrayContaining(["How many clips", "Longest video", "Post kept clips to"]));
    expect(names("factory")).toEqual([]);
    expect(names("clip factory")).toEqual([]);
  });

  it("leaves out Get the app once installed", () => {
    expect(names("install")).toContain("Get the app");
    expect(names("install", true)).not.toContain("Get the app");
  });
});
