// The Real earnings routes of docs/CONTRACTS.md §25.5 in memory, with every state the cards can be in. Tests and
// screenshots pick one with window.__cfMock.money.setScenario(name) (kept in sessionStorage, so a reload or the trip
// through "Allow money reading" keeps it). The numbers are fixtures for the pretend app only: the real app shows
// only what a platform reported. Only bundled into mock builds.
import { ApiError } from "../errors.ts";
import type { Api, MoneyCard, MoneyCelebration, MoneyGoal, MoneyState, MoneyView, Platform } from "../types.ts";

export type MoneyApi = Pick<Api, "getMoney" | "refreshMoney" | "seenMoney" | "setMoneyCountry">;

export const MONEY_SCENARIOS = [
  "start",
  "not_connected",
  "consent_needed",
  "not_yet",
  "goal_reached",
  "in_program",
  "earning",
  "facebook_verified",
  "facebook_unverified",
  "unsupported",
  "error",
] as const;
export type MoneyScenario = (typeof MONEY_SCENARIOS)[number];

/** Test knobs, reachable as window.__cfMock.money. */
export interface MockMoneyControls {
  setScenario(name: MoneyScenario): void;
  scenario(): MoneyScenario;
  /** Forget the owner's country, celebrations seen and the Check now hour. */
  reset(): void;
}

const KEY = "cf-mock-money";
const ORDER: Platform[] = ["youtube", "tiktok", "instagram", "facebook", "x"];
const YT_SOURCE = "https://support.google.com/youtube/answer/72851";
const TT_SOURCE = "https://support.tiktok.com/en/business-and-creator/creator-rewards-program/creator-rewards-program";
const IG_SOURCE = "https://creators.instagram.com/earn-money";
const X_SOURCE = "https://help.x.com/en/using-x/creator-revenue-sharing";
const MONETARY = "https://www.googleapis.com/auth/yt-analytics-monetary.readonly";
const COUNTRIES = [
  { code: "US", name: "United States" },
  { code: "GB", name: "United Kingdom" },
  { code: "DE", name: "Germany" },
  { code: "FR", name: "France" },
  { code: "ES", name: "Spain" },
  { code: "IT", name: "Italy" },
  { code: "NL", name: "Netherlands" },
  { code: "SE", name: "Sweden" },
  { code: "IE", name: "Ireland" },
  { code: "BR", name: "Brazil" },
  { code: "JP", name: "Japan" },
  { code: "KR", name: "South Korea" },
  { code: "CA", name: "Canada" },
  { code: "AU", name: "Australia" },
  { code: "other", name: "Somewhere else" },
];
const PILL: Record<MoneyState, string> = {
  earning: "Earning",
  in_program: "In the programme",
  goal_reached: "Goal reached",
  not_yet: "Not yet",
  counting: "Counting",
  unknown: "Not earning yet",
  needs_permission: "Needs your OK",
  not_available: "Not shared",
  not_connected: "Not connected",
  error: "Couldn't check",
};

interface Saved {
  scenario: MoneyScenario;
  country: string | null;
  seen: string[];
  lastManualAt?: number;
}

function load(): Saved {
  try {
    const raw = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as Partial<Saved> | null;
    if (raw && MONEY_SCENARIOS.includes(raw.scenario as MoneyScenario)) {
      return { scenario: raw.scenario as MoneyScenario, country: raw.country ?? null, seen: raw.seen ?? [], lastManualAt: raw.lastManualAt };
    }
  } catch {
    /* no storage: defaults */
  }
  return { scenario: "start", country: null, seen: [] };
}

function save(s: Saved) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode: this page only */
  }
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);

function goal(
  key: string,
  label: string,
  current: number | null,
  target: number | null,
  sourceUrl: string,
  extra: Partial<MoneyGoal> = {},
): MoneyGoal {
  const kind = extra.kind ?? "bar";
  return {
    key,
    label,
    kind,
    current,
    goal: target,
    reached: kind !== "number" && current !== null && target !== null && current >= target,
    approx: false,
    sourceUrl,
    ...extra,
  };
}

function youtubeGoals(subs: number, hours: number, shorts: number): { goals: MoneyGoal[]; more: MoneyGoal[] } {
  return {
    goals: [
      goal("subscribers", "subscribers", subs, 1000, YT_SOURCE, { note: "YouTube rounds this" }),
      goal("watchHours", "watch hours in 12 months", hours, 4000, YT_SOURCE, {
        approx: true,
        or: "shortsViews",
        windowDays: 365,
        help: "Our count of long videos and lives. YouTube Studio's number is the official one.",
      }),
      goal("shortsViews", "Shorts views in 90 days", shorts, 10_000_000, YT_SOURCE, {
        or: "watchHours",
        windowDays: 90,
        help: "YouTube's engaged Shorts views, up to the last day YouTube finished counting.",
      }),
    ],
    more: [
      goal("fanSubscribers", "subscribers for fan money", subs, 500, YT_SOURCE, { note: "Fan money: memberships, Super Thanks, Super Chat" }),
      goal("fanUploads", "public videos in 90 days", 4, 3, YT_SOURCE, { windowDays: 90 }),
      goal("fanWatchHours", "watch hours for fan money", hours, 3000, YT_SOURCE, { approx: true, or: "fanShortsViews", windowDays: 365 }),
      goal("fanShortsViews", "Shorts views for fan money", shorts, 3_000_000, YT_SOURCE, { or: "fanWatchHours", windowDays: 90 }),
    ],
  };
}

function base(platform: Platform, state: MoneyState, line: string): MoneyCard {
  const where: Record<Platform, [string, string, string, string | undefined]> = {
    youtube: ["YouTube Partner Program", "YouTube Studio › Earn", "AdSense for YouTube › Payments", "https://adsense.google.com/"],
    tiktok: ["Creator Rewards", "Creator tools › Creator Rewards", "Profile › Balance", undefined],
    instagram: ["Instagram Gifts", "Professional dashboard › Monetization", "Professional dashboard › Payouts", undefined],
    facebook: ["Facebook content monetization", "Meta Business Suite › Monetization", "Meta Business Suite › Payouts", "https://business.facebook.com/latest/monetization"],
    x: ["Creator Revenue Sharing", "X › Monetization", "X › Monetization (paid through Stripe)", "https://x.com/settings/monetization"],
  };
  const [programme, status, paid, paidUrl] = where[platform];
  return {
    platform,
    state,
    pill: PILL[state],
    line,
    programme,
    statusWhere: { label: status },
    paidWhere: paidUrl ? { label: paid, url: paidUrl } : { label: paid },
    goals: [],
    more: [],
    extras: [],
    checkedAt: hoursAgo(2),
  };
}

function money(platform: Platform, currency: string, tag: string, note: string, daily: number[]): MoneyCard["revenue"] {
  const last30 = daily.map((micros, i) => ({ date: daysAgo(daily.length - i + 1), amountMicros: micros }));
  const month = new Date().toISOString().slice(0, 7);
  const thisMonth = last30.filter((d) => d.date.startsWith(month)).reduce((n, d) => n + d.amountMicros, 0);
  return {
    platform,
    currency,
    unit: currency,
    source: platform === "youtube" ? "youtube.estimatedRevenue" : "facebook.content_monetization_earnings",
    tag,
    note,
    month,
    thisMonthMicros: thisMonth,
    last30,
    months: [{ month, amountMicros: thisMonth }],
  };
}

const YT_DAILY = [120_000, 180_000, 90_000, 260_000, 310_000, 280_000, 400_000, 350_000, 520_000, 480_000, 610_000, 590_000, 700_000, 820_000, 760_000, 900_000, 840_000, 980_000, 1_050_000, 1_120_000];
const FB_DAILY = [40_000, 0, 60_000, 90_000, 70_000, 110_000, 150_000, 130_000, 160_000, 210_000];

function permission(platform: "youtube" | "tiktok"): MoneyCard["needsPermission"] {
  return platform === "youtube"
    ? {
        what: "money",
        button: "Allow money reading",
        steps: [
          "Ask a grown-up. Use the same Google Cloud project. Don't make new keys.",
          "In Google Cloud › Data access, add the money permission below.",
          "In Google Cloud › Audience, Publishing status must say In production.",
          'Press Allow money reading. Google\'s "unverified app" screen is normal: press Advanced, then Continue.',
        ],
        copy: [{ label: "Money permission", value: MONETARY }],
        open: { label: "Open Data access", url: "https://console.cloud.google.com/auth/scopes" },
      }
    : {
        what: "followers",
        button: "Allow follower reading",
        steps: [
          "Ask a grown-up. In TikTok for Developers, add the permission below and send the app for review.",
          "Wait until TikTok approves it.",
          "Press Allow follower reading. Until TikTok approves, nothing changes and posting keeps working.",
        ],
        copy: [{ label: "Permission", value: "user.info.stats" }],
        open: { label: "Open TikTok for Developers", url: "https://developers.tiktok.com/apps/" },
      };
}

function youtubeCard(scenario: MoneyScenario): MoneyCard {
  if (scenario === "start" || scenario === "consent_needed" || scenario === "unsupported" || scenario === "facebook_unverified") {
    const c = base("youtube", "needs_permission", "YouTube needs your OK before Clip Factory can read money.");
    Object.assign(c, youtubeGoals(812, 1500, 1_200_000), { needsPermission: permission("youtube"), lagNote: "2–3 days behind" });
    c.extras = ["New rules from 1 Feb 2027: 8,000 watch hours or 20M Shorts views, still with 1,000 subscribers."];
    return c;
  }
  if (scenario === "not_yet") {
    const c = base("youtube", "not_yet", "Not in YouTube Partner Program yet. Here's how close you are.");
    Object.assign(c, youtubeGoals(812, 1500, 1_200_000), { lagNote: "2–3 days behind" });
    c.extras = ["New rules from 1 Feb 2027: 8,000 watch hours or 20M Shorts views, still with 1,000 subscribers."];
    return c;
  }
  if (scenario === "goal_reached") {
    const c = base("youtube", "goal_reached", "Goal reached. YouTube also checks things we can't see.");
    Object.assign(c, youtubeGoals(1040, 4120, 2_400_000), { lagNote: "2–3 days behind" });
    return c;
  }
  if (scenario === "error") {
    const c = base("youtube", "error", "Turn on YouTube Analytics API in Google Cloud.");
    Object.assign(c, youtubeGoals(812, 1500, 1_200_000), { lastError: "Turn on YouTube Analytics API in Google Cloud.", lagNote: "2–3 days behind" });
    return c;
  }
  if (scenario === "in_program") {
    const c = base("youtube", "in_program", "You're in YouTube Partner Program. Money shows here when YouTube reports some.");
    return { ...c, detectedAt: hoursAgo(5), lagNote: "2–3 days behind" };
  }
  // earning, facebook_verified
  const c = base("youtube", "earning", "You're earning on YouTube.");
  return {
    ...c,
    detectedAt: hoursAgo(24 * 20),
    earningSince: hoursAgo(24 * 18),
    lagNote: "2–3 days behind",
    revenue: money("youtube", "USD", "YouTube's estimate", "Can change at month end · 2–3 days behind", YT_DAILY),
    extras: ["Ads are on."],
  };
}

function tiktokCard(scenario: MoneyScenario): MoneyCard {
  const extras = ["Videos 1 min or longer: 7 of your last 20.", "Deleted or private videos aren't counted.", "Don't switch to a Business account. Creator Rewards won't pay it."];
  if (scenario === "unsupported" || scenario === "earning" || scenario === "facebook_verified") {
    const c = base("tiktok", "not_available", "TikTok doesn't tell apps if you're getting paid. Check Creator tools › Creator Rewards.");
    c.goals = [
      goal("followers", "followers", 10_500, 10_000, TT_SOURCE),
      goal("views30", "views in 30 days", 64_200, 100_000, TT_SOURCE, { approx: true, windowDays: 30, help: "Our count from your public videos. TikTok only counts views it calls real." }),
    ];
    return { ...c, extras, notShared: "TikTok doesn't share earnings with apps." };
  }
  const c = base("tiktok", "needs_permission", "TikTok needs your OK before Clip Factory can read followers.");
  c.goals = [
    goal("followers", "followers", null, 10_000, TT_SOURCE, { missing: "Press Allow follower reading once TikTok approves it." }),
    goal("views30", "views in 30 days", null, 100_000, TT_SOURCE, { approx: true, windowDays: 30, countingDaysLeft: 12, help: "Our count from your public videos. TikTok only counts views it calls real." }),
  ];
  return { ...c, extras, needsPermission: permission("tiktok"), notShared: "TikTok doesn't share earnings with apps." };
}

function instagramCard(scenario: MoneyScenario): MoneyCard {
  const reached = scenario !== "unsupported";
  const c = base(
    "instagram",
    reached ? "goal_reached" : "not_available",
    reached ? "Goal reached. Instagram also checks things we can't see." : "Instagram doesn't tell apps if you're getting paid. Check Professional dashboard › Monetization.",
  );
  c.goals = [goal("followers", "followers for Gifts", reached ? 640 : 320, 500, IG_SOURCE, { note: "Instagram also checks age, country and rules" })];
  return { ...c, extras: ["If your Reels also go to a Facebook Page, look at the Facebook card too."], notShared: "Instagram doesn't share earnings with apps." };
}

function facebookCard(scenario: MoneyScenario): MoneyCard {
  const facts = [
    goal("followers", "followers", 2_310, null, "https://www.facebook.com/business/help", { kind: "number" }),
    goal("minutes60", "minutes watched in 60 days", 18_420, null, "https://www.facebook.com/business/help", { kind: "number", approx: true, note: "Our count. Meta's may differ." }),
    goal("qualifiedViews60", "views that can earn in 60 days", 9_100, null, "https://www.facebook.com/business/help", { kind: "number" }),
  ];
  const extras = ["Meta invites creators. Look in Meta Business Suite › Monetization."];
  if (scenario === "facebook_verified") {
    const c = base("facebook", "earning", "You're earning on Facebook.");
    return { ...c, goals: facts, extras, lagNote: "Can take 2 days", revenue: money("facebook", "EUR", "Meta's estimate", "Final may differ", FB_DAILY) };
  }
  const c = base("facebook", "unknown", "Not earning yet. Meta doesn't tell apps if you've joined.");
  return {
    ...c,
    goals: facts,
    extras,
    lagNote: "Can take 2 days",
    comingSoon: "Facebook money: coming soon. A grown-up checks it once against Meta Business Suite first.",
  };
}

function xCard(): MoneyCard {
  const c = base("x", "not_available", "X doesn't tell apps if you're getting paid. Check X › Monetization.");
  c.goals = [
    goal("premium", "Premium", 1, 1, X_SOURCE, { kind: "tick", note: "X's rule, from X's help page" }),
    goal("verifiedFollowers", "verified followers", 120, 500, X_SOURCE, { note: "X's rule, from X's help page" }),
    goal("impressions90", "impressions in 90 days", 40_200, null, X_SOURCE, {
      kind: "number",
      approx: true,
      windowDays: 90,
      help: "Upper guess from the posts Clip Factory made. X only counts verified people on Home.",
    }),
  ];
  return { ...c, notShared: "X doesn't share earnings with apps." };
}

function notConnected(platform: Platform): MoneyCard {
  const names: Record<Platform, string> = { youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram", facebook: "Facebook", x: "X" };
  const c = base(platform, "not_connected", `Connect ${names[platform]} in Settings › Posting › Set up posting to see this.`);
  delete c.checkedAt;
  return c;
}

function celebrationsFor(scenario: MoneyScenario): MoneyCelebration[] {
  if (scenario === "in_program") return [{ key: "youtube:in_program", platform: "youtube", kind: "in_program", text: "You're in YouTube's Partner Program!" }];
  if (scenario === "earning") return [{ key: "youtube:first_money", platform: "youtube", kind: "first_money", text: "Your first money from YouTube!" }];
  if (scenario === "goal_reached") return [{ key: "youtube:goal:subscribers:1000", platform: "youtube", kind: "goal", text: "You hit 1,000 subscribers!" }];
  return [];
}

export function buildMoneyView(saved: Saved): MoneyView {
  const s = saved.scenario;
  const cards =
    s === "not_connected" ? ORDER.map(notConnected) : [youtubeCard(s), tiktokCard(s), instagramCard(s), facebookCard(s), xCard()];
  if (!saved.country) {
    const tiktok = cards.find((c) => c.platform === "tiktok");
    if (tiktok && tiktok.state !== "not_connected") {
      tiktok.goals = [];
      tiktok.extras = ["Pick your country at the top to see this programme's goals.", ...tiktok.extras];
    }
  } else if (saved.country === "other") {
    const tiktok = cards.find((c) => c.platform === "tiktok");
    if (tiktok && tiktok.state !== "not_connected") {
      tiktok.goals = [];
      tiktok.extras = ["Creator Rewards is not open in your country. Check its rules in the TikTok app.", ...tiktok.extras];
    }
  }
  const totals = new Map<string, { currency: string; amountMicros: number; platforms: Platform[] }>();
  for (const c of cards) {
    if (c.state !== "earning" || !c.revenue) continue;
    const line = totals.get(c.revenue.currency) ?? { currency: c.revenue.currency, amountMicros: 0, platforms: [] };
    line.amountMicros += c.revenue.thisMonthMicros;
    line.platforms.push(c.platform);
    totals.set(c.revenue.currency, line);
  }
  const view: MoneyView = {
    platforms: cards,
    country: saved.country,
    countries: COUNTRIES,
    thisMonth: [...totals.values()],
    celebrations: celebrationsFor(s).filter((c) => !saved.seen.includes(c.key)),
    asOf: "2026-11-18",
  };
  if (saved.lastManualAt && saved.lastManualAt + 3_600_000 > Date.now()) view.nextCheckAllowedAt = new Date(saved.lastManualAt + 3_600_000).toISOString();
  return view;
}

/** "Allow money reading" in the pretend app: approved at once, back on the Money page like the real callback. */
export function mockMoneyGrant(platform: Platform): { authorizeUrl: string; expiresAt: string } {
  if (platform !== "youtube" && platform !== "tiktok") throw new ApiError(400, "bad_request", "That app does not share money with apps, so there is nothing to allow.");
  const s = load();
  if (platform === "youtube" && ["start", "consent_needed", "unsupported", "facebook_unverified"].includes(s.scenario)) s.scenario = "not_yet";
  if (platform === "tiktok" && s.scenario !== "not_connected") s.scenario = s.scenario === "start" ? "unsupported" : s.scenario;
  save(s);
  return { authorizeUrl: `/settings/posting/money?result=money_allowed&platform=${platform}`, expiresAt: new Date(Date.now() + 600_000).toISOString() };
}

export function moneyApi(wait: () => Promise<void>): { api: MoneyApi; controls: MockMoneyControls } {
  const controls: MockMoneyControls = {
    setScenario(name) {
      save({ ...load(), scenario: name });
    },
    scenario: () => load().scenario,
    reset() {
      save({ scenario: load().scenario, country: null, seen: [] });
    },
  };
  const api: MoneyApi = {
    async getMoney() {
      await wait();
      return buildMoneyView(load());
    },
    async refreshMoney() {
      await wait();
      const s = load();
      if (s.lastManualAt && s.lastManualAt + 3_600_000 > Date.now()) {
        return { started: false, nextAllowedAt: new Date(s.lastManualAt + 3_600_000).toISOString() };
      }
      s.lastManualAt = Date.now();
      save(s);
      return { started: true, nextAllowedAt: new Date(s.lastManualAt + 3_600_000).toISOString() };
    },
    async seenMoney(key) {
      await wait();
      const s = load();
      if (!celebrationsFor(s.scenario).some((c) => c.key === key) || s.seen.includes(key)) {
        throw new ApiError(404, "not_found", "That celebration is not waiting.");
      }
      s.seen = [...s.seen, key];
      save(s);
      return buildMoneyView(s);
    },
    async setMoneyCountry(country) {
      await wait();
      if (!COUNTRIES.some((c) => c.code === country)) throw new ApiError(400, "bad_request", "Pick your country from the list.", "country");
      const s = load();
      s.country = country;
      save(s);
      return buildMoneyView(s);
    },
  };
  return { api, controls };
}
