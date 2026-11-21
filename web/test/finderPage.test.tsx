// The Find page drawn in jsdom (docs/CONTRACTS.md §41.1, §41.6 Tests): every state of §41.1's table with its single
// vermilion; every match has "Open on Content Rewards" and only the open match holds the vermilion; Not for me opens
// the next; Open → the steps and "I joined: add it" (opened kept when the PATCH fails, one retry); two hours later
// the vermilion is back on Open; not signed in → the rules box and the read right after the add; the application
// steps with the Copy chips; the If you see fold; back to the window → "You're in!" with Reading the rules…, then
// Make clips (still there after a live refetch); Why not more?; the want card's PATCH bodies; Updating your matches…;
// the TikTok chip; Set up another place; the no-place state; the ask card only while signed in.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import type { Api, Campaign, CampaignSummary, CrOverview, Finder, FinderMatch, LiveEvent, Platform, SetupOverview } from "../src/api/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let fake: Partial<Api> = {};
vi.mock("../src/api/index.ts", async (orig) => ({ ...(await orig<object>()), api: () => fake as Api }));
vi.mock("../src/app/session.tsx", () => ({ useSession: () => ({ me: { settings: { notify: { contentRewards: newsOn } } } }) }));
let newsOn = true;
// A small live hub: the page's live news and resyncs arrive through it.
const hub = new Set<(s: { kind: "event"; event: LiveEvent } | { kind: "resync" }) => void>();
vi.mock("../src/lib/live.ts", async () => {
  const { useEffect, useRef } = await import("react");
  return {
    onLiveSignal: (fn: never) => {
      hub.add(fn);
      return () => hub.delete(fn);
    },
    useLiveEvents: (onEvent: (e: LiveEvent) => void, onResync: () => void) => {
      const ref = useRef({ onEvent, onResync });
      ref.current = { onEvent, onResync };
      useEffect(() => {
        const fn = (s: { kind: "event"; event: LiveEvent } | { kind: "resync" }) => (s.kind === "resync" ? ref.current.onResync() : ref.current.onEvent(s.event));
        hub.add(fn as never);
        return () => void hub.delete(fn as never);
      }, []);
    },
    useLivePoll: () => undefined,
  };
});

const { FindPage } = await import("../src/screens/campaigns/FindPage.tsx");
const { ToastProvider } = await import("../src/components/Toasts.tsx");
const { resetCr } = await import("../src/lib/contentRewards.ts");
const { resetFinder, WANT_DEFAULTS, LIVE_DEBOUNCE_MS } = await import("../src/lib/finder.ts");
const { CampaignsRow } = await import("../src/screens/home/CampaignsRow.tsx");
const { CampaignsPage } = await import("../src/screens/campaigns/CampaignsPage.tsx");

const U = {
  a: "c0c37381-e244-4643-98bd-edbff4bc1465",
  b: "3d9ef19f-1256-47ca-b630-e33e2c923969",
  c: "e4a9465f-d415-4e30-bf53-e46014958bc6",
  app: "0d341d7d-e390-4807-9149-9b5294dff3e6",
};

const match = (id: string, over: Partial<FinderMatch> = {}): FinderMatch => ({
  campaignId: id,
  url: `https://contentrewards.com/c/campaigns/${id}`,
  name: `Campaign ${id.slice(0, 4)}`,
  brand: "Brand",
  access: "open",
  kind: "cpm",
  pay: [{ platform: "youtube", line: "$1.50 per 1,000 views · up to $250 a clip", per1kCents: 150, topPer1kCents: 150, perPostCents: null, maxPayoutCents: 25_000, geo: false }],
  maxPerClipCents: 25_000,
  budget: { totalCents: 250_000, leftCents: 241_010, usedPct: 4, line: "$2,410.10 left of $2,500", asOf: "2026-11-21T14:10:00Z", tag: "Content Rewards' numbers" },
  categories: [],
  why: "Pays $1.50 per 1,000 views on YouTube and Instagram. 96% of the money left. Open to join.",
  notes: ["It has 2 rules you see once you join."],
  headsUp: [],
  cantTell: [],
  hiddenRules: 2,
  launchedAt: "2026-11-14T17:23:44Z",
  rank: 1,
  isNew: false,
  ...over,
});

const finder = (over: Partial<Finder> = {}): Finder => ({
  state: "ok",
  want: { ...WANT_DEFAULTS },
  resolvedPlaces: ["youtube", "instagram"],
  tiktokWaits: true,
  matches: [match(U.a), match(U.b), match(U.c)],
  newCount: 0,
  hiddenCount: 0,
  skipped: [
    { code: "low_pay", count: 62, text: "62 pay less than $1.00 per 1,000 views." },
    { code: "hidden", count: 3, text: "3 you said Not for me." },
  ],
  looked: { campaigns: 154, pending: 0 },
  categories: [{ id: "gaming", name: "Gaming", count: 9 }],
  lastLookAt: "2026-11-21T14:10:00Z",
  asOf: "2026-11-21T14:10:00Z",
  signedIn: true,
  ...over,
});

function setupOf(ready: Platform[]): SetupOverview {
  return {
    platforms: (["youtube", "tiktok", "instagram", "facebook", "x"] as Platform[]).map((p) => ({
      platform: p,
      ready: ready.includes(p),
      stepsDone: [],
      keys: { saved: ready.includes(p) },
      account: ready.includes(p) ? { platform: p, status: "connected", handle: p === "youtube" ? "@clipfactorygaming" : "@clipfactory.gg" } : { platform: p, status: "not_connected" },
      gates: p === "tiktok" ? [{ key: "posting_audit", state: "limited" }] : [],
    })),
    ready: ready.length,
    values: {},
  } as unknown as SetupOverview;
}

const overview = (over: Partial<CrOverview> = {}): CrOverview =>
  ({
    connection: { status: "connected", canSubmit: true, crLinked: {}, stepsDone: [], pilotEmail: { to: "", subject: "", body: "", mailto: "" } },
    campaigns: [],
    money: { state: "none_yet", tag: "Content Rewards' numbers", stillEarningCents: null, onItsWayCents: null, readyToMoveCents: null, paidSoFarCents: null, waitingForBrand: 0, campaigns: [], celebrations: [] },
    waitingSends: [],
    finder: { on: true, started: true, newCount: 0, matches: 3 },
    ...over,
  }) as CrOverview;

let host: HTMLElement;
let root: Root;
let current: Finder;
beforeEach(() => {
  resetCr();
  resetFinder();
  hub.clear();
  newsOn = true;
  history.replaceState(null, "", "/campaigns/find");
  current = finder();
  fake = {
    crFinder: vi.fn(async () => structuredClone(current)),
    crPatchFinder: vi.fn(async () => structuredClone(current)),
    crFinderSaid: vi.fn(async () => structuredClone(current)),
    crFinderAdd: vi.fn(async (id: string) => ({ campaignId: id }) as Campaign),
    crFinderJoined: vi.fn(async () => [] as CampaignSummary[]),
    crFinderCheck: vi.fn(async () => ({ started: true, nextAllowedAt: "2026-11-21T14:40:00Z" })),
    crFinderAsk: vi.fn(async () => ({ askedAt: "2026-11-21T15:00:00Z" })),
    crReadCampaign: vi.fn(async (id: string) => ({ campaignId: id }) as Campaign),
    crOverview: vi.fn(async () => overview()),
    getSetup: vi.fn(async () => setupOf(["youtube", "instagram", "facebook", "x"])),
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const flush = () => act(async () => await new Promise((r) => setTimeout(r, 0)));
async function draw(node: React.ReactNode = <FindPage />) {
  await act(async () => {
    root.render(<ToastProvider>{node}</ToastProvider>);
  });
  await flush();
  await flush();
}
const main = () => [...host.querySelectorAll<HTMLElement>(".btn--primary")];
const text = () => host.textContent ?? "";
const button = (name: string | RegExp, within: ParentNode = host) =>
  [...within.querySelectorAll<HTMLElement>("button, a")].find((b) => (typeof name === "string" ? b.textContent?.trim() === name : name.test(b.textContent ?? "")))!;
const cards = () => [...host.querySelectorAll<HTMLElement>(".finder-match")];
async function tap(el: HTMLElement | undefined) {
  expect(el, "the button is on screen").toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}
async function live(event: LiveEvent) {
  await act(async () => {
    for (const fn of hub) fn({ kind: "event", event });
  });
  await flush();
}

describe("every state of §41.1's table, with its single vermilion", () => {
  it("new: the What you want card open with the defaults, and Find campaigns for me", async () => {
    current = finder({ state: "new", matches: [], lastLookAt: undefined });
    await draw();
    expect(text()).toContain("What you want");
    expect(text()).toContain("for every 1,000 views");
    expect(main().map((b) => b.textContent?.trim())).toEqual(["Find campaigns for me"]);
    expect(host.querySelector<HTMLInputElement>("input[value='100']")!.checked).toBe(true);
    expect(host.querySelector<HTMLInputElement>("input[value='25']")!.checked).toBe(true);
    expect(text()).toContain("The places you set up.");
    expect(text()).toContain("I skip campaigns Clip Factory can't make clips for, like ones that need their own sound or picture on the video.");
    // The first PATCH sends the whole want, with a change he made before it.
    await tap(host.querySelector<HTMLElement>("input[value='200']")!);
    await tap(button("Find campaigns for me"));
    expect(fake.crPatchFinder).toHaveBeenCalledWith({ want: { ...WANT_DEFAULTS, minPer1kCents: 200, on: true } });
  });

  it("new with no place set up: Set up a place to post first, and Set up YouTube is the vermilion", async () => {
    current = finder({ state: "new", matches: [], resolvedPlaces: [] });
    fake.getSetup = vi.fn(async () => setupOf([]));
    await draw();
    expect(text()).toContain("Set up a place to post first. Then I can find campaigns that pay for it.");
    expect(main().map((b) => b.textContent?.trim())).toEqual(["Set up YouTube"]);
    expect(main()[0]!.getAttribute("href")).toBe("/settings/posting/setup/youtube?back=/campaigns/find");
  });

  it("ok with no place set up: the same line and Set up YouTube", async () => {
    current = finder({ resolvedPlaces: [], matches: [] });
    fake.getSetup = vi.fn(async () => setupOf([]));
    await draw();
    expect(text()).toContain("Set up a place to post first.");
    expect(main().map((b) => b.textContent?.trim())).toEqual(["Set up YouTube"]);
  });

  it("looking: the waiting line, no vermilion", async () => {
    current = finder({ state: "looking", matches: [] });
    await draw();
    expect(text()).toContain("Looking at Content Rewards' campaigns… This takes a minute or two.");
    expect(main()).toHaveLength(0);
  });

  it("ok, the first fill not finished: no match yet, how many looked at, nothing to do", async () => {
    current = finder({ matches: [], looked: { campaigns: 120, pending: 646 } });
    await draw();
    expect(text()).toContain("No match yet. I've looked at 120 campaigns so far. I'll look at more later today.");
    expect(text()).toContain("You don't need to do anything. I'll tell you when one matches.");
    expect(main()).toHaveLength(0);
  });

  it("ok, no match: Change what you want opens the card", async () => {
    current = finder({ matches: [] });
    await draw();
    expect(text()).toContain("No campaign matches right now. I look again 4 times a day.");
    expect(main()).toHaveLength(0);
    await tap(button("Change what you want"));
    expect(text()).toContain("Pays at least");
  });

  it("ok with matches: every match has Open on Content Rewards and exactly one button is vermilion", async () => {
    await draw();
    expect(cards()).toHaveLength(3);
    for (const c of cards()) expect(button(/Open on Content Rewards/, c)).toBeTruthy();
    expect(main()).toHaveLength(1);
    expect(cards()[0]!.contains(main()[0]!)).toBe(true);
    expect(main()[0]!.textContent).toContain("Open on Content Rewards");
    expect(text()).toContain("$2,410.10 left of $2,500");
    expect(text()).toContain("Content Rewards' numbers, 2:10 pm".replace("2:10 pm", new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date("2026-11-21T14:10:00Z")).replace(/\s+/g, " ").toLowerCase()));
    expect(text()).toContain("Why it matched");
    // The open match holds the vermilion, and it moves with the head he taps.
    await tap(cards()[1]!.querySelector<HTMLElement>(".finder-match__head")!);
    expect(cards()[1]!.classList.contains("is-open")).toBe(true);
    expect(cards()[0]!.classList.contains("is-open")).toBe(false);
    expect(main()).toHaveLength(1);
    expect(cards()[1]!.contains(main()[0]!)).toBe(true);
  });

  for (const [state, words] of [
    ["down", "Content Rewards didn't answer. I'll try again in a few hours."],
    ["blocked", "Content Rewards isn't letting Clip Factory look right now. Tap Look on Content Rewards yourself."],
    ["not_allowed", "Content Rewards asked apps not to read its campaign pages. Tap Look on Content Rewards yourself."],
    ["unreadable", "I can't read Content Rewards' campaign pages right now. Tap Look on Content Rewards yourself."],
  ] as const)
    it(`${state}: its sentence, the stored matches As of, the open match keeps the vermilion`, async () => {
      current = finder({ state });
      await draw();
      expect(text()).toContain(words);
      expect(host.querySelector(".finder-asof")!.textContent).toMatch(/^As of \w{3} 21 Nov, /);
      expect(cards()).toHaveLength(3);
      expect(main()).toHaveLength(1);
      expect(cards()[0]!.contains(main()[0]!)).toBe(true);
    });

  it("off: no match shows, Find campaigns again is the vermilion", async () => {
    current = finder({ state: "off", want: { ...WANT_DEFAULTS, on: false } });
    await draw();
    expect(text()).toContain("You stopped finding campaigns.");
    expect(cards()).toHaveLength(0);
    expect(main().map((b) => b.textContent?.trim())).toEqual(["Find campaigns again"]);
    await tap(main()[0]);
    expect(fake.crPatchFinder).toHaveBeenCalledWith({ want: { on: true } });
  });

  it("GET failed: the shared ErrorPanel says Couldn't load. Tap Try again.", async () => {
    fake.crFinder = vi.fn(async () => Promise.reject(new ApiError(500, "internal", "x")));
    await draw();
    expect(text()).toContain("Couldn't load. Tap Try again.");
    expect(button("Try again")).toBeTruthy();
  });

  for (const err of [new ApiError(404, "not_found", "x"), new ApiError(503, "unavailable", "x")])
    it(`${err.status}: Find campaigns is coming soon, with Your campaigns`, async () => {
      fake.crFinder = vi.fn(async () => Promise.reject(err));
      await draw();
      expect(text()).toContain("Find campaigns is coming soon to Clip Factory.");
      expect(button("Your campaigns").getAttribute("href")).toBe("/campaigns");
      expect(main()).toHaveLength(0);
    });
});

describe("a match", () => {
  it("Not for me on the open match hides it and opens the next; Undo takes it back", async () => {
    await draw();
    await tap(button("Not for me", cards()[0]!));
    expect(fake.crFinderSaid).toHaveBeenCalledWith(U.a, "not_for_me");
    expect(cards()).toHaveLength(2);
    expect(cards()[0]!.dataset.campaign).toBe(U.b);
    expect(cards()[0]!.classList.contains("is-open")).toBe(true);
    expect(text()).toContain("Hidden.");
    await tap(button("Undo", document.body));
    expect(fake.crFinderSaid).toHaveBeenCalledWith(U.a, null);
    expect(cards()).toHaveLength(3);
  });

  it("Open → the steps and I joined: add it (the vermilion); opened stays when the PATCH fails, one retry after 2 s", async () => {
    vi.spyOn(window, "open").mockImplementation(() => null);
    let n = 0;
    fake.crFinderSaid = vi.fn(async () => {
      n++;
      throw new ApiError(500, "internal", "x");
    });
    await draw();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await tap(button(/Open on Content Rewards/, cards()[0]!));
    expect(text()).toContain("Tap Join Campaign.");
    expect(text()).toContain("Does the big button now say Submit clip? Then tap I joined: add it.");
    expect(main().map((b) => b.textContent?.trim())).toEqual(["I joined: add it"]);
    expect(button(/Open on Content Rewards/, cards()[0]!).className).toContain("btn--glass");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(n).toBe(2);
    expect(main().map((b) => b.textContent?.trim())).toEqual(["I joined: add it"]);
  });

  it("two hours after Open with no add: the vermilion is back on Open, and I joined: add it is glass", async () => {
    current = finder({ matches: [match(U.a, { opened: new Date(Date.now() - 3 * 3_600_000).toISOString() })] });
    await draw();
    expect(main()).toHaveLength(1);
    expect(main()[0]!.textContent).toContain("Open on Content Rewards");
    expect(button("I joined: add it").className).toContain("btn--glass");
  });

  it("the If you see fold, word for word", async () => {
    current = finder({ matches: [match(U.a, { opened: new Date().toISOString() })] });
    await draw();
    const fold = [...host.querySelectorAll("details")].find((d) => d.textContent?.includes("If you see…"))!;
    expect(fold.textContent).toContain("If you see Hold to confirm: Press and hold it.");
    expect(fold.textContent).toContain("If you see a box about Discord: Tap Done. You don't need Discord.");
    expect(fold.textContent).toContain("If you see a sign-in page: Sign in with your email code, then tap the big button again.");
    expect(fold.textContent).toContain("If you see Submit clip: You're in already. Tap I joined: add it.");
    expect(fold.textContent).toContain("If you see Pending review: You applied already. Tap I applied: add it.");
  });

  it("not signed in: the four steps and the rules box; the add, then the pasted rules are read", async () => {
    current = finder({ signedIn: false, matches: [match(U.a, { opened: new Date().toISOString() })] });
    await draw();
    expect(text()).toContain("Copy everything under Brief and Content requirements.");
    expect(text()).toContain("Come back. Paste it below, then tap I joined: add it.");
    expect(host.querySelector("[data-help='cr-finder-ask']")).toBeNull();
    const box = host.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      set.call(box, "Clips 20 to 60 seconds. Use #Ad.");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await tap(button("I joined: add it"));
    expect(fake.crFinderAdd).toHaveBeenCalledWith(U.a);
    expect(fake.crReadCampaign).toHaveBeenCalledWith(U.a, "Clips 20 to 60 seconds. Use #Ad.");
    expect(location.pathname).toBe(`/campaigns/${U.a}`);
  });

  it("There are no rules to copy adds it without rules", async () => {
    current = finder({ signedIn: false, matches: [match(U.a, { opened: new Date().toISOString() })] });
    await draw();
    await tap(button("There are no rules to copy"));
    expect(fake.crFinderAdd).toHaveBeenCalledWith(U.a);
    expect(fake.crReadCampaign).not.toHaveBeenCalled();
  });

  it("an error stays on the match with its sentence and the same button", async () => {
    current = finder({ matches: [match(U.a, { opened: new Date().toISOString() })] });
    fake.crFinderAdd = vi.fn(async () => Promise.reject(new ApiError(404, "not_found", "That campaign isn't in your matches any more. Tap Look again now.")));
    await draw();
    await tap(button("I joined: add it"));
    expect(text()).toContain("That campaign isn't in your matches any more. Tap Look again now.");
    expect(main().map((b) => b.textContent?.trim())).toEqual(["I joined: add it"]);
  });

  it("an application: the apply steps, the Copy chips and I applied: add it", async () => {
    current = finder({ matches: [match(U.app, { access: "application", hiddenRules: null, opened: new Date().toISOString() })] });
    await draw();
    expect(text()).toContain("Tap Apply.");
    expect(text()).toContain("Tick your accounts. Answer the questions.");
    expect(text()).toContain("Tap Submit application.");
    expect(text()).toContain("Come back here and tap I applied: add it.");
    expect(text()).toContain("Your YouTube link");
    expect(main().map((b) => b.textContent?.trim())).toEqual(["I applied: add it"]);
    expect(host.querySelector("textarea")).toBeNull();
  });
});

describe("by itself, once signed in", () => {
  it("back to the window → You're in! with Reading the rules…, then Make clips, still there after a live refetch", async () => {
    current = finder({ matches: [match(U.a), match(U.b, { opened: new Date().toISOString() })] });
    const row: CampaignSummary = {
      campaignId: U.b,
      name: "Clip Pro Pickleball",
      brand: "CNPL",
      state: "active",
      membership: "in",
      uploadPlaces: ["youtube"],
      waitingClips: 0,
      clipCounts: { approved: 0, waiting: 0, notApproved: 0 },
      checkedAt: "2026-11-21T14:10:00Z",
      chip: "Reading the rules",
      nextStepText: "Reading the rules… (about 30 seconds)",
      hardStops: 1,
      nextStepKind: "stop",
    };
    fake.crFinderJoined = vi.fn(async () => [row]);
    await draw();
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();
    expect(fake.crFinderJoined).toHaveBeenCalledTimes(1);
    expect(text()).toContain("You're in! Clip Pro Pickleball is in your campaigns.");
    const reading = button("Reading the rules… (about 30 seconds)");
    expect(reading.getAttribute("aria-disabled")).toBe("true");
    expect(main()).toHaveLength(0);
    // The campaign's live update: its rules are read.
    fake.crCampaign = vi.fn(async () => ({ campaignId: U.b, name: "Clip Pro Pickleball", membership: "in", nextStep: { kind: "make_clips", chip: "You're in", text: "You're in! Make clips for this campaign." } }) as Campaign);
    await live({ type: "contentrewards", op: "upsert", id: `campaign:${U.b}`, partial: true });
    expect(main().map((b) => b.textContent?.trim())).toEqual(["Make clips for this campaign"]);
    expect(main()[0]!.getAttribute("href")).toBe(`/?campaign=${U.b}`);
    // A live refetch of the finder (the added match is gone from it) keeps the row.
    current = finder({ matches: [match(U.a)] });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await live({ type: "contentrewards", op: "upsert", id: "finder", partial: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_DEBOUNCE_MS + 50);
    });
    await flush();
    expect(vi.mocked(fake.crFinder!).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(text()).toContain("You're in! Clip Pro Pickleball is in your campaigns.");
    expect(main().map((b) => b.textContent?.trim())).toEqual(["Make clips for this campaign"]);
    expect(cards()).toHaveLength(1);
  });

  it("not signed in: coming back adds nothing by itself", async () => {
    current = finder({ signedIn: false, matches: [match(U.a, { opened: new Date().toISOString() })] });
    await draw();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(fake.crFinderJoined).not.toHaveBeenCalled();
  });
});

describe("what you want and the rest of the page", () => {
  it("Change opens the card; each control's PATCH body, 500 ms after the last change; Updating your matches…", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // The server answers with the want as saved.
    fake.crPatchFinder = vi.fn(async (body) => {
      current = { ...current, want: { ...current.want, ...body.want } };
      return { ...structuredClone(current), state: "looking" as const };
    });
    await draw();
    expect(text()).toContain("At least $1 per 1,000 views · YouTube, Instagram · At least a quarter of the money left · Open to join");
    await tap(button("Change"));
    await tap(host.querySelector<HTMLElement>("input[value='any']")!);
    await tap(host.querySelector<HTMLElement>("[role='group'][aria-labelledby*='left'] input[value='50']")!);
    expect(fake.crPatchFinder).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(520);
    });
    await flush();
    expect(fake.crPatchFinder).toHaveBeenCalledWith({ want: { access: "any", minLeftPct: 50 } });
    expect(text()).toContain("Updating your matches…");
    expect(host.querySelector(".finder-matches")!.className).toContain("is-dim");
    expect(main()).toHaveLength(0);
    // Places: Instagram off → the list; on again → null (every place he set up).
    const chip = (name: string) => [...host.querySelectorAll<HTMLElement>(".finder-chip")].find((c) => c.textContent?.includes(name))!;
    await tap(chip("Instagram"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(520);
    });
    expect(fake.crPatchFinder).toHaveBeenLastCalledWith({ want: { places: ["youtube", "facebook", "x"] } });
    await tap(chip("Instagram"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(520);
    });
    expect(fake.crPatchFinder).toHaveBeenLastCalledWith({ want: { places: null } });
    await tap(chip("Gaming"));
    await tap(chip("Spanish"));
    await tap(host.querySelectorAll<HTMLElement>("[role='switch']")[0]!);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(520);
    });
    expect(fake.crPatchFinder).toHaveBeenLastCalledWith({ want: { categories: ["gaming"], languages: ["es"], otherPay: true } });
  });

  it("the TikTok chip can't be tapped until its audit, a place not set up says Set it up first, and Set up another place", async () => {
    fake.getSetup = vi.fn(async () => setupOf(["youtube", "instagram"]));
    current = finder({ state: "new", matches: [] });
    await draw();
    const chip = (name: string) => [...host.querySelectorAll<HTMLElement>(".finder-chip")].find((c) => c.textContent?.includes(name))!;
    expect(chip("TikTok").getAttribute("aria-disabled")).toBe("true");
    expect(chip("TikTok").getAttribute("aria-pressed")).toBe("false");
    expect(text()).toContain("TikTok: not yet. TikTok keeps Clip Factory's posts private until it checks the app, and private posts can't earn.");
    expect(chip("Facebook").getAttribute("aria-disabled")).toBe("true");
    expect(text()).toContain("Set it up first.");
    expect(button("Set up another place").getAttribute("href")).toBe("/settings/posting/setup?back=/campaigns/find");
  });

  it("Tell me about new ones says when Content Rewards news is off in Settings", async () => {
    newsOn = false;
    current = finder({ state: "new", matches: [] });
    await draw();
    expect(text()).toContain("At most once a day.");
    expect(text()).toContain("Content Rewards news is off in Settings.");
  });

  it("Why not more? and Bring them back", async () => {
    await draw();
    expect(text()).toContain("I looked at 154 campaigns. 3 match.");
    expect(text()).toContain("62 pay less than $1.00 per 1,000 views.");
    await tap(button("Bring them back"));
    expect(fake.crPatchFinder).toHaveBeenCalledWith({ unhideAll: true });
  });

  it("the quiet lines say who joins and when the rules are read", async () => {
    await draw();
    expect(text()).toContain("You join each campaign yourself on Content Rewards.");
    expect(text()).toContain("Open campaigns show their rules only after you join. I read them right after.");
    expect(button(/Look on Content Rewards yourself/).getAttribute("href")).toBe("https://contentrewards.com/c/discover");
  });

  it("Look again now; once limited, You can look again at …", async () => {
    fake.crFinderCheck = vi.fn(async () => ({ started: false, nextAllowedAt: new Date(Date.now() + 30 * 60_000).toISOString() }));
    await draw();
    await tap(button("Look again now"));
    expect(text()).toMatch(/You can look again at \d{1,2}:\d{2} [ap]m\./);
  });

  it("the ask card only while signed in: one tap, then the date; the message under Show more", async () => {
    await draw();
    const ask = host.querySelector<HTMLElement>("[data-help='cr-finder-ask']")!;
    expect(ask.textContent).toContain("Clip Factory can't join for you");
    expect(ask.textContent).toContain("This is what Clip Factory sends to Content Rewards' team.");
    await tap(button("Ask Content Rewards", ask));
    expect(fake.crFinderAsk).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-help='cr-finder-ask']")!.textContent).toContain("You asked Content Rewards on 21 Nov.");
  });

  it("New chips come from the visit's frozen set, and seenAll goes 2 s after", async () => {
    current = finder({ matches: [match(U.a, { isNew: true }), match(U.b)], newCount: 1 });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await draw();
    expect(host.querySelectorAll(".finder-new")).toHaveLength(1);
    current = finder({ matches: [match(U.a), match(U.b)] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    await flush();
    expect(fake.crPatchFinder).toHaveBeenCalledWith({ seenAll: true });
    expect(host.querySelectorAll(".finder-new")).toHaveLength(1);
  });
});

describe("the entries elsewhere", () => {
  it("Home: a first chip with new matches (alone too), a last Find campaigns chip, none while stopped", async () => {
    fake.crOverview = vi.fn(async () => overview({ connection: { ...overview().connection, status: "not_connected" }, finder: { on: true, started: true, newCount: 3, matches: 6 } }));
    await draw(<CampaignsRow />);
    expect([...host.querySelectorAll(".cr-row-chip")].map((c) => c.textContent)).toEqual(["3 new campaigns match"]);
    resetCr();
    fake.crOverview = vi.fn(async () => overview({ campaigns: [{ campaignId: U.a, name: "FaZe Clips", brand: "FaZe", membership: "in", chip: "You're in", nextStepText: "", hardStops: 0 } as unknown as CampaignSummary], finder: { on: true, started: false, newCount: 0, matches: 0 } }));
    await draw(<CampaignsRow />);
    expect([...host.querySelectorAll(".cr-row-chip")].at(-1)!.textContent).toBe("Find campaigns");
    resetCr();
    fake.crOverview = vi.fn(async () => overview({ campaigns: [{ campaignId: U.a, name: "FaZe Clips", brand: "FaZe", membership: "in", chip: "You're in", nextStepText: "", hardStops: 0 } as unknown as CampaignSummary], finder: { on: false, started: true, newCount: 2, matches: 4 } }));
    await draw(<CampaignsRow />);
    expect(host.querySelector(".cr-row-chip.is-find")).toBeNull();
  });

  it("Campaigns: the entry card at the top; change 1 makes it the vermilion only in the empty, signed-in state", async () => {
    fake.crOverview = vi.fn(async () => overview({ finder: { on: true, started: true, newCount: 0, matches: 4 } }));
    await draw(<CampaignsPage />);
    const entry = host.querySelector<HTMLElement>("[data-help='cr-finder-entry']")!;
    expect(entry.textContent).toContain("4 campaigns match what you want.");
    expect(entry.querySelector(".btn--primary")).not.toBeNull();
    expect(main()).toHaveLength(1);
    expect(host.querySelector<HTMLElement>("#step-join-find a.cr-open")!.className).toContain("btn--glass");
    resetCr();
    fake.crOverview = vi.fn(async () => overview({ finder: undefined }));
    await draw(<CampaignsPage />);
    expect(host.querySelector("[data-help='cr-finder-entry']")).toBeNull();
    expect(host.querySelector<HTMLElement>("#step-join-find a.cr-open")!.className).toContain("btn--primary");
  });
});
