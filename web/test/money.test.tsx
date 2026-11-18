// Real earnings on the web (docs/CONTRACTS.md §25.7): formatting only (never maths on money), one colour meaning per
// state with no vermilion pill, every state of every card from the mock, "$" only next to platform-reported money
// with its source, celebrations once, the money grant's answers, and the goals' official sources.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import config from "../../config/monetization.json";
import type { Api, MoneyCard as Card, MoneyGoal } from "../src/api/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let current: Partial<Api> = {};
vi.mock("../src/api/index.ts", async (orig) => ({ ...(await orig<object>()), api: () => current as Api }));

const { MoneyCard } = await import("../src/components/MoneyCard.tsx");
const { ToastProvider } = await import("../src/components/Toasts.tsx");
const { buildMoneyView, moneyApi, mockMoneyGrant, MONEY_SCENARIOS } = await import("../src/api/mock/money.ts");
const money = await import("../src/lib/money.ts");
const { readMoneyResult } = await import("../src/screens/settings/MoneyBranch.tsx");
const { moneyTileLine } = await import("../src/screens/home/MoneyTile.tsx");
const { legacySettingsRedirect, findApple } = await import("../src/lib/settingsTree.ts");

const goal = (over: Partial<MoneyGoal>): MoneyGoal => ({
  key: "subscribers",
  label: "subscribers",
  kind: "bar",
  current: 812,
  goal: 1000,
  reached: false,
  approx: false,
  sourceUrl: "https://support.google.com/youtube/answer/72851",
  ...over,
});

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  sessionStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(card: Card) {
  act(() =>
    root.render(
      <ToastProvider>
        <MoneyCard card={card} now={Date.parse("2026-11-18T08:00:00Z")} />
      </ToastProvider>,
    ),
  );
}

describe("formatting, never maths", () => {
  it("formats the platform's own currency and never converts", () => {
    expect(money.formatMoney(12_400_000, "USD")).toBe("$12.40");
    expect(money.formatMoney(85_000_000, "SEK")).toMatch(/^SEK\s85\.00$/);
    expect(money.formatMoney(3_000, "USD")).toBe("<$0.01");
    expect(money.formatMoney(0, "EUR")).toBe("€0.00");
    expect(money.formatMoney(1_000_000, "NOT-A-CODE")).toBe("1.00 NOT-A-CODE");
  });

  it("writes goals plainly", () => {
    expect(money.goalText(goal({}))).toBe("812 / 1,000 subscribers");
    expect(money.goalText(goal({ current: 1_200_000, goal: 10_000_000, label: "Shorts views in 90 days" }))).toBe("1.2M / 10M Shorts views in 90 days");
    expect(money.goalText(goal({ kind: "tick", current: 1, goal: 1, label: "Premium" }))).toBe("Premium: yes");
    expect(money.goalText(goal({ kind: "number", current: 40_200, goal: null, label: "impressions in 90 days" }))).toBe("40,200 impressions in 90 days");
    expect(money.fraction(goal({ current: 1500, goal: 1000 }))).toBe(1);
    expect(money.fraction(goal({ current: null }))).toBe(0);
  });

  it("no state pill is vermilion: vermilion is only for actions", () => {
    expect(Object.values(money.STATE_TONE)).not.toContain("vermilion");
  });

  it("says plainly what came back from Allow money reading", () => {
    expect(money.resultCopy("money_allowed", "YouTube")).toEqual({ ok: true, text: "Done! Clip Factory can read money from YouTube now. Checking…" });
    expect(money.resultCopy("money_missing", "TikTok").text).toBe("TikTok hasn't approved this yet. Try again after it's approved. Posting still works.");
    expect(money.resultCopy("money_wrong_account", "YouTube").ok).toBe(false);
    expect(money.resultCopy("money_error", "X").text).toContain("Nothing changed.");
  });

  it("finds the bar nearest its goal for Home", () => {
    const view = buildMoneyView({ scenario: "start", country: "US", seen: [] });
    expect(money.nearestGoal(view.platforms)?.goal.key).toBe("subscribers");
    expect(moneyTileLine(view)).toBe("No money yet. Here's how close you are.");
    expect(moneyTileLine(buildMoneyView({ scenario: "earning", country: "US", seen: [] }))).toBe("Money the apps reported this month.");
    expect(moneyTileLine(buildMoneyView({ scenario: "not_connected", country: null, seen: [] }))).toBe(
      "Connect an app to see how close you are to getting paid.",
    );
  });
});

describe("every state from the mock", () => {
  for (const scenario of MONEY_SCENARIOS) {
    it(`${scenario}: money only with a source, a currency and the platform's estimate tag`, () => {
      const view = buildMoneyView({ scenario, country: "US", seen: [] });
      expect(view.platforms.map((c) => c.platform)).toEqual(["youtube", "tiktok", "instagram", "facebook", "x"]);
      for (const card of view.platforms) {
        if (card.revenue) {
          expect(card.revenue.source).toBeTruthy();
          expect(card.revenue.currency).toMatch(/^[A-Z]{3}$/);
          expect(card.revenue.tag).toMatch(/'s estimate$/);
          expect(card.state).toBe("earning");
        }
        render(card);
        const text = host.textContent ?? "";
        if (!card.revenue && !card.approxMonth) expect(text).not.toMatch(/[$€£]\s?\d/);
        else expect(text).toContain(card.revenue!.tag);
        for (const word of [/\bpaid you\b/i, /\breceived\b/i, /\bactual\b/i, /best guess/i]) expect(text).not.toMatch(word);
        expect(host.querySelectorAll(".btn--action, .btn--primary").length).toBeLessThanOrEqual(1);
        expect(host.querySelectorAll(".money-goals > .money-goal").length).toBeLessThanOrEqual(money.SHOWN_GOALS);
      }
    });
  }

  it("states pick the right pill and line", () => {
    const pills = (s: (typeof MONEY_SCENARIOS)[number]) => buildMoneyView({ scenario: s, country: "US", seen: [] }).platforms.map((c) => c.state);
    expect(pills("start")).toEqual(["needs_permission", "needs_permission", "goal_reached", "unknown", "not_available"]);
    expect(pills("not_yet")[0]).toBe("not_yet");
    expect(pills("in_program")[0]).toBe("in_program");
    expect(pills("earning")[0]).toBe("earning");
    expect(pills("facebook_verified")[3]).toBe("earning");
    expect(pills("facebook_unverified")[3]).toBe("unknown");
    expect(pills("unsupported")).toEqual(["needs_permission", "not_available", "not_available", "unknown", "not_available"]);
    expect(pills("not_connected")).toEqual(Array(5).fill("not_connected"));
    expect(pills("error")[0]).toBe("error");
  });

  it("two currencies stay two lines", () => {
    const view = buildMoneyView({ scenario: "facebook_verified", country: "US", seen: [] });
    expect(view.thisMonth.map((l) => l.currency).sort()).toEqual(["EUR", "USD"]);
  });

  it("goal reached always says the app checks more", () => {
    render(buildMoneyView({ scenario: "start", country: "US", seen: [] }).platforms[2]!);
    expect(host.textContent).toContain("Goal reached. Instagram also checks things we can't see.");
  });

  it("Facebook money waits for its live check", () => {
    const fb = buildMoneyView({ scenario: "facebook_unverified", country: "US", seen: [] }).platforms[3]!;
    expect(fb.revenue).toBeUndefined();
    render(fb);
    expect(host.textContent).toContain("Facebook money: coming soon");
  });

  it("TikTok needs a country, and says when it is not open", () => {
    expect(buildMoneyView({ scenario: "start", country: null, seen: [] }).platforms[1]!.extras[0]).toBe(
      "Pick your country at the top to see this programme's goals.",
    );
    expect(buildMoneyView({ scenario: "unsupported", country: "other", seen: [] }).platforms[1]!.extras[0]).toContain("not open in your country");
  });
});

describe("Allow money reading and celebrations", () => {
  it("the grant comes straight back to the Money page in the pretend app", () => {
    const out = mockMoneyGrant("youtube");
    expect(out.authorizeUrl).toBe("/settings/posting/money?result=money_allowed&platform=youtube");
    expect(() => mockMoneyGrant("instagram")).toThrow();
  });

  it("the YouTube card has one button that does the whole flow", () => {
    const card = buildMoneyView({ scenario: "start", country: "US", seen: [] }).platforms[0]!;
    current = { connectAccount: vi.fn(async () => ({ authorizeUrl: "javascript:alert(1)", expiresAt: "" })) };
    render(card);
    const buttons = [...host.querySelectorAll("button")].filter((b) => b.textContent?.includes("Allow money reading"));
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.className).toContain("btn--action");
  });

  it("a celebration plays once: seen moves it out for good", async () => {
    const { api } = moneyApi(async () => undefined);
    const store = { scenario: "in_program", country: "US", seen: [] as string[] };
    sessionStorage.setItem("cf-mock-money", JSON.stringify(store));
    const first = await api.getMoney();
    expect(first.celebrations.map((c) => c.key)).toEqual(["youtube:in_program"]);
    const after = await api.seenMoney("youtube:in_program");
    expect(after.celebrations).toEqual([]);
    await expect(api.seenMoney("youtube:in_program")).rejects.toThrow();
    expect((await api.getMoney()).celebrations).toEqual([]);
  });

  it("Check now runs at most once an hour", async () => {
    const { api } = moneyApi(async () => undefined);
    expect((await api.refreshMoney()).started).toBe(true);
    expect((await api.refreshMoney()).started).toBe(false);
  });

  it("reads ?result=&platform= once and cleans the address", () => {
    history.replaceState(null, "", "/settings/posting/money?result=money_allowed&platform=youtube#money-youtube");
    expect(readMoneyResult()).toEqual({ result: "money_allowed", platform: "youtube" });
    expect(location.search).toBe("");
    expect(location.hash).toBe("#money-youtube");
    expect(readMoneyResult()).toBeNull();
    history.replaceState(null, "", "/settings/posting/money?result=hacked&platform=youtube");
    expect(readMoneyResult()).toBeNull();
  });
});

describe("settings tree and config", () => {
  it("old money anchors open the branch, and every money apple exists", () => {
    for (const old of ["money-how", "money-paid", "money-rate", "money-sources"]) {
      expect(legacySettingsRedirect("/settings", "", `#${old}`)).toBe("/settings/posting/money");
    }
    for (const id of ["money-country", "money-youtube", "money-tiktok", "money-instagram", "money-facebook", "money-x", "money-payouts"]) {
      expect(findApple(id)?.branch.slug).toBe("money");
    }
  });

  it("every goal in config/monetization.json names an official source (no third-party numbers)", () => {
    const hosts = new Set(["support.google.com", "support.tiktok.com", "www.tiktok.com", "creators.instagram.com", "help.instagram.com", "www.facebook.com", "help.x.com"]);
    for (const p of Object.values(config.platforms) as { rules: { goals: { source: string; verifiedHow: string }[]; more?: { source: string; verifiedHow: string }[] }[] }[]) {
      for (const r of p.rules) {
        for (const g of [...r.goals, ...(r.more ?? [])]) {
          const url = new URL(g.source);
          expect(url.protocol).toBe("https:");
          expect(hosts.has(url.hostname), g.source).toBe(true);
          expect(["official-page", "official-snippet"]).toContain(g.verifiedHow);
        }
      }
    }
  });

  it("the mock's goal numbers are the config's", () => {
    const yt = config.platforms.youtube.rules[0]!.goals.map((g) => [g.key, g.goal]);
    const mock = buildMoneyView({ scenario: "not_yet", country: "US", seen: [] }).platforms[0]!.goals.map((g) => [g.key, g.goal]);
    expect(mock).toEqual(yt);
  });
});
