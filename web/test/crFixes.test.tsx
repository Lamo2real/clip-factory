// The review fixes of the Content Rewards web part (docs/CONTRACTS.md §38): "Make clips anyway" keeps every soft stop
// he accepted (the API's PATCH replaces the list), Library asks only the two query shapes the API answers, the setup
// page has one vermilion button, step 3's words follow where the page runs, Home names buttons that exist, and the
// small helpers (safe links, countdown, bold only for the other site's labels).
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, Campaign, CrConnection, CrMoney, CrOverview, CrSubmission, SetupOverview } from "../src/api/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let current: Partial<Api> = {};
vi.mock("../src/api/index.ts", async (orig) => ({ ...(await orig<object>()), api: () => current as Api }));

const { ApiError } = await import("../src/api/errors.ts");
const { CR_IDS, crMockApi } = await import("../src/api/mock/contentrewards.ts");
const { NextStepPanel } = await import("../src/screens/campaigns/NextStep.tsx");
const { CrSetup, crStepHome } = await import("../src/screens/settings/setup/CrSetup.tsx");
const { ToastProvider } = await import("../src/components/Toasts.tsx");
const { CrPostLines } = await import("../src/components/CrPostLine.tsx");
const lib = await import("../src/lib/contentRewards.ts");

const conn = (over: Partial<CrConnection> = {}): CrConnection => ({
  status: "connected",
  canSubmit: true,
  crLinked: {},
  stepsDone: [],
  pilotEmail: { to: "support@contentrewards.com", subject: "s", body: "b", mailto: "mailto:support@contentrewards.com?subject=s" },
  ...over,
});
const money: CrMoney = {
  state: "none_yet",
  tag: "Content Rewards' numbers",
  asOf: null,
  stillEarningCents: null,
  onItsWayCents: null,
  readyToMoveCents: null,
  paidSoFarCents: null,
  lastPaidAt: null,
  waitingForBrand: 0,
  campaigns: [],
  celebrations: [],
} as unknown as CrMoney;
const overview = (c: CrConnection, campaigns: CrOverview["campaigns"] = []): CrOverview => ({ connection: c, campaigns, money, waitingSends: [] });
const setupNone = { platforms: [], ready: 0, values: {} } as unknown as SetupOverview;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  lib.resetCr();
  sessionStorage.clear();
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  Element.prototype.scrollIntoView = () => undefined;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as { __CF_CR_CONNECT__?: unknown }).__CF_CR_CONNECT__;
});

async function draw(node: React.ReactNode) {
  await act(async () => {
    root.render(<ToastProvider>{node}</ToastProvider>);
  });
  for (let i = 0; i < 3; i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
}
const vermilion = () => [...host.querySelectorAll(".btn--primary")].map((b) => b.textContent?.trim() ?? "");

async function mockCampaign(): Promise<Campaign> {
  sessionStorage.clear();
  const cr = crMockApi({ store: { clips: [], posts: [] }, setup: () => setupNone, publish: () => undefined });
  return cr.api.crCampaign(CR_IDS.faze);
}

describe("Make clips anyway (§38.4): every soft stop he accepted goes with the new one", () => {
  it("one soft stop accepted earlier and a second one now: one tap leads to Make clips for this campaign", async () => {
    const base = await mockCampaign();
    const low = { code: "low_rate", hard: false, text: "It pays only $0.50 per 1,000 views.", anyway: true } as const;
    const half = { code: "budget_half", hard: false, text: "Half the money is used. Post soon, before it runs out.", anyway: false } as const;
    const before: Campaign = {
      ...base,
      membership: "in",
      anyway: ["low_rate"],
      stops: [low, half],
      nextStep: { kind: "anyway", chip: "You're in", text: half.text, button: { label: "Make clips anyway", external: false, action: "anyway" } },
    };
    const sent: unknown[] = [];
    // As the API: PATCH keeps exactly the list it gets; Make clips shows only once nothing is left un-accepted.
    current = {
      crPatchCampaign: async (_id, body) => {
        sent.push(body);
        const kept = body.anyway ?? [];
        const open = before.stops.filter((s) => !kept.includes(s.code));
        return {
          ...before,
          anyway: kept,
          stops: before.stops.map((s) => ({ ...s, anyway: kept.includes(s.code) })),
          nextStep: open.length
            ? before.nextStep
            : { kind: "make_clips", chip: "You're in", text: "You're in! Make clips for this campaign.", button: { label: "Make clips for this campaign", href: `/?campaign=${before.campaignId}`, external: false } },
        } as Campaign;
      },
      crOverview: async () => overview(conn()),
    };
    function Card() {
      const [shown, setShown] = useState(before);
      return <NextStepPanel campaign={shown} onCampaign={setShown} onPickLogo={() => undefined} />;
    }
    await draw(<Card />);
    const tap = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Make clips anyway"))!;
    await act(async () => tap.click());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(sent).toEqual([{ anyway: expect.arrayContaining(["low_rate", "budget_half"]) }]);
    expect(host.textContent).toContain("Make clips for this campaign");
  });
});

describe("the mock answers like the API", () => {
  it("GET submissions with no query is refused; PATCH anyway replaces the list", async () => {
    sessionStorage.clear();
    const { api } = crMockApi({ store: { clips: [], posts: [] }, setup: () => setupNone, publish: () => undefined });
    await expect(api.crSubmissions({})).rejects.toBeInstanceOf(ApiError);
    await expect(api.crSubmissions({ campaignId: CR_IDS.money })).resolves.toBeInstanceOf(Array);
    const a = await api.crPatchCampaign(CR_IDS.faze, { anyway: ["low_rate", "budget_half"] });
    expect(a.anyway).toEqual(["budget_half", "low_rate"]);
    const b = await api.crPatchCampaign(CR_IDS.faze, { anyway: ["budget_half"] });
    expect(b.anyway).toEqual(["budget_half"]);
  });

  it("a TikTok-only campaign never says 'It goes up on nowhere only.'", async () => {
    sessionStorage.clear();
    const { api } = crMockApi({ store: { clips: [], posts: [] }, setup: () => setupNone, publish: () => undefined });
    const t = await api.crCampaign(CR_IDS.tiktok);
    expect(t.plainRules.join(" ")).not.toContain("nowhere");
  });
});

describe("Library's Content Rewards lines (§38.6, §38.8)", () => {
  it("reads each campaign with ?campaignId= and merges them; never a call with no query", async () => {
    const calls: unknown[] = [];
    const s = (postId: string, campaignId: string) => ({ postId, campaignId, clipId: "c1" }) as unknown as CrSubmission;
    current = {
      crSubmissions: async (q) => {
        calls.push(q);
        return q.campaignId === "a" ? [s("p1", "a")] : [s("p2", "b")];
      },
    };
    let got: CrSubmission[] = [];
    function Probe() {
      got = lib.useSubmissions({ campaignIds: ["a", "b", "a"] }).subs;
      return null;
    }
    await draw(<Probe />);
    expect(calls).toEqual([{ campaignId: "a" }, { campaignId: "b" }]);
    expect(got.map((x) => x.postId).sort()).toEqual(["p1", "p2"]);
    calls.length = 0;
    function None() {
      lib.useSubmissions({ campaignIds: [] });
      return null;
    }
    await draw(<None />);
    expect(calls).toEqual([]);
  });
});

describe("the setup page (§38.3)", () => {
  it("connected, step 2 not done, no campaigns: exactly one vermilion (step 2's Open), no Add a campaign", async () => {
    current = { crOverview: async () => overview(conn({ stepsDone: ["ready-account"] })), getSetup: async () => setupNone };
    await draw(<CrSetup />);
    expect(vermilion()).toEqual(["Open Content Rewards settings (opens in a new tab)"]);
    expect(host.textContent).not.toContain("Add a campaign");
  });

  it("every step done and no campaigns: Add a campaign is the one vermilion; the panel says You're connected", async () => {
    current = { crOverview: async () => overview(conn({ crLinked: { youtube: true } })), getSetup: async () => setupNone };
    await draw(<CrSetup />);
    expect(vermilion()).toEqual(["Add a campaign"]);
    expect(host.textContent).toContain("You're connected");
    // Content Rewards lets Clip Factory send: the "said no?" card is gone.
    expect(host.textContent).not.toContain("Content Rewards said no?");
  });

  it("in a browser, step 3 says where to do it, without the Mac app's lines or hints", async () => {
    current = { crOverview: async () => overview(conn({ status: "not_connected", canSubmit: false, stepsDone: ["ready-account", "ready-socials"] })), getSetup: async () => setupNone };
    await draw(<CrSetup />);
    const step3 = host.querySelector('[data-step="connect"]')!.textContent!;
    expect(step3).toContain("Connect works in the Clip Factory app on your Mac.");
    expect(step3).not.toContain("Your web browser opens");
    expect(step3).not.toContain("If you see");
  });

  it("in the Mac app, step 3's three lines show once", async () => {
    (window as { __CF_CR_CONNECT__?: unknown }).__CF_CR_CONNECT__ = { version: 1, open: async () => undefined, listen: async () => ({ port: 47811, expiresAt: "" }), result: async () => ({ status: "waiting" }), cancel: async () => undefined };
    current = { crOverview: async () => overview(conn({ status: "not_connected", canSubmit: false, stepsDone: ["ready-account", "ready-socials"] })), getSetup: async () => setupNone };
    await draw(<CrSetup />);
    const step3 = host.querySelector('[data-step="connect"]')!.textContent!;
    expect(step3.split("Your web browser opens").length - 1).toBe(1);
    expect(vermilion()).toEqual(["Connect Content Rewards"]);
  });

  it("signed out by Content Rewards: one Connect on the page (the panel's vermilion Connect again), and it says so", async () => {
    (window as { __CF_CR_CONNECT__?: unknown }).__CF_CR_CONNECT__ = { version: 1, open: async () => undefined, listen: async () => ({ port: 47811, expiresAt: "" }), result: async () => ({ status: "waiting" }), cancel: async () => undefined };
    current = { crOverview: async () => overview(conn({ status: "needs_reconnect", canSubmit: false, crLinked: { youtube: true }, connectedAt: "2026-11-01T10:00:00Z" })), getSetup: async () => setupNone };
    await draw(<CrSetup />);
    expect(vermilion()).toEqual(["Connect again"]);
    const connects = [...host.querySelectorAll("button:not(.gstep__head)")].filter((b) => /Connect (Content Rewards|again)/.test(b.textContent ?? ""));
    expect(connects).toHaveLength(1);
    expect(host.textContent).toContain("Content Rewards signed you out.");
    expect(host.textContent).toContain("Sign in again");
    expect(host.textContent).not.toContain("Signed in to Content Rewards since");
  });

  it("signed in, in the Mac app: one Connect on the page (the panel's glass Connect again)", async () => {
    (window as { __CF_CR_CONNECT__?: unknown }).__CF_CR_CONNECT__ = { version: 1, open: async () => undefined, listen: async () => ({ port: 47811, expiresAt: "" }), result: async () => ({ status: "waiting" }), cancel: async () => undefined };
    current = { crOverview: async () => overview(conn({ crLinked: { youtube: true } }), [{ campaignId: CR_IDS.faze } as never]), getSetup: async () => setupNone };
    await draw(<CrSetup />);
    // Open step 3 too: its body has no second Connect.
    await act(async () => (host.querySelector('[data-step="connect"] .gstep__head') as HTMLButtonElement).click());
    const connects = [...host.querySelectorAll("button:not(.gstep__head)")].filter((b) => /Connect (Content Rewards|again)/.test(b.textContent ?? ""));
    expect(connects.map((b) => b.textContent)).toEqual(["Connect again"]);
    expect(vermilion()).toEqual([]);
  });

  it("Content Rewards said no? wears one info mark, in the number's place (never two)", async () => {
    current = { crOverview: async () => overview(conn({ status: "read_only", canSubmit: false, stepsDone: ["ready-account", "ready-socials"] })), getSetup: async () => setupNone };
    await draw(<CrSetup />);
    const head = host.querySelector('[data-step="connect-pilot"] .gstep__head')!;
    expect(head.textContent).toContain("Content Rewards said no?");
    expect(head.querySelectorAll(".gstep__icon")).toHaveLength(0);
    expect(head.querySelectorAll(".gstep__num svg")).toHaveLength(1);
    // The mark and the open/close chevron: nothing else draws in the row.
    expect(head.querySelectorAll("svg")).toHaveLength(2);
    // Numbered steps keep their number and their own picture.
    const step1 = host.querySelector('[data-step="ready-account"] .gstep__head')!;
    expect(step1.querySelectorAll(".gstep__icon")).toHaveLength(1);
  });

  it("phones: steps 1's lines sit above the pinned pair's box, which starts with the pair's room", async () => {
    const before = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia;
    try {
      current = { crOverview: async () => overview(conn({ status: "not_connected", canSubmit: false })), getSetup: async () => setupNone };
      await draw(<CrSetup />);
      const body = host.querySelector('[data-step="ready-account"] .gstep__body')!;
      const rest = body.querySelector(".gstep__rest")!;
      const say = body.querySelector(".gstep__say")!;
      const pin = rest.querySelector(".cr-pin")!;
      expect(rest.classList.contains("has-room")).toBe(true);
      // Every line of the step comes before the sticky box (so the pair can never ride up over one), the pair last.
      expect(rest.contains(say)).toBe(false);
      expect(say.compareDocumentPosition(rest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(rest.lastElementChild).toBe(pin);
      expect([...pin.querySelectorAll("a, button")].map((b) => b.textContent?.replace("(opens in a new tab)", "").trim())).toEqual(["Open Content Rewards", "I have an account"]);
      // The room is the pair's own height (0 in jsdom, which lays nothing out).
      expect((rest as HTMLElement).style.getPropertyValue("--pin-room")).toBe("0px");
      // Only the open, pinned step with its own answer gets the room.
      expect(host.querySelectorAll(".gstep__rest.has-room")).toHaveLength(1);
    } finally {
      window.matchMedia = before;
    }
  });

  it("an Ask button for a join or money step lands where that step is", () => {
    expect(crStepHome("#step-join-copy")).toBe("/campaigns#step-join-copy");
    expect(crStepHome("#step-move-withdraw")).toBe("/money#content-rewards");
    expect(crStepHome("#step-connect")).toBeNull();
    expect(crStepHome("")).toBeNull();
  });
});

describe("send by hand: Try sending again (§38.8)", () => {
  const waiting = (over: Partial<CrSubmission> = {}) =>
    ({
      postId: "p1",
      clipId: "c1",
      clipTitle: "Big win",
      campaignId: CR_IDS.faze,
      campaignName: "FaZe Clips",
      platform: "youtube",
      url: "https://youtu.be/x",
      state: "send_by_hand",
      line: "",
      views: null,
      earned: null,
      minutesLeft: 12,
      sendBy: new Date(Date.now() + 12 * 60_000).toISOString(),
      openCampaignHref: `https://contentrewards.com/c/campaigns/${CR_IDS.faze}`,
      ...over,
    }) as CrSubmission;
  it("shows while Clip Factory may send and sends it again; hidden when it may not", async () => {
    const sent: string[] = [];
    current = {
      crOverview: async () => overview(conn()),
      crSendSubmission: async (id) => (sent.push(id), { ...waiting(), state: "sent" }),
    };
    let got: CrSubmission | null = null;
    await draw(<CrPostLines subs={[waiting()]} onChange={(n) => (got = n)} />);
    const again = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Try sending again"))!;
    expect(again).toBeTruthy();
    await act(async () => again.click());
    expect(sent).toEqual(["p1"]);
    expect(got).toMatchObject({ state: "sent" });

    lib.resetCr();
    current = { crOverview: async () => overview(conn({ status: "read_only", canSubmit: false })) };
    await draw(<CrPostLines subs={[waiting()]} onChange={() => undefined} />);
    expect(host.textContent).not.toContain("Try sending again");
  });
});

describe("small helpers", () => {
  it("Home's words for a hard stop name buttons that are on Home", () => {
    const logo = lib.homeStop({ code: "logo_missing", text: lib.stopText("logo_missing") });
    expect(logo).toEqual({ short: "Add the logo first", text: expect.stringContaining("Open the campaign"), openCard: true });
    expect(logo.text).not.toContain("below");
    expect(lib.homeStop({ code: "rules_failed", text: lib.stopText("rules_failed") }).text).not.toContain("below");
    expect(lib.homeStop({ code: "rules_reading", text: "x" }).short).toBe("Reading the rules…");
    expect(lib.homeStop({ code: "paused", text: "p" })).toEqual({ short: "Campaign paused", text: "p", openCard: false });
  });

  it("opens only https pages; a mailto only to Content Rewards' support", () => {
    expect(lib.safeHref("https://contentrewards.com/c/submissions")).toBe("https://contentrewards.com/c/submissions");
    expect(lib.safeHref("javascript:alert(1)")).toBe("https://contentrewards.com/c/submissions");
    expect(lib.safeHref("data:text/html,x", "https://contentrewards.com/c/campaigns/1")).toBe("https://contentrewards.com/c/campaigns/1");
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    void lib.copyAndOpen("t", "javascript:alert(1)", async () => true, "https://contentrewards.com/c/home");
    expect(open).toHaveBeenCalledWith("https://contentrewards.com/c/home", "_blank", "noopener,noreferrer");
    open.mockRestore();
    expect(lib.safeMailto("mailto:support@contentrewards.com?subject=x", "F")).toBe("mailto:support@contentrewards.com?subject=x");
    expect(lib.safeMailto("javascript:alert(1)", "F")).toBe("F");
    expect(lib.crCampaignUrl(CR_IDS.faze)).toBe(`https://contentrewards.com/c/campaigns/${CR_IDS.faze}`);
    expect(lib.crCampaignUrl("../x")).toBe("https://contentrewards.com/c/submissions");
  });

  it("bold only for the code's own button names, never inside the brand's quoted words", () => {
    expect(lib.richLine("Tap **Accounts**. “**big** logo”")).toBe("Tap **Accounts**. “*​*big*​* logo”");
  });

  it("the minutes left count down from sendBy, and a send whose time is up leaves the group", () => {
    const now = Date.parse("2026-11-21T12:00:00Z");
    const s = { postId: "p", clipId: "c", campaignId: "k", platform: "youtube", state: "send_by_hand", url: "https://youtu.be/x", minutesLeft: 12, sendBy: "2026-11-21T12:05:30Z", openCampaignHref: "https://contentrewards.com/c/campaigns/k" } as unknown as CrSubmission;
    expect(lib.minutesLeftOf(s, now)).toBe(6);
    expect(lib.sendGroups([s], now)[0]!.line).toContain("(6 min left)");
    expect(lib.sendGroups([s], now + 6 * 60_000)).toEqual([]);
    expect(lib.minutesLeftOf({ minutesLeft: 9 }, now)).toBe(9);
  });

  it("the send hints name each post's own place", () => {
    const h = lib.sendHints(["instagram", "x"]).map((x) => x.see);
    expect(h).toContain("“You don't have a linked Instagram account”");
    expect(h).toContain("“You don't have a linked X account”");
    expect(h.join(" ")).not.toContain("YouTube");
  });

  it("signed out by Content Rewards: only step 3 opens again (he has an account)", () => {
    expect(lib.crStepsDone(conn({ status: "needs_reconnect", stepsDone: [] }))["ready-account"]).toBe(true);
    expect(lib.crStepsDone(conn({ status: "needs_reconnect" })).connect).toBe(false);
  });
});
