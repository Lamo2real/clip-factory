import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isWeek, isoWeek, shiftWeek, weekBoundsOk, weekLabel, weekRange, weekStart, weeksInYear } from "../src/lib/week.ts";

// Weeks are read in the owner's time zone; pin one with real clock changes so the DST cases mean something.
const before = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "Europe/Stockholm";
});
afterAll(() => {
  process.env.TZ = before;
});

const hours = (r: { from: string; to: string }) => (Date.parse(r.to) - Date.parse(r.from)) / 3_600_000;

describe("isoWeek", () => {
  it("puts New Year's Day in the right week across year boundaries", () => {
    expect(isoWeek(new Date(2026, 0, 1, 12))).toBe("2026-W01"); // a Thursday: week 1 of 2026
    expect(isoWeek(new Date(2027, 0, 1, 12))).toBe("2026-W53"); // a Friday: still 2026's last week
    expect(isoWeek(new Date(2025, 11, 29, 12))).toBe("2026-W01"); // a Monday that belongs to next year
    expect(isoWeek(new Date(2021, 0, 3, 12))).toBe("2020-W53");
  });

  it("starts weeks on Monday", () => {
    expect(isoWeek(new Date(2026, 10, 15, 23, 59))).toBe("2026-W46"); // Sunday night
    expect(isoWeek(new Date(2026, 10, 16, 0, 0))).toBe("2026-W47"); // Monday 00:00
    expect(isoWeek(new Date(2026, 10, 22, 23, 59))).toBe("2026-W47");
  });

  it("knows long years", () => {
    expect(weeksInYear(2026)).toBe(53);
    expect(weeksInYear(2025)).toBe(52);
    expect(weeksInYear(2020)).toBe(53);
    expect(isWeek("2026-W53")).toBe(true);
    expect(isWeek("2025-W53")).toBe(false);
    expect(isWeek("2026-W00")).toBe(false);
    expect(isWeek("2026-W54")).toBe(false);
    expect(isWeek("2026-47")).toBe(false);
    expect(isWeek(null)).toBe(false);
  });
});

describe("weekRange", () => {
  it("is local Monday 00:00 to the next Monday 00:00, as UTC instants", () => {
    expect(weekRange("2026-W47")).toEqual({ from: "2026-11-15T23:00:00.000Z", to: "2026-11-22T23:00:00.000Z" });
    expect(weekStart("2026-W47").getDay()).toBe(1);
    expect(hours(weekRange("2026-W47"))).toBe(168);
  });

  it("is 167 or 169 hours when the clocks change inside the week", () => {
    expect(hours(weekRange("2026-W13"))).toBe(167); // summer time starts 29 March
    expect(hours(weekRange("2026-W43"))).toBe(169); // and ends 25 October
  });

  it("passes the server's own check, DST weeks included", () => {
    for (const w of ["2026-W01", "2026-W13", "2026-W43", "2026-W53"]) {
      const r = weekRange(w);
      expect(weekBoundsOk(w, r.from, r.to)).toBe(true);
    }
    const r = weekRange("2026-W47");
    expect(weekBoundsOk("2026-W48", r.from, r.to)).toBe(false);
    expect(weekBoundsOk("2026-W47", r.from, new Date(Date.parse(r.to) + 3 * 3_600_000).toISOString())).toBe(false);
    expect(weekBoundsOk("2026-W47", "nope", r.to)).toBe(false);
  });
});

describe("shiftWeek and weekLabel", () => {
  it("steps over year ends", () => {
    expect(shiftWeek("2026-W53", 1)).toBe("2027-W01");
    expect(shiftWeek("2026-W01", -1)).toBe("2025-W52");
    expect(shiftWeek("2026-W47", -1)).toBe("2026-W46");
    expect(shiftWeek("2026-W13", 1)).toBe("2026-W14"); // across the DST change
  });

  it("names the days of the week", () => {
    expect(weekLabel("2026-W46")).toBe("9–15 Nov");
    expect(weekLabel("2026-W47")).toBe("16–22 Nov");
    expect(weekLabel("2026-W44")).toBe("26 Oct–1 Nov");
    expect(weekLabel("2026-W53")).toBe("28 Dec–3 Jan");
  });
});
