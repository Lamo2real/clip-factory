// Ask's setup tools learn the Content Rewards guide (docs/CONTRACTS.md §38.17): ask-knowledge.mjs emits
// setup_steps.contentrewards from CR_GUIDE, numbered as the page numbers it (only the three setup steps).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CR_GUIDE, crAllSteps } from "../src/setup/contentrewards.ts";

describe("ask-knowledge: setup_steps.contentrewards", () => {
  it("emits every CR_GUIDE step and the said-no card, three of them numbered", async () => {
    const { setupSteps } = await import("../scripts/ask-knowledge.mjs");
    const { steps, names } = await setupSteps();
    expect(names.contentrewards).toBe("Content Rewards");
    const rows = steps.contentrewards!;
    expect(rows.map((r) => r.id).sort()).toEqual(crAllSteps().map((s) => s.id).sort());
    expect(rows.filter((r) => r.n !== null).map((r) => [r.id, r.n])).toEqual([
      ["ready-account", 1],
      ["ready-socials", 2],
      ["connect", 3],
    ]);
    // The five platforms are still there, unchanged in kind.
    for (const p of ["youtube", "tiktok", "instagram", "facebook", "x"]) expect(steps[p]!.length).toBeGreaterThan(0);
    // Content Rewards' own pages keep their address (a whole URL, not hidden): Ask can name the exact page.
    expect(rows.find((r) => r.id === "ready-account")!.open!.url).toBe("https://contentrewards.com/login?intent=signup");
    expect(rows.every((r) => r.say.length > 0)).toBe(true);
    expect(CR_GUIDE.parts.length).toBe(4);
  }, 30_000);

  it("the committed pack carries it (run node scripts/ask-knowledge.mjs after changing CR_GUIDE)", () => {
    const pack = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "api/src/clipfactory_api/ask/knowledge.json"), "utf8")) as { setupSteps: Record<string, { id: string }[]>; routes: string[] };
    expect(pack.setupSteps.contentrewards!.map((s) => s.id)).toContain("connect");
    expect(pack.routes).toContain("/settings/posting/setup/contentrewards");
  });
});
