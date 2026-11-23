// Reference videos from a link (docs/CONTRACTS.md §45.40): the web's copy of the allowlist gives the answers of the
// fixture every copy reads (stories/agent/tests/fixtures/reference_links.json), and the mock walks a link reference
// the way the API and Clips Funded's own runtime do: link → fetching → ready, refFetchFail → fetch_failed and Try
// again, the same link twice, three on their way at once, and the analysis refused until the video is here.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { refLink, REF_LINK_REFUSED, shareLink, SITE_NAME, siteOf, type RefSite } from "../src/stories/api/refLinks.ts";
import * as chat from "../src/stories/api/mock/chat.ts";
import * as references from "../src/stories/api/mock/references.ts";
import { createStore, type MockStore } from "../src/stories/api/mock/store.ts";
import type { StoriesApi } from "../src/stories/api/types.ts";

interface Fixture {
  sites: Record<RefSite, string>;
  platforms: RefSite[];
  cases: ({ in: string; url: string; site: RefSite } | { in: string; why: string })[];
}

const FIXTURE: Fixture = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "stories", "agent", "tests", "fixtures", "reference_links.json"), "utf8"));

describe("refLink: the allowlist every copy shares", () => {
  it("the fixture has every site, good links and every kind of refusal", () => {
    expect(SITE_NAME).toEqual(FIXTURE.sites);
    const sites = new Set(FIXTURE.cases.flatMap((c) => ("site" in c ? [c.site] : [])));
    expect([...sites].sort()).toEqual(Object.keys(SITE_NAME).sort());
    const whys = new Set(FIXTURE.cases.flatMap((c) => ("why" in c ? [c.why] : [])));
    expect([...whys].sort()).toEqual(Object.keys(REF_LINK_REFUSED).sort());
  });

  for (const c of FIXTURE.cases)
    it(`${JSON.stringify(c.in)} → ${"url" in c ? c.url : c.why}`, () => {
      expect(refLink(c.in)).toEqual("url" in c ? { ok: true, url: c.url, site: c.site } : { ok: false, why: c.why });
    });

  it("a cleaned link is clean: the same answer again, and its site", () => {
    for (const c of FIXTURE.cases) {
      if (!("url" in c)) continue;
      expect(refLink(c.url)).toEqual({ ok: true, url: c.url, site: c.site });
      expect(siteOf(c.url)).toBe(c.site);
    }
    expect(siteOf("https://vimeo.com/1")).toBeNull();
  });

  it("at most 2048 characters, and never a control character", () => {
    const long = `https://www.youtube.com/watch?v=dQw4w9WgXcQ&x=${"a".repeat(2048)}`;
    expect(refLink(long)).toEqual({ ok: false, why: "not_a_link" });
    expect(refLink(`https://youtu.be/dQw4w9WgXcQ\u0000`)).toEqual({ ok: false, why: "not_a_link" });
    expect(refLink("x\u2003y")).toEqual({ ok: false, why: "not_a_link" });
    expect(shareLink("a\u00a0https://youtu.be/dQw4w9WgXcQ")).toBe("https://youtu.be/dQw4w9WgXcQ");
  });
});

// --- the mock --------------------------------------------------------------------------------------------------------

type RefApi = Pick<StoriesApi, (typeof references.KEYS)[number]>;
let store: MockStore;
let api: RefApi;
const TIKTOK = "https://www.tiktok.com/@pip.the.cat/video/7301234567890123456";

function setup(knobs: Record<string, unknown> = {}) {
  store = createStore();
  store.knobs = { ...knobs };
  chat.seed(store);
  references.seed(store);
  api = references.api(store);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-23T12:00:00.000Z"));
  setup();
});

afterEach(() => {
  vi.useRealTimers();
});

async function call<T>(p: Promise<T>): Promise<T> {
  const out = p.then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e }),
  );
  await vi.advanceTimersByTimeAsync(400);
  const r = await out;
  if (!r.ok) throw r.e;
  return r.v;
}

async function refused(p: Promise<unknown>): Promise<ApiError> {
  try {
    await call(p);
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }
  throw new Error("expected the call to be refused");
}

describe("the mock: a reference from a link", () => {
  it("link → fetching (its own job, no file yet) → ready with the file, the title kept", async () => {
    const made = await call(api.createReferenceFromLink("stories", { url: `Look! ${TIKTOK}?is_from_webapp=1 #fyp` }));
    expect(made.reference).toMatchObject({ status: "fetching", title: "TikTok video", link: TIKTOK, bytes: 0, durationSec: null, currentJobId: made.job.jobId });
    expect(made.reference.url).toBeUndefined();
    expect(made.job).toMatchObject({ jobType: "reference_fetch", contentType: "reference", contentId: made.reference.refId, status: "queued", configuration: { run: ["get"] } });
    expect(made.job.steps).toEqual([{ key: "get", label: "Get the video", status: "pending" }]);
    const list = await call(api.listReferences("stories"));
    expect(list[0]!.refId).toBe(made.reference.refId); // the newest is first
    let got = await call(api.getReference("stories", made.reference.refId));
    expect(got.reference.status).toBe("fetching");
    expect(got.job).toBeNull(); // `job` is the analysis job only
    expect(got.fetchJob).toMatchObject({ jobId: made.job.jobId, status: "running" });
    await vi.advanceTimersByTimeAsync(2500);
    got = await call(api.getReference("stories", made.reference.refId));
    expect(got.reference).toMatchObject({ status: "ready", title: "TikTok video", bytes: 24 * 1024 * 1024, durationSec: 42, currentJobId: null, link: TIKTOK });
    expect(got.reference.url).toBeTruthy();
    expect(got.fetchJob).toMatchObject({ status: "ready", progress: 1 });
    expect(got.fetchJob!.steps[0]!.status).toBe("done");
    expect((await call(api.analyzeReference("stories", made.reference.refId))).reference.status).toBe("analyzing");
  });

  it("an upload has no link and no fetch job", async () => {
    const got = await call(api.getReference("stories", references.SEED_IDS.ready));
    expect(got.reference.link).toBeNull();
    expect(got.fetchJob).toBeNull();
  });

  it("a given title is kept, and the video's length comes from refUploadSeconds", async () => {
    setup({ refUploadSeconds: 17 });
    const made = await call(api.createReferenceFromLink("stories", { url: "https://youtu.be/dQw4w9WgXcQ", title: "  Pip   skates " }));
    expect(made.reference.title).toBe("Pip skates");
    await vi.advanceTimersByTimeAsync(2500);
    expect((await call(api.getReference("stories", made.reference.refId))).reference).toMatchObject({ status: "ready", title: "Pip skates", durationSec: 17 });
  });

  it("refuses what the API refuses, with the card's sentences", async () => {
    for (const [url, why] of [["https://vimeo.com/1", "other_site"], ["https://www.tiktok.com/@pip", "not_one_video"], ["hello", "not_a_link"], ["", "empty"]] as const) {
      const e = await refused(api.createReferenceFromLink("stories", { url }));
      expect([e.status, e.message, e.field]).toEqual([400, REF_LINK_REFUSED[why], "url"]);
    }
    expect((await refused(api.createReferenceFromLink("stories", { url: TIKTOK, title: "x".repeat(81) }))).field).toBe("title");
    expect((await refused(api.createReferenceFromLink("stories", { url: TIKTOK, extra: 1 } as never))).status).toBe(400);
  });

  it("the same link twice, three on their way at once, and the 100 limit", async () => {
    await call(api.createReferenceFromLink("stories", { url: TIKTOK }));
    const twice = await refused(api.createReferenceFromLink("stories", { url: `${TIKTOK}?lang=en` }));
    expect([twice.status, twice.message]).toEqual([409, "That video is in your list already."]);
    await call(api.createReferenceFromLink("stories", { url: "https://youtu.be/dQw4w9WgXcQ" }));
    await call(api.createReferenceFromLink("stories", { url: "https://x.com/pip/status/1" }));
    const three = await refused(api.createReferenceFromLink("stories", { url: "https://www.instagram.com/reel/Cabc/" }));
    expect([three.status, three.message]).toEqual([409, "Three videos are on their way already. Wait for one to arrive."]);
    await vi.advanceTimersByTimeAsync(2500);
    await call(api.createReferenceFromLink("stories", { url: "https://www.instagram.com/reel/Cabc/" })); // one arrived
    setup();
    for (let i = store.references.length; i < 100; i++) store.references.push({ ...store.references[0]!, refId: `R${i}` });
    const full = await refused(api.createReferenceFromLink("stories", { url: TIKTOK }));
    expect([full.status, full.message]).toEqual([409, "You have 100 reference videos already. Delete one first."]);
  });

  it("refFetchFail: fetch_failed with the sentence on the job and its step, then Try again gets it", async () => {
    setup({ refFetchFail: "That video is gone. Check the link." });
    const made = await call(api.createReferenceFromLink("stories", { url: TIKTOK }));
    expect((await refused(api.analyzeReference("stories", made.reference.refId))).message).toBe("Wait until the video is here.");
    expect((await refused(api.fetchReferenceAgain("stories", made.reference.refId))).message).toBe("It is getting the video now.");
    await vi.advanceTimersByTimeAsync(2500);
    let got = await call(api.getReference("stories", made.reference.refId));
    expect(got.reference).toMatchObject({ status: "fetch_failed", currentJobId: null });
    expect(got.reference.url).toBeUndefined();
    expect(got.fetchJob).toMatchObject({ status: "failed", error: "That video is gone. Check the link." });
    expect(got.fetchJob!.steps[0]).toMatchObject({ status: "failed", message: "That video is gone. Check the link." });
    expect((await refused(api.analyzeReference("stories", made.reference.refId))).message).toBe("Get the video first. Tap Try again.");
    const again = await call(api.fetchReferenceAgain("stories", made.reference.refId));
    expect(again.reference.status).toBe("fetching");
    expect(again.job.jobId).not.toBe(made.job.jobId);
    await vi.advanceTimersByTimeAsync(2500);
    got = await call(api.getReference("stories", made.reference.refId));
    expect(got.reference.status).toBe("ready");
    expect(got.fetchJob!.jobId).toBe(again.job.jobId); // the newest fetch job
    expect((await refused(api.fetchReferenceAgain("stories", made.reference.refId))).message).toBe("This video is here already.");
  });

  it("a rename while it is on its way is kept; delete takes its fetch job too", async () => {
    const made = await call(api.createReferenceFromLink("stories", { url: TIKTOK }));
    await call(api.patchReference("stories", made.reference.refId, { title: "Mine" }));
    await vi.advanceTimersByTimeAsync(2500);
    expect((await call(api.getReference("stories", made.reference.refId))).reference.title).toBe("Mine");
    await call(api.deleteReferenceVideo("stories", made.reference.refId));
    expect(store.jobs.filter((j) => j.contentId === made.reference.refId)).toEqual([]);
  });
});
