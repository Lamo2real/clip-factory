// The two ways (docs/CONTRACTS.md §39.1, §39.5): the tap counts the e2e click-count tests hold every journey to, and
// the one name for each thing. No screen string (the help corpus, the screens' own words) says "the Content Rewards
// way", "mode", "compatible", "clip type", "upload type", "campaign type", or the old "I linked it".
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { CAMPAIGN_WAY_TAPS, CONNECT_CF_TAPS_FROM_ZERO, CONNECT_TAPS_DONE, COPY_TAPS, NORMAL_HOME_CONTROLS, NORMAL_WAY_TAPS } from "../e2e/flows.ts";
import { CR_GUIDE, CR_SETUP_STEPS, CR_SHORTCUT } from "../src/setup/contentrewards.ts";
import { reasonText } from "../src/lib/contentRewards.ts";

const SRC = join(import.meta.dirname, "..", "src");
const BANNED = ["content rewards way", "normal mode", "compatible", "clip type", "upload type", "campaign type", "i linked it"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}
/** A file's string literals and JSX text (comments left out): what a screen can say. */
function screenStrings(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .map((l) => l.replace(/\s\/\/ .*$/, ""))
    .join("\n");
}

describe("the taps (§39.1)", () => {
  it("the normal way stays 5, the campaign way 6, the copy 3, Connect 7 when set up and 10 from zero", () => {
    expect(NORMAL_WAY_TAPS).toBe(5);
    expect(CAMPAIGN_WAY_TAPS).toBe(6);
    expect(COPY_TAPS).toBe(3);
    expect(CONNECT_TAPS_DONE).toBe(7);
    expect(CONNECT_CF_TAPS_FROM_ZERO).toBe(10);
    // The campaign way is the normal way plus one tap (the campaign), never more.
    expect(CAMPAIGN_WAY_TAPS - NORMAL_WAY_TAPS).toBe(1);
  });

  it("Home's normal form keeps origin/main's controls, with no campaign field", () => {
    for (const list of [NORMAL_HOME_CONTROLS.empty, NORMAL_HOME_CONTROLS.withLink]) {
      expect(list).toHaveLength(8);
      expect(list.join(" ").toLowerCase()).not.toContain("campaign");
    }
  });
});

describe("one name for each thing (§39.1)", () => {
  it("no screen string says a banned name", () => {
    const corpus = readFileSync(join(SRC, "features", "help", "help-corpus.json"), "utf8").toLowerCase();
    for (const b of BANNED) expect(corpus, `help corpus: ${b}`).not.toContain(b);
    const hits: string[] = [];
    for (const f of files(SRC).filter((p) => /\/(screens|components|lib|setup)\//.test(p))) {
      const text = screenStrings(f).toLowerCase();
      for (const b of BANNED) if (text.includes(b)) hits.push(`${relative(SRC, f)}: ${b}`);
    }
    expect(hits).toEqual([]);
  });

  it("the two ways' own words are on their screens", () => {
    const home = readFileSync(join(SRC, "screens", "home", "NewJobForm.tsx"), "utf8");
    expect(home).toContain('"Make campaign clips"');
    expect(home).toContain("Make normal clips instead");
    expect(home).toContain("Campaign clips");
    expect(readFileSync(join(SRC, "screens", "home", "CampaignsRow.tsx"), "utf8")).toContain('"Make campaign clips"');
    expect(readFileSync(join(SRC, "screens", "review", "CampaignFit.tsx"), "utf8")).toContain("Campaign clip ·");
    // The job page strip "Campaign clips · FaZe Clips · Following 9 rules" and Library's chip "Campaign" (§39.1).
    const job = readFileSync(join(SRC, "screens", "jobs", "JobDetail.tsx"), "utf8");
    expect(job).toContain("Campaign clips");
    expect(job).toContain("{`· Following ${plural(campaign.plainRules.length, \"rule\")}`}");
    expect(job).not.toContain("on Content Rewards</>");
    expect(readFileSync(join(SRC, "screens", "library", "Library.tsx"), "utf8")).toContain('<Pill icon="coin">Campaign</Pill>');
    const line = readFileSync(join(SRC, "screens", "review", "FitSuggestion.tsx"), "utf8");
    expect(line).toContain("This clip could earn money on ${name}.");
    expect(line).toContain("Make a ${name} copy");
  });

  it("adding an account inside Content Rewards is always add, never link or connect", () => {
    const socials = CR_SETUP_STEPS.find((s) => s.id === "ready-socials")!;
    expect(socials.title).toBe("Add your accounts there");
    expect(socials.doneLabel).toBe("I added them");
    expect(socials.lead).toBe("Already added YouTube there? Tap I added them.");
    expect(CR_SETUP_STEPS.find((s) => s.id === "ready-account")!.doneLabel).toBe("I have an account");
    expect(CR_SHORTCUT.question).toBe("Already use Content Rewards, with {places} added there?");
    // Content Rewards' own button names stay word for word (**Connect account**); our own words say add.
    for (const step of CR_GUIDE.parts.flatMap((p) => p.steps))
      for (const line of [...step.say, step.title, ...(step.ifYouSee ?? []).map((h) => h.do)])
        expect(line.replace(/\*\*[^*]+\*\*/g, ""), line).not.toMatch(/\b(link|connect) (it|youtube|instagram|x|facebook|tiktok|them)\b/i);
    expect(reasonText("not_linked", "youtube")).toContain("and add it. Then tap I added it.");
    expect(reasonText("relink", "youtube")).toContain("then tap I added it.");
    const upload = readFileSync(join(SRC, "screens", "review", "UploadTo.tsx"), "utf8");
    expect(upload).toContain("in Content Rewards first.");
    expect(upload).toContain("I added it");
  });

  it("Connect is only Clip Factory and Content Rewards: one Connect step on the setup page", () => {
    const connects = CR_SETUP_STEPS.filter((s) => /connect/i.test(s.title));
    expect(connects.map((s) => s.id)).toEqual(["connect"]);
  });
});
