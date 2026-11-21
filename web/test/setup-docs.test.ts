import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allSteps, GUIDES, SETUP_ORDER } from "../src/setup/index.ts";
import { crAllSteps } from "../src/setup/contentrewards.ts";

// docs/SETUP_POSTING.md says the same steps as the app (docs/CONTRACTS.md §17.12): under each platform's heading,
// every step title appears. The docs builder writes that file; until it lands this check waits for it.
const file = join(import.meta.dirname, "..", "..", "docs", "SETUP_POSTING.md");
const present = existsSync(file);

describe.skipIf(!present)("docs/SETUP_POSTING.md matches the in-app steps", () => {
  const text = present ? readFileSync(file, "utf8") : "";
  const lines = text.split("\n");
  // The text under each platform's own heading (a heading line that names the platform), up to the next one.
  const sectionOf = (name: string): string => {
    const heads = lines.map((l, i) => ({ l, i })).filter(({ l }) => /^#{1,3}\s/.test(l));
    const start = heads.find(({ l }) => new RegExp(`^#{1,3}\\s.*\\b${name}\\b`).test(l) && !/Instagram and Facebook/.test(l));
    if (!start) return "";
    const level = /^(#+)/.exec(start.l)![1]!.length;
    const end = heads.find(({ l, i }) => i > start.i && /^(#+)/.exec(l)![1]!.length <= level);
    return lines.slice(start.i, end ? end.i : lines.length).join("\n");
  };

  for (const p of SETUP_ORDER) {
    it(`has every ${GUIDES[p].name} step title under its heading`, () => {
      const section = sectionOf(GUIDES[p].name);
      expect(section, `no heading for ${GUIDES[p].name}`).not.toBe("");
      for (const s of allSteps(GUIDES[p])) expect(section, s.title).toContain(s.title);
    });
  }

  // §38.19 (F writes it): the Content Rewards titles sit under "## Content Rewards", checked once that heading exists.
  const crHeading = lines.some((l) => /^##\s+Content Rewards\b/.test(l));
  it.skipIf(!crHeading)("has every Content Rewards step title under ## Content Rewards", () => {
    const at = lines.findIndex((l) => /^##\s+Content Rewards\b/.test(l));
    const end = lines.findIndex((l, i) => i > at && /^##\s/.test(l));
    const section = lines.slice(at, end < 0 ? lines.length : end).join("\n");
    for (const s of crAllSteps()) expect(section, s.title).toContain(s.title);
  });
});
