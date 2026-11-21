// The CI guard of docs/CONTRACTS.md §25 (ADR-47): no screen may guess money again. The retired §21 helpers and the
// owner-typed rates must not come back anywhere in web/src. `earningsRates` and `earningsPaid` stay only where the
// settings are typed and validated (they are stored, never read).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");
const ALLOWED_SETTINGS_FILES = new Set(["api/types.ts", "api/mock/index.ts", "api/mock/fixtures.ts"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx|json)$/.test(name) && name !== "help-corpus.json" ? [path] : [];
  });
}

const read = (f: string) => readFileSync(f, "utf8");
const rel = (f: string) => relative(SRC, f).split("\\").join("/");

describe("no money guesses (§25, ADR-47)", () => {
  it("nothing imports the retired lib/earnings.ts or config/earnings.json", () => {
    const using = files(SRC).filter((f) => /from\s+["'][^"']*(lib\/earnings|config\/earnings\.json)/.test(read(f)) || /earnings\.(ts|json)/.test(read(f)));
    expect(using.map(rel)).toEqual([]);
  });

  it("no guess helpers: rateFor, perThousand, moneyPhrase, moneyWords, paidViews", () => {
    const using = files(SRC).filter((f) => /\b(rateFor|perThousand|moneyPhrase|moneyWords|earningFor|clipEarnings)\b/.test(read(f)));
    expect(using.map(rel)).toEqual([]);
  });

  it("the retired owner-typed amounts are only typed and validated, never read by a screen", () => {
    const using = files(SRC).filter((f) => /\bearnings(Rates|Paid)\b/.test(read(f)) && !ALLOWED_SETTINGS_FILES.has(rel(f)));
    expect(using.map(rel)).toEqual([]);
  });

  // §27.9 (the money dashboard): money is worked out only on the server. The web only formats it. The one exception is
  // the mock's copy of the server's numbers, checked against the shared golden cases (test/moneyDash.test.ts).
  const MOCK_NUMBERS = "api/mock/moneySummary.ts";
  // Drawing only: the Settings money card's sparkline scales each day's height to its card (never a shown amount).
  const DRAWING = new Map([["components/MoneyCard.tsx", 1]]);
  const code = (f: string) =>
    read(f)
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");

  it("no screen multiplies or divides an amount (amountMicros * or /)", () => {
    const hits = files(SRC)
      .filter((f) => rel(f) !== MOCK_NUMBERS)
      .flatMap((f) => (code(f).match(/amountMicros\s*[*/]/g) ?? []).map(() => rel(f)));
    const counts = new Map<string, number>();
    for (const h of hits) counts.set(h, (counts.get(h) ?? 0) + 1);
    expect([...counts].filter(([f, n]) => DRAWING.get(f) !== n)).toEqual([]);
  });

  it("no yearly pace on the web: nothing times 12 next to money", () => {
    const using = files(SRC).filter((f) => rel(f) !== MOCK_NUMBERS && /(Micros|money|Money)[^\n]{0,80}\*\s*12\b|\*\s*12\b[^\n]{0,80}(Micros|money|Money)/.test(code(f)));
    expect(using.map(rel)).toEqual([]);
  });

  it("views are never turned into money (no views times or divided by anything)", () => {
    const using = files(SRC).filter((f) => rel(f) !== MOCK_NUMBERS && !rel(f).startsWith("api/mock/stats") && /\bviews\s*[*/]|[*/]\s*\(?\s*\w*\.?views\b/i.test(code(f)));
    expect(using.map(rel)).toEqual([]);
  });

  it("per 1,000 views is only shown, never worked out", () => {
    const using = files(SRC).filter(
      (f) => rel(f) !== MOCK_NUMBERS && code(f).split("\n").some((line) => line.includes("per1000Views") && /[*/]\s*[\w(]|\b1000\b|1_000\b/.test(line)),
    );
    expect(using.map(rel)).toEqual([]);
  });

  // §38.7: Content Rewards' money is its own reported numbers, only formatted. Never a rate × views, never added up on
  // the web (the mock's copy of the server's numbers is the one exception).
  const CR_MOCK = "api/mock/contentrewards.ts";
  it("Content Rewards amounts are never worked out (no cents times, divided or added)", () => {
    const hits = files(SRC)
      .filter((f) => rel(f) !== CR_MOCK)
      .flatMap((f) => (code(f).match(/\w*Cents\b\s*[-*/+]\s*[\w(]|[\w)]\s*[*/+]\s*\w*Cents\b/g) ?? []).map((m) => `${rel(f)}: ${m}`));
    expect(hits).toEqual([]);
  });

  it("a campaign's rate is never turned into money (no per 1,000 rate times views)", () => {
    const using = files(SRC).filter((f) => rel(f) !== CR_MOCK && code(f).split("\n").some((line) => /per1kCents/.test(line) && /views/.test(line) && /[*/]/.test(line)));
    expect(using.map(rel)).toEqual([]);
  });

  it("Content Rewards' paid-so-far line says Checking… until the list was read to its end", () => {
    const part = read(join(SRC, "screens/money/CrMoneyPart.tsx"));
    expect(part).toMatch(/paidSoFarCents == null \? "Checking…"/);
    expect(part).toContain("Content Rewards&apos; numbers");
  });

  // §39.2: All your money adds money in one place only, the server (GET /v1/money/everywhere). The web formats it; the
  // mock's copy of the server's sums (checked against money_everywhere_cases.json) is the one exception.
  const EVERYWHERE_MOCK = "api/mock/moneyEverywhere.ts";
  it("All your money only formats: no amount or cents added, multiplied or divided on its screens", () => {
    for (const f of ["screens/money/AllMoney.tsx", "screens/money/MoneyDashboard.tsx", "screens/review/CampaignFit.tsx", "screens/review/FitSuggestion.tsx", "screens/clip/ClipFit.tsx", "lib/crFit.ts"]) {
      const text = code(join(SRC, f));
      expect(text, f).not.toMatch(/amountMicros\s*[-+*/]|[-+*/]=?\s*[\w.]*amountMicros\b/);
      expect(text, f).not.toMatch(/Cents\b\s*[-+*/]|[-+*/]\s*[\w.]*Cents\b/);
    }
    const all = read(join(SRC, "screens/money/AllMoney.tsx"));
    expect(all).toContain("formatMoney(");
    expect(all).not.toMatch(/\.reduce\(/);
  });

  it("no screen sums amounts by place or currency (only the mock's copies of the server do)", () => {
    const using = files(SRC).filter((f) => !rel(f).startsWith("api/mock/") && /amountMicros\s*\+=|\+=\s*[\w.]*amountMicros\b/.test(code(f)));
    expect(using.map(rel)).toEqual([]);
    expect(code(join(SRC, EVERYWHERE_MOCK))).toMatch(/amountMicros \+= a\.amountMicros/);
  });

  // §40.4: Get paid's screens show what Google or Whop reported, only formatted: never added, converted or guessed,
  // and never typed in (the mock's copy of the server is the one exception).
  it("Get paid only formats: no amount or cents worked out on its screens, no money field to type", () => {
    const screens = ["lib/getPaid.ts", "screens/money/GetPaidCard.tsx", ...readdirSync(join(SRC, "screens/getpaid")).map((f) => `screens/getpaid/${f}`), ...readdirSync(join(SRC, "getpaid")).map((f) => `getpaid/${f}`)];
    expect(screens.length).toBeGreaterThan(8);
    for (const f of screens) {
      const text = code(join(SRC, f));
      expect(text, f).not.toMatch(/amountMicros\s*[-+*/]|[-+*/]=?\s*[\w.]*amountMicros\b/);
      expect(text, f).not.toMatch(/Cents\b\s*[-+*/]|[-+*/]\s*[\w.]*Cents\b/);
      expect(text, f).not.toMatch(/\.reduce\(/);
      // No box to type money, a bank, card or tax number into (§40: Clip Factory never asks for them).
      expect(text, f).not.toMatch(/type="number"|inputMode="(decimal|numeric)"|iban|account number|card number|tax number/i);
    }
    expect(read(join(SRC, "screens/getpaid/SentRows.tsx"))).toContain("formatMoney(");
  });

  it("the help assistant never offers to change a rate or calls money a best guess", () => {
    const kb = read(join(SRC, "features/help/helpKb.json")).toLowerCase();
    for (const phrase of ["for 1,000 views", "best guess", "use the usual", "your amount"]) expect(kb).not.toContain(phrase);
  });
});
