// The money dashboard's numbers in the pretend app (docs/CONTRACTS.md §27.5, §27.7). Mock builds only.
//
// `summarize` is a line-for-line copy of api/src/clipfactory_api/money/summary.py `summarize`, and `moneyClips` of
// money/clips.py. Both are checked against the shared golden cases (api/tests/fixtures/money_summary_cases.json), so
// the mock and the server always agree. This is the only web file allowed to do arithmetic on money
// (web/test/noGuesses.test.ts): the real app only formats what the server sent.
import type {
  Clip,
  MoneyChange,
  MoneyChart,
  MoneyClip,
  MoneyClipLine,
  MoneyClips,
  MoneyClipsQuery,
  MoneyCurrencySummary,
  MoneyExcluded,
  MoneySummary,
  MoneyWhere,
  Platform,
  Post,
} from "../types.ts";

export const ORDER: Platform[] = ["youtube", "tiktok", "instagram", "facebook", "x"];
const LABEL: Record<Platform, string> = { youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram", facebook: "Facebook", x: "X" };
const MONEY_PLATFORMS = new Set<Platform>(["youtube", "facebook"]);
const LAG: Partial<Record<Platform, string>> = { youtube: "YouTube is 2–3 days behind", facebook: "Facebook can take 2 days" };
const STALE_DAYS = 6;

// ---------- plain dates (yyyy-mm-dd, never through a time zone) ----------

const DAY_MS = 86_400_000;
const toN = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / DAY_MS;
const toS = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => toS(toN(day) + n);
export const todayUtc = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Tue 27 Oct", as the server words it (English, no time zone). */
const plainDayEn = (day: string) => {
  const d = new Date(toN(day) * DAY_MS);
  return `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
};

// ---------- integer helpers (the same steps as the server) ----------

/** `num / den` rounded half away from zero, whole numbers only. */
export function divRound(num: number, den: number): number {
  let n = num;
  let d = den;
  if (d < 0) {
    n = -n;
    d = -d;
  }
  const a = Math.abs(n);
  let q = Math.floor(a / d);
  const r = a - q * d;
  if (2 * r >= d) q += 1;
  return n >= 0 ? q : -q;
}

export function change(current: number, previous: number | null): MoneyChange {
  if (previous === null) return { previousPeriodMicros: null, changePct: null, direction: "none" };
  if (previous === 0) return { previousPeriodMicros: 0, changePct: null, direction: current > 0 ? "new" : "none" };
  const pct = divRound((current - previous) * 100, Math.abs(previous));
  return { previousPeriodMicros: previous, changePct: pct, direction: pct > 0 ? "up" : pct < 0 ? "down" : "same" };
}

// ---------- the summary ----------

export interface MoneyRow {
  platform: Platform;
  date: string;
  amountMicros: number;
  currency: string;
  revisedAt?: string | null;
}

export interface MoneyStatus {
  connected?: boolean;
  moneyScope?: boolean;
  lastError?: string | null;
  checkedAt?: string | null;
}

export interface SummaryInput {
  today: string;
  platforms: Platform[];
  chart: MoneyChart;
  rows: MoneyRow[];
  status: Partial<Record<Platform, MoneyStatus>>;
  facebookVerified: boolean;
  where: Partial<Record<Platform, MoneyWhere>>;
}

const orderOf = (list: readonly Platform[]) => ORDER.filter((p) => list.includes(p));

function excludedFor(platform: Platform, status: MoneyStatus, verified: boolean, hasRows: boolean, where: MoneyWhere): MoneyExcluded | null {
  const name = LABEL[platform];
  if (!MONEY_PLATFORMS.has(platform)) return { platform, reason: "not_shared", text: `${name} doesn't share money with apps.`, where };
  if (platform === "facebook" && !verified) return { platform, reason: "coming_soon", text: "Facebook money: coming soon." };
  if (!status.connected) return { platform, reason: "not_connected", text: `Connect ${name} in Settings › Posting › Set up posting.` };
  if (platform === "youtube" && !status.moneyScope) return { platform, reason: "needs_permission", text: `${name} needs your OK first.` };
  if (!hasRows && status.lastError) return { platform, reason: "error", text: `Couldn't check ${name} today.` };
  if (!hasRows) return { platform, reason: "no_money_yet", text: `No money from ${name} yet.` };
  return null;
}

type ByDay = Map<string, Map<Platform, number>>;

function total(byDay: ByDay, start: number, end: number): number {
  let n = 0;
  for (let c = start; c <= end; c++) for (const v of byDay.get(toS(c))?.values() ?? []) n += v;
  return n;
}

function chartFor(period: MoneyChart, through: number, byDay: ByDay, plats: Platform[], history: Map<Platform, number>): MoneyCurrencySummary["chart"] {
  const startOfHistory = Math.min(...plats.map((p) => history.get(p)!));
  const point = (start: number, end: number) => {
    let amount = 0;
    const by: Partial<Record<Platform, number>> = {};
    for (let c = start; c <= end; c++) {
      const found = byDay.get(toS(c));
      for (const p of plats) {
        if (history.get(p)! <= c) {
          const v = found?.get(p) ?? 0;
          by[p] = (by[p] ?? 0) + v;
          amount += v;
        }
      }
    }
    return { start: toS(start), end: toS(end), amountMicros: amount, byPlatform: by } as MoneyCurrencySummary["chart"]["points"][number];
  };
  const points: MoneyCurrencySummary["chart"]["points"] = [];
  if (period === 365) {
    const oldest = through - 364;
    for (let k = 52; k >= 0; k--) {
      const end = through - 7 * k;
      if (end < startOfHistory || end < oldest) continue;
      const start = Math.max(end - 6, oldest, startOfHistory);
      const found = point(start, end);
      if (end - start < 6) found.partial = true;
      points.push(found);
    }
  } else {
    for (let k = period - 1; k >= 0; k--) {
      const day = through - k;
      if (day >= startOfHistory) points.push(point(day, day));
    }
  }
  return { period, bucket: period === 365 ? "week" : "day", from: points[0]?.start ?? toS(through), to: toS(through), points };
}

function entry(currency: string, byDay: ByDay, t: number, plats: Platform[], history: Map<Platform, number>, chart: MoneyChart): MoneyCurrencySummary {
  const covered = (start: number) => plats.every((p) => history.get(p)! <= start);
  const first = Math.min(...plats.map((p) => history.get(p)!));
  const days = Math.max(1, Math.min(30, t - first + 1));
  const monthly = total(byDay, t - 29, t);
  const prevMonth = covered(t - 59) ? total(byDay, t - 59, t - 30) : null;
  const weekly = total(byDay, t - 6, t);
  const prevWeek = covered(t - 13) ? total(byDay, t - 13, t - 7) : null;
  const dailyChange = change(monthly, prevMonth);
  if (prevMonth !== null) dailyChange.previousPeriodMicros = divRound(prevMonth, 30);
  let latest = 0;
  for (const v of byDay.get(toS(t))?.values() ?? []) latest += v;
  return {
    currency,
    tag: plats.length === 1 ? (plats[0] === "facebook" || plats[0] === "instagram" ? "Meta's estimate" : `${LABEL[plats[0]!]}'s estimate`) : "Apps' estimates",
    platforms: plats,
    coveredDays: days,
    monthly: { amountMicros: monthly, from: toS(t - 29), to: toS(t), ...change(monthly, prevMonth) },
    weekly: { amountMicros: weekly, from: toS(t - 6), to: toS(t), ...change(weekly, prevWeek) },
    daily: { averageMicros: divRound(monthly, days), from: toS(t - 29), to: toS(t), latest: { date: toS(t), amountMicros: latest }, ...dailyChange },
    yearly: { paceMicros: divRound(monthly * 360, days), last365Micros: covered(t - 364) ? total(byDay, t - 364, t) : null },
    chart: chartFor(chart, t, byDay, plats, history),
  };
}

/** The MoneySummary without `asOf`, exactly as the server works it out. */
export function summarize(input: SummaryInput): Omit<MoneySummary, "asOf"> {
  const asked = orderOf(input.platforms).length ? orderOf(input.platforms) : [...ORDER];
  const byPlatform = new Map<Platform, MoneyRow[]>();
  for (const r of input.rows) {
    if (!Number.isInteger(r.amountMicros) || typeof r.date !== "string" || !r.currency) continue;
    byPlatform.set(r.platform, [...(byPlatform.get(r.platform) ?? []), r]);
  }
  const included: Platform[] = [];
  const excluded: MoneyExcluded[] = [];
  for (const p of asked) {
    const out = excludedFor(p, input.status[p] ?? {}, input.facebookVerified, Boolean(byPlatform.get(p)?.length), { ...(input.where[p] ?? { label: LABEL[p] }) });
    if (out) excluded.push(out);
    else included.push(p);
  }
  const summary: Omit<MoneySummary, "asOf"> = {
    platforms: asked,
    included,
    excluded,
    through: null,
    throughBy: {},
    historyFrom: {},
    currencies: [],
    revised: { days: 0, platforms: [] },
    errors: [],
    behind: [],
    stale: false,
  };
  const errorsFor = (list: Platform[]) =>
    orderOf(list)
      .filter((p) => input.status[p]?.lastError)
      .map((p) => {
        const item: MoneySummary["errors"][number] = { platform: p, text: `Couldn't check ${LABEL[p]} today.` };
        const checked = input.status[p]?.checkedAt;
        if (checked) item.checkedAt = checked;
        return item;
      });
  const errored = excluded.filter((e) => e.reason === "error").map((e) => e.platform);
  if (!included.length) {
    summary.errors = errorsFor(errored);
    return summary;
  }
  const newest = new Map<Platform, string>(included.map((p) => [p, byPlatform.get(p)!.map((r) => r.date).sort().at(-1)!]));
  const oldestOk = toN(input.today) - STALE_DAYS;
  const behind = included.filter((p) => toN(newest.get(p)!) < oldestOk);
  if (behind.length && behind.length < included.length) {
    // One app falling behind would pull every app's days back: count the up-to-date ones, say which is behind.
    for (const p of behind) excluded.push({ platform: p, reason: "behind", text: `${LABEL[p]} hasn't sent money since ${plainDayEn(newest.get(p)!)}. Not counted for now.` });
    excluded.sort((a, b) => ORDER.indexOf(a.platform) - ORDER.indexOf(b.platform));
    included.splice(0, included.length, ...included.filter((p) => !behind.includes(p)));
    summary.included = included;
  }
  summary.behind = behind;
  const throughBy: Partial<Record<Platform, string>> = {};
  const historyFrom: Partial<Record<Platform, string>> = {};
  for (const p of included) {
    const dates = byPlatform.get(p)!.map((r) => r.date).sort();
    throughBy[p] = dates.at(-1)!;
    historyFrom[p] = dates[0]!;
  }
  const throughS = included.map((p) => throughBy[p]!).sort()[0]!;
  const t = toN(throughS);
  const history = new Map<Platform, number>(included.map((p) => [p, toN(historyFrom[p]!)]));
  summary.through = throughS;
  summary.throughBy = throughBy;
  summary.historyFrom = historyFrom;
  const lag = (["youtube", "facebook"] as Platform[]).find((p) => included.includes(p));
  if (lag) summary.lagNote = LAG[lag];
  summary.stale = t < toN(input.today) - STALE_DAYS;

  const days = new Map<string, ByDay>();
  for (const p of included) {
    for (const r of byPlatform.get(p)!) {
      if (r.date > throughS) continue;
      const cur = days.get(r.currency) ?? new Map();
      days.set(r.currency, cur);
      const day = cur.get(r.date) ?? new Map<Platform, number>();
      cur.set(r.date, day);
      day.set(p, (day.get(p) ?? 0) + r.amountMicros);
    }
  }
  const entries: MoneyCurrencySummary[] = [];
  for (const [currency, byDay] of days) {
    const plats = included.filter((p) => [...byDay.values()].some((v) => v.has(p)));
    entries.push(entry(currency, byDay, t, plats, history, input.chart));
  }
  entries.sort((a, b) => b.monthly.amountMicros - a.monthly.amountMicros || (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));
  summary.currencies = entries;

  const start = toS(t - 59);
  let revisedDays = 0;
  const revisedPlatforms: Platform[] = [];
  for (const p of included) {
    const n = byPlatform.get(p)!.filter((r) => r.revisedAt && start <= r.date && r.date <= throughS).length;
    if (n) {
      revisedDays += n;
      revisedPlatforms.push(p);
    }
  }
  summary.revised = { days: revisedDays, platforms: revisedPlatforms };
  summary.errors = errorsFor([...included, ...errored, ...behind]);
  return summary;
}

// ---------- money per clip (money/clips.py) ----------

/** A Post as the server stores it, with the money fields the collector writes (§27.6). */
export interface MoneyPost {
  postId: string;
  clipId: string;
  platform: Platform;
  postedAt: string;
  url?: string;
  views: number | null;
  revenue?: { amountMicros: number; currency: string; through: string; views?: number };
  revenueWindows?: Partial<Record<"7" | "30" | "90", { amountMicros: number; views: number; from: string; to: string; currency: string }>>;
}

export interface ClipCard {
  clipId: string;
  title: string;
  coverUrl?: string;
}

const PER_1000_MIN_VIEWS = 1000;

function moneyOf(post: MoneyPost, period: MoneyClipsQuery["period"]): [MoneyClipLine["money"], MoneyClipLine["per1000Views"]] {
  const found = period === "all" ? post.revenue : post.revenueWindows?.[String(period) as "7" | "30" | "90"];
  if (!found || !Number.isInteger(found.amountMicros)) return [null, null];
  const money = {
    amountMicros: found.amountMicros,
    currency: found.currency || "USD",
    from: period === "all" ? post.postedAt.slice(0, 10) || null : ("from" in found ? found.from : null) || null,
    to: ("through" in found ? found.through : "to" in found ? found.to : "") || "",
    tag: "YouTube's estimate",
    source: "youtube.estimatedRevenue",
  };
  const views = found.views;
  const per =
    typeof views === "number" && views >= PER_1000_MIN_VIEWS
      ? { amountMicros: divRound(found.amountMicros * 1000, views), currency: money.currency, views, tag: "YouTube's numbers" }
      : null;
  return [money, per];
}

const namesOf = (list: Platform[]) => (list.length === 1 ? LABEL[list[0]!] : `${list.slice(0, -1).map((p) => LABEL[p]).join(", ")} and ${LABEL[list.at(-1)!]}`);

/** GET /v1/money/clips over the pretend app's posts. `cursor` is the offset as a string (opaque to the screen). */
export function moneyClips(
  posts: MoneyPost[],
  cards: Map<string, ClipCard>,
  query: MoneyClipsQuery,
  facebookVerified: boolean,
  youtube: "ok" | "needs_permission" | "not_connected" = "ok",
): MoneyClips {
  const chosen = orderOf(query.platforms).length ? orderOf(query.platforms) : [...ORDER];
  const posted = posts.filter((p) => chosen.includes(p.platform));
  // Only YouTube reports money per video (Facebook's is per Page), and only while it may read it.
  const perVideo = chosen.includes("youtube") && youtube === "ok";
  const reported = posted.filter((p) => p.platform === "youtube").map((p) => moneyOf(p, query.period)[0]).filter((m) => m !== null);
  const ends = reported.map((m) => m.to).filter(Boolean).sort();
  const to = perVideo && ends.length ? ends.at(-1)! : null;
  const starts = reported.filter((m) => m.to === to).map((m) => m.from).filter((f): f is string => Boolean(f)).sort();
  const windowFrom = to && query.period !== "all" ? (starts[0] ?? null) : null;
  const groups = new Map<string, MoneyPost[]>();
  for (const p of posted) {
    const day = p.postedAt.slice(0, 10);
    if (to !== null && day && day > to) continue;
    groups.set(p.clipId, [...(groups.get(p.clipId) ?? []), p]);
  }
  const rows: Omit<MoneyClip, "title" | "coverUrl">[] = [];
  for (const [clipId, items] of groups) {
    const lines: MoneyClipLine[] = [];
    const totals = new Map<string, number>();
    let viewsTotal = 0;
    let anyViews = false;
    for (const platform of chosen) {
      const post = items.find((i) => i.platform === platform);
      if (!post) continue;
      if (post.views !== null) {
        viewsTotal += post.views;
        anyViews = true;
      }
      let money: MoneyClipLine["money"] = null;
      let per: MoneyClipLine["per1000Views"] = null;
      let state: MoneyClipLine["moneyState"] = !MONEY_PLATFORMS.has(platform) ? "not_shared" : platform === "facebook" ? (facebookVerified ? "not_shared" : "coming_soon") : "not_reported_yet";
      if (platform === "youtube" && youtube !== "ok") state = youtube;
      else if (platform === "youtube") {
        [money, per] = moneyOf(post, query.period);
        // An older run's window covers other days than the list's: "not reported yet", never ranked with fresh ones.
        if (money && query.period !== "all" && (money.from !== windowFrom || money.to !== to)) [money, per] = [null, null];
        if (money) {
          state = "reported";
          totals.set(money.currency, (totals.get(money.currency) ?? 0) + money.amountMicros);
        }
      }
      const line: MoneyClipLine = { platform, postId: post.postId, postedAt: post.postedAt, views: post.views, money, per1000Views: per, moneyState: state };
      if (post.url) line.url = post.url;
      lines.push(line);
    }
    if (!lines.length) continue;
    rows.push({
      clipId,
      firstPostedAt: lines.map((l) => l.postedAt).sort()[0]!,
      views: anyViews ? viewsTotal : null,
      totals: [...totals].map(([currency, amountMicros]) => ({ currency, amountMicros })).sort((a, b) => b.amountMicros - a.amountMicros || (a.currency < b.currency ? -1 : 1)),
      platforms: lines,
    });
  }
  const sortedBy = perVideo ? query.sort : "views";
  const viewsKey = (r: (typeof rows)[number]) => r.views ?? -1;
  const moneyKey = (r: (typeof rows)[number]) => r.totals[0]?.amountMicros ?? -1;
  rows.sort((a, b) => (a.firstPostedAt < b.firstPostedAt ? 1 : a.firstPostedAt > b.firstPostedAt ? -1 : 0));
  if (sortedBy === "money") rows.sort((a, b) => moneyKey(b) - moneyKey(a) || viewsKey(b) - viewsKey(a));
  else rows.sort((a, b) => viewsKey(b) - viewsKey(a));
  const limit = query.limit ?? 20;
  const offset = query.cursor ? Number(query.cursor) : 0;
  const page = rows.slice(offset, offset + limit).map((r) => {
    const card = cards.get(r.clipId);
    const out: MoneyClip = { ...r, title: card?.title || "Your clip" };
    if (card?.coverUrl) out.coverUrl = card.coverUrl;
    return out;
  });
  const out: MoneyClips = {
    period: query.period,
    from: windowFrom,
    to,
    sort: query.sort,
    sortedBy,
    clips: page,
  };
  if (!perVideo) {
    out.note =
      youtube === "needs_permission" && chosen.includes("youtube")
        ? "YouTube needs your OK first. Sorted by views."
        : youtube === "not_connected" && chosen.includes("youtube")
          ? "Connect YouTube to see money per video. Sorted by views."
          : `${namesOf(chosen)} ${chosen.length === 1 ? "doesn't" : "don't"} share money per video. Sorted by views.`;
  }
  if (offset + limit < rows.length) out.nextCursor = String(offset + limit);
  return out;
}

// ---------- the pretend owner's stored money (§27.7) ----------

/** A gentle weekly wave on an upward trend, in micros. Fixed, so screenshots stay the same. */
function wave(days: number, base: number, swing: number, climb: number): number[] {
  const shape = [0.55, 0.62, 0.7, 0.86, 1.05, 1.22, 1.0];
  return Array.from({ length: days }, (_, i) => Math.round(base * shape[i % 7]! + swing * Math.sin(i / 9) + climb * i));
}

/** Rows for `days` days ending on `end`, oldest first. */
export function series(platform: Platform, currency: string, end: string, amounts: number[]): MoneyRow[] {
  return amounts.map((amountMicros, i) => ({ platform, currency, date: addDays(end, i - amounts.length + 1), amountMicros }));
}

export const WAVES = {
  youtube: (days: number) => wave(days, 900_000, 120_000, 2_600),
  facebook: (days: number) => wave(days, 180_000, 40_000, 900),
  short: (days: number) => wave(days, 600_000, 60_000, 4_000),
};

// ---------- the pretend clips' money ----------

const TITLES = [
  "He jumped the bridge in a police car",
  "Bank job goes wrong in the first second",
  "The betrayal nobody saw coming",
  "Chat called it: the parachute fails",
  "Three stars in eleven seconds",
  "The getaway driver forgot the car",
  "Boss fight with a shopping trolley",
  "Speed run through the docks",
  "He sold the same car twice",
  "Rooftop chase, no brakes",
  "The heist plan in one breath",
  "Police scanner says what?",
  "Last second save at the airport",
  "Fake cop meets a real one",
  "The worst parking in Los Santos",
  "Tow truck to the rescue",
  "Never trust the quiet one",
  "Jetpack at the gas station",
  "The longest wheelie ever",
  "He talked his way out of jail",
];

/** Lifetime views and period money for the pretend clips. `money: false` leaves YouTube's money out (not reported). */
export function pretendClipPosts(
  realClips: Clip[],
  realPosts: Post[],
  opts: { extra: number; withMoney: number; money: boolean; end: string | null; platforms: Platform[] },
): { posts: MoneyPost[]; cards: Map<string, ClipCard> } {
  const cards = new Map<string, ClipCard>();
  const posts: MoneyPost[] = [];
  const posted = realClips.filter((c) => c.status === "posted");
  posted.forEach((c) => cards.set(c.clipId, { clipId: c.clipId, title: c.captions.youtubeTitle || c.hook, coverUrl: c.coverUrl }));
  for (const p of realPosts) {
    if (p.status !== "posted" || !p.postedAt || !cards.has(p.clipId)) continue;
    posts.push({ postId: p.postId, clipId: p.clipId, platform: p.platform, postedAt: p.postedAt, url: p.url, views: p.metrics?.views ?? null });
  }
  const now = Date.now();
  for (let i = 0; i < opts.extra; i++) {
    const clipId = `01MONEYDASH${String(i).padStart(15, "0")}`;
    cards.set(clipId, { clipId, title: TITLES[i % TITLES.length]!, coverUrl: realClips[i % Math.max(1, realClips.length)]?.coverUrl });
    const postedAt = new Date(now - (6 + i * 4) * DAY_MS).toISOString();
    for (const [j, platform] of opts.platforms.entries()) {
      if ((i + j) % 4 === 3) continue; // not every clip went everywhere
      const views = Math.round(1_800 + ((i * 7919 + j * 104_729) % 96_000) * (platform === "tiktok" ? 1.6 : 1));
      posts.push({ postId: `${clipId}-${platform}`, clipId, platform, postedAt, url: `https://example.com/${platform}/${i}`, views });
    }
  }
  // YouTube's money: the biggest earners first in the list, so the top row is a real clip with its own page.
  if (opts.money && opts.end) {
    const real = new Set(posted.map((c) => c.clipId));
    const yt = posts.filter((p) => p.platform === "youtube").sort((a, b) => Number(real.has(b.clipId)) - Number(real.has(a.clipId)));
    yt.slice(0, opts.withMoney).forEach((p, rank) => {
      const lifetimeViews = Math.max(p.views ?? 0, 600);
      const base = Math.max(40_000, 9_400_000 - rank * 470_000);
      const windows: MoneyPost["revenueWindows"] = {};
      for (const [n, share] of [[7, 0.22], [30, 0.64], [90, 0.92]] as const) {
        const views = Math.round(lifetimeViews * share);
        windows[String(n) as "7" | "30" | "90"] = { amountMicros: Math.round(base * share), views, from: addDays(opts.end!, -(n - 1)), to: opts.end!, currency: "USD" };
      }
      p.revenueWindows = windows;
      p.revenue = { amountMicros: base, currency: "USD", through: addDays(opts.end!, 1), views: lifetimeViews };
    });
  }
  return { posts, cards };
}
