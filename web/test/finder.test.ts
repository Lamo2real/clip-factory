// lib/finder.ts (docs/CONTRACTS.md §41): the 404 / 503 rule, the debounced What you want saves, the `places: null`
// rule, `finderHref` (§41.6 change 2), the visit's frozen "New" set and "You're in!" rows, the words the web makes,
// and the mock's copy of the server's matching and words, checked against §41.3's golden cases.
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import type { Api, CampaignSummary, Finder, FinderWant, Platform, SetupOverview } from "../src/api/types.ts";

const current: Partial<Api> = {};
vi.mock("../src/api/index.ts", async (orig) => ({ ...(await orig<object>()), api: () => current as Api }));

const lib = await import("../src/lib/finder.ts");
const { CARDS, FINDER_IDS, find, checkWant } = await import("../src/api/mock/finder.ts");
const { findAnother, payLine } = await import("../src/lib/contentRewards.ts");

const {
  WANT_DEFAULTS,
  createWantSaver,
  entryLine,
  finderAvailability,
  finderHref,
  freezeNew,
  mergeAdded,
  newChipText,
  openedRecently,
  pickedPlaces,
  readyPlaces,
  stateLine,
  togglePlace,
  wantPlaces,
  wantSummary,
} = lib;

const BANNED = /\b(cpm|budget|api|mcp|scrape|sitemap|robots)\b/i;
const ours = (t: string) => t.replace(/\*\*[^*]+\*\*/g, "");
const words = (t: string) => ours(t).split(/\s+/).filter(Boolean).length;

const setup = (ready: Platform[], audited = false): SetupOverview =>
  ({
    platforms: (["youtube", "tiktok", "instagram", "facebook", "x"] as Platform[]).map((p) => ({
      platform: p,
      ready: ready.includes(p),
      stepsDone: [],
      keys: { saved: true },
      account: { platform: p, status: ready.includes(p) ? "connected" : "not_connected" },
      gates: p === "tiktok" ? [{ key: "posting_audit", state: audited ? "ok" : "limited" }] : [],
    })),
    ready: ready.length,
    values: {},
  }) as unknown as SetupOverview;

const finder = (over: Partial<Finder> = {}): Finder => ({
  state: "ok",
  want: { ...WANT_DEFAULTS },
  resolvedPlaces: ["youtube", "instagram"],
  tiktokWaits: true,
  matches: [],
  newCount: 0,
  hiddenCount: 0,
  skipped: [],
  looked: { campaigns: 154, pending: 0 },
  categories: [],
  signedIn: true,
  ...over,
});

describe("the 404 / 503 rule", () => {
  it("404 is an API before §41; 503 with any code is coming soon; anything else is an error", () => {
    expect(finderAvailability(new ApiError(404, "not_found", "x"))).toBe("missing");
    expect(finderAvailability(new ApiError(503, "unavailable", "x"))).toBe("soon");
    expect(finderAvailability(new ApiError(503, "internal", "x"))).toBe("soon");
    expect(finderAvailability(new ApiError(500, "internal", "x"))).toBe("error");
    expect(finderAvailability(new Error("network"))).toBe("error");
  });
});

describe("What you want", () => {
  it("the defaults literal is §41.3's", () => {
    expect(WANT_DEFAULTS).toEqual({ on: true, minPer1kCents: 100, places: null, categories: [], minLeftPct: 25, access: "open", otherPay: false, languages: [], tellMe: true });
  });

  it("changes within 500 ms go out as one PATCH; flush sends what waits", async () => {
    vi.useFakeTimers();
    const sent: Partial<FinderWant>[] = [];
    const s = createWantSaver(async (w) => void sent.push(w), 500);
    s.change({ minPer1kCents: 200 });
    await vi.advanceTimersByTimeAsync(300);
    s.change({ access: "any" });
    await vi.advanceTimersByTimeAsync(499);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([{ minPer1kCents: 200, access: "any" }]);
    s.change({ tellMe: false });
    expect(s.flush()).not.toBeNull();
    expect(sent.at(-1)).toEqual({ tellMe: false });
    expect(s.flush()).toBeNull();
    vi.useRealTimers();
  });

  it("places: null whenever the picked chips equal every ready place, else the list", () => {
    const ready: Platform[] = ["youtube", "instagram", "facebook", "x"];
    expect(wantPlaces(["x", "youtube", "facebook", "instagram"], ready)).toBeNull();
    expect(wantPlaces(["instagram", "youtube"], ready)).toEqual(["youtube", "instagram"]);
    expect(pickedPlaces({ places: null }, ready)).toEqual(ready);
    // A place that is no longer set up is never on.
    expect(pickedPlaces({ places: ["youtube", "tiktok"] }, ready)).toEqual(["youtube"]);
    expect(togglePlace(["youtube"], "youtube", ready)).toBeNull();
    expect(togglePlace(["youtube"], "x", ready)).toEqual(["youtube", "x"]);
  });

  it("TikTok is a ready place only once its audit passed; not set up is never ready", () => {
    expect(readyPlaces(setup(["youtube", "tiktok"]), true)).toEqual(["youtube"]);
    expect(readyPlaces(setup(["youtube", "tiktok"], true), false)).toEqual(["youtube", "tiktok"]);
    expect(readyPlaces(null, true)).toEqual([]);
  });

  it("the folded card's one line", () => {
    expect(wantSummary(WANT_DEFAULTS, ["youtube", "instagram"])).toBe("At least $1 per 1,000 views · YouTube, Instagram · At least a quarter of the money left · Open to join");
    expect(wantSummary({ ...WANT_DEFAULTS, minPer1kCents: 50, minLeftPct: 0, access: "any", categories: ["gaming"], languages: ["es"] }, ["x"], [{ id: "gaming", name: "Gaming" }])).toBe(
      "At least $0.50 per 1,000 views · X · Any money left · Also ones I apply to · Gaming · Spanish",
    );
  });
});

describe("§41.6 change 2: Find another campaign", () => {
  const DISCOVER = "https://contentrewards.com/c/discover";
  it("Discover becomes the Find page (same tab) only while the overview has finder", () => {
    expect(finderHref(DISCOVER, true)).toEqual({ href: "/campaigns/find", external: false });
    expect(finderHref(DISCOVER, false)).toEqual({ href: DISCOVER, external: true });
    expect(finderHref("https://contentrewards.com/c/campaigns/x", true).href).toBe("https://contentrewards.com/c/campaigns/x");
    expect(finderHref("/campaigns", true)).toEqual({ href: "/campaigns", external: false });
  });
  it("the server's words stay: the gate's Find another campaign is Discover", () => {
    expect(findAnother()).toEqual({ label: "Find another campaign", href: DISCOVER, external: true });
    expect(findAnother(true)).toEqual({ label: "Find another campaign", href: "/campaigns/find", external: false });
  });
  it("change 13: the retainer's words", () => {
    expect(payLine({ platform: "youtube", per1kCents: null, perPostCents: null, minPayoutCents: null, maxPayoutCents: null, minViews: null }, "retainer")).toBe("Pays picked creators each month");
  });
});

describe("the visit", () => {
  it("the frozen New set keeps every uuid new on this visit, and a later new one joins it", () => {
    const first = freezeNew(new Set(), [
      { campaignId: "a", isNew: true },
      { campaignId: "b", isNew: false },
    ]);
    expect([...first]).toEqual(["a"]);
    const later = freezeNew(first, [
      { campaignId: "a", isNew: false },
      { campaignId: "c", isNew: true },
    ]);
    expect([...later].sort()).toEqual(["a", "c"]);
    expect(freezeNew(later, [{ campaignId: "a", isNew: false }])).toBe(later);
  });

  it("the You're in rows: newest first, each campaign once", () => {
    const row = (id: string, kind: CampaignSummary["nextStepKind"]) => ({ campaignId: id, nextStepKind: kind }) as CampaignSummary;
    const rows = mergeAdded([row("a", "stop")], [row("b", "make_clips")]);
    expect(rows.map((r) => r.campaignId)).toEqual(["b", "a"]);
    expect(mergeAdded(rows, [row("a", "make_clips")]).map((r) => `${r.campaignId}:${r.nextStepKind}`)).toEqual(["a:make_clips", "b:make_clips"]);
    expect(mergeAdded(rows, [])).toBe(rows);
  });

  it("I joined: add it leads for 2 hours after Open", () => {
    const now = Date.parse("2026-11-21T12:00:00Z");
    expect(openedRecently("2026-11-21T10:30:00Z", now)).toBe(true);
    expect(openedRecently("2026-11-21T09:59:00Z", now)).toBe(false);
    expect(openedRecently(undefined, now)).toBe(false);
  });
});

describe("the words the web makes", () => {
  it("the entry card's line and Home's chip", () => {
    expect(entryLine({ on: true, started: false, newCount: 0, matches: 0 })).toBe("Tell me what you want. I'll find campaigns that pay for it.");
    expect(entryLine({ on: true, started: true, newCount: 3, matches: 6 })).toBe("3 new campaigns match what you want.");
    expect(entryLine({ on: true, started: true, newCount: 1, matches: 6 })).toBe("1 new campaign matches what you want.");
    expect(entryLine({ on: true, started: true, newCount: 0, matches: 4 })).toBe("4 campaigns match what you want.");
    expect(entryLine({ on: true, started: true, newCount: 0, matches: 0 })).toBe("None match right now. I look 4 times a day.");
    expect(entryLine({ on: false, started: true, newCount: 2, matches: 4 })).toBe("You stopped finding campaigns.");
    expect(newChipText(3)).toBe("3 new campaigns match");
    expect(newChipText(1)).toBe("1 new campaign matches");
  });

  it("every state's sentence (§41.1's table)", () => {
    expect(stateLine(finder({ state: "looking" }))).toBe("Looking at Content Rewards' campaigns… This takes a minute or two.");
    expect(stateLine(finder({ state: "looking" }), true)).toBe("Updating your matches…");
    expect(stateLine(finder({ state: "ok", looked: { campaigns: 120, pending: 640 } }))).toBe("No match yet. I've looked at 120 campaigns so far. I'll look at more later today.");
    expect(stateLine(finder({ state: "ok" }))).toBe("No campaign matches right now. I look again 4 times a day.");
    expect(stateLine(finder({ state: "down" }))).toBe("Content Rewards didn't answer. I'll try again in a few hours.");
    expect(stateLine(finder({ state: "blocked" }))).toBe("Content Rewards isn't letting Clip Factory look right now. Tap Look on Content Rewards yourself.");
    expect(stateLine(finder({ state: "not_allowed" }))).toBe("Content Rewards asked apps not to read its campaign pages. Tap Look on Content Rewards yourself.");
    expect(stateLine(finder({ state: "unreadable" }))).toBe("I can't read Content Rewards' campaign pages right now. Tap Look on Content Rewards yourself.");
    expect(stateLine(finder({ state: "off" }))).toBe("You stopped finding campaigns.");
  });

  it("kid-proof: at most 26 words a line, none of the banned words", () => {
    const all = [
      lib.FINDER_SOON,
      lib.NO_PLACE_LINE,
      ...lib.STEPS_OPEN_SIGNED_IN,
      ...lib.STEPS_OPEN_BY_HAND,
      ...lib.STEPS_APPLY,
      ...lib.IF_YOU_SEE.flatMap((h) => [h.see, h.do]),
      ...(["new", "looking", "ok", "down", "blocked", "not_allowed", "unreadable", "off"] as const).map((s) => stateLine(finder({ state: s })) ?? ""),
      entryLine({ on: true, started: false, newCount: 0, matches: 0 }),
      wantSummary(WANT_DEFAULTS, ["youtube"]),
    ];
    for (const line of all) {
      expect(words(line), line).toBeLessThanOrEqual(26);
      expect(ours(line), line).not.toMatch(BANNED);
    }
  });

  it("If you see is §38.4 join-join's list word for word, with the sign-in line and two more", () => {
    expect(lib.IF_YOU_SEE.map((h) => h.see)).toEqual([
      "**Hold to confirm**",
      "“Select at least one account”",
      "“Must be at least … characters”",
      "“Enter a full link, e.g. https://…”",
      "a box about Discord",
      "“This brand has gone quiet”",
      "“Campaign is not accepting applications”",
      "a sign-in page",
      "**Submit clip**",
      "**Pending review**",
    ]);
    expect(lib.IF_YOU_SEE.find((h) => h.see === "a sign-in page")!.do).toBe("Sign in with your email code, then tap the big button again.");
  });
});

describe("the mock's matching and words match §41.3's golden cases", () => {
  const PLACES: Platform[] = ["youtube", "instagram", "facebook", "x"];
  const run = (want: Partial<FinderWant> = {}, opts: { places?: Platform[]; tiktokOk?: boolean; own?: string[]; hidden?: string[] } = {}) => {
    const places = opts.places ?? (opts.tiktokOk ? ["youtube", "tiktok", "instagram", "facebook", "x"] : PLACES);
    return find(CARDS, { ...WANT_DEFAULTS, ...want }, { places, tiktokOk: !!opts.tiktokOk, own: new Set(opts.own), hidden: new Set(opts.hidden), asOf: "2026-11-21T12:00:00Z" });
  };
  const I = FINDER_IDS;
  const order = (r: ReturnType<typeof run>) => r.matches.map((m) => m.campaignId);

  it("default", () => {
    const r = run();
    expect(order(r)).toEqual([I.fundingpips, I.cod, I.pickleball, I.santacruz, I.energy, I.lanco]);
    const [fp, cod, pb, sc, en, la] = r.matches;
    expect(fp!.why).toBe("Pays $6.00 per 1,000 views on YouTube and Instagram. 41% of the money left. Open to join.");
    expect(fp!.notes).toEqual(["It has 4 rules you see once you join.", "Also pays on TikTok, once TikTok checks Clip Factory."]);
    expect(cod!.why).toBe("Pays $1.50 per 1,000 views on Instagram. 46% of the money left. Open to join.");
    expect(pb!.why).toBe("Pays $1.50 per 1,000 views on YouTube and Instagram. 96% of the money left. Open to join.");
    expect(sc!.why).toBe("Pays $1.00 per 1,000 views on YouTube and Instagram. 44% of the money left. Open to join.");
    expect(en!.why).toBe("Pays $1.00 per 1,000 views on YouTube, Instagram and X. 98% of the money left. Open to join.");
    expect(en!.headsUp).toEqual(["This brand only counts viewers from some countries. Check where yours are first."]);
    expect(en!.notes[0]).toBe("It has 1 rule you see once you join.");
    expect(la!.why).toBe("Pays $1.00 per 1,000 views on Instagram. 99% of the money left. Open to join.");
    expect(la!.headsUp).toEqual(["It may need its own sound. Clip Factory can't add one."]);
    expect(r.skipped.map((s) => [s.code, s.count])).toEqual([
      ["cant_make", 4],
      ["apply", 2],
      ["budget_low", 1],
      ["budget_gone", 1],
      ["other_pay", 1],
    ]);
    expect(r.skipped.find((s) => s.code === "apply")!.text).toBe("2 want you to apply first.");
    expect(r.skipped.find((s) => s.code === "budget_low")!.text).toBe("1 campaign has less than a quarter of the money left.");
    expect(r.looked).toBe(15);
    expect(fp!.budget.line).toBe("$1,668.79 left of $4,000");
    expect(fp!.pay.map((p) => p.line)).toEqual(["$6.00 per 1,000 views · up to $100 a clip", "$6.00 per 1,000 views · up to $100 a clip"]);
  });

  it("also apply", () => {
    const r = run({ access: "any" });
    expect(order(r)).toEqual([I.fundingpips, I.cod, I.pickleball, I.santacruz, I.hablando, I.ungodly, I.energy, I.lanco]);
    expect(r.matches[4]!.why).toBe("Pays $1.00 per 1,000 views on Instagram. 29% of the money left. You apply first.");
    expect(r.matches[5]!.why).toBe("Pays $1.75 per 1,000 views on YouTube. 95% of the money left. You apply first.");
  });

  it("gaming", () => {
    const r = run({ access: "any", categories: ["gaming"] });
    expect(order(r)).toEqual([I.ungodly]);
    expect(r.skipped.find((s) => s.code === "topic")!.count).toBe(7);
  });

  it("other pay, any money", () => {
    const r = run({ otherPay: true, minLeftPct: 0 });
    expect(order(r)).toEqual([I.fundingpips, I.cod, I.pickleball, I.santacruz, I.kai, I.splitscreen, I.energy, I.lanco]);
    expect(r.matches[4]!.why).toMatch(/^Shares the prize money on YouTube, Instagram and X\./);
    expect(r.matches[5]!.why).toBe("Pays up to $3.00 per 1,000 views on YouTube, Instagram and X. 21% of the money left. Open to join.");
  });

  it("$2 and up", () => {
    const r = run({ minPer1kCents: 200, access: "any", minLeftPct: 0 });
    expect(order(r)).toEqual([I.fundingpips, I.splitscreen]);
    expect(r.matches[1]!.why).toMatch(/^Pays \$3\.00 per 1,000 views on Instagram and X\./);
    expect(r.matches[1]!.pay[0]!.line).toMatch(/^\$1\.50 per 1,000 views/);
    expect(r.skipped.find((s) => s.code === "low_pay")).toEqual({ code: "low_pay", count: 7, text: "7 pay less than $2.00 per 1,000 views." });
  });

  it("YouTube only", () => {
    const r = run({}, { places: ["youtube"] });
    expect(order(r)).toEqual([I.fundingpips, I.pickleball, I.santacruz, I.energy]);
    expect(r.skipped.find((s) => s.code === "not_your_places")!.count).toBe(2);
  });

  it("TikTok after its audit", () => {
    const r = run({}, { tiktokOk: true });
    expect(order(r)).toEqual([I.fundingpips, I.cod, I.pickleball, I.santacruz, I.energy, I.lanco]);
    const cod = r.matches[1]!;
    expect(cod.pay.find((p) => p.platform === "tiktok")!.line).toBe("Up to $2.00 per 1,000 views · up to $1,200 a clip");
    expect(cod.notes).toContain("Pays less in some countries.");
    expect(cod.why).toMatch(/^Pays up to \$2\.00 per 1,000 views on TikTok and Instagram\./);
    expect(r.matches.some((m) => m.notes.some((n) => n.startsWith("Also pays on TikTok")))).toBe(false);
  });

  it("English", () => {
    const r = run({ languages: ["en"], access: "any", minLeftPct: 0 });
    expect(order(r)).toContain(I.splitscreen);
    expect(r.matches.find((m) => m.campaignId === I.hablando)!.cantTell).toContain("I can't tell the language.");
  });

  it("hidden and own are refused and counted", () => {
    const r = run({}, { own: [I.fundingpips], hidden: [I.cod] });
    expect(order(r)).not.toContain(I.fundingpips);
    expect(order(r)).not.toContain(I.cod);
    expect(r.skipped.find((s) => s.code === "own")!.text).toBe("1 campaign is in your campaigns already.");
    expect(r.skipped.find((s) => s.code === "hidden")!.text).toBe("1 campaign you said Not for me.");
  });

  it("every server word is at most 26 words and free of the banned words", () => {
    for (const want of [{}, { access: "any" as const }, { otherPay: true, minLeftPct: 0 as const }, { languages: ["en" as const] }])
      for (const m of run(want).matches)
        for (const line of [m.why, ...m.notes, ...m.headsUp, ...m.cantTell, ...m.pay.map((p) => p.line), m.budget.line ?? ""]) {
          expect(words(line), line).toBeLessThanOrEqual(26);
          expect(line, line).not.toMatch(BANNED);
        }
  });

  it("the want checks: only the nine keys and the choices shown", () => {
    expect(() => checkWant({ minPer1kCents: 150 })).toThrow("Pick one of the choices shown.");
    expect(() => checkWant({ colour: "red" })).toThrow();
    expect(() => checkWant({ places: ["youtube", "youtube"] })).toThrow();
    expect(() => checkWant({ languages: ["ja"] })).toThrow();
    expect(checkWant({ places: null, minLeftPct: 50, access: "any" })).toEqual({ places: null, minLeftPct: 50, access: "any" });
  });
});
