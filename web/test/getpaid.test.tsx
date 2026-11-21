// Get paid drawn in jsdom (docs/CONTRACTS.md §40, §40.8 tests), against the pretend API (api/mock/getpaid.ts): the
// status pill words, tones and icons; never "Live", "Not connected" or "disconnected"; one vermilion per screen, per
// status; the ring without the reading step and its chip; phone steps on a computer; ticks and autos; the Money card's
// buttons; the result sentences word for word; notify.getPaid only when the API knows it; the live refetch; and Set up
// posting still exactly five rows, "of 5", with every Get paid tick set.
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
const { GetPaidPage, READING_GONE } = await import("../src/screens/getpaid/GetPaidPage.tsx");
const { StatusPill } = await import("../src/screens/getpaid/StatusPill.tsx");
const { GetPaidCard: MoneyCard } = await import("../src/screens/money/GetPaidCard.tsx");
const { NotifyBranch } = await import("../src/screens/settings/NotifyBranch.tsx");
const { ToastProvider } = await import("../src/components/Toasts.tsx");
const gp = await import("../src/lib/getPaid.ts");
const { resetCr } = await import("../src/lib/contentRewards.ts");
const { todoRows, todoCount } = await import("../src/lib/setupTodo.ts");
const { setupApi } = await import("../src/api/mock/setup.ts");
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
  it("the list has none; each card is one tap to its page; Your bank says only D's words", async () => {
    start("owner");
    accounts = (["youtube", "instagram", "facebook", "x", "tiktok"] as Platform[]).map((platform) => ({ platform, status: "connected" }) as Account);
    await draw(<GetPaidList />);
    expect(vermilion()).toHaveLength(0);
    const cards = [...host.querySelectorAll<HTMLAnchorElement>("a.gp-card")];
    expect(cards.map((a) => a.getAttribute("href"))).toEqual(["youtube", "tiktok", "instagram", "facebook", "x", "contentrewards"].map((p) => `/settings/posting/getpaid/${p}`));
    expect(host.querySelector("[data-help='getpaid-list']")).not.toBeNull();
    expect(text()).toContain("Clip Factory can't see your bank. Look in your bank's app to see what arrived.");
    expect(host.querySelector(".gp-bank button, .gp-bank a")).toBeNull();
    expect(host.querySelector(".gp-summary")!.textContent).toBe((await mock.api.getPaid()).summary);
    expect(host.querySelector("a.gp-card[data-place='x']")!.textContent).toContain("Your Clip Factory clips probably won't earn on X.");
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
  });

  it("a phone step on a computer says to use the phone and has no Open; on a phone it opens the app's https page", async () => {
    await draw(<GetPaidPage place="tiktok" />);
    const one = host.querySelector<HTMLElement>("#step-tt-gifts")!;
    expect(one.textContent).toContain("Do this in the TikTok app on your phone.");
    expect(one.querySelector("a[href^='https://']")).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    gp.resetGetPaid();
    phone(true);
    await draw(<GetPaidPage place="tiktok" />);
    expect(host.querySelector("#step-tt-gifts")!.textContent).not.toContain("on your phone.");
    expect(host.querySelector<HTMLAnchorElement>(".gp-pin a")!.getAttribute("href")).toBe("https://www.tiktok.com/");
    expect(host.querySelector<HTMLAnchorElement>(".gp-pin a")!.rel).toBe("noopener noreferrer");
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
    expect(text()).toContain("Pick your country in Money settings to see its rules.");
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
  it("every Get paid tick set: still exactly five rows and of 5; no Get paid tick in SETUP#", async () => {
    sessionStorage.removeItem("cf-mock-setup");
    const setup = setupApi();
    const before = setup.overview();
    for (const { step } of allGetPaidSteps()) if (step.manual !== false) await mock.api.setGetPaidStep(step.id, true);
    const after = setup.overview();
    expect(after.platforms).toHaveLength(5);
    expect(after.ready).toBe(before.ready);
    const rows = todoRows(after.platforms);
    expect(rows).toHaveLength(5);
    expect(todoCount(rows).total).toBe(5);
    expect(`${after.ready} of 5 ready`).toMatch(/ of 5 ready$/);
    const ids = new Set(allGetPaidSteps().map((s) => s.step.id));
    for (const p of after.platforms) expect(p.stepsDone.filter((s) => ids.has(s))).toEqual([]);
  });
});
