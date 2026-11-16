// Audit F004 and F005: the page the client sends must be one the API accepts, a skill page ranks like Settings, and
// a complete question asked right after another one keeps its own answer.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import corpusJson from "../src/features/help/help-corpus.json";
import { suggestionsFor, SUGGESTIONS } from "../src/features/help/compose.ts";
import { helpPage } from "../src/features/help/context.ts";
import { boostPage, rank, startsFollowUp } from "../src/features/help/retrieve.ts";
import { HELP_PAGES, type HelpContext, type HelpCorpus } from "../src/features/help/types.ts";
import { mockHelpTransport } from "../src/api/mock/help.ts";
import type { Route } from "../src/lib/router.ts";

const corpus = corpusJson as unknown as HelpCorpus;
const root = resolve(__dirname, "..", "..");

function routeNames(): Route["name"][] {
  const text = readFileSync(resolve(root, "web/src/lib/router.ts"), "utf8");
  const block = text.slice(text.indexOf("export type Route ="), text.indexOf("export const MOTION_GALLERY_PATH"));
  return Array.from(block.matchAll(/\{\s*name:\s*"([a-z_]+)"/g), (m) => m[1] as Route["name"]);
}

function apiPages(): Set<string> {
  const text = readFileSync(resolve(root, "api/src/clipfactory_api/routes/help.py"), "utf8");
  const block = /PAGES = frozenset\(\s*\{([^}]*)\}/.exec(text)?.[1] ?? "";
  return new Set(Array.from(block.matchAll(/"([a-z_]+)"/g), (m) => m[1]!));
}

describe("help pages (§19.6)", () => {
  it("sends every route as a page the API accepts", () => {
    const names = routeNames();
    expect(names).toContain("skill");
    const accepted = apiPages();
    expect(accepted.size).toBeGreaterThan(5);
    for (const name of names) {
      const page = helpPage(name);
      expect((HELP_PAGES as readonly string[]).includes(page), name).toBe(true);
      expect(accepted.has(page), name).toBe(true);
    }
    for (const page of HELP_PAGES) expect(accepted.has(page), page).toBe(true);
  });

  it("keeps real page names and sends the mock-only ones as not_found", () => {
    expect(helpPage("skill")).toBe("skill");
    expect(helpPage("settings")).toBe("settings");
    expect(helpPage("mock_oauth")).toBe("not_found");
    expect(helpPage("motion_gallery")).toBe("not_found");
  });

  it("treats a skill page as Settings for the chips and the page boost", () => {
    expect(boostPage("skill")).toBe("settings");
    expect(suggestionsFor({ page: "skill" })).toContain(SUGGESTIONS.clickSound);
    const ctx: HelpContext = { device: "desktop", os: "mac", installed: false, page: "skill" };
    const r = rank(corpus.docs, "How do I write a skill?", [], ctx, corpus);
    expect(r.known).toBe(true);
  });
});

describe("the mock transport checks the page like the API", () => {
  const ask = (page: unknown) =>
    mockHelpTransport({ enabled: true, outcomes: [] })(
      "POST",
      "/help/answers",
      { question: "What does Keep do?", context: { device: "desktop", os: "mac", installed: false, page } },
      "token",
      new AbortController().signal,
    );

  it("rejects a page the API does not know", async () => {
    const res = await ask("admin");
    expect(res.status).toBe(400);
  });

  it("answers on a skill page", async () => {
    const res = await ask("skill");
    expect(res.status).toBe(200);
  }, 10_000);
});

describe("follow-ups (§19.4)", () => {
  const ctx: HelpContext = { device: "desktop", os: "mac", installed: false, page: "home" };
  const after = (previous: string) => [
    { role: "user" as const, text: previous },
    { role: "assistant" as const, text: "(the answer)" },
  ];

  it("answers a complete short question on its own, even right after another one", () => {
    const r = rank(corpus.docs, "What does Keep do?", after("How do I make clips from a Twitch link?"), ctx, corpus);
    expect(r.known).toBe(true);
    expect(r.followUp).toBe(false);
    expect(r.candidates[0]!.doc.id).toBe("review-keep");
  });

  it("still merges an explicit follow-up phrase", () => {
    expect(startsFollowUp("and the error sound?")).toBe(true);
    expect(startsFollowUp("What does Keep do?")).toBe(false);
    const r = rank(corpus.docs, "and the error sound?", after("Where do I change my click sound?"), ctx, corpus);
    expect(r.followUp).toBe(true);
    expect(r.candidates[0]!.doc.id).toBe("sounds-error");
  });
});
