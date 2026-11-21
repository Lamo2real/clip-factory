// Get paid's guides (docs/CONTRACTS.md §40.1, §40.8 tests): the step ids and roles are the server's (getpaid_steps.json
// when K's file is there), every step is kid-proof (≤ 6-word titles, ≤ 26-word lines, exact https Opens, bold only for
// the other site's own labels), the YouTube Copy chip is platforms.json's paymentScopes, and the facts follow his
// country. §40.8 change 14: Content Rewards' bank step gains exactly its two hints.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADSENSE_SCOPE, CR_GETPAID, drawnSteps, factsFor, GETPAID_GUIDES, GETPAID_ORDER, getPaidTime, numberedSteps, rulesLabel, stepNumber } from "../src/getpaid/index.ts";
import type { GetPaidGuide, GetPaidStep } from "../src/getpaid/types.ts";
import { CR_GUIDE, crPart } from "../src/setup/contentrewards.ts";

const REPO = join(import.meta.dirname, "..", "..");
const STEPS_FILE = join(REPO, "api", "tests", "fixtures", "getpaid_steps.json");
const PLATFORMS_FILE = join(REPO, "config", "platforms.json");
const guides = Object.values(GETPAID_GUIDES);
const words = (t: string) => t.trim().split(/\s+/).length;
/** Our own words: the other site's **bold** labels taken out. */
const ours = (t: string) => t.replace(/\*\*[^*]+\*\*/g, "");
const texts = (s: GetPaidStep) => [s.title, ...s.say, s.lead ?? "", s.when ?? "", ...(s.ifYouSee ?? []).flatMap((h) => [h.see, h.do])];

/** Reads K's file in any of the plain shapes it may take: {place: {id: role}}, {place: [{id, role}]}, [{place, id, role}]. */
function serverSteps(raw: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (place: string, id: string, role: string) => out.set(place, [...(out.get(place) ?? []), `${id}:${role}`]);
  const body = raw && typeof raw === "object" && "steps" in (raw as object) ? (raw as { steps: unknown }).steps : raw;
  if (Array.isArray(body)) for (const r of body as { place: string; id: string; role: string }[]) add(r.place, r.id, r.role);
  else if (body && typeof body === "object")
    for (const [place, v] of Object.entries(body as Record<string, unknown>)) {
      if (Array.isArray(v)) for (const r of v as { id: string; role: string }[]) add(place, r.id, r.role);
      else if (v && typeof v === "object")
        for (const [k, role] of Object.entries(v as Record<string, unknown>)) {
          if (Array.isArray(role)) for (const id of role as string[]) add(place, id, k);
          else add(place, k, String(role));
        }
    }
  for (const [k, v] of out) out.set(k, v.sort());
  return out;
}

describe("the guides' ids and roles (§40.1–§40.2)", () => {
  it("have exactly the contract's steps, in order", () => {
    const shape = (g: GetPaidGuide) => g.steps.map((s) => `${s.id}:${s.role}`);
    expect(shape(GETPAID_GUIDES.youtube)).toEqual(["yt-join:earn", "yt-reading:reading", "yt-tax:payout", "yt-bank:payout", "yt-test:payout", "yt-id:payout", "yt-pin:payout"]);
    expect(shape(GETPAID_GUIDES.tiktok)).toEqual(["tt-gifts:earn", "tt-payout:payout", "tt-withdraw:each_time"]);
    expect(shape(GETPAID_GUIDES.instagram)).toEqual(["ig-gifts:earn", "meta-payout:payout"]);
    expect(shape(GETPAID_GUIDES.facebook)).toEqual(["fb-join:earn", "meta-payout:payout"]);
    expect(shape(GETPAID_GUIDES.x)).toEqual(["x-premium:earn", "x-apply:earn", "x-stripe:payout"]);
    expect(GETPAID_ORDER).toEqual(["youtube", "tiktok", "instagram", "facebook", "x", "contentrewards"]);
  });

  it.skipIf(!existsSync(STEPS_FILE))("equal the server's STEPS (api/tests/fixtures/getpaid_steps.json)", () => {
    const server = serverSteps(JSON.parse(readFileSync(STEPS_FILE, "utf8")));
    for (const g of guides) {
      const want = server.get(g.place);
      expect(want, g.place).toBeDefined();
      const roles = new Set(want!.map((x) => x.split(":")[1]));
      const mine = g.steps.filter((s) => roles.has(s.role)).map((s) => `${s.id}:${s.role}`).sort();
      expect(mine, g.place).toEqual(want);
    }
  });

  it("ids are unique per guide and match the API's pattern; meta-payout is one shared tick", () => {
    for (const g of guides) {
      const ids = g.steps.map((s) => s.id);
      expect(new Set(ids).size, g.place).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^[a-z0-9-]{1,40}$/);
    }
    for (const p of ["instagram", "facebook"] as const) expect(GETPAID_GUIDES[p].steps.find((s) => s.id === "meta-payout")!.shared).toBe("meta");
    expect(GETPAID_GUIDES.instagram.steps.find((s) => s.id === "meta-payout")!.phone).toBe(true);
    expect(GETPAID_GUIDES.facebook.steps.find((s) => s.id === "meta-payout")!.phone).toBeUndefined();
  });

  it("the ring counts only numbered earn and payout steps; the reading step is Optional, right after step 1", () => {
    const yt = GETPAID_GUIDES.youtube;
    expect(numberedSteps(yt).map((s) => s.id)).not.toContain("yt-reading");
    expect(numberedSteps(yt)).toHaveLength(6);
    expect(stepNumber(yt, "yt-reading")).toBeNull();
    expect(stepNumber(yt, "yt-bank")).toBe(3);
    expect(drawnSteps(yt).map((s) => s.id).slice(0, 3)).toEqual(["yt-join", "yt-reading", "yt-tax"]);
    expect(stepNumber(GETPAID_GUIDES.tiktok, "tt-withdraw")).toBeNull();
    const reading = yt.steps.find((s) => s.id === "yt-reading")!;
    expect(reading.manual).toBe(false);
    expect(reading.action).toBe("allow_payment_reading");
    expect(reading.auto).toBe("payment_reading");
  });

  it("autos, the paid step and the phone steps", () => {
    const auto = (g: GetPaidGuide) => Object.fromEntries(g.steps.filter((s) => s.auto).map((s) => [s.id, s.auto]));
    expect(auto(GETPAID_GUIDES.youtube)).toEqual({ "yt-join": "in_program", "yt-reading": "payment_reading", "yt-tax": "sent", "yt-bank": "sent", "yt-test": "sent", "yt-id": "sent", "yt-pin": "sent" });
    expect(auto(GETPAID_GUIDES.x)).toEqual({ "x-premium": "premium" });
    expect(guides.flatMap((g) => g.steps.filter((s) => s.paid).map((s) => s.id))).toEqual(["x-premium"]);
    expect(GETPAID_GUIDES.tiktok.steps.every((s) => s.phone)).toBe(true);
    expect(GETPAID_GUIDES.instagram.steps.every((s) => s.phone)).toBe(true);
    expect(GETPAID_GUIDES.youtube.steps.some((s) => s.phone)).toBe(false);
    const labels = Object.fromEntries(guides.flatMap((g) => g.steps.filter((s) => s.doneLabel).map((s) => [s.id, s.doneLabel])));
    expect(labels).toEqual({ "yt-join": "I'm in", "tt-gifts": "I turned it on", "ig-gifts": "I turned it on", "fb-join": "I joined", "x-premium": "I have Premium", "x-apply": "X said yes" });
  });
});

describe("kid-proof words (§40.1, §38.1)", () => {
  it("titles are six words or fewer, lines 26 words or fewer", () => {
    for (const g of guides)
      for (const s of g.steps) {
        expect(words(s.title), s.title).toBeLessThanOrEqual(6);
        for (const l of [...s.say, s.lead ?? "", s.when ?? ""].filter(Boolean)) expect(words(l), l).toBeLessThanOrEqual(26);
        for (const h of s.ifYouSee ?? []) expect(words(h.do), h.do).toBeLessThanOrEqual(26);
      }
  });

  it("every Open is an exact https page; every fact names an official https page", () => {
    const hosts = /^(studio\.youtube\.com|adsense\.google\.com|console\.cloud\.google\.com|www\.tiktok\.com|www\.instagram\.com|business\.facebook\.com|creators\.facebook\.com|x\.com|connect\.stripe\.com)$/;
    for (const g of guides) {
      for (const s of g.steps)
        for (const o of [s.open, ...(s.more ?? []), ...(s.ifYouSee ?? []).map((h) => h.open)].filter(Boolean)) {
          const u = new URL(o!.url);
          expect(u.protocol, o!.url).toBe("https:");
          expect(hosts.test(u.hostname), o!.url).toBe(true);
        }
      if (g.eachTime?.open) expect(g.eachTime.open.url).toBe("https://connect.stripe.com/express_login");
      for (const f of g.facts) expect(new URL(f.source).protocol).toBe("https:");
    }
    expect(GETPAID_GUIDES.youtube.steps[0]!.open!.url).toBe("https://studio.youtube.com/channel/UC/monetization");
    expect(GETPAID_GUIDES.x.steps.find((s) => s.id === "x-apply")!.open!.url).toBe("https://x.com/i/jf/creators/studio");
    for (const f of CR_GETPAID.facts) expect(new URL(f.source).protocol).toBe("https:");
  });

  it("bold is only the other site's labels: never Clip Factory's own buttons or answers", () => {
    const ownButtons = ["I did this", "Allow payment reading", "I'm in", "I turned it on", "I joined", "I have Premium", "X said yes", "Not done yet", "Check now"];
    for (const g of guides)
      for (const s of g.steps)
        for (const t of texts(s)) for (const m of t.matchAll(/\*\*([^*]+)\*\*/g)) expect(ownButtons, `${s.id}: ${t}`).not.toContain(m[1]);
  });

  it("our own words never say KYC, EFT, OAuth, token, scope, API, Client ID, tax treaty, payout account, Live or disconnected", () => {
    const banned = /\b(kyc|eft|oauth|tokens?|scopes?|api|client id|tax treaty|payout account|disconnected|not connected|verified ✓)\b/i;
    for (const g of guides)
      for (const s of g.steps) for (const t of texts(s)) expect(banned.test(ours(t)), `${s.id}: ${t}`).toBe(false);
    for (const g of guides) for (const s of g.steps) for (const t of texts(s)) expect(/\bLive\b/.test(ours(t)), `${s.id}: ${t}`).toBe(false);
  });

  it("AdSense is always AdSense for YouTube (the button Turn on AdSense reading and the AdSense website aside)", () => {
    const ok = /AdSense for YouTube|Turn on AdSense reading|the AdSense website|the AdSense card/g;
    for (const g of guides)
      for (const s of g.steps)
        for (const t of [...texts(s), s.open?.label ?? "", ...(s.more ?? []).map((m) => m.label)]) expect(ours(t).replace(ok, "").includes("AdSense"), `${s.id}: ${t}`).toBe(false);
    for (const f of GETPAID_GUIDES.youtube.facts) expect(f.text.replace(ok, "").includes("AdSense"), f.text).toBe(false);
    expect(GETPAID_GUIDES.youtube.facts[0]!.text).toBe("AdSense for YouTube is Google's page that pays you.");
  });

  it("the steps nobody saw say the site may show them a little differently", () => {
    const say = (g: GetPaidGuide, id: string) => g.steps.find((s) => s.id === id)!.say.join(" ");
    expect(say(GETPAID_GUIDES.youtube, "yt-tax")).toContain("Google may show this a little differently.");
    expect(say(GETPAID_GUIDES.tiktok, "tt-payout")).toContain("TikTok may show this a little differently.");
    expect(say(GETPAID_GUIDES.instagram, "meta-payout")).toContain("Meta may show this a little differently.");
    expect(say(GETPAID_GUIDES.x, "x-stripe")).toContain("X may show this a little differently.");
  });
});

describe("the YouTube permission and the facts", () => {
  it("the Copy chip is platforms.json's paymentScopes (or adsense.readonly before K adds it)", () => {
    const cfg = existsSync(PLATFORMS_FILE) ? (JSON.parse(readFileSync(PLATFORMS_FILE, "utf8")) as { platforms?: Record<string, { paymentScopes?: string[] }> } & Record<string, { paymentScopes?: string[] }>) : null;
    const yt = cfg?.platforms?.youtube ?? cfg?.youtube;
    const want = yt?.paymentScopes?.[0] ?? "https://www.googleapis.com/auth/adsense.readonly";
    const chip = GETPAID_GUIDES.youtube.steps.find((s) => s.id === "yt-reading")!.copy!;
    expect(chip).toEqual([{ label: "Permission", value: want }]);
    expect(ADSENSE_SCOPE).toBe(want);
  });

  it("facts follow his country: Sweden's only for SE; with none picked, only the ones that hold everywhere", () => {
    const yt = GETPAID_GUIDES.youtube.facts;
    expect(factsFor(yt, "SE").map((f) => f.text)).toContain("YouTube pays in kronor, straight to your bank. Not PayPal.");
    expect(factsFor(yt, "US").map((f) => f.text)).not.toContain("YouTube pays in kronor, straight to your bank. Not PayPal.");
    expect(factsFor(yt, null).every((f) => !f.countries)).toBe(true);
    expect(factsFor(GETPAID_GUIDES.tiktok.facts, "SE")[0]!.text).toMatch(/^Creator Rewards isn't open in Sweden\./);
    expect(factsFor(GETPAID_GUIDES.facebook.facts, "DE").map((f) => f.text)).toContain("Paying for no ads, or picking less personal ads, stops a profile from earning with Content Monetization.");
    expect(factsFor(GETPAID_GUIDES.facebook.facts, "US").map((f) => f.text)).not.toContain("Paying for no ads, or picking less personal ads, stops a profile from earning with Content Monetization.");
    expect(rulesLabel("youtube", yt[0]!.source)).toBe("Read YouTube's rules");
    expect(rulesLabel("contentrewards", CR_GETPAID.facts[1]!.source)).toBe("Read Content Rewards' rules");
    expect(getPaidTime("x")).toBe("About 15 minutes · X Premium costs money");
    expect(getPaidTime("youtube")).toBe("About 30 minutes over a few weeks · Free");
  });

  it("X's guide warns that it probably won't pay for Clip Factory clips, first thing on its paid step", () => {
    expect(GETPAID_GUIDES.x.steps[0]!.say[0]).toBe("X probably won't pay for Clip Factory clips. Only buy Premium if you also post your own videos.");
  });
});

describe("§40.8 change 14: Content Rewards' money steps", () => {
  it("bank-setup gains exactly the two hints; no other word of §38.7 changes", () => {
    const bank = crPart("bank").steps.find((s) => s.id === "bank-setup")!;
    expect(bank.ifYouSee).toEqual([
      { see: "**Set up Whop Payments**", do: "Tap it. Pick Sweden." },
      { see: "that Whop asks about tax for a business (VAT)", do: "Tap **Settings**, then **Tax**, then **No, my business is not registered**. Don't type your personal number." },
    ]);
    expect(bank.title).toBe("Add your bank on Whop");
    expect(CR_GUIDE.parts.map((p) => p.id)).toEqual(["setup", "join", "move", "bank"]);
  });
});
