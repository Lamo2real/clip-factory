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
  it("has the four trees and eighteen branches of §15.1, §16.12, §21, §24, §28, §32, §36 and §40, in order", () => {
    expect(TREES.map((t) => t.slug)).toEqual(["clip-making", "posting", "look-and-feel", "app"]);
    expect(TREES.map((t) => t.branches.map((b) => b.slug))).toEqual([
      ["clips", "skills", "learned", "streamers", "youtube"],
      ["setup", "getpaid", "where", "my-settings", "money"],
      ["sounds", "motion", "background"],
      ["get-the-app", "notifications", "updates", "ask", "account"],
    ]);
  });

  it("§32: App & account › Notifications has this device, the choices, the badge, the lock screen and a test", () => {
    const n = TREES.find((t) => t.slug === "app")!.branches.find((b) => b.slug === "notifications")!;
    expect(n.apples.map((a) => a.id)).toEqual([
      "notify-device",
      "notify-ready",
      "notify-stopped",
      "notify-resumed",
      "notify-steps",
      "notify-contentrewards",
      "notify-getpaid",
      "notify-badge",
      "notify-lock-screen",
      "notify-test",
    ]);
    expect(searchSettings("widget").map((h) => h.apple.id)).toContain("notify-lock-screen");
    expect(searchSettings("notifications").map((h) => h.apple.id)).toContain("notify-device");
  });

  it("§28: App & account › Ask has Web search and What Ask can do, with their data-help anchors", () => {
    const ask = TREES.find((t) => t.slug === "app")!.branches.find((b) => b.slug === "ask")!;
    expect(ask.apples.map((a) => a.id)).toEqual(["ask-web-setup", "ask-status"]);
    expect(searchSettings("search key").map((h) => h.apple.id)).toContain("ask-web-setup");
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
    expect(go("#accounts")).toBe("/settings/posting/setup");
    expect(go("#appearance")).toBe("/settings/look-and-feel");
    expect(go("#app")).toBe("/settings/app");
    expect(go("#get-app")).toBe("/settings/app/get-the-app");
    expect(go("#click-sound")).toBe("/settings/look-and-feel/sounds#click-sound");
    expect(go("#skills", "?update=1")).toBe("/settings/clip-making/skills?update=1");
    expect(go("#nothing-here")).toBeNull();
    expect(go("")).toBeNull();
  });

  it("send Accounts and the old hooks API returns to Set up posting (§17.1)", () => {
    expect(legacySettingsRedirect("/settings", "?account=instagram&status=coming_soon", "")).toBe("/settings/posting/setup/instagram");
    expect(legacySettingsRedirect("/settings/posting/accounts", "?account=x&status=coming_soon", "")).toBe("/settings/posting/setup/x");
    expect(legacySettingsRedirect("/settings", "?account=myspace&status=coming_soon", "")).toBe("/settings/posting/setup");
    expect(legacySettingsRedirect("/settings/posting/accounts", "", "")).toBe("/settings/posting/setup");
    expect(legacySettingsRedirect("/settings/posting/accounts/", "", "#accounts")).toBe("/settings/posting/setup");
  });

  it("send the setup apples to their platform page", () => {
    expect(legacySettingsRedirect("/settings", "", "#youtube-privacy")).toBe("/settings/posting/setup/youtube#youtube-privacy");
    expect(searchSettings("unlisted")[0]!.href).toBe("/settings/posting/setup/youtube#youtube-privacy");
    expect(searchSettings("credits")[0]!.href).toBe("/settings/posting/setup/x#x-cost");
    expect(searchSettings("connect tiktok")[0]!.href).toBe("/settings/posting/setup#setup-posting");
    // §25.7: "tiktok" alone also finds TikTok's money card, and Set up posting is still in the list.
    const tiktok = searchSettings("tiktok").map((h) => h.href);
    expect(tiktok).toContain("/settings/posting/money#money-tiktok");
    expect(tiktok).toContain("/settings/posting/setup#setup-posting");
  });

  it("§40: Posting › Get paid has its apple, and Money's payouts apple links there", () => {
    const posting = TREES.find((t) => t.slug === "posting")!;
    const gp = posting.branches.find((b) => b.slug === "getpaid")!;
    expect(gp.name).toBe("Get paid");
    expect(gp.line).toBe("Set up how each app pays you. See if money can reach you.");
    expect(gp.icon).toBe("coin");
    expect(gp.apples.map((a) => [a.id, a.name, a.leaf])).toEqual([["getpaid", "Get paid", "One card per place. Do the steps once so money can reach you."]]);
    for (const w of ["get paid", "payout", "payouts", "bank", "bank account", "paypal", "stripe", "adsense", "whop", "tax", "money on hold", "withdraw", "cash out"]) expect(gp.apples[0]!.words).toContain(w);
    const payouts = findApple("money-payouts")!.apple;
    expect(payouts.leaf).toBe("Each app pays you itself. Get paid shows the steps for each one.");
    expect(payouts.href).toBe("/settings/posting/getpaid");
    expect(searchSettings("cash out").map((h) => h.href)).toContain("/settings/posting/getpaid#getpaid");
    expect(match("/settings/posting/getpaid")).toEqual({ name: "settings", tree: "posting", branch: "getpaid" });
    expect(titleFor({ name: "settings", tree: "posting", branch: "getpaid" })).toBe("Get paid · Settings");
  });

  it("§40: route each Get paid place page, and nothing else under it", () => {
    for (const place of ["youtube", "tiktok", "instagram", "facebook", "x", "contentrewards"] as const) {
      expect(match(`/settings/posting/getpaid/${place}`)).toEqual({ name: "getpaid", place });
      expect(match(`/settings/posting/getpaid/${place}/`)).toEqual({ name: "getpaid", place });
    }
    expect(match("/settings/posting/getpaid/myspace")).toEqual({ name: "not_found" });
    expect(match("/settings/posting/getpaid/youtube/x")).toEqual({ name: "not_found" });
    expect(titleFor({ name: "getpaid", place: "youtube" })).toBe("YouTube · Get paid · Settings");
    expect(titleFor({ name: "getpaid", place: "contentrewards" })).toBe("Content Rewards · Get paid · Settings");
  });

  it("route each platform's setup page, and nothing else under it", () => {
    expect(match("/settings/posting/setup/youtube")).toEqual({ name: "settings", tree: "posting", branch: "setup", platform: "youtube" });
    expect(match("/settings/posting/setup/x/")).toEqual({ name: "settings", tree: "posting", branch: "setup", platform: "x" });
    expect(match("/settings/posting/setup")).toEqual({ name: "settings", tree: "posting", branch: "setup" });
    expect(match("/settings/posting/setup/myspace")).toEqual({ name: "not_found" });
    expect(match("/settings/posting/accounts")).toEqual({ name: "not_found" });
    expect(titleFor({ name: "settings", tree: "posting", branch: "setup", platform: "tiktok" })).toBe("TikTok setup · Settings");
    // The pretend consent page exists only in mock builds.
    expect(match("/mock-oauth/youtube")).toEqual({ name: "not_found" });
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
    expect(clip).toEqual(expect.arrayContaining(["How many clips", "Longest video", "Upload clips to"]));
    expect(names("factory")).toEqual([]);
    expect(names("clip factory")).toEqual([]);
  });

  it("leaves out Get the app once installed", () => {
    expect(names("install")).toContain("Get the app");
    expect(names("install", true)).not.toContain("Get the app");
  });
});
