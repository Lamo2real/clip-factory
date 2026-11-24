// Get paid drawn in jsdom (docs/CONTRACTS.md §40, §40.8 tests), against the pretend API (api/mock/getpaid.ts): the
// status pill words, tones and icons; never "Live", "Not connected" or "disconnected"; one vermilion per screen, per
// status; the ring without the reading step and its chip; phone steps on a computer; ticks and autos; the Money card's
// buttons; the result sentences word for word; notify.getPaid only when the API knows it; the live refetch; and Set up
// posting still exactly five rows, "of 5", with every Get paid tick set.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account, Api, CrConnection, CrMoney, GetPaidCard, GetPaidStatus, Me, Platform, Settings } from "../src/api/types.ts";
import type { LiveSignal } from "../src/lib/live.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let current: Partial<Api> = {};
vi.mock("../src/api/index.ts", async (orig) => ({ ...(await orig<object>()), api: () => current as Api }));
// The live hub: the test sends the news itself.
const signals = new Set<(s: LiveSignal) => void>();
vi.mock("../src/lib/live.ts", async (orig) => ({
  ...(await orig<object>()),
  onLiveSignal: (fn: (s: LiveSignal) => void) => {
    signals.add(fn);
    return () => signals.delete(fn);
  },
}));
const saveSettings = vi.fn(async (patch: Partial<Settings>) => patch);
let me: Me | null = null;
vi.mock("../src/app/session.tsx", () => ({ useSession: () => ({ me, saveSettings }) }));

const { getPaidMockApi, scenarioState } = await import("../src/api/mock/getpaid.ts");
const { GetPaidList } = await import("../src/screens/getpaid/GetPaidList.tsx");
const { CR_FINANCE, GetPaidPage, READING_GONE } = await import("../src/screens/getpaid/GetPaidPage.tsx");
const { StatusPill } = await import("../src/screens/getpaid/StatusPill.tsx");
const { GetPaidCard: MoneyCard } = await import("../src/screens/money/GetPaidCard.tsx");
const { SentRows } = await import("../src/screens/getpaid/SentRows.tsx");
const { WhopCard, WHOP_KEY_CHANGED } = await import("../src/screens/getpaid/WhopCard.tsx");
const { mockApi } = await import("../src/api/mock/index.ts");
const { seed } = await import("../src/api/mock/fixtures.ts");
const { SetupList } = await import("../src/screens/settings/setup/SetupList.tsx");
const { SetupTodo } = await import("../src/components/SetupTodo.tsx");
const { forgetLoaded } = await import("../src/lib/hooks.ts");
const { NotifyBranch } = await import("../src/screens/settings/NotifyBranch.tsx");
const { ToastProvider } = await import("../src/components/Toasts.tsx");
const gp = await import("../src/lib/getPaid.ts");
const { resetCr } = await import("../src/lib/contentRewards.ts");
const { resetBank } = await import("../src/lib/bank.ts");
const { todoRows, todoCount } = await import("../src/lib/setupTodo.ts");
const { allGetPaidSteps } = await import("../src/getpaid/index.ts");

const DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";

const conn = (over: Partial<CrConnection> = {}): CrConnection => ({ status: "connected", canSubmit: true, crLinked: {}, stepsDone: [], pilotEmail: { to: "", subject: "", body: "", mailto: "" }, ...over });
const crMoney = (): CrMoney => ({
  state: "ok",
  tag: "Content Rewards' numbers",
  asOf: new Date().toISOString(),
  stillEarningCents: 420,
  onItsWayCents: 0,
  readyToMoveCents: 1825,
  paidSoFarCents: 6240,
  waitingForBrand: 0,
  campaigns: [],
  celebrations: [],
});

let accounts: Account[] = [];
let country: string | null = "SE";
let crConn: CrConnection = conn();
let crOn = true;
const calls: string[] = [];
let mock: ReturnType<typeof getPaidMockApi>;

function install() {
  mock = getPaidMockApi(async () => undefined, {
    accounts: () => accounts,
    country: () => country,
    setCountry: (c) => (country = c),
    connect: (ps) => (accounts = ps.map((platform) => ({ platform, status: "connected" }) as Account)),
    cr: () => ({ on: crOn, conn: crOn ? crConn : null, moneyAboveZero: true, readyCents: 1825 }),
    publish: () => undefined,
  });
  current = {
    ...mock.api,
    getPaid: async () => {
      calls.push("getPaid");
      return mock.api.getPaid();
    },
    setGetPaidStep: async (step, done) => {
      calls.push(`patch:${step}:${done}`);
      return mock.api.setGetPaidStep(step, done);
    },
    crOverview: async () => ({ connection: crConn, campaigns: [], money: crMoney(), waitingSends: [] }),
    crPatchConnection: async (body) => {
      calls.push(`crpatch:${JSON.stringify(body)}`);
      if ("step" in body) crConn = { ...crConn, stepsDone: body.done ? [...crConn.stepsDone, body.step] : crConn.stepsDone.filter((x) => x !== body.step) };
      if ("finance" in body) crConn = { ...crConn, finance: body.finance ?? undefined };
      return crConn;
    },
    refreshMoney: async () => ({ started: true }),
    connectAccount: async () => mock.connectPayments(),
  };
}

function start(name: Parameters<typeof scenarioState>[0], over: (s: ReturnType<typeof scenarioState>) => void = () => undefined) {
  const s = scenarioState(name);
  over(s);
  sessionStorage.setItem("cf-mock-getpaid", JSON.stringify(s));
}

let host: HTMLElement;
let root: Root;
function phone(on: boolean) {
  Object.defineProperty(navigator, "userAgent", { value: on ? PHONE_UA : DESKTOP_UA, configurable: true });
  Object.defineProperty(navigator, "maxTouchPoints", { value: on ? 5 : 0, configurable: true });
  window.matchMedia = ((q: string) => ({ matches: on && q.includes("max-width: 767px"), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia;
}
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  gp.resetGetPaid();
  resetBank();
  resetCr();
  accounts = [];
  country = "SE";
  crConn = conn();
  crOn = true;
  calls.length = 0;
  me = null;
  saveSettings.mockClear();
  phone(false);
  history.replaceState(null, "", "/settings/posting/getpaid");
  install();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

async function settle() {
  for (let i = 0; i < 6; i++) await act(async () => await new Promise((r) => setTimeout(r, 10)));
}
async function draw(node: React.ReactNode) {
  await act(async () => root.render(<ToastProvider>{node}</ToastProvider>));
  await settle();
}
const vermilion = () => [...host.querySelectorAll<HTMLElement>(".btn--primary")];
const text = () => host.textContent ?? "";
const cardOf = async (place: GetPaidCard["place"]) => (await mock.api.getPaid()).places.find((p) => p.place === place)!;

// ---------- the pill ----------

describe("the status pill (§40.2)", () => {
  const cases: [GetPaidStatus, GetPaidCard["tone"], string][] = [
    ["on_hold", "error", "Payment on hold (YouTube says)"],
    ["not_allowed", "neutral", "Not allowed yet (Instagram's rules)"],
    ["can_get_paid", "success", "Can get paid ✓ (Whop says)"],
    ["not_set_up", "error", "Not set up (YouTube says)"],
    ["not_set_up", "warn", "Not set up yet"],
    ["checking", "neutral", "Checking…"],
    ["you_said_done", "success", "Can get paid (you said it's done)"],
    ["not_connected", "neutral", "Clip Factory can't check"],
    ["not_started", "neutral", "Not started"],
  ];
  it("every status has its words, its tone and an icon (never colour alone)", async () => {
    for (const [status, tone, pill] of cases) {
      expect(pill, status).toMatch(gp.PILL_WORDS[status]);
      await draw(<StatusPill card={{ status, tone, pill }} />);
      const el = host.querySelector<HTMLElement>(".gp-pill")!;
      expect(el.className).toContain(`gp-pill--${tone}`);
      expect(el.textContent).toBe(pill);
      expect(el.querySelector("svg"), status).not.toBeNull();
      expect(el.className).not.toContain("vermilion");
    }
    // "Can get paid (you said it's done)" has an outline icon, no check mark; "Not set up yet" is never red.
    expect(gp.STATUS_ICON.you_said_done).not.toMatch(/check/i);
    expect(gp.PILL_WORDS.you_said_done.test("Can get paid ✓ (you said it's done)")).toBe(false);
  });

  it("the pretend server's own pills: Not set up yet is warn, a signal's Not set up is red", async () => {
    start("fresh", (s) => (s.youtube = "in_program"));
    expect((await cardOf("youtube")).pill).toBe("Not set up yet");
    expect((await cardOf("youtube")).tone).toBe("warn");
    start("owner", (s) => (s.adsense.state = "NEEDS_ATTENTION"));
    const yt = await cardOf("youtube");
    expect([yt.pill, yt.tone]).toEqual(["Not set up (YouTube says)", "error"]);
    start("hold");
    expect((await cardOf("youtube")).status).toBe("on_hold");
  });

  it("no pill, line or summary says Live, Not connected or disconnected, in any start", async () => {
    for (const name of ["fresh", "owner", "hold", "checking", "not_yet", "all_done", "unread"] as const) {
      start(name);
      accounts = name === "fresh" ? [] : (["youtube", "tiktok", "instagram", "facebook", "x"] as Platform[]).map((platform) => ({ platform, status: "connected" }) as Account);
      const v = await mock.api.getPaid();
      for (const t of [v.summary, ...v.places.flatMap((p) => [p.pill, p.line, ...p.seen])]) {
        expect(/\bLive\b|Not connected|disconnected/i.test(t.replace(/\bLIVE (Gifts|rewards)\b/g, "")), `${name}: ${t}`).toBe(false);
      }
    }
  });
});

// ---------- one vermilion per screen ----------

describe("one vermilion per screen, per status (§40.1)", () => {
  it("the list has none; each card is one tap to its page; Your bank, while it can't be read, says only today's words", async () => {
    start("owner");
    accounts = (["youtube", "instagram", "facebook", "x", "tiktok"] as Platform[]).map((platform) => ({ platform, status: "connected" }) as Account);
    await draw(<GetPaidList />);
    expect(vermilion()).toHaveLength(0);
    const cards = [...host.querySelectorAll<HTMLAnchorElement>("a.gp-card")];
    expect(cards.map((a) => a.getAttribute("href"))).toEqual(["youtube", "tiktok", "instagram", "facebook", "x", "contentrewards"].map((p) => `/settings/posting/getpaid/${p}`));
    // The list is the branch's apple: Settings search and Ask land on #getpaid and light it up.
    const list = host.querySelector<HTMLElement>("[data-help~='getpaid-list']")!;
    expect(list).not.toBeNull();
    expect(host.querySelector("#getpaid")).toBe(list);
    expect(list.matches("[data-help~='getpaid']")).toBe(true);
    expect(list.tabIndex).toBe(-1);
    expect(text()).toContain("Clip Factory can't see your bank. Look in your bank's app to see what arrived.");
    expect(host.querySelector(".gp-bank button, .gp-bank a")).toBeNull();
    expect(host.querySelector(".gp-summary")!.textContent).toBe((await mock.api.getPaid()).summary);
    expect(host.querySelector("a.gp-card[data-place='x']")!.textContent).toContain("Your Clip Factory clips probably won't earn on X.");
  });

  it("Your bank on (§40.5.2 item 1): one big glass tap to the bank page, under the place cards; still no vermilion", async () => {
    const { bankMockApi } = await import("../src/api/mock/bank.ts");
    current = { ...current, ...bankMockApi(async () => undefined, { country: () => "SE", crOn: () => true, publish: () => undefined }).api };
    await draw(<GetPaidList />);
    expect(vermilion()).toHaveLength(0);
    const bank = host.querySelector<HTMLAnchorElement>("a[data-help='getpaid-bank-card']")!;
    expect(bank.getAttribute("href")).toBe("/settings/posting/getpaid/bank");
    expect(bank.querySelector(".gp-pill")!.textContent).toBe("Not started");
    const cards = [...host.querySelectorAll("a.gp-card")];
    expect(cards).toHaveLength(6);
    expect(cards.at(-1)!.compareDocumentPosition(bank) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(text()).not.toContain("Clip Factory can't see your bank.");
  });

  it("Content Rewards switched off: five cards", async () => {
    crOn = false;
    await draw(<GetPaidList />);
    expect(host.querySelectorAll("a.gp-card")).toHaveLength(5);
  });

  it("Money's card has none: one glass button per row, by status, to the place's page with the way back", async () => {
    start("owner");
    await draw(<MoneyCard />);
    expect(vermilion()).toHaveLength(0);
    expect(host.querySelector("[data-help='getpaid-card']")!.textContent).toContain("Can money reach you from each place?");
    const v = await mock.api.getPaid();
    for (const p of v.places) {
      const row = host.querySelector<HTMLElement>(`.gp-money__row[data-place='${p.place}']`)!;
      const links = row.querySelectorAll<HTMLAnchorElement>("a.btn");
      expect(links).toHaveLength(1);
      expect(links[0]!.getAttribute("href")).toBe(`/settings/posting/getpaid/${p.place}?back=/money`);
      expect(links[0]!.textContent).toBe(gp.rowButton(p.status));
    }
    expect(gp.rowButton("not_set_up")).toBe("See steps");
    expect(gp.rowButton("on_hold")).toBe("See steps");
    expect(gp.rowButton("not_started")).toBe("See steps");
    expect(gp.rowButton("not_connected")).toBe("See steps");
    expect(gp.rowButton("not_allowed")).toBe("See why");
    expect(gp.rowButton("checking")).toBe("See why");
    expect(gp.rowButton("can_get_paid")).toBe("See more");
    expect(gp.rowButton("you_said_done")).toBe("See more");
    // Status only: no sent amounts on this card.
    expect(host.querySelector(".gp-money")!.textContent).not.toMatch(/SEK|\$\d/);
  });

  it("the place page: next names a step → exactly one, that step's Open; the status block says next.text with no button", async () => {
    start("fresh", (s) => (s.youtube = "in_program"));
    await draw(<GetPaidPage place="youtube" />);
    const red = vermilion();
    expect(red).toHaveLength(1);
    expect(red[0]!.closest("#step-yt-tax")).not.toBeNull();
    expect(red[0]!.textContent).toContain("Open AdSense for YouTube");
    const status = host.querySelector<HTMLElement>("[data-help='getpaid-status']")!;
    expect(status.querySelector("button, a.btn")).toBeNull();
    expect(status.textContent).toContain("Next: step 2, Add your US tax info.");
    // Said once: the line already ends with it, so it is not said again under the line.
    expect(status.textContent!.split("Next: step 2, Add your US tax info.").length - 1).toBe(1);
  });

  it("on a phone the next step's Open is pinned at the bottom right from page open, and not in its card", async () => {
    phone(true);
    start("fresh", (s) => (s.youtube = "in_program"));
    await draw(<GetPaidPage place="youtube" />);
    const red = vermilion();
    expect(red).toHaveLength(1);
    expect(red[0]!.closest(".gp-pin")).not.toBeNull();
    expect(host.querySelector("#step-yt-tax .btn--primary, #step-yt-tax .cr-open")).toBeNull();
    // The pin is the page's last part (sticky at the bottom right).
    expect(host.querySelector(".gp-page")!.lastElementChild!.className).toContain("gp-pin");
  });

  it("next.stepId null (a hold's fix): exactly one, in the status block", async () => {
    start("hold", (s) => (s.ticks = ["yt-tax", "yt-bank", "yt-test", "yt-id", "yt-pin"]));
    await draw(<GetPaidPage place="youtube" />);
    const red = vermilion();
    expect(red).toHaveLength(1);
    expect(red[0]!.closest("[data-help='getpaid-status']")).not.toBeNull();
    expect(red[0]!.textContent).toContain("Open AdSense for YouTube");
    expect(host.querySelector("[data-help='getpaid-status']")!.textContent).toContain("Look for the red message on Payments. Do what it says.");
  });

  it("next null (not allowed, a goal not reached): none; with every goal reached, yt-join is next", async () => {
    start("not_yet");
    await draw(<GetPaidPage place="youtube" />);
    expect(vermilion()).toHaveLength(0);
    expect(text()).toContain("YouTube needs 1,000 subscribers. YouTube says you have 812. Clip Factory tells you when you get there.");
    act(() => root.unmount());
    root = createRoot(host);
    gp.resetGetPaid();
    start("fresh", (s) => (s.youtube = "goal_reached"));
    await draw(<GetPaidPage place="youtube" />);
    expect(vermilion()).toHaveLength(1);
    expect(vermilion()[0]!.closest("#step-yt-join")).not.toBeNull();
  });

  it("next.text is said once, also when the line goes on with the step's when line", async () => {
    accounts = [{ platform: "instagram", status: "connected" } as Account];
    start("fresh", (s) => {
      s.ticks = ["ig-gifts"];
      s.followers.instagram = 900;
    });
    const ig = await cardOf("instagram");
    expect(ig.next!.text).toBe("Next: step 2, Tell Meta where to pay you.");
    expect(ig.line).toContain(ig.next!.text!);
    expect(ig.line.endsWith(ig.next!.text!)).toBe(false);
    await draw(<GetPaidPage place="instagram" />);
    const status = host.querySelector<HTMLElement>("[data-help='getpaid-status']")!;
    expect(status.textContent!.split("Next: step 2, Tell Meta where to pay you.").length - 1).toBe(1);
    expect(status.querySelector(".gp-status__next")).toBeNull();
  });

  it("a paid next (X Premium) is never the vermilion", async () => {
    accounts = [{ platform: "x", status: "connected" } as Account];
    start("fresh", (s) => (s.followers.xVerified = 900));
    const x = await cardOf("x");
    expect(x.next!.stepId).toBe("x-premium");
    expect(x.next!.vermilion).toBe(false);
    await draw(<GetPaidPage place="x" />);
    expect(vermilion()).toHaveLength(0);
    expect(text()).toContain("X doesn't pay for posts an app made or posted, or clips copied from other sites. Your Clip Factory clips probably won't earn on X.");
  });

  it("after I have Premium, the status block says the next step under §40.2's line, so the tap shows it worked", async () => {
    accounts = [{ platform: "x", status: "connected" } as Account];
    start("fresh", (s) => {
      s.followers.xVerified = 900;
      s.ticks = ["x-premium"];
    });
    const x = await cardOf("x");
    expect(x.ring.done).toBe(1);
    expect(x.next!.stepId).toBe("x-apply");
    await draw(<GetPaidPage place="x" />);
    const status = host.querySelector<HTMLElement>("[data-help='getpaid-status']")!;
    expect(status.querySelector(".gp-status__next")!.textContent).toBe("Next: step 2, Apply for Original Content Rewards.");
    expect(host.querySelector("#step-x-premium .gp-step__who")!.textContent).toBe("You said it's done");
  });

  it("Content Rewards: §38.7's money steps are glass unless next; Connect Whop is glass while a step is next", async () => {
    crConn = conn({ finance: false });
    start("fresh", (s) => (s.whopOn = true));
    await draw(<GetPaidPage place="contentrewards" />);
    const red = vermilion();
    expect(red).toHaveLength(1);
    expect(red[0]!.closest("#step-move-whop")).not.toBeNull();
    expect(host.querySelector("#step-bank-setup .btn--primary")).toBeNull();
    const whop = host.querySelector<HTMLElement>("[data-help='getpaid-whop']")!;
    expect(whop.querySelector(".btn--primary")).toBeNull();
    expect(whop.textContent).toContain("Connect Whop");
    // The once steps are numbered; the each-time steps are not.
    expect(host.querySelector("#step-move-whop .gstep__num")!.textContent).toBe("1");
    expect(host.querySelector("#step-bank-setup .gstep__num")!.textContent).toBe("2");
    expect(host.querySelector("#step-move-withdraw .gstep__num")!.textContent).not.toMatch(/\d/);
  });

  it("Whop off: Coming soon and no button; the Finance question comes first", async () => {
    await draw(<GetPaidPage place="contentrewards" />);
    const whop = host.querySelector<HTMLElement>("[data-help='getpaid-whop']")!;
    expect(whop.textContent).toContain("Coming soon: your Whop payouts here.");
    expect(whop.querySelector("button, a")).toBeNull();
    expect(host.querySelector("#cr-finance")!.textContent).toContain("Do you see Finance in the Content Rewards menu?");
    expect(host.querySelector("#cr-finance [role='radiogroup']")).not.toBeNull();
  });
});

// ---------- the ring, the chip, phone steps, ticks and autos ----------

describe("the place page's steps", () => {
  it("the ring counts the six numbered steps, never the reading step; the reading chip shows", async () => {
    start("owner");
    const yt = await cardOf("youtube");
    expect(yt.ring.total).toBe(6);
    expect(yt.readingChip).toBe("Clip Factory can see payments: on");
    await draw(<GetPaidPage place="youtube" />);
    expect(host.querySelector(".gp-head [role='progressbar']")!.getAttribute("aria-label")).toBe("YouTube: 6 of 6 steps done");
    expect(host.querySelector("[data-help='getpaid-status']")!.textContent).toContain("Clip Factory can see payments: on");
    expect(host.querySelector("#step-yt-reading .gstep__num")!.textContent).not.toMatch(/^\d/);
    // The chip is the status block's alone (§40.2), never said again in the reading step.
    act(() => (host.querySelector<HTMLButtonElement>("#step-yt-reading > .gstep__head")!.getAttribute("aria-expanded") === "false" ? host.querySelector<HTMLButtonElement>("#step-yt-reading > .gstep__head")!.click() : undefined));
    expect(host.querySelector("#step-yt-reading .gstep__body")).not.toBeNull();
    expect(host.querySelectorAll(".gp-chip")).toHaveLength(1);
    expect(text().split("Clip Factory can see payments: on").length - 1).toBe(1);
  });

  it("a phone step on a computer says to use the phone and has no Open; on a phone it opens the app's https page", async () => {
    expect((await cardOf("tiktok")).next!.stepId).toBe("tt-gifts");
    await draw(<GetPaidPage place="tiktok" />);
    const one = host.querySelector<HTMLElement>("#step-tt-gifts")!;
    expect(one.textContent).toContain("Do this in the TikTok app on your phone.");
    expect(one.querySelector("a[href^='https://']")).toBeNull();
    // The next step is done on the phone, so a computer has no main button for it: no vermilion at all, and the green
    // answer stays glass. The status block still says the next step in words.
    expect(vermilion()).toHaveLength(0);
    expect(host.querySelector("[data-help='getpaid-status']")!.textContent).toContain("Next: step 1, Turn on Gifts.");
    act(() => root.unmount());
    root = createRoot(host);
    gp.resetGetPaid();
    phone(true);
    await draw(<GetPaidPage place="tiktok" />);
    expect(host.querySelector("#step-tt-gifts")!.textContent).not.toContain("on your phone.");
    expect(host.querySelector<HTMLAnchorElement>(".gp-pin a")!.getAttribute("href")).toBe("https://www.tiktok.com/");
    expect(host.querySelector<HTMLAnchorElement>(".gp-pin a")!.rel).toBe("noopener noreferrer");
    expect(vermilion()).toHaveLength(1);
  });

  it("I did this sends the PATCH, folds the step with You said it's done, and opens the next", async () => {
    start("fresh", (s) => (s.youtube = "in_program"));
    await draw(<GetPaidPage place="youtube" />);
    const done = [...host.querySelectorAll<HTMLButtonElement>("#step-yt-tax button")].find((b) => b.textContent?.includes("I did this"))!;
    await act(async () => done.click());
    await settle();
    expect(calls).toContain("patch:yt-tax:true");
    const tax = host.querySelector<HTMLElement>("#step-yt-tax")!;
    expect(tax.dataset.done).toBe("true");
    expect(tax.querySelector(".gp-step__who")!.textContent).toBe("You said it's done");
    expect(tax.querySelector(".gstep__body")).toBeNull();
    expect(host.querySelector("#step-yt-bank .gstep__body")).not.toBeNull();
    // The answer went away with the folded step: focus is on that step's head, never lost to the page.
    expect(document.activeElement).toBe(tax.querySelector(":scope > .gstep__head"));
  });

  it("the first step not done is brought into view on the first visit too, only as far as it must", async () => {
    const seen: { id: string; block?: ScrollLogicalPosition }[] = [];
    const before = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, o?: boolean | ScrollIntoViewOptions) {
      seen.push({ id: this.id, block: typeof o === "object" ? o.block : undefined });
    };
    try {
      await draw(<GetPaidPage place="facebook" />);
      await act(async () => await new Promise((r) => setTimeout(r, 220)));
      expect((await cardOf("facebook")).ring.done).toBe(0);
      expect(seen).toContainEqual({ id: "step-fb-join", block: "nearest" });
    } finally {
      Element.prototype.scrollIntoView = before;
    }
  });

  it("Content Rewards' done steps say who said so on their folded row", async () => {
    crConn = conn({ finance: false, stepsDone: ["move-whop"] });
    await draw(<GetPaidPage place="contentrewards" />);
    const move = host.querySelector<HTMLElement>("#step-move-whop")!;
    expect(move.dataset.done).toBe("true");
    expect(move.querySelector(".gp-step__who")!.textContent).toBe("You said it's done");
    expect(host.querySelector("#step-bank-setup .gp-step__who")).toBeNull();
  });

  it("one meta-payout tick is for both Meta places, but never makes them you said it's done alone", async () => {
    await mock.api.setGetPaidStep("meta-payout", true);
    const v = await mock.api.getPaid();
    for (const p of ["instagram", "facebook"] as const) {
      const c = v.places.find((x) => x.place === p)!;
      expect(c.steps.find((s) => s.id === "meta-payout")!.done).toBe(true);
      expect(c.status).not.toBe("you_said_done");
      expect(c.line).toMatch(/^You said Meta knows where to pay you\. Next: step 1, /);
    }
  });

  it("autos say who said so", async () => {
    start("owner");
    await draw(<GetPaidPage place="youtube" />);
    expect(host.querySelector("#step-yt-join .gp-step__who")!.textContent).toBe("YouTube says you're in");
    expect(host.querySelector("#step-yt-bank .gp-step__who")!.textContent).toBe("Google sent you money on 23 Oct, so this is done");
    expect(host.querySelector<HTMLElement>("#step-yt-join")!.dataset.by).toBe("auto");
  });

  it("Can you earn here? shows his country's facts, or asks him to pick his country", async () => {
    country = null;
    await draw(<GetPaidPage place="youtube" />);
    expect(text()).toContain("Pick your country to see its rules.");
    expect(host.querySelector<HTMLAnchorElement>("a[href='/settings/posting/money#money-country']")!.textContent).toContain("Pick my country");
    expect(text()).not.toContain("YouTube pays in kronor");
  });

  it("Sent to your bank: Google's rows, never reached your bank, and the bank line", async () => {
    start("owner");
    await draw(<GetPaidPage place="youtube" />);
    const sent = host.querySelector<HTMLElement>("[data-help='getpaid-sent']")!;
    expect(sent.textContent).toContain("Sent to your bank by Google");
    expect(sent.textContent).toContain("Your bank gets it up to 7 workdays after Google sends it.");
    expect(sent.textContent).toContain("Clip Factory can't see your bank. Look in your bank's app to see what arrived.");
    expect(sent.textContent).not.toMatch(/Reached your bank|received|in your bank\b(?!'s)/);
    expect(sent.querySelectorAll(".gp-sent__row")).toHaveLength(2);
    // Google's balance it hasn't paid yet: its own words, with when Google pays; never in a total.
    expect(sent.querySelector("[data-sent='unpaid']")!.textContent).toBe("Waiting to be paid: SEK 512.30 (YouTube says).Google pays between the 21st and 26th when you have kr 700 or more.");
    expect(sent.querySelector(".gp-sent__amount")!.textContent).not.toContain("512");
    // Google's own words when the money type can't be read: shown, never added up.
    act(() => root.unmount());
    root = createRoot(host);
    gp.resetGetPaid();
    start("unread");
    await draw(<GetPaidPage place="youtube" />);
    const s2 = host.querySelector<HTMLElement>("[data-help='getpaid-sent']")!;
    expect(s2.textContent).toContain("Google sent 3 payments. Clip Factory couldn't tell their money type, so they aren't added up.");
    expect(s2.textContent).toContain("1 234,56 kr");
    expect(s2.textContent).not.toContain("Nothing sent to your bank yet.");
    // "See them" goes to this very page: it is left out here (Money's line points here instead).
    expect((await cardOf("youtube")).sent.button?.label).toBe("See them");
    expect([...s2.querySelectorAll("a")].some((a) => a.textContent?.includes("See them"))).toBe(false);
  });

  it("a Whop payout that didn't go through, came back or is gone never says when it arrives", async () => {
    const sent = { state: "number", headline: "Sent to your bank by Whop", amounts: [{ currency: "USD", amountMicros: 40_000_000 }], tag: "Whop says", arrive: "Whop says it should arrive by 19 Nov." } as const;
    const rows = [
      { date: "2026-11-18", by: "Whop", state: "didnt_go_through", amountMicros: 25_000_000, currency: "USD", arriveBy: "2026-11-19" },
      { date: "2026-11-17", by: "Whop", state: "came_back", amountMicros: 15_000_000, currency: "USD", arriveBy: "2026-11-19" },
      { date: "2026-11-16", by: "Whop", state: "on_its_way", amountMicros: 10_000_000, currency: "USD", arriveBy: "2026-11-20" },
      { date: "2026-11-01", by: "Whop", state: "sent", amountMicros: 40_000_000, currency: "USD", arriveBy: "2026-11-05" },
    ] as const;
    await draw(<SentRows sent={{ ...sent, amounts: [...sent.amounts] }} rows={rows.map((r) => ({ ...r }))} />);
    const row = (state: string) => host.querySelector<HTMLElement>(`.gp-sent__row[data-state='${state}']`)!;
    expect(row("didnt_go_through").textContent).toContain("Didn't go through. Whop puts it back in your balance.");
    expect(row("didnt_go_through").querySelector(".gp-sent__arrive")).toBeNull();
    expect(row("came_back").querySelector(".gp-sent__arrive")).toBeNull();
    expect(row("on_its_way").querySelector(".gp-sent__arrive")!.textContent).toBe("Whop says it should arrive by 20 Nov 2026.");
    // A sent one is already on its way to the bank: only the sent line's own arrive words, and only on the newest.
    expect(row("sent").textContent).not.toContain("should arrive by 5 Nov");
  });

  it("TikTok, Instagram, Facebook and X: not available, never $0", async () => {
    for (const p of ["tiktok", "instagram", "facebook", "x"] as const) {
      const c = await cardOf(p);
      expect(c.sent.state).toBe("not_available");
      expect(c.sent.amounts).toEqual([]);
      expect(JSON.stringify(c.sent)).not.toMatch(/\$0\b/);
    }
  });

  it("reading gone (needs_reconnect): the page says so, and the reconnect is the status block's vermilion when nothing else is next", async () => {
    start("all_done", (s) => (s.adsense = { status: "needs_reconnect", reason: "token_dead", firstReadDone: true }));
    await draw(<GetPaidPage place="youtube" />);
    expect(text()).toContain(READING_GONE);
    const red = vermilion();
    expect(red).toHaveLength(1);
    expect(red[0]!.textContent).toContain("Allow payment reading");
    expect(red[0]!.closest("[data-help='getpaid-status']")).not.toBeNull();
    // The old sign-in is still kept (nothing is deleted), so he can still stop and forget it.
    const stop = [...host.querySelectorAll<HTMLButtonElement>(".gp-done button")].find((b) => b.textContent?.includes("Stop payment reading"));
    expect(stop).toBeDefined();
    expect(stop!.classList.contains("btn--primary")).toBe(false);
  });
});

// ---------- the Finance question's link (§40.2) ----------

describe("the Finance question's link: the server's, and it lands on the question", () => {
  type Golden = { cards: { name: string; place: string; expect: GetPaidCard }[] };
  const golden = (JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "api", "tests", "fixtures", "getpaid_status_cases.json"), "utf8")) as Golden).cards;
  const asked = golden.filter((c) => c.expect.next?.label === "Answer: do you see Finance?");
  const server = asked[0]!.expect;
  const spy = () => {
    const seen: { id: string; block?: ScrollLogicalPosition }[] = [];
    const before = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, o?: boolean | ScrollIntoViewOptions) {
      seen.push({ id: this.id, block: typeof o === "object" ? o.block : undefined });
    };
    return { seen, done: () => (Element.prototype.scrollIntoView = before) };
  };

  it("the pretend app sends exactly the server's next (same href, words and vermilion) and line", async () => {
    expect(asked.length).toBeGreaterThan(0);
    for (const c of asked) expect(c.expect.next, c.name).toEqual(server.next);
    const money = golden.find((c) => c.name.startsWith("contentrewards: money and no Finance answer"))!.expect;
    const mine = await cardOf("contentrewards");
    expect(mine.next).toEqual(server.next);
    expect([mine.status, mine.pill, mine.tone, mine.line]).toEqual([money.status, money.pill, money.tone, money.line]);
  });

  it("the server's href ends in the page's own id for the question", async () => {
    const [path, hash] = server.next!.href.split("#");
    expect(path).toBe("/settings/posting/getpaid/contentrewards");
    expect(hash).toBe(CR_FINANCE);
    await draw(<GetPaidPage place="contentrewards" />);
    expect(host.querySelector(`#${hash}`)!.textContent).toContain("Do you see Finance in the Content Rewards menu?");
  });

  it("arriving on the server's href brings the question into view", async () => {
    const s = spy();
    try {
      history.replaceState(null, "", server.next!.href);
      window.dispatchEvent(new HashChangeEvent("hashchange")); // the app's router reads the address on its events
      await draw(<GetPaidPage place="contentrewards" />);
      await act(async () => await new Promise((r) => setTimeout(r, 220)));
      expect(s.seen).toContainEqual({ id: CR_FINANCE, block: "center" });
    } finally {
      s.done();
    }
  });

  it("tapping Answer: do you see Finance? brings the question into view on every tap, the address untouched", async () => {
    history.replaceState(null, "", "/settings/posting/getpaid/contentrewards?back=/money");
    await draw(<GetPaidPage place="contentrewards" />);
    await act(async () => await new Promise((r) => setTimeout(r, 220)));
    const s = spy();
    try {
      const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("Answer: do you see Finance?"))!;
      expect(button.classList.contains("btn--primary")).toBe(false);
      for (let i = 0; i < 2; i++) await act(async () => button.click());
      expect(s.seen.filter((x) => x.id === CR_FINANCE)).toHaveLength(2);
      expect(location.pathname + location.search + location.hash).toBe("/settings/posting/getpaid/contentrewards?back=/money");
    } finally {
      s.done();
    }
  });
});

// ---------- the result sentences (§40.6, exact) ----------

describe("back from Google or Whop: the sentences word for word", () => {
  const PAYMENTS: Record<string, string> = {
    payments_allowed: "Clip Factory can see your YouTube payments now. It checks once a day.",
    payments_denied: "You didn't allow it. Tap Allow payment reading to try again.",
    payments_missing: "Tick View your AdSense data on Google's page. Then tap Allow payment reading again.",
    payments_no_account: "That Google account has no AdSense for YouTube. Tap Allow payment reading again and pick the Google account that has it. Still no luck? Skip this step. Your ticks still work.",
    payments_api_off: "Tap Turn on AdSense reading, then Enable. Then tap Allow payment reading again.",
    payments_error: "Something went wrong. Tap Allow payment reading again.",
  };
  const WHOP: Record<string, string> = {
    whop_connected: "Clip Factory can see your Whop payouts now (@faze).",
    whop_denied: "You didn't allow it. Tap Connect Whop to try again.",
    whop_missing: "Tick all four boxes in your Whop app. Then tap Connect Whop.",
    whop_expired: "That took too long. Tap Connect Whop again.",
    whop_error: "Whop didn't answer. Tap Connect Whop again in a few minutes.",
  };

  for (const [code, sentence] of Object.entries(PAYMENTS))
    it(`?result=${code}`, async () => {
      start("fresh", (s) => (s.youtube = "in_program"));
      history.replaceState(null, "", `/settings/posting/getpaid/youtube?result=${code}`);
      await draw(<GetPaidPage place="youtube" />);
      expect(host.querySelector(`[data-result='${code}']`)!.textContent).toBe(sentence);
      expect(location.search).toBe("");
    });

  for (const [code, sentence] of Object.entries(WHOP))
    it(`?result=${code}`, async () => {
      start("fresh", (s) => {
        s.whopOn = true;
        s.whop = { status: "connected", accountName: "@faze", keyHint: "app_ab…wxyz" };
      });
      history.replaceState(null, "", `/settings/posting/getpaid/contentrewards?result=${code}#whop`);
      await draw(<GetPaidPage place="contentrewards" />);
      expect(host.querySelector("[data-help='getpaid-whop'] .gp-result")!.textContent).toBe(sentence);
      expect(location.search).toBe("");
      expect(location.hash).toBe("#whop");
    });

  it("an unknown result says nothing", () => {
    history.replaceState(null, "", "/settings/posting/getpaid/youtube?result=hacked");
    expect(gp.takeGetPaidResult()).toBeNull();
    expect(location.search).toBe("");
  });
});

// ---------- the Whop key ----------

describe("Connect Whop (§40.6)", () => {
  it("the key must start with app_; Save key stores it; then Connect Whop goes to Whop", async () => {
    start("fresh", (s) => (s.whopOn = true));
    await draw(<GetPaidPage place="contentrewards" />);
    const input = host.querySelector<HTMLInputElement>("#whop-key")!;
    const setValue = (v: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => setValue("nope"));
    await act(async () => host.querySelector<HTMLFormElement>(".gp-whop__form")!.requestSubmit());
    expect(host.querySelector("#whop-key-bad")!.textContent).toBe("Your Whop key starts with app_.");
    await act(async () => setValue("app_AbCdEf123456"));
    await act(async () => host.querySelector<HTMLFormElement>(".gp-whop__form")!.requestSubmit());
    await settle();
    expect(host.querySelector("[data-help='getpaid-whop']")!.textContent).toContain("Your Whop key is saved: app_Ab…3456");
    expect([...host.querySelectorAll("[data-help='getpaid-whop'] button")].some((b) => b.textContent?.includes("Connect Whop") && b.getAttribute("aria-disabled") !== "true")).toBe(true);
  });
});

describe("the Whop card's buttons (§40.1 item 2, §40.6)", () => {
  const whopConn = (over: Partial<import("../src/api/types.ts").PayConn> = {}) => ({ source: "whop" as const, status: "not_connected" as const, redirectUri: "https://hooks.example/oauth/whop/callback", ...over });

  it("nothing next and Whop not connected: Save key is the one vermilion until a key is saved, then Connect Whop", async () => {
    await draw(<WhopCard conn={whopConn()} main result={null} />);
    expect(vermilion().map((b) => b.textContent)).toEqual(["Save key"]);
    expect(host.querySelector("[data-step='whop-key']")!.textContent).toContain("A grown-up does this once on the Mac.");
    await draw(<WhopCard conn={whopConn({ status: "keys_saved", keyHint: "app_Ab…3456" })} main result={null} />);
    expect(vermilion().map((b) => b.textContent)).toEqual(["Connect Whop"]);
    // A step is next: every button here is glass.
    await draw(<WhopCard conn={whopConn({ status: "keys_saved", keyHint: "app_Ab…3456" })} main={false} result={null} />);
    expect(vermilion()).toHaveLength(0);
  });

  it("needs a reconnect: Connect Whop, and Stop reading Whop to forget the old sign-in", async () => {
    await draw(<WhopCard conn={whopConn({ status: "needs_reconnect", reason: "token_dead", keyHint: "app_Ab…3456" })} main result={null} />);
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("[data-help='getpaid-whop'] button")].map((b) => b.textContent);
    expect(buttons).toContain("Connect Whop");
    expect(buttons).toContain("Stop reading Whop");
    expect(vermilion().map((b) => b.textContent)).toEqual(["Connect Whop"]);
  });

  it("a different key while connected: the saved line comes back with a note, never the empty form", async () => {
    start("fresh", (s) => {
      s.whopOn = true;
      s.whop = { status: "connected", accountName: "@faze", keyHint: "app_Ab…3456" };
    });
    crConn = conn({ finance: false });
    await draw(<GetPaidPage place="contentrewards" />);
    const card = () => host.querySelector<HTMLElement>("[data-help='getpaid-whop']")!;
    await act(async () => [...card().querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Change key")!.click());
    const input = host.querySelector<HTMLInputElement>("#whop-key")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "app_ZyXw98765432");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => host.querySelector<HTMLFormElement>(".gp-whop__form")!.requestSubmit());
    await settle();
    expect(card().querySelector(".gp-whop__form")).toBeNull();
    expect(card().textContent).toContain("Your Whop key is saved: app_Zy…5432");
    expect(card().textContent).toContain(WHOP_KEY_CHANGED);
  });
});

// ---------- notify.getPaid ----------

describe("notify.getPaid (§40.7)", () => {
  const baseMe = (notify: Record<string, boolean>) => ({ user: { id: "u", email: "a@b.c" }, settings: { notify }, counts: { review: 0, running: 0, posted: 0 } }) as unknown as Me;
  beforeEach(() => {
    current = { ...current, listJobs: async () => ({ jobs: [], nextCursor: null }) };
  });

  it("absent from the API: no switch, and no getPaid in the PATCH body", async () => {
    me = baseMe({ ready: true, stopped: true, resumed: false, steps: false });
    await draw(<NotifyBranch />);
    expect(host.querySelector("#notify-getpaid")).toBeNull();
    const sw = host.querySelector<HTMLButtonElement>("#notify-ready [role='switch']")!;
    await act(async () => sw.click());
    expect(saveSettings).toHaveBeenCalled();
    expect(Object.keys((saveSettings.mock.calls[0]![0] as { notify: object }).notify)).not.toContain("getPaid");
  });

  it("known to the API: the switch, and getPaid in the PATCH", async () => {
    me = baseMe({ ready: true, stopped: true, resumed: false, steps: false, getPaid: true });
    await draw(<NotifyBranch />);
    const apple = host.querySelector<HTMLElement>("#notify-getpaid")!;
    expect(apple.textContent).toContain("Money on hold or sent to your bank");
    await act(async () => apple.querySelector<HTMLButtonElement>("[role='switch']")!.click());
    expect((saveSettings.mock.calls.at(-1)![0] as { notify: { getPaid: boolean } }).notify.getPaid).toBe(false);
  });
});

// ---------- the live refetch ----------

describe("lib/getPaid.ts refetches", () => {
  function Probe() {
    gp.useGetPaid();
    return null;
  }
  const send = (type: string) => {
    for (const fn of signals) fn({ kind: "event", event: { type, op: "upsert", id: "x", partial: true } as never });
  };

  it("on getpaid, setup and contentrewards news (debounced to one read), never on others", async () => {
    await draw(<Probe />);
    const before = calls.filter((c) => c === "getPaid").length;
    vi.useFakeTimers();
    send("getpaid");
    send("setup");
    send("contentrewards");
    await act(async () => vi.advanceTimersByTime(gp.LIVE_DEBOUNCE_MS + 10));
    vi.useRealTimers();
    await settle();
    expect(calls.filter((c) => c === "getPaid").length).toBe(before + 1);
    vi.useFakeTimers();
    send("job");
    send("follow");
    await act(async () => vi.advanceTimersByTime(gp.LIVE_DEBOUNCE_MS + 10));
    vi.useRealTimers();
    await settle();
    expect(calls.filter((c) => c === "getPaid").length).toBe(before + 1);
    expect(gp.isGetPaidNews("getpaid") && gp.isGetPaidNews("setup") && gp.isGetPaidNews("contentrewards")).toBe(true);
  });

  it("after a Content Rewards step's answer (it answers with the connection, not GetPaid)", async () => {
    crConn = conn({ finance: false });
    await draw(<GetPaidPage place="contentrewards" />);
    const before = calls.filter((c) => c === "getPaid").length;
    const done = [...host.querySelectorAll<HTMLButtonElement>("#step-move-whop button")].find((b) => b.textContent?.includes("I did this"))!;
    await act(async () => done.click());
    await act(async () => await new Promise((r) => setTimeout(r, gp.LIVE_DEBOUNCE_MS + 50)));
    await settle();
    expect(calls.some((c) => c.startsWith("crpatch:") && c.includes("move-whop"))).toBe(true);
    expect(calls.filter((c) => c === "getPaid").length).toBeGreaterThan(before);
  });
});

// ---------- never part of Set up posting ----------

describe("Set up posting is unchanged (§40.1 item 5)", () => {
  afterEach(() => {
    delete (window as unknown as { __cfMockFaults?: unknown }).__cfMockFaults;
  });
  it("every Get paid tick set: Set up posting and the floating list still have exactly five rows and say of 5", async () => {
    forgetLoaded();
    // The whole pretend API, so the Get paid ticks and Set up posting share one pretend server (with no pretend wait).
    (window as unknown as { __cfMockFaults?: { latencyMs: number } }).__cfMockFaults = { latencyMs: 0 };
    const full = mockApi(seed());
    current = full;
    me = { user: { id: "u", email: "a@b.c" }, settings: { notify: {} }, counts: { review: 0, running: 0, posted: 0 } } as unknown as Me;
    const before = await full.getSetup();
    for (const { step } of allGetPaidSteps()) if (step.manual !== false) await full.setGetPaidStep(step.id, true);
    const ticked = (await full.getPaid()).stepsDone;
    expect(ticked.length).toBeGreaterThan(10);
    const after = await full.getSetup();
    expect(after.platforms).toHaveLength(5);
    expect(after.platforms.map((p) => p.stepsDone)).toEqual(before.platforms.map((p) => p.stepsDone));
    const ids = new Set(allGetPaidSteps().map((x) => x.step.id));
    for (const p of after.platforms) expect(p.stepsDone.filter((x) => ids.has(x))).toEqual([]);
    const rows = todoRows(after.platforms);
    expect(rows).toHaveLength(5);
    expect(todoCount(rows).total).toBe(5);

    history.replaceState(null, "", "/settings/posting/getpaid");
    await draw(
      <>
        <SetupList />
        <SetupTodo />
      </>,
    );
    for (let i = 0; i < 150 && !(host.querySelector(".setup-todo__pill") && host.querySelector("ul[aria-label='The five platforms'] > li .setup-card")); i++) await settle();
    expect(host.querySelectorAll("ul[aria-label='The five platforms'] > li")).toHaveLength(5);
    expect(text()).toMatch(/\d of 5 ready/);
    const pill = host.querySelector<HTMLButtonElement>(".setup-todo__pill")!;
    expect(pill.getAttribute("aria-label")).toMatch(/^Set up posting: \d of 5 done$/);
    await act(async () => pill.click());
    expect(document.querySelectorAll(".setup-todo-panel .todo-row")).toHaveLength(5);
    expect([...document.querySelectorAll<HTMLElement>(".setup-todo-panel .todo-row")].map((r) => r.dataset.platform)).toEqual(["youtube", "tiktok", "instagram", "facebook", "x"]);
  }, 20_000);
});
