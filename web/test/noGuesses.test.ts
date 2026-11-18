// The CI guard of docs/CONTRACTS.md §25 (ADR-45): no screen may guess money again. The retired §21 helpers and the
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

describe("no money guesses (§25, ADR-45)", () => {
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

  it("the help assistant never offers to change a rate or calls money a best guess", () => {
    const kb = read(join(SRC, "features/help/helpKb.json")).toLowerCase();
    for (const phrase of ["for 1,000 views", "best guess", "use the usual", "your amount"]) expect(kb).not.toContain(phrase);
  });
});
