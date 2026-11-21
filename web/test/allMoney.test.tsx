// All your money in one place (docs/CONTRACTS.md §39.2, §39.5): every state of every place, one total per currency, no
// amount on a place that tells apps nothing, "Nothing to add up yet." with no total, the total bigger than Monthly's
// number, Monthly's "Apps only." line, the Notes card unchanged, and the mock's numbers equal to the server's.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, MoneyEverywhere, MoneyPlace } from "../src/api/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let current: Partial<Api> = {};
vi.mock("../src/api/index.ts", async (orig) => ({ ...(await orig<object>()), api: () => current as Api }));

const { AllMoney, APPS_ONLY, NOTHING_TO_ADD, TWO_MONIES, crLines, clockTime } = await import("../src/screens/money/AllMoney.tsx");
const { everywhere } = await import("../src/api/mock/moneyEverywhere.ts");
const { ToastProvider } = await import("../src/components/Toasts.tsx");

const CR = { stillEarningCents: 420, onItsWayCents: 0, readyToMoveCents: 1825, paidSoFarCents: 6240, asOf: "2026-11-19T14:10:00.000Z", movedOut: "not_available" as const };
const SETUP_CR = { label: "Set up Content Rewards", href: "/settings/posting/setup/contentrewards?back=/money", external: false };

/** Every state of the table, for each place it can happen to. */
const ROWS: MoneyPlace[] = [
  { place: "youtube", name: "YouTube", state: "number", headline: "YouTube says", amounts: [{ currency: "USD", amountMicros: 12_400_000 }], tag: "YouTube's estimate" },
  { place: "youtube", name: "YouTube", state: "not_set_up", headline: "Not set up yet", amounts: [], why: "Connect YouTube to see its money.", button: { label: "Set up YouTube", href: "/settings/posting/setup/youtube?back=/money", external: false } },
  { place: "youtube", name: "YouTube", state: "needs_ok", headline: "YouTube needs your OK", amounts: [], why: "Tap Allow money reading so YouTube shares your money with Clip Factory.", button: { label: "Allow money reading", href: "/settings/posting/money#money-youtube", external: false } },
  { place: "youtube", name: "YouTube", state: "waiting", headline: "Waiting for the first numbers", amounts: [], why: "YouTube says you're not in its Partner Program yet.", button: { label: "How close am I?", href: "/settings/posting/money", external: false } },
  { place: "youtube", name: "YouTube", state: "error", headline: "Couldn't check today", amounts: [], why: "Clip Factory tries again tomorrow." },
  { place: "tiktok", name: "TikTok", state: "not_available", headline: "Not available from TikTok", amounts: [], why: "TikTok doesn't tell apps what you earn.", where: { text: "Look in TikTok: Profile, then Balance." } },
  { place: "instagram", name: "Instagram", state: "not_available", headline: "Not available from Instagram", amounts: [], why: "Instagram doesn't tell apps what you earn.", where: { text: "Look in Instagram: Professional dashboard, then Payouts." } },
  { place: "facebook", name: "Facebook", state: "coming_soon", headline: "Coming soon", amounts: [], why: "Clip Factory can't show Facebook money yet.", where: { text: "Look in Meta Business Suite, then Payouts.", button: { label: "Open Meta Business Suite", url: "https://business.facebook.com/latest/monetization" } } },
  { place: "facebook", name: "Facebook", state: "number", headline: "Meta says", amounts: [{ currency: "EUR", amountMicros: 3_000_000 }], tag: "Meta's estimate" },
  { place: "x", name: "X", state: "not_available", headline: "Not available from X", amounts: [], why: "X doesn't tell apps what you earn.", where: { text: "Look in X, then Monetization (paid through Stripe).", button: { label: "Open X", url: "https://x.com/settings/monetization" } } },
  { place: "contentrewards", name: "Content Rewards", state: "number", headline: "Content Rewards says", amounts: [{ currency: "USD", amountMicros: 8_000_000 }], tag: "reached your balance in these 30 days · Content Rewards' numbers", cr: CR },
  { place: "contentrewards", name: "Content Rewards", state: "not_set_up", headline: "Not set up yet", amounts: [], why: "Connect Content Rewards to see its money.", button: SETUP_CR },
  { place: "contentrewards", name: "Content Rewards", state: "waiting", headline: "Waiting for the first numbers", amounts: [], why: "Checking Content Rewards…", cr: { ...CR, paidSoFarCents: null } },
  { place: "contentrewards", name: "Content Rewards", state: "error", headline: "Couldn't check today", amounts: [], why: "Content Rewards didn't answer. Try again in a few minutes.", cr: CR },
  { place: "contentrewards", name: "Content Rewards", state: "sign_in", headline: "Sign in again", amounts: [], why: "Sign in to Content Rewards again to see your money.", button: { ...SETUP_CR, label: "Sign in again" }, cr: CR },
];

function card(places: MoneyPlace[], totals: MoneyEverywhere["totals"] = []): MoneyEverywhere {
  return { from: "2026-10-18", to: "2026-11-16", periodText: "30 days up to Mon 16 Nov", lagNote: "YouTube is 2–3 days behind", places, totals, notCounted: [], asOf: "2026-11-19T15:00:00.000Z" };
}

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const draw = async (m: MoneyEverywhere) => {
  await act(async () => root.render(<ToastProvider>{<AllMoney load={{ state: "ok", data: m, reload: () => undefined }} />}</ToastProvider>));
};
const row = (i: number) => host.querySelectorAll<HTMLElement>(".cr-all__row")[i]!;

describe("All your money (AllMoney.tsx)", () => {
  it("every state of every place says its words, with at most one glass button and never a vermilion", async () => {
    await draw(card(ROWS));
    expect(host.textContent).toContain("All your money");
    expect(host.textContent).toContain("Every place · 30 days up to Mon 16 Nov · YouTube is 2–3 days behind");
    ROWS.forEach((p, i) => {
      const r = row(i);
      expect(r.dataset.state).toBe(p.state);
      expect(r.textContent).toContain(p.headline);
      if (p.why) expect(r.textContent).toContain(p.why);
      if (p.where) expect(r.textContent).toContain(p.where.text);
      expect(r.querySelectorAll(".btn").length, `${p.place} ${p.state}`).toBeLessThanOrEqual(1);
    });
    expect(host.querySelectorAll(".btn--primary")).toHaveLength(0);
    expect(host.querySelector("[data-help='money-everywhere']")).not.toBeNull();
  });

  it("no amount on a place that tells apps nothing, never $0 there", async () => {
    await draw(card(ROWS));
    ROWS.forEach((p, i) => {
      if (p.state === "number") return;
      expect(row(i).querySelector(".cr-all__amount"), `${p.place} ${p.state}`).toBeNull();
      if (p.place !== "contentrewards") expect(row(i).textContent).not.toMatch(/\$0\b/);
    });
    expect(row(5).textContent).toContain("Not available from TikTok");
    expect(row(0).textContent).toContain("$12.40");
    expect(row(0).textContent).toContain("YouTube's estimate");
  });

  it("Content Rewards' small lines in money's time order; See it all only while the row has no button", async () => {
    expect(crLines(CR)).toEqual([
      `Right now (Content Rewards says, ${clockTime(CR.asOf)}): Still earning $4.20 · Ready to move to Whop $18.25 · On its way to Whop $0.00`,
      "Earned so far, since you started: $62.40",
      "Paid out to your bank: not available from Content Rewards. Look on Whop: **Balances**.",
    ]);
    expect(crLines({ ...CR, paidSoFarCents: null, onItsWayCents: null })[0]).not.toContain("On its way");
    expect(crLines({ ...CR, paidSoFarCents: null })[1]).toBe("Earned so far, since you started: Checking…");
    expect(clockTime("2026-11-19T14:10:00.000Z")).toMatch(/^\d{1,2}:\d{2} [ap]m$/);
    await draw(card(ROWS));
    const seeAll = (i: number) => [...row(i).querySelectorAll("a")].some((a) => a.textContent?.includes("See it all"));
    expect(seeAll(10)).toBe(true); // number
    expect(seeAll(12)).toBe(true); // waiting
    expect(seeAll(14)).toBe(false); // sign_in has its own button
    expect(seeAll(11)).toBe(false); // not_set_up has no small lines
    expect(row(11).textContent).not.toContain("Earned so far");
    expect(row(14).textContent).toContain("Sign in again");
  });

  it("one total per currency, biggest first, naming what it adds; two currencies are never added", async () => {
    await draw(
      card(ROWS.slice(0, 1).concat(ROWS[8]!, ROWS[10]!), [
        { currency: "USD", amountMicros: 20_400_000, places: ["youtube", "contentrewards"], tag: "YouTube's estimate + Content Rewards' numbers" },
        { currency: "EUR", amountMicros: 3_000_000, places: ["facebook"], tag: "Meta's estimate" },
      ]),
    );
    const sums = host.querySelectorAll(".cr-all__sum");
    expect(sums).toHaveLength(2);
    expect(sums[0]!.textContent).toContain("Total: $20.40");
    expect(sums[0]!.textContent).toContain("YouTube + Content Rewards · 30 days up to Mon 16 Nov");
    expect(sums[0]!.textContent).toContain("YouTube's estimate + Content Rewards' numbers");
    expect(sums[1]!.textContent).toContain("€3.00");
    expect(host.textContent).toContain(TWO_MONIES);
  });

  it("nothing to add: Nothing to add up yet., and no total", async () => {
    await draw({ ...card(ROWS.slice(5, 8)), notCountedText: "Not in the total: TikTok and Instagram (not available) · Facebook (coming soon)." });
    expect(host.textContent).toContain(NOTHING_TO_ADD);
    expect(host.querySelector(".cr-all__sum")).toBeNull();
    expect(host.textContent).not.toContain("Total:");
    expect(host.textContent).toContain("Not in the total: TikTok and Instagram (not available) · Facebook (coming soon).");
  });

  it("hidden on an API from before §39 (404)", async () => {
    await act(async () => root.render(<AllMoney load={{ state: "off", data: null, reload: () => undefined }} />));
    expect(host.innerHTML).toBe("");
  });

  it("the total is the biggest number on the page; Monthly's is one size smaller while the card is there", () => {
    const css = readFileSync(join(import.meta.dirname, "..", "src", "styles", "contentrewards.css"), "utf8");
    expect(css).toMatch(/\.cr-all__total-num\s*\{[^}]*font-size:\s*var\(--fs-display\)/);
    expect(css).toMatch(/\.money-dash\.has-all-money \.dash-kpi--main \.dash-num\s*\{[^}]*font-size:\s*var\(--fs-h1\)/);
    // Its total never counts up: no count-up hook in the card.
    const tsx = readFileSync(join(import.meta.dirname, "..", "src", "screens", "money", "AllMoney.tsx"), "utf8");
    expect(tsx).not.toMatch(/useCountUp|requestAnimationFrame/);
  });
});

// ---------- the mock's numbers against the server's golden cases, when they are in the repo (G writes them) ----------

const CASES = join(import.meta.dirname, "..", "..", "api", "tests", "fixtures", "money_everywhere_cases.json");
const golden: (Parameters<typeof everywhere>[0] & { name: string; expect: MoneyEverywhere })[] = existsSync(CASES) ? JSON.parse(readFileSync(CASES, "utf8")) : [];

describe.skipIf(!golden.length)("the mock's All your money equals the server's (money_everywhere_cases.json)", () => {
  for (const c of golden)
    it(c.name, async () => {
      const { name: _n, expect: want, ...input } = c;
      expect(everywhere(input)).toEqual(want);
      await draw(want);
      expect(host.querySelectorAll(".cr-all__sum")).toHaveLength(want.totals.length);
      expect(host.textContent?.includes(NOTHING_TO_ADD)).toBe(want.totals.length === 0);
      want.places.forEach((p, i) => {
        if (p.state !== "number") expect(row(i).querySelector(".cr-all__amount")).toBeNull();
      });
    });
});

describe("the mock's All your money (no golden file needed)", () => {
  const SCOPE = "https://www.googleapis.com/auth/yt-analytics-monetary.readonly";
  const day = (i: number) => new Date(Date.UTC(2026, 9, 17 + i)).toISOString().slice(0, 10);
  const rows = Array.from({ length: 31 }, (_, i) => ({ platform: "youtube" as const, date: day(i), amountMicros: 400_000, currency: "USD" }));
  it("YouTube and Content Rewards give one USD total; TikTok, Instagram and X are never a number", () => {
    const m = everywhere({
      today: "2026-11-19T15:00:00.000Z",
      facebookVerified: false,
      accounts: { youtube: { platform: "youtube", status: "connected", scopes: [SCOPE] } },
      states: { youtube: { state: "earning" } },
      rows,
      crOn: true,
      crconn: { status: "connected", signInBy: "2027-02-01T00:00:00.000Z" },
      crmoney: { firstReadDone: true, paidByDayDone: true, paidTotalCents: 6240, stillEarningCents: 420, readyToMoveCents: 1825, onItsWayCents: 0, asOf: "2026-11-19T14:10:00.000Z", paidByDay: { "2026-11-12": 500, "2026-11-01": 300, "2026-10-01": 999 } },
    });
    expect(m.places.map((p) => p.place)).toEqual(["youtube", "tiktok", "instagram", "facebook", "x", "contentrewards"]);
    expect(m.places.find((p) => p.place === "contentrewards")!.amounts).toEqual([{ currency: "USD", amountMicros: 8_000_000 }]);
    for (const p of m.places.filter((x) => ["tiktok", "instagram", "x"].includes(x.place))) {
      expect(p.state).toBe("not_available");
      expect(p.amounts).toEqual([]);
    }
    expect(m.totals).toHaveLength(1);
    expect(m.totals[0]!.places).toEqual(["youtube", "contentrewards"]);
    expect(m.totals[0]!.tag).toBe("YouTube's estimate + Content Rewards' numbers");
  });
  it("Content Rewards switched off: no row; nothing stored: the last 30 days and nothing to add", () => {
    const off = everywhere({ today: "2026-11-19T15:00:00.000Z", facebookVerified: false, accounts: {}, states: {}, rows: [], crOn: false, crconn: null, crmoney: null });
    expect(off.places.some((p) => p.place === "contentrewards")).toBe(false);
    expect(off.periodText).toBe("the last 30 days");
    expect(off.totals).toEqual([]);
  });
});

// ---------- the Money page: All your money first, Monthly says it is apps only, Notes unchanged ----------

describe("the Money page with All your money", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia;
  });

  it("the card comes before the Apps chips; Monthly gains Apps only.; the Notes card keeps every line", async () => {
    sessionStorage.setItem("cf-mock-money", JSON.stringify({ scenario: "dash_many", country: null, seen: [] }));
    const { mockApi } = await import("../src/api/mock/index.ts");
    current = mockApi();
    const { MoneyDashboard, forgetDashCache } = await import("../src/screens/money/MoneyDashboard.tsx");
    forgetDashCache();
    await act(async () => root.render(<ToastProvider>{<MoneyDashboard />}</ToastProvider>));
    for (let i = 0; i < 40 && !host.querySelector(".cr-all__rows, .dash-kpi--monthly"); i++) await act(async () => await new Promise((r) => setTimeout(r, 50)));
    for (let i = 0; i < 40 && !(host.querySelector(".cr-all__rows") && host.querySelector(".dash-kpi--monthly")); i++) await act(async () => await new Promise((r) => setTimeout(r, 50)));
    const all = host.querySelector(".cr-all")!;
    const band = host.querySelector(".dash-band, .money-dock")!;
    expect(all).not.toBeNull();
    expect(all.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(host.querySelector(".money-dash")!.className).toContain("has-all-money");
    expect(host.querySelector(".dash-kpi--monthly")!.textContent).toContain(APPS_ONLY);
    expect(host.querySelector(".dash-kpi--weekly")!.textContent).not.toContain(APPS_ONLY);
    // The Notes card (§27.3) keeps every line.
    expect(host.querySelector(".dash-notes")?.textContent).toContain("Not counted:");
    // Content Rewards' own part stays at the end of the page.
    expect(host.querySelector("#content-rewards")).not.toBeNull();
  });

  /** The page on a phone (the dock's media query matches), with All your money answering or not (404: before §39). */
  async function phonePage(off: boolean) {
    window.matchMedia = ((q: string) => ({ matches: q.includes("max-width: 767px"), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia;
    sessionStorage.setItem("cf-mock-money", JSON.stringify({ scenario: "dash_many", country: null, seen: [] }));
    const { mockApi } = await import("../src/api/mock/index.ts");
    const { ApiError } = await import("../src/api/errors.ts");
    current = off ? { ...mockApi(), getMoneyEverywhere: async () => Promise.reject(new ApiError(404, "not_found", "Not found")) } : mockApi();
    const { MoneyDashboard, forgetDashCache } = await import("../src/screens/money/MoneyDashboard.tsx");
    forgetDashCache();
    await act(async () => root.render(<ToastProvider>{<MoneyDashboard />}</ToastProvider>));
    for (let i = 0; i < 40 && !host.querySelector(".dash-kpi--monthly"); i++) await act(async () => await new Promise((r) => setTimeout(r, 50)));
    if (!off) for (let i = 0; i < 40 && !host.querySelector(".cr-all__rows"); i++) await act(async () => await new Promise((r) => setTimeout(r, 50)));
    return host.querySelector<HTMLElement>(".money-dash")!;
  }

  it("phones: the Apps and days dock sits with the cards it changes, never in All your money's part (§39.2)", async () => {
    const page = await phonePage(false);
    expect(page.className).toContain("dock-with-cards");
    const filtered = page.querySelector(".dash-filtered")!;
    const dock = page.querySelector(".money-dock")!;
    // Its own part holds the dock and everything it changes (the cards, the chart, the clip list); All your money
    // and its total stay outside, above it.
    expect(filtered.contains(dock)).toBe(true);
    expect(filtered.contains(page.querySelector(".dash-kpi--monthly"))).toBe(true);
    expect(page.querySelector(".dash-clips")).not.toBeNull();
    expect(filtered.contains(page.querySelector(".dash-clips"))).toBe(true);
    expect(filtered.contains(page.querySelector(".cr-all"))).toBe(false);
    expect(filtered.contains(page.querySelector(".cr-all__total"))).toBe(false);
    expect(page.querySelector(".cr-all")!.compareDocumentPosition(filtered) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Still first in the reading and tab order of that part: right after All your money.
    expect(filtered.firstElementChild).toBe(dock);
  });

  it("phones without All your money (an API from before §39): the dock is as before", async () => {
    const page = await phonePage(true);
    expect(page.querySelector(".cr-all")).toBeNull();
    expect(page.className).not.toContain("dock-with-cards");
    expect(page.querySelector(".money-dock")).not.toBeNull();
  });
});
