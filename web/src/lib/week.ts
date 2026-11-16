// ISO weeks in the owner's own time zone (docs/CONTRACTS.md §16.8): weeks start on Monday, week 1 is the week with
// the year's first Thursday. The server gets each week as two UTC instants (local Monday 00:00 and the next Monday
// 00:00), so a week is 167 or 169 hours long when the clocks change inside it.

export const WEEK_RE = /^(\d{4})-W(0[1-9]|[1-4]\d|5[0-3])$/;

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");

export function isWeek(week: string | null | undefined): week is string {
  if (!week) return false;
  const m = WEEK_RE.exec(week);
  if (!m) return false;
  // Years below 100 would turn into 19xx in Date(); no clip is that old or that far ahead.
  const year = Number(m[1]);
  if (year < 2000 || year > 2999) return false;
  // W53 only exists in long years.
  return Number(m[2]) <= weeksInYear(Number(m[1]));
}

/** The ISO week ("2026-W47") of a moment, read in the browser's time zone. */
export function isoWeek(date: Date = new Date()): string {
  // Work on the local calendar date only, as a UTC date, so DST never shifts a day.
  const day = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const weekday = (new Date(day).getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
  const thursday = new Date(day + (3 - weekday) * DAY);
  const year = thursday.getUTCFullYear();
  const firstThursday = Date.UTC(year, 0, 4) - ((new Date(Date.UTC(year, 0, 4)).getUTCDay() + 6) % 7) * DAY + 3 * DAY;
  const n = 1 + Math.round((thursday.getTime() - firstThursday) / (7 * DAY));
  return `${year}-W${pad(n)}`;
}

/** 52 or 53. */
export function weeksInYear(year: number): number {
  // A year has 53 weeks when 28 December falls in week 53 (it is always in the year's last week).
  const dec28 = new Date(Date.UTC(year, 11, 28));
  const weekday = (dec28.getUTCDay() + 6) % 7;
  const thursday = Date.UTC(year, 11, 28) + (3 - weekday) * DAY;
  const firstThursday = Date.UTC(year, 0, 4) - ((new Date(Date.UTC(year, 0, 4)).getUTCDay() + 6) % 7) * DAY + 3 * DAY;
  return 1 + Math.round((thursday - firstThursday) / (7 * DAY));
}

/** The calendar date (year, month 0-11, day) of the Monday that starts `week`. */
function mondayDate(week: string): { y: number; m: number; d: number } {
  const match = WEEK_RE.exec(week);
  if (!match) throw new Error(`not an ISO week: ${week}`);
  const year = Number(match[1]);
  const n = Number(match[2]);
  const jan4 = Date.UTC(year, 0, 4);
  const week1Monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY;
  const monday = new Date(week1Monday + (n - 1) * 7 * DAY);
  return { y: monday.getUTCFullYear(), m: monday.getUTCMonth(), d: monday.getUTCDate() };
}

/** The local Monday 00:00 that starts `week`. */
export function weekStart(week: string): Date {
  const { y, m, d } = mondayDate(week);
  return new Date(y, m, d, 0, 0, 0, 0);
}

/** `from`/`to` for the API: UTC ISO instants of local Monday 00:00 and the next Monday 00:00. */
export function weekRange(week: string): { from: string; to: string } {
  const { y, m, d } = mondayDate(week);
  return { from: new Date(y, m, d).toISOString(), to: new Date(y, m, d + 7).toISOString() };
}

/** The week `n` weeks after (or, negative, before) `week`. */
export function shiftWeek(week: string, n: number): string {
  const { y, m, d } = mondayDate(week);
  // Noon keeps a DST change from pushing the date across midnight.
  return isoWeek(new Date(y, m, d + n * 7, 12));
}

/** Sorts ISO weeks: negative when a is earlier. */
export function compareWeeks(a: string, b: string): number {
  return a.localeCompare(b);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "10–16 Nov", "27 Oct–2 Nov", "29 Dec–4 Jan". */
export function weekLabel(week: string): string {
  const { y, m, d } = mondayDate(week);
  const start = new Date(Date.UTC(y, m, d));
  const end = new Date(Date.UTC(y, m, d + 6));
  const sm = MONTHS[start.getUTCMonth()]!;
  const em = MONTHS[end.getUTCMonth()]!;
  return sm === em
    ? `${start.getUTCDate()}–${end.getUTCDate()} ${em}`
    : `${start.getUTCDate()} ${sm}–${end.getUTCDate()} ${em}`;
}

/** The week a moment belongs to, for clips: their anchor (first post, else when they were kept). */
export function weekOf(isoTime: string): string {
  return isoWeek(new Date(isoTime));
}

/** ISO Monday 00:00 UTC of `week` (the server checks `from` is within 14 hours of it). */
export function weekMondayUtc(week: string): number {
  const { y, m, d } = mondayDate(week);
  return Date.UTC(y, m, d);
}

/** The server's rule for a week's `from`/`to` (§16.2): 167–169 hours long, starting within 14 h of the ISO Monday. */
export function weekBoundsOk(week: string, from: string, to: string): boolean {
  if (!isWeek(week)) return false;
  const f = Date.parse(from);
  const t = Date.parse(to);
  if (!Number.isFinite(f) || !Number.isFinite(t)) return false;
  const hours = (t - f) / 3_600_000;
  return hours >= 167 && hours <= 169 && Math.abs(f - weekMondayUtc(week)) <= 14 * 3_600_000;
}
