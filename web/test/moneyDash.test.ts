// The money dashboard's rules on the web (docs/CONTRACTS.md §27.4, §27.9): the apps filter, saved choices (the
// address wins, broken storage never breaks the page), plain dates in any time zone, the chip's words, the chart's
// shape, and the mock's numbers against the server's shared golden cases.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addDays, divRound, moneyClips, summarize, type MoneyPost, type MoneyRow } from "../src/api/mock/moneySummary.ts";
import { dashData, MONEY_SCENARIOS, moneyApi } from "../src/api/mock/money.ts";
import type { MoneyChart, Platform } from "../src/api/types.ts";
import {
  barHeights,
  barLayout,
  chipFor,
  chipSentence,
  choiceSearch,
  clipPeriod,
  DEFAULT_CHOICE,
  nearestBar,
  numberStep,
  plainDay,
  plainShort,
  readChoice,
  readStored,
  stackShares,
  toggleApp,
  writeStored,
} from "../src/lib/moneyDash.ts";
import { match, section } from "../src/lib/router.ts";

interface GoldenCase {
  name: string;
  today: string;
  platforms: Platform[];
  chart: MoneyChart;
  facebookVerified: boolean;
  status: Record<string, { connected?: boolean; moneyScope?: boolean; lastError?: string | null }>;
  series: { platform: Platform; currency: string; start: string; amounts: (number | null)[] }[];
  revised?: { platform: Platform; date: string }[];
  expected: unknown;
}
const GOLDEN = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "api", "tests", "fixtures", "money_summary_cases.json"), "utf8")) as {
  where: Record<string, { label: string; url?: string }>;
  cases: GoldenCase[];
};

function rowsOf(c: GoldenCase): MoneyRow[] {
  const revised = new Set((c.revised ?? []).map((r) => `${r.platform}|${r.date}`));
  return c.series.flatMap((s) =>
    s.amounts.flatMap((amountMicros, i) => {
      if (amountMicros === null) return [];
      const date = addDays(s.start, i);
      const row: MoneyRow = { platform: s.platform, date, amountMicros, currency: s.currency };
      if (revised.has(`${s.platform}|${date}`)) row.revisedAt = "2026-11-18T06:00:00.000Z";
      return [row];
    }),
  );
}

describe("the mock agrees with the server (shared golden cases)", () => {
  it("has the cases", () => expect(GOLDEN.cases.length).toBeGreaterThanOrEqual(25));
  for (const c of GOLDEN.cases) {
    it(c.name, () => {
      const got = summarize({ today: c.today, platforms: c.platforms, chart: c.chart, rows: rowsOf(c), status: c.status, facebookVerified: c.facebookVerified, where: GOLDEN.where });
      expect(JSON.parse(JSON.stringify(got))).toEqual(c.expected);
    });
  }
  it("rounds half away from zero in whole numbers", () => {
    expect(divRound(15, 30)).toBe(1);
    expect(divRound(-15, 30)).toBe(-1);
    expect(divRound(14, 30)).toBe(0);
    expect(divRound(7, -2)).toBe(-4);
  });
});

describe("the apps filter", () => {
  it("All is the default; tapping an app while All is on picks only it", () => {
    expect(DEFAULT_CHOICE.apps).toEqual([]);
    expect(toggleApp([], "tiktok")).toEqual(["tiktok"]);
  });
  it("adds and removes, always in YouTube, TikTok, Instagram, Facebook, X order", () => {
    expect(toggleApp(["x"], "youtube")).toEqual(["youtube", "x"]);
    expect(toggleApp(["youtube", "x"], "x")).toEqual(["youtube"]);
  });
  it("turning off the last app goes back to All; all five is All; All clears the rest", () => {
    expect(toggleApp(["youtube"], "youtube")).toEqual([]);
    expect(toggleApp(["youtube", "tiktok", "instagram", "facebook"], "x")).toEqual([]);
    expect(toggleApp(["youtube", "tiktok"], "all")).toEqual([]);
  });
});

describe("saved choices", () => {
  afterEach(() => localStorage.clear());

  it("the address wins over this device's saved choice", () => {
    writeStored({ apps: ["tiktok"], period: 7, sort: "views" });
    const got = readChoice("?apps=youtube&period=90", readStored());
    expect(got).toEqual({ apps: ["youtube"], period: 90, sort: "views" });
  });
  it("bad JSON or bad values fall back to the defaults", () => {
    localStorage.setItem("cf-money-dash", "{nope");
    expect(readStored()).toEqual(DEFAULT_CHOICE);
    localStorage.setItem("cf-money-dash", JSON.stringify({ apps: ["myspace"], period: 14, sort: "newest" }));
    expect(readStored()).toEqual(DEFAULT_CHOICE);
    expect(readChoice("?apps=vine&period=3", DEFAULT_CHOICE)).toEqual(DEFAULT_CHOICE);
  });
  it("storage that throws on read and write never breaks the page", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readStored(broken)).toEqual(DEFAULT_CHOICE);
    expect(() => writeStored({ apps: [], period: 30, sort: "money" }, broken)).not.toThrow();
  });
  it("the address leaves the defaults out and keeps other words", () => {
    expect(choiceSearch(DEFAULT_CHOICE)).toBe("");
    expect(choiceSearch({ apps: ["youtube", "facebook"], period: 365, sort: "views" }, "?x=1")).toBe("?x=1&apps=youtube,facebook&period=365&sort=views");
    expect(readChoice("?period=year", DEFAULT_CHOICE).period).toBe(365);
  });
  it("a year of chart shows each clip's lifetime money in the list", () => {
    expect(clipPeriod(365)).toBe("all");
    expect(clipPeriod(30)).toBe(30);
  });
});

describe("plain dates", () => {
  const original = process.env.TZ;
  afterEach(() => {
    process.env.TZ = original;
  });
  for (const tz of ["Pacific/Kiritimati", "America/Los_Angeles", "UTC"]) {
    it(`the platform's day is never shifted (${tz})`, () => {
      process.env.TZ = tz;
      expect(plainDay("2026-11-16")).toBe("Mon 16 Nov");
      expect(plainDay("2026-01-01")).toBe("Thu 1 Jan");
      expect(plainShort("2026-09-01")).toBe("1 Sep");
      expect(plainShort("2025-11-17", 2026)).toBe("17 Nov 2025");
    });
  }
});

describe("the comparison chip", () => {
  it("says it in words, with an arrow, never vermilion", () => {
    expect(chipFor({ direction: "up", changePct: 12, previousPeriodMicros: 1 })).toEqual({ text: "Up 12%", tone: "success", icon: "arrowUp" });
    expect(chipFor({ direction: "down", changePct: -8, previousPeriodMicros: 1 })).toEqual({ text: "Down 8%", tone: "neutral", icon: "arrowDown" });
    expect(chipFor({ direction: "same", changePct: 0, previousPeriodMicros: 1 })?.text).toBe("Same");
    expect(chipFor({ direction: "new", changePct: null, previousPeriodMicros: 0 })?.text).toBe("New");
    expect(chipFor({ direction: "none", changePct: null, previousPeriodMicros: null })).toBeNull();
    expect(chipFor({ direction: "up", changePct: 499_900, previousPeriodMicros: 1 })?.text).toBe("Up 999%+");
    expect(chipSentence({ direction: "down", changePct: -8, previousPeriodMicros: 1 }, 30)).toBe("Down 8% on the 30 days before");
  });
});

describe("the chart's shape", () => {
  it("scales to the tallest bar, keeps zero at zero and a tiny value visible", () => {
    expect(barHeights([0, 50, 100], 180)).toEqual([0, 90, 180]);
    expect(barHeights([0, 0], 180)).toEqual([0, 0]);
    expect(barHeights([1, 1_000_000], 180)[0]).toBe(2);
  });
  it("90 bars fit in 288 px", () => {
    const bars = barLayout(90, 288, 2);
    expect(bars).toHaveLength(90);
    const last = bars.at(-1)!;
    expect(last.x + last.w).toBeCloseTo(288, 5);
    expect(bars[0]!.w).toBeGreaterThanOrEqual(1);
  });
  it("53 week bars, and the nearest bar to a tap", () => {
    expect(barLayout(53, 600, 2)).toHaveLength(53);
    expect(nearestBar(0, 90, 288)).toBe(0);
    expect(nearestBar(287, 90, 288)).toBe(89);
    expect(nearestBar(999, 90, 288)).toBe(89);
    expect(nearestBar(5, 0, 288)).toBe(-1);
  });
  it("stacks pieces by share of the bar", () => {
    expect(stackShares([1, 3], 100)).toEqual([25, 75]);
    expect(stackShares([0, 0], 100)).toEqual([0, 0]);
  });
  it("a narrow card drops the number one step", () => {
    expect(numberStep(138)).toBe("h3");
    expect(numberStep(200)).toBe("h2");
  });
});

describe("the mock dashboard", () => {
  it("every money scenario answers the summary and the clip list", async () => {
    for (const scenario of MONEY_SCENARIOS) {
      sessionStorage.setItem("cf-mock-money", JSON.stringify({ scenario, country: "US", seen: [] }));
      const { api } = moneyApi(async () => {});
      const summary = await api.getMoneySummary([], 30);
      expect(summary.platforms).toEqual(["youtube", "tiktok", "instagram", "facebook", "x"]);
      if (scenario !== "dash_error") await api.getMoneyClips({ platforms: [], period: 30, sort: "money" });
    }
  });
  it("dash_many counts YouTube and Facebook, and TikTok, Instagram and X say they don't share", () => {
    const data = dashData("dash_many", "2026-11-19");
    const out = summarize({ today: "2026-11-19", platforms: [], chart: 365, rows: data.rows, status: data.status, facebookVerified: data.facebookVerified, where: {} });
    expect(out.included).toEqual(["youtube", "facebook"]);
    expect(out.through).toBe("2026-11-16");
    expect(out.excluded.map((e) => e.reason)).toEqual(["not_shared", "not_shared", "not_shared"]);
    // Facebook has 120 days: "Last 365 days" waits until every counted app covers the year.
    expect(out.currencies[0]!.yearly.last365Micros).toBeNull();
    expect(out.revised.days).toBe(2);
    const yt = summarize({ today: "2026-11-19", platforms: ["youtube"], chart: 30, rows: data.rows, status: data.status, facebookVerified: true, where: {} });
    expect(yt.currencies[0]!.yearly.last365Micros).not.toBeNull();
  });
  it("per 1,000 views only from the same report's views, from 1,000 views", () => {
    const post = (views: number): MoneyPost => ({
      postId: `p${views}`,
      clipId: `c${views}`,
      platform: "youtube",
      postedAt: "2026-10-01T00:00:00.000Z",
      views: 99_999,
      revenueWindows: { "30": { amountMicros: 4_100_000, views, from: "2026-10-18", to: "2026-11-16", currency: "USD" } },
    });
    const out = moneyClips([post(2_500), post(999)], new Map(), { platforms: ["youtube"], period: 30, sort: "money" }, false);
    expect(out.clips.map((c) => c.platforms[0]!.per1000Views?.amountMicros ?? null)).toEqual([1_640_000, null]);
  });
});

describe("the route", () => {
  it("/money is its own page in the Money section", () => {
    expect(match("/money", "?apps=youtube")).toEqual({ name: "money" });
    expect(section({ name: "money" })).toBe("money");
  });
});
