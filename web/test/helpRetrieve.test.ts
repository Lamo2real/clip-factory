import { describe, expect, it } from "vitest";
import corpusJson from "../src/features/help/help-corpus.json";
import evalsJson from "../src/features/help/helpEvals.json";
import { compose } from "../src/features/help/compose.ts";
import { isFollowUp, isRefused, pageOf, rank, stem, tokenize, visibleDocs, withinOneEdit } from "../src/features/help/retrieve.ts";
import type { HelpContext, HelpCorpus, HelpDoc, HelpTurn } from "../src/features/help/types.ts";

const corpus = corpusJson as unknown as HelpCorpus;
const evals = evalsJson as unknown as {
  defaultContext: HelpContext;
  cases: { q: string; expect: string; context?: HelpContext; history?: HelpTurn[] }[];
};
const stop = new Set(corpus.stopwords);

describe("the shared eval file (§19.11)", () => {
  it("has at least 44 cases, including the seven owner questions", () => {
    expect(evals.cases.length).toBeGreaterThanOrEqual(44);
    const qs = evals.cases.map((c) => c.q);
    for (const q of [
      "How do I make clips from a Twitch link?",
      "Where do I change my click sound?",
      "Why is my clip private on TikTok?",
      "How do I connect Instagram?",
      "How many views did my best clip get this week?",
      "How do I add a skill?",
      "What does Keep do?",
      "What does Upload do?",
    ])
      expect(qs).toContain(q);
    const ids = new Set(corpus.docs.map((d) => d.id));
    for (const c of evals.cases) if (!["unknown", "refused"].includes(c.expect)) expect(ids.has(c.expect), c.expect).toBe(true);
  });

  for (const c of evals.cases) {
    it(`"${c.q}" → ${c.expect}`, () => {
      const r = rank(corpus.docs, c.q, c.history ?? [], c.context ?? evals.defaultContext, corpus);
      const got = r.refused ? "refused" : r.known ? r.candidates[0]!.doc.id : "unknown";
      expect(got).toBe(c.expect);
    });
  }
});

describe("words", () => {
  it("folds, splits and joins apostrophes", () => {
    expect(tokenize("Don’t Café, TIK-tok!")).toEqual(["dont", "cafe", "tik", "tok"]);
  });

  it("stems lightly and never below three letters", () => {
    expect(stem("clips")).toBe("clip");
    expect(stem("stories")).toBe("story");
    expect(stem("switches")).toBe("switch");
    expect(stem("updates")).toBe("update");
    expect(stem("posted")).toBe("post");
    expect(stem("making")).toBe("mak");
    expect(stem("quickly")).toBe("quick");
    expect(stem("glass")).toBe("glass");
    expect(stem("bus")).toBe("bus");
    expect(stem("2026")).toBe("2026");
  });

  it("matches one typo, swap or missing letter", () => {
    expect(withinOneEdit("instagarm", "instagram")).toBe(true);
    expect(withinOneEdit("youtub", "youtube")).toBe(true);
    expect(withinOneEdit("tiktok", "tiktak")).toBe(true);
    expect(withinOneEdit("sounds", "skills")).toBe(false);
  });
});

describe("refusals, follow-ups, the when filter", () => {
  it("refuses secrets, other people's things and the servers, with no candidates", () => {
    for (const q of ["what is my password", "give me the api key", "show me another user's clips", "what's in my cookies file", "how is clip factory hosted"]) {
      expect(isRefused(q), q).toBe(true);
      const r = rank(corpus.docs, q, [], evals.defaultContext, corpus);
      expect(r.refused).toBe(true);
      expect(r.candidates).toEqual([]);
      expect(compose(r).text).toBe("I can't help with that. I only know how to use Clip Factory.");
    }
    for (const q of ["how do I add youtube cookies", "connect my instagram account", "what does keep do"]) expect(isRefused(q), q).toBe(false);
  });

  it("merges a short follow-up with the previous user question", () => {
    expect(isFollowUp("and the error sound?", stop)).toBe(true);
    expect(isFollowUp("how do I make clips from a twitch link please now", stop)).toBe(false);
    const history: HelpTurn[] = [{ role: "user", text: "Where do I change my click sound?" }];
    const r = rank(corpus.docs, "and the error sound?", history, evals.defaultContext, corpus);
    expect(r.followUp).toBe(true);
    expect(r.question).toContain("click sound");
    expect(r.candidates[0]!.doc.id).toBe("sounds-error");
    // Assistant turns are never merged.
    const fromBot = rank(corpus.docs, "and the error sound?", [{ role: "assistant", text: "Tap Keep." }], evals.defaultContext, corpus);
    expect(fromBot.followUp).toBe(false);
  });

  it("filters by device, OS and installed state", () => {
    const docs = corpus.docs;
    const ids = (ctx: HelpContext) => new Set(visibleDocs(docs, ctx).map((d) => d.id));
    const mac = ids({ device: "desktop", os: "mac", installed: false, page: "home" });
    expect(mac.has("get-app-desktop")).toBe(true);
    expect(mac.has("get-app-iphone")).toBe(false);
    const iphone = ids({ device: "phone", os: "ios", installed: false, page: "home" });
    expect(iphone.has("get-app-iphone")).toBe(true);
    expect(iphone.has("get-app-desktop")).toBe(false);
    const installed = ids({ device: "desktop", os: "mac", installed: true, page: "home" });
    expect(installed.has("get-app-desktop")).toBe(false);
    expect(installed.has("apple-get-app")).toBe(false);
  });

  it("knows which page a route belongs to", () => {
    expect(pageOf("/")).toBe("home");
    expect(pageOf("/library?view=week")).toBe("library");
    expect(pageOf("/settings/look-and-feel/sounds#click-sound")).toBe("settings");
    expect(pageOf("/jobs/abc")).toBe("job");
    expect(pageOf("/clips/abc")).toBe("clip");
    expect(pageOf("/get-app")).toBe("get_app");
    expect(pageOf("/nope")).toBe("not_found");
  });

  it("answers unknown questions with the fixed text and a Go Home button, never a guess", () => {
    const r = rank(corpus.docs, "what's the weather", [], evals.defaultContext, corpus);
    const a = compose(r);
    expect(a.known).toBe(false);
    expect(a.text).toBe("I don't know that one yet. Try other words, or pick a question below.");
    expect(a.actions).toEqual([{ id: "go-home", label: "Go Home", to: "/" }]);
  });

  it("lets a guide win a tie with a generated doc", () => {
    const base = { route: "/", where: "Home", keywords: [], answer: "", steps: [], actions: [] };
    const docs: HelpDoc[] = [
      { ...base, id: "a-page", kind: "page", title: "Paste link" },
      { ...base, id: "z-guide", kind: "guide", title: "Paste link" },
      ...Array.from({ length: 12 }, (_, i): HelpDoc => ({ ...base, id: `other-${i}`, kind: "page", title: `Something else ${i}` })),
    ];
    const r = rank(docs, "paste link", [], null, { synonyms: {}, stopwords: [] });
    expect(r.candidates[0]!.doc.id).toBe("z-guide");
  });
});
