// CR_GUIDE (docs/CONTRACTS.md §38.3, §38.4, §38.7, §38.20): plain data the screens draw and Ask reads.
import { describe, expect, it } from "vitest";
import { CR_GUIDE, CR_PILOT, CR_PILOT_EMAIL, CR_SETUP_STEPS, crAllSteps, pilotMailto } from "../src/setup/contentrewards.ts";
import { GUIDES, SETUP_ORDER } from "../src/setup/index.ts";

/** Words a kid can't read (§38.1). The pilot email's body is for Content Rewards' team, under Show more. */
const BANNED = /\b(mcp|oauth|tokens?|scopes?|cpm|submissions?|api)\b/i;

const visible = (s: { title: string; say: string[]; open?: { label: string }; ifYouSee?: { see: string; do: string }[]; folds?: { question: string; say: string[] }[] }) => [
  s.title,
  ...s.say,
  s.open?.label ?? "",
  ...(s.ifYouSee ?? []).flatMap((h) => [h.see, h.do]),
  ...(s.folds ?? []).flatMap((f) => [f.question, ...f.say]),
];

describe("CR_GUIDE", () => {
  it("is its own guide: never one of the five, checked on 21 Nov 2026, free", () => {
    expect(CR_GUIDE.name).toBe("Content Rewards");
    expect(CR_GUIDE.checkedOn).toBe("2026-11-21");
    expect(CR_GUIDE.cost).toBe("Free");
    expect([...Object.keys(GUIDES)].sort()).toEqual([...SETUP_ORDER].sort());
    expect(Object.keys(GUIDES)).toHaveLength(5);
    expect(Object.values(GUIDES).map((g) => g.name)).not.toContain("Content Rewards");
  });

  it("has its parts in order: set up, join, move to Whop, the bank", () => {
    expect(CR_GUIDE.parts.map((p) => p.id)).toEqual(["setup", "join", "move", "bank"]);
  });

  it("has exactly three numbered setup steps, in the contract's order", () => {
    expect(CR_SETUP_STEPS.map((s) => s.id)).toEqual(["ready-account", "ready-socials", "connect"]);
    expect(CR_SETUP_STEPS.map((s) => s.title)).toEqual(["Make a Content Rewards account", "Add your accounts there", "Connect Content Rewards"]);
    // The "said no?" card is unnumbered: it is not one of the three.
    expect(CR_SETUP_STEPS.map((s) => s.id)).not.toContain(CR_PILOT.id);
    expect(CR_GUIDE.parts.find((p) => p.id === "join")!.steps.map((s) => s.id)).toEqual(["join-find", "join-join", "join-copy"]);
  });

  it("has unique step ids the API accepts by pattern, and fold-outs that are never steps", () => {
    const ids = crAllSteps().map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]{1,40}$/);
    const folds = crAllSteps().flatMap((s) => s.folds ?? []);
    expect(folds.map((f) => f.id)).toEqual(["fold-instagram", "fold-facebook"]);
    for (const f of folds) expect(ids).not.toContain(f.id);
  });

  it("opens only exact https pages", () => {
    for (const s of crAllSteps()) {
      if (s.open) expect(s.open.url, s.id).toMatch(/^https:\/\/[a-z.]+\//);
      for (const f of s.folds ?? []) if (f.open) expect(f.open.url).toMatch(/^https:\/\//);
    }
    expect(CR_SETUP_STEPS[0]!.open!.url).toBe("https://contentrewards.com/login?intent=signup");
    expect(CR_SETUP_STEPS[1]!.open!.url).toBe("https://contentrewards.com/c/settings");
  });

  it("step 3 ticks itself on Connect and has no I did this", () => {
    const connect = CR_SETUP_STEPS[2]!;
    expect(connect.auto).toBe("connected");
    expect(connect.manual).toBe(false);
    expect(CR_SETUP_STEPS[0]!.auto).toBe("connected");
    expect(CR_SETUP_STEPS[1]!.auto).toBe("linked");
  });

  it("the pilot email: the exact words, URL-encoded in the mailto", () => {
    expect(CR_PILOT_EMAIL.to).toBe("support@contentrewards.com");
    expect(CR_PILOT_EMAIL.subject).toBe("Please let my account connect apps (MCP sign-in pilot)");
    expect(CR_PILOT_EMAIL.body).toContain("scope my_submissions:write");
    const href = pilotMailto();
    expect(href.startsWith("mailto:support@contentrewards.com?subject=")).toBe(true);
    const u = new URL(href);
    expect(u.searchParams.get("subject")).toBe(CR_PILOT_EMAIL.subject);
    expect(u.searchParams.get("body")).toBe(CR_PILOT_EMAIL.body);
    expect(href).not.toContain(" ");
    expect(CR_PILOT.mailto!.href).toBe(href);
  });

  it("the visible words, Copy chip label included, have no banned word", () => {
    // **Bold** is the other site's own label, word for word (Content Rewards' "Highest CPM" sort): not our words.
    const ours = (t: string) => t.replace(/\*\*[^*]+\*\*/g, "");
    for (const s of crAllSteps()) for (const t of visible(s)) expect(BANNED.test(ours(t)), `${s.id}: ${t}`).toBe(false);
    for (const c of CR_PILOT.copy ?? []) expect(BANNED.test(c.label), c.label).toBe(false);
    expect(CR_PILOT.copy![0]!.label).toBe("Email to Content Rewards");
  });

  it("every money step says which Finance answer shows it", () => {
    const money = [...CR_GUIDE.parts.find((p) => p.id === "move")!.steps, ...CR_GUIDE.parts.find((p) => p.id === "bank")!.steps];
    expect(money.map((s) => s.id).sort()).toEqual(["bank-cashout", "bank-setup", "fin-bank", "fin-setup", "move-whop", "move-withdraw"]);
    for (const s of money) expect(["yes", "no", "both"], s.id).toContain(s.finance);
    expect(money.find((s) => s.id === "move-withdraw")!.finance).toBe("both");
    for (const s of money) expect(["once", "each_time"], s.id).toContain(s.repeat);
  });

  it("lines stay short (26 words or fewer) and titles six words or fewer", () => {
    for (const s of crAllSteps()) {
      expect(s.title.split(/\s+/).length, s.title).toBeLessThanOrEqual(6);
      for (const line of s.say) expect(line.split(/\s+/).length, line).toBeLessThanOrEqual(26);
    }
  });
});
