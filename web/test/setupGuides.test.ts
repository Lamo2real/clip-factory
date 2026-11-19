import { describe, expect, it } from "vitest";
import type { Platform } from "../src/api/types.ts";
import {
  allSteps,
  checkedOnText,
  GUIDES,
  RESULT_CODES,
  resolveValue,
  resultCopy,
  resultStep,
  SETUP_ORDER,
  stepNumber,
  TIKTOK_REVIEW_TEXT,
  VALUE_REFS,
  type GuideStep,
} from "../src/setup/index.ts";
import { MOCK_VALUES } from "../src/api/mock/setup.ts";
import { KEY_FORMATS } from "../src/lib/keyFormats.ts";

// The step ids and titles are the content contract of docs/CONTRACTS.md §17.2: they may not drift.
const CONTRACT: Record<Platform, [string, string][]> = {
  youtube: [
    ["ready-channel", "Have a YouTube channel"],
    ["ready-computer", "Use a computer"],
    ["key-console", "Open Google Cloud"],
    ["key-project", "Make a project"],
    ["key-data-api", "Turn on YouTube Data API v3"],
    ["key-analytics-api", "Turn on YouTube Analytics API"],
    ["key-get-started", "Start Google Auth Platform"],
    ["key-branding", "Fill in Branding"],
    ["key-scopes", "Add the 3 permissions"],
    ["key-publish", "Publish the app"],
    ["key-client", "Make the key"],
    ["key-paste", "Paste the key here"],
    ["connect", "Connect YouTube"],
    ["public-privacy", "Pick who can see your clips"],
    ["public-keep-alive", "Post at least every 6 months"],
    ["public-quota", "Only if you post over 100 a day"],
  ],
  tiktok: [
    ["ready-account", "Have your TikTok account"],
    ["ready-computer", "Use a computer"],
    ["ready-private", "Make your TikTok private for now"],
    ["key-signup", "Make a TikTok developer account"],
    ["key-org", "Make an organization"],
    ["key-app", "Create the app"],
    ["key-details", "Fill in App details"],
    ["key-web", "Choose Web"],
    ["key-products", "Add 2 products"],
    ["key-redirect", "Paste the return address"],
    ["key-direct-post", "Turn on Direct Post"],
    ["key-scopes", "Add 2 permissions"],
    ["key-review", "Fill in App review, then Save"],
    ["key-verify", "Prove the website is yours"],
    ["key-paste", "Paste Client key and secret"],
    ["sandbox-make", "Make a Sandbox for testing"],
    ["sandbox-user", "Add yourself as a test user"],
    ["sandbox-verify", "Verify the website in Sandbox too"],
    ["sandbox-keys", "Use the Sandbox keys"],
    ["connect", "Connect TikTok"],
    ["public-demo", "Record the real demo video"],
    ["public-review", "Ask TikTok to check the app"],
    ["public-live-keys", "When it says Live"],
    ["public-audit", "Ask to post publicly"],
    ["public-unprivate", "Make your account public again"],
  ],
  instagram: [
    ["ready-pro", "Make Instagram a pro account"],
    ["ready-page", "Link Instagram to a Facebook Page"],
    ["ready-computer", "Use a computer"],
    ["ready-portfolio", "Make a business portfolio"],
    ["key-developer", "Become a Meta developer"],
    ["key-app", "Create the app"],
    ["key-basic", "Fill in Basic settings"],
    ["key-config", "Make the Instagram login setup"],
    ["key-redirect-check", "Double-check the return address"],
    ["key-paste", "Paste the 3 values"],
    ["connect", "Connect Instagram"],
    ["public-try", "Post one test clip"],
  ],
  facebook: [
    ["ready-page", "Have a Facebook Page"],
    ["ready-computer", "Use a computer"],
    ["key-developer", "Turn on Meta for developers"],
    ["key-app", "Create the app"],
    ["key-use-case", "Pick one use case"],
    ["key-finish-app", "Finish the app"],
    ["key-permissions", "Turn on Page permissions"],
    ["key-basic", "Fill in Basic settings"],
    ["key-redirect", "Paste the return address"],
    ["key-config", "Make a login configuration"],
    ["key-paste", "Paste the 3 values"],
    ["connect", "Connect Facebook"],
    ["public-live", "Make the app Live"],
  ],
  x: [
    ["ready-account", "Use the X account your clips go on"],
    ["ready-computer", "Use a computer"],
    ["ready-card", "Ask a grown-up for a card"],
    ["key-console", "Sign in to the X Developer Console"],
    ["key-credits", "Buy a few credits"],
    ["key-app", "Create the app"],
    ["key-auth-settings", "Open the sign-in settings"],
    ["key-permissions", "Pick Read and write"],
    ["key-addresses", "Paste the addresses"],
    ["key-paste", "Paste Client ID and Secret"],
    ["connect", "Connect X"],
    ["public-credits", "Keep a few credits"],
  ],
};

const steps = (p: Platform): GuideStep[] => allSteps(GUIDES[p]);

describe("the five setup guides (§17.2)", () => {
  it("are in SETUP_ORDER and checked on 16 Nov 2026 (TikTok on 19 Nov 2026)", () => {
    expect(SETUP_ORDER).toEqual(["youtube", "tiktok", "instagram", "facebook", "x"]);
    for (const p of SETUP_ORDER) {
      expect(GUIDES[p].platform).toBe(p);
      expect(GUIDES[p].checkedOn).toBe(p === "tiktok" ? "2026-11-19" : "2026-11-16");
    }
    expect(checkedOnText(GUIDES.tiktok)).toBe("19 Nov 2026");
  });

  for (const p of SETUP_ORDER) {
    describe(p, () => {
      it("has exactly the contract's steps, ids and titles, in order", () => {
        expect(steps(p).map((s) => [s.id, s.title])).toEqual(CONTRACT[p]);
      });

      it("has unique step ids in the allowed shape", () => {
        const ids = steps(p).map((s) => s.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) expect(id).toMatch(/^[a-z0-9-]{1,40}$/);
      });

      it("has the four parts in order and exactly one Connect step", () => {
        expect(GUIDES[p].parts.map((x) => x.id)).toEqual(["ready", "key", "connect", "public"]);
        expect(GUIDES[p].parts[1]!.title).toBe(`Make your ${GUIDES[p].name} key`);
        const connect = steps(p).filter((s) => s.id === "connect");
        expect(connect).toHaveLength(1);
        expect(connect[0]!.auto).toBe("connected");
        expect(GUIDES[p].parts[2]!.steps.map((s) => s.id)).toContain("connect");
        expect(steps(p).some((s) => s.id === "ready-computer")).toBe(true);
      });

      it("opens only exact https pages, and only knows values Clip Factory has", () => {
        for (const s of steps(p)) {
          if (s.open) expect(new URL(s.open.url).protocol).toBe("https:");
          for (const c of s.copy ?? []) if (typeof c.value !== "string") expect(VALUE_REFS).toContain(c.value.ref);
          for (const c of s.copy ?? []) expect(resolveValue(c.value, p, MOCK_VALUES)).toBeTruthy();
        }
      });

      it("speaks in short lines, and every paste box exists for the platform", () => {
        for (const s of steps(p)) {
          expect(s.say.length, s.id).toBeGreaterThanOrEqual(1);
          expect(s.say.length, s.id).toBeLessThanOrEqual(4);
          for (const line of s.say) expect(line.split(/\s+/).length, `${s.id}: ${line}`).toBeLessThanOrEqual(26);
          for (const k of s.paste ?? []) expect(KEY_FORMATS[p][k], `${p} ${k}`).toBeDefined();
          // Bold marks come in pairs.
          for (const line of s.say) expect((line.match(/\*\*/g) ?? []).length % 2).toBe(0);
        }
        const paste = steps(p).find((s) => s.id === "key-paste")!;
        expect(paste.auto).toBe("keys");
        expect(paste.paste).toEqual(Object.keys(KEY_FORMATS[p]));
      });

      it("has a sentence for every connect result, naming real steps", () => {
        const copy = resultCopy(p);
        for (const code of RESULT_CODES) {
          expect(copy[code], code).toMatch(/[.!]$/);
          const nums = [...copy[code].matchAll(/steps? ([\d, and]+)/g)].flatMap((m) => m[1]!.match(/\d+/g) ?? []).map(Number);
          for (const n of nums) expect(n).toBeGreaterThanOrEqual(1);
          for (const n of nums) expect(n).toBeLessThanOrEqual(steps(p).length);
          const back = resultStep(p, code);
          if (back) expect(steps(p).map((s) => s.id)).toContain(back);
        }
      });
    });
  }

  it("words the YouTube results like the contract", () => {
    const yt = resultCopy("youtube");
    expect(yt.connected).toBe("YouTube is connected!");
    expect(yt.keys_wrong).toBe("The key does not work. Copy the Client ID and secret again (step 11).");
    expect(yt.redirect_wrong).toBe("The return address does not match. Copy it again in step 11.");
    expect(yt.no_channel).toBe("This Google account has no YouTube channel. Make one first (step 1).");
    expect(resultCopy("instagram").no_accounts).toBe("Instagram did not show a pro account. Do steps 1, 2 and 4, then connect again.");
    expect(resultCopy("facebook").no_pages).toBe("Facebook did not show a Page you control. Do step 1, then connect again.");
    expect(stepNumber(GUIDES.youtube, "key-client")).toBe(11);
  });

  it("asks for a grown-up and a card on X, and says TikTok may stay private", () => {
    expect(GUIDES.x.cost).toMatch(/Costs a little/);
    expect(steps("x").find((s) => s.id === "ready-card")!.say.join(" ")).toMatch(/grown-up/);
    expect(steps("tiktok").find((s) => s.id === "public-audit")!.say.join(" ")).toMatch(/stay private/);
  });

  it("walks TikTok's site as it really is: Save needs App review, Web only, no Display API", () => {
    const say = (id: string): string => steps("tiktok").find((s) => s.id === id)!.say.join(" ");
    // Save stays off until App review has its text and a video: the guide says so before Save, then fills it.
    expect(say("key-details")).toMatch(/Don't press \*\*Save\*\* yet/);
    expect(stepNumber(GUIDES.tiktok, "key-details")).toBeLessThan(stepNumber(GUIDES.tiktok, "key-review"));
    expect(say("key-details")).toContain(`step ${stepNumber(GUIDES.tiktok, "key-review")}`);
    expect(say("key-review")).toMatch(/text below/);
    expect(say("key-review")).toContain(`step ${stepNumber(GUIDES.tiktok, "public-demo")}`);
    expect(steps("tiktok").find((s) => s.id === "key-review")!.copy![0]!.value).toEqual({ ref: "tiktokReviewText" });
    expect(say("key-web")).toMatch(/\*\*Web\*\* only\. Not \*\*Desktop\*\*/);
    expect(steps("tiktok").find((s) => s.id === "key-products")!.say[1]).toBe("Add **Login Kit** and **Content Posting API**. Nothing else.");
    expect(say("key-products")).toMatch(/no \*\*Display API\*\* to add/);
    expect(say("key-scopes")).toMatch(/Add scopes/);
    for (const scope of ["user.info.basic", "video.publish", "video.list", "user.info.stats"]) expect(say("key-scopes")).toContain(scope);
    // The real demo shows the whole path TikTok's reviewers ask for.
    expect(say("public-demo")).toMatch(/Connect TikTok.*Authorize.*Keep.*arriving/);
    expect(say("sandbox-make")).toMatch(/Sandbox first.*private/);
  });

  it("explains every TikTok scope in the review text, one plain line each, matching what the app asks for", () => {
    const lines = TIKTOK_REVIEW_TEXT.split("\n");
    expect(lines.map((l) => l.split(/[ :]/)[0])).toEqual(["user.info.basic", "video.publish", "video.upload", "video.list", "user.info.stats"]);
    for (const line of lines) expect(line.split(/\s+/).length, line).toBeLessThanOrEqual(26);
    // Connect asks for these three (MOCK_VALUES mirrors the api); video.upload is never asked for, and says so.
    for (const scope of MOCK_VALUES.scopes.tiktok) expect(TIKTOK_REVIEW_TEXT).toContain(`${scope}`);
    expect(lines[2]).toMatch(/does not ask for it/);
    expect(resolveValue({ ref: "tiktokReviewText" }, "tiktok", null)).toBe(TIKTOK_REVIEW_TEXT);
  });

  it("copies the shared values the contract names", () => {
    expect(resolveValue({ ref: "appName" }, "youtube", MOCK_VALUES)).toBe("Clip Factory");
    expect(resolveValue({ ref: "appName" }, "facebook", MOCK_VALUES)).toBe("Clip Factory Pages");
    expect(resolveValue({ ref: "redirectUri" }, "x", MOCK_VALUES)).toBe(
      "https://hexample.execute-api.eu-north-1.amazonaws.com/v1/oauth/x/callback",
    );
    expect(resolveValue({ ref: "scopes" }, "youtube", MOCK_VALUES)!.split("\n")).toHaveLength(3);
    // Before GET /v1/setup answers, config.json's oauthCallbackBase gives the return address.
    expect(resolveValue({ ref: "redirectUri" }, "tiktok", null, "https://h.example/v1/oauth")).toBe("https://h.example/v1/oauth/tiktok/callback");
    expect(resolveValue({ ref: "privacyUrl" }, "tiktok", null)).toBeNull();
    expect(resolveValue({ ref: "dataDeletionUrl" }, "facebook", MOCK_VALUES)).toBe("https://dexample.cloudfront.net/legal/privacy.html#delete");
  });
});
