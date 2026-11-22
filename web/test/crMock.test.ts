// Mock mode's Content Rewards (docs/CONTRACTS.md §38.18): the fixtures and the walk from a fresh owner to a campaign
// he is in, with the API's sentences, so the e2e journeys stand on something true.
import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import { CR_IDS, crMockApi } from "../src/api/mock/contentrewards.ts";
import type { SetupOverview } from "../src/api/types.ts";

const setup = (ready: string[] = ["youtube", "instagram"], tiktokAudit = false): SetupOverview =>
  ({
    platforms: ["youtube", "tiktok", "instagram", "facebook", "x"].map((p) => ({
      platform: p,
      ready: ready.includes(p),
      stepsDone: [],
      keys: { saved: true },
      account: { platform: p, status: ready.includes(p) ? "connected" : "not_connected" },
      gates: p === "tiktok" ? [{ key: "posting_audit", state: tiktokAudit ? "ok" : "limited" }] : [],
    })),
    ready: ready.length,
    values: {},
  }) as unknown as SetupOverview;

type Controls = { join(id: string): void; reset(s?: string): void; sendFails(postId: string): void; connect(): void };
const controls = () => (window as unknown as { __cfMock: { cr: Controls } }).__cfMock.cr;

beforeEach(() => sessionStorage.clear());

function make(opts: { fresh?: boolean; ready?: string[]; audit?: boolean } = {}) {
  if (opts.fresh) sessionStorage.setItem("cf-mock-cr-start", "fresh");
  const published: string[] = [];
  const cr = crMockApi({ store: { clips: [], posts: [] }, setup: () => setup(opts.ready, opts.audit), publish: (id) => published.push(id) });
  return { ...cr, published };
}

describe("the mock Content Rewards", () => {
  it("a fresh owner: not connected, no campaigns, money says connect first", async () => {
    const { api } = make({ fresh: true });
    const o = await api.crOverview();
    expect(o.connection.status).toBe("not_connected");
    expect(o.campaigns).toEqual([]);
    expect(o.money.state).toBe("not_connected");
    expect(o.connection.pilotEmail.mailto).toMatch(/^mailto:support@contentrewards\.com\?subject=/);
  });

  it("Connect → add a campaign → not joined → joined → You're in! (once)", async () => {
    const { api, published } = make({ fresh: true });
    const fin = await api.crConnectFinish({ state: "s", code: "c" });
    expect(fin.result).toBe("connected");
    const added = await api.crAddCampaign(`https://contentrewards.com/c/campaigns/${CR_IDS.faze}`);
    expect(added.campaign!.membership).toBe("not_joined");
    expect(added.campaign!.nextStep.kind).toBe("join");
    expect(added.campaign!.rulesState).toBe("waiting_for_join");
    expect(published).toContain(`campaign:${CR_IDS.faze}`);
    controls().join(CR_IDS.faze);
    const joined = await api.crCampaign(CR_IDS.faze);
    expect(joined.membership).toBe("in");
    expect(joined.celebrate).toBe("in");
    await api.crSeen(`in:${CR_IDS.faze}`);
    expect((await api.crCampaign(CR_IDS.faze)).celebrate).toBeUndefined();
    expect(joined.uploadPlaces).toEqual(["youtube", "instagram"]);
  });

  it("a group link answers its choices and adds nothing", async () => {
    const { api } = make({ fresh: true });
    const g = await api.crAddCampaign(`https://contentrewards.com/c/campaigns/${CR_IDS.group}?group=1`);
    expect(g.group!.choices.map((c) => c.campaignId)).toEqual([CR_IDS.season1, CR_IDS.season2]);
    expect((await api.crCampaigns()).length).toBe(0);
  });

  it("refused links come back as the contract's 400 sentence", async () => {
    const { api } = make({ fresh: true });
    await expect(api.crAddCampaign("https://contentrewards.com/c/invite/abc")).rejects.toMatchObject({ status: 400 });
  });

  it("an application campaign: Applied? → Yes, I applied → waiting for the brand", async () => {
    const { api } = make();
    let c = await api.crCampaign(CR_IDS.apply);
    expect(c.membership).toBe("apply_first");
    expect(c.nextStep.button?.action).toBe("said_applied");
    c = await api.crPatchCampaign(CR_IDS.apply, { said: "applied" });
    expect(c.membership).toBe("waiting");
    expect(c.nextStep.button).toBeUndefined();
  });

  it("the seeded campaigns: logo needed, paused, TikTok only, manual with pasted rules", async () => {
    const { api } = make({ ready: ["youtube", "instagram", "facebook"] });
    expect((await api.crCampaign(CR_IDS.logo)).nextStep.kind).toBe("logo");
    expect((await api.crCampaign(CR_IDS.paused)).nextStep.chip).toBe("Paused");
    expect((await api.crCampaign(CR_IDS.tiktok)).stops.map((s) => s.code)).toContain("tiktok_only");
    const manual = await api.crCampaign(CR_IDS.manual);
    expect(manual.membership).toBe("manual");
    expect(manual.plainRules.join(" ")).toContain("#PixelPals");
  });

  it("a logo link: a folder, another site", async () => {
    const { api } = make();
    const folder = await api.crLogoLink(CR_IDS.logo, "https://drive.google.com/drive/folders/abc");
    expect(folder.logo).toMatchObject({ state: "failed", error: "That's a folder. Open the logo file in it, then copy that link." });
    await expect(api.crLogoLink(CR_IDS.logo, "https://example.com/logo.png")).rejects.toBeInstanceOf(ApiError);
    const ok = await api.crLogoLink(CR_IDS.logo, "https://drive.google.com/file/d/abc/view");
    expect(ok.logo.state).toBe("ready");
    await expect(api.crLogoUpload(CR_IDS.logo, { filename: "x.svg", contentType: "image/svg+xml" as "image/png", size: 10 })).rejects.toMatchObject({ status: 400 });
  });

  it("a hard stop refuses a campaign job; a soft stop needs Make clips anyway", async () => {
    const m = make();
    await expect(m.jobCheck(CR_IDS.paused, [])).rejects.toMatchObject({ status: 409 });
    await expect(m.jobCheck(CR_IDS.apply, [])).rejects.toMatchObject({ status: 409 });
    await expect(m.jobCheck(CR_IDS.faze, [])).resolves.toBeUndefined();
  });

  it("Confirm for a campaign clip: only its places, public, never made for kids", async () => {
    const m = make();
    const clip = { campaignId: CR_IDS.faze } as never;
    await expect(m.confirmCheck(clip, undefined, undefined, undefined)).rejects.toThrow("Pick where it goes, then tap Upload.");
    await expect(m.confirmCheck(clip, ["x"], undefined, undefined)).rejects.toThrow("This campaign doesn't pay for X. Turn it off, then tap Upload.");
    await expect(
      m.confirmCheck(clip, ["youtube"], { youtube: { privacy: "unlisted", category: "20", madeForKids: false, notifySubscribers: true, embeddable: true } }, undefined),
    ).rejects.toThrow("Campaign clips must be public. Pick Everyone.");
    await expect(m.confirmCheck(clip, ["youtube"], { youtube: { privacy: "public", category: "20", madeForKids: false, notifySubscribers: true, embeddable: true } }, undefined)).resolves.toBeUndefined();
  });
});
