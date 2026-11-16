import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import corpusJson from "../src/features/help/help-corpus.json";
import kb from "../src/features/help/helpKb.json";
import { compose, fill, hasPlaceholder, noDashes, suggestionsFor, withoutLive } from "../src/features/help/compose.ts";
import { routeOk, safeActions } from "../src/features/help/kb.ts";
import { rank } from "../src/features/help/retrieve.ts";
import { HELP_METRICS, type HelpCorpus } from "../src/features/help/types.ts";
import { TREES } from "../src/lib/settingsTree.ts";

const corpus = corpusJson as unknown as HelpCorpus;
const web = join(import.meta.dirname, "..");
const SENSITIVE =
  /arn:|amazonaws|AKIA[0-9A-Z]{12,}|\b\d{12}\b|[\w.+-]+@[\w-]+\.[\w.]+|s3:\/\/|https?:\/\/[^\s]*\?|\b(?:passwords?|secrets?|tokens?|api keys?|access keys?|lambdas?|dynamodb|bedrock|cognito|cloudfront|agentcore|terraform|jwts?|sub claim)\b/i;

function allText(): string[] {
  return corpus.docs.flatMap((d) => [d.title, d.where, d.answer, ...d.steps, ...d.keywords, ...d.actions.map((a) => a.label), d.live?.text ?? ""]);
}

describe("the generated corpus (§19.2)", () => {
  it("is up to date with the source (the CI --check)", async () => {
    const { buildCorpus } = await import("../scripts/help-corpus.mjs");
    const { text, problems } = await buildCorpus();
    expect(problems).toEqual([]);
    expect(readFileSync(join(web, "src/features/help/help-corpus.json"), "utf8")).toBe(text);
  }, 30_000);

  it("has the shape the api reads", () => {
    expect(corpus.app).toBe("clip-factory");
    expect(corpus.version).toMatch(/^[0-9a-f]{12}$/);
    expect(corpus.routes).toContain("/settings/look-and-feel/sounds");
    expect(corpus.stopwords.length).toBeGreaterThan(50);
    expect(corpus.synonyms["tik tok"]).toBe("tiktok");
  });

  it("keeps nothing sensitive and no em or en dashes", () => {
    for (const t of allText()) {
      expect(SENSITIVE.test(t), t).toBe(false);
      expect(/[–—]/.test(t), t).toBe(false);
    }
    // "YouTube cookies" is a real setting and stays.
    expect(corpus.docs.some((d) => d.title === "YouTube cookies")).toBe(true);
  });

  it("has unique ids, real pages, short answers and known live metrics", () => {
    const ids = corpus.docs.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    const actionIds = corpus.docs.flatMap((d) => d.actions.map((a) => a.id));
    expect(new Set(actionIds).size).toBe(actionIds.length);
    for (const d of corpus.docs) {
      expect(routeOk(d.route), d.id).toBe(true);
      expect(d.answer.length, d.id).toBeLessThanOrEqual(400);
      expect(d.steps.length, d.id).toBeLessThanOrEqual(6);
      expect(d.actions.length, d.id).toBeLessThanOrEqual(2);
      for (const a of d.actions) {
        expect(routeOk(a.to), a.id).toBe(true);
        expect(a.label.length, a.id).toBeLessThanOrEqual(24);
      }
      if (d.live) expect(HELP_METRICS).toContain(d.live.metric);
    }
  });

  it("has one doc for every tree, branch and apple of Settings, and every curated guide", () => {
    const ids = new Set(corpus.docs.map((d) => d.id));
    for (const t of TREES) {
      expect(ids.has(`settings-${t.slug}`)).toBe(true);
      for (const b of t.branches) {
        expect(ids.has(`settings-${t.slug}-${b.slug}`)).toBe(true);
        for (const a of b.apples) expect(ids.has(`apple-${a.id}`)).toBe(true);
      }
    }
    for (const g of kb.guides) expect(ids.has(g.id)).toBe(true);
    for (const p of ["youtube", "instagram", "facebook", "tiktok", "x"]) {
      const g = corpus.docs.find((d) => d.id === `posting-setup-${p}`)!;
      expect(g.extends).toBe("§17");
      // §17.1: the card on Set up posting lights up, and the second button opens the platform's own steps.
      expect(g.actions[0]).toMatchObject({ to: "/settings/posting/setup", highlight: [`setup-${p}`] });
      expect(g.actions[1]!.to).toBe(`/settings/posting/setup/${p}`);
      expect(g.route).toBe(`/settings/posting/setup/${p}`);
    }
    // An apple with its own href (§17.1) leads to that page, not to its branch.
    const xCost = corpus.docs.find((d) => d.id === "apple-x-cost")!;
    expect(xCost.route).toBe("/settings/posting/setup/x");
    expect(xCost.actions[0]).toMatchObject({ to: "/settings/posting/setup/x#x-cost", highlight: ["x-cost"] });
  });

  it("offers suggestions that each find a suggested doc", () => {
    for (const page of ["home", "settings", "clip"] as const) {
      const qs = suggestionsFor({ page });
      expect(qs).toHaveLength(3);
      for (const q of qs) {
        const r = rank(corpus.docs, q, [], { device: "desktop", os: "mac", installed: false, page }, corpus);
        expect(r.candidates[0]?.doc.suggest, q).toBe(true);
      }
    }
    expect(suggestionsFor({ page: "settings" })[1]).toBe("Where do I change my click sound?");
    expect(suggestionsFor({ page: "clip" })[1]).toBe("Why is my clip private on TikTok?");
  });
});

describe("routes and actions", () => {
  it("drops an action that leads nowhere", () => {
    const actions = safeActions([
      { id: "a", label: "Nowhere", to: "/nope" },
      { id: "b", label: "Elsewhere", to: "https://example.org/" },
      { id: "c", label: "Other host", to: "//example.org/settings" },
      { id: "d", label: "Open Sounds", to: "/settings/look-and-feel/sounds#click-sound" },
      { id: "e", label: "Bad branch", to: "/settings/look-and-feel/nope" },
    ]);
    expect(actions.map((a) => a.id)).toEqual(["d"]);
    expect(routeOk("/library?view=week")).toBe(true);
  });
});

describe("the composer", () => {
  it("leads a live answer with its number sentence", () => {
    const r = rank(corpus.docs, "How many views did my best clip get this week?", [], null, corpus);
    const a = compose(r);
    expect(a.known).toBe(true);
    expect(a.live?.metric).toBe("best_clip_week_views");
    expect(a.text.startsWith('Your best clip this week, "{hook}", has {value} views.')).toBe(true);
    expect(a.sources).toEqual(["best-clip-week-views"]);
    expect(hasPlaceholder(a.text)).toBe(true);
    expect(fill(a.text, { value: "12K", hook: "Big win" })).toContain('"Big win", has 12K views.');
    expect(withoutLive(a.text)).toBe("**This week** in **Library** shows this week's clips, most views first.");
  });

  it("never lets a dash through", () => {
    expect(noDashes("Fast — and calm – always")).toBe("Fast, and calm, always");
  });
});
