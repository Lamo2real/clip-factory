// Ask's setup tools learn the Content Rewards guide (docs/CONTRACTS.md §38.17): ask-knowledge.mjs emits
// setup_steps.contentrewards from CR_GUIDE, each part numbered as its own screen numbers it, so Ask's
// "Open Content Rewards step {n}" button never reads "step None" (api ask/tools.py setup_step_action).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CR_GUIDE, crAllSteps } from "../src/setup/contentrewards.ts";

describe("ask-knowledge: setup_steps.contentrewards", () => {
  it("emits every CR_GUIDE step and the said-no card, every one numbered as its screen numbers it", async () => {
    const { setupSteps } = await import("../scripts/ask-knowledge.mjs");
    const { steps, names } = await setupSteps();
    expect(names.contentrewards).toBe("Content Rewards");
    const rows = steps.contentrewards!;
    expect(rows.map((r) => r.id).sort()).toEqual(crAllSteps().map((s) => s.id).sort());
    expect(rows.every((r) => Number.isInteger(r.n) && r.n >= 1)).toBe(true);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.n]))).toEqual({
      "ready-account": 1,
      "ready-socials": 2,
      connect: 3,
      // "Content Rewards said no?" is step 3's helper card.
      "connect-pilot": 3,
      "join-find": 1,
      "join-join": 2,
      "join-copy": 3,
      // Money › Content Rewards, "No Finance": 1 Link Whop, 2 Move, 3 Add your bank, 4 Get it to your bank.
      "move-whop": 1,
      "move-withdraw": 2,
      "bank-setup": 3,
      "bank-cashout": 4,
      // "Yes, I see Finance": 1 Set up payouts, 2 Move, 3 Get it to your bank.
      "fin-setup": 1,
      "fin-bank": 3,
    });
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
