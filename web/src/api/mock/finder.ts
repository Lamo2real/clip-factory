// Mock mode's campaign finder (docs/CONTRACTS.md §41.5): the seven routes under /v1/contentrewards/finder and the
// overview's `finder`, with their state in sessionStorage (`cf-mock-finder`). The campaigns are the golden samples of
// §41.3 (their numbers are Content Rewards' own, copied as they are), matched and worded the way the server does it,
// so the screens show the server's words. Only bundled into mock builds.
//
// Test knobs: window.__cfMock.finder.{newMatches(n), setState(state | "unavailable"), joinedOnCr(uuid),
// signedIn(bool), reset()}. "unavailable": only the finder routes answer 503 and the overview has no finder.
import { ApiError } from "../errors.ts";
import type {
  Api,
  Campaign,
  CampaignRules,
  CampaignSummary,
  CrFinderSummary,
  CrPay,
  Finder,
  FinderKind,
  FinderMatch,
  FinderPay,
  FinderState,
  FinderWant,
  Platform,
  SetupOverview,
} from "../types.ts";
import { usd, usdShort } from "../../lib/contentRewards.ts";
import { PLATFORM_LABEL, PLATFORM_ORDER } from "../../lib/format.ts";

const KEY = "cf-mock-finder";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** A look takes 3 s on the fake clock (`looking`, then `ok`). */
export const LOOK_MS = 3000;

const DEFAULTS: FinderWant = {
  on: true,
  minPer1kCents: 100,
  places: null,
  categories: [],
  minLeftPct: 25,
  access: "open",
  otherPay: false,
  languages: [],
  tellMe: true,
};

const iso = (ms: number) => new Date(ms).toISOString();
const crUrl = (uuid: string) => `https://contentrewards.com/c/campaigns/${uuid}`;

/** One public campaign page as the look keeps it (a `FinderCard`, §41.2), with Content Rewards' own numbers. */
interface MockCard {
  uuid: string;
  name: string;
  brand: string;
  access: "open" | "application";
  kind: FinderKind;
  /** Every place it pays for; `top` is the most a place pays per 1,000 views ("Up to $2.00"). */
  pay: { platform: Platform; per1kCents: number | null; top: number | null; geo: boolean; maxPayoutCents: number | null; perPostCents?: number | null }[];
  /** CR's budget: total, spent, left, and its own progress in basis points (`metrics.budgetProgressBps`). */
  budget: { totalCents: number | null; spentCents: number | null; leftCents: number | null; usedBps: number | null; usedPct: number | null };
  categories: { id: string; name: string }[];
  /** Drafts first, its own sound, its own overlay, or no clipping at all (§41.3 check 4). */
  cantMake: boolean;
  sound: "maybe" | null;
  overlay: "maybe" | null;
  faceOnCamera: boolean;
  audience: boolean;
  hiddenRules: number | null;
  launchedAt: string;
  namedLanguages: string[];
  pageLanguage: string | null;
  onDiscover: boolean;
}

const p = (platform: Platform, per1k: number | null, max: number | null, extra: Partial<MockCard["pay"][number]> = {}): MockCard["pay"][number] => ({
  platform,
  per1kCents: per1k,
  top: per1k,
  geo: false,
  maxPayoutCents: max,
  ...extra,
});

/** COD DMZ's real uuid (a1cefc3b-…-a7299550f1cf) is the mock's "apply" campaign already, so it gets its own here. */
export const FINDER_IDS = {
  fundingpips: "c0c37381-e244-4643-98bd-edbff4bc1465",
  cod: "a1cefc3b-4533-438f-8e70-a7299550f2d0",
  pickleball: "3d9ef19f-1256-47ca-b630-e33e2c923969",
  santacruz: "c49840ae-ca22-4745-8a42-b675847e0355",
  energy: "e4a9465f-d415-4e30-bf53-e46014958bc6",
  lanco: "d5d8b659-68ac-41d5-9e53-ab89545f437d",
  ungodly: "0d341d7d-e390-4807-9149-9b5294dff3e6",
  hablando: "e815a623-badd-4516-906c-b6cfce227ff9",
  kai: "1d2bcb00-c904-415f-aa82-f95b96baad86",
  splitscreen: "6e8cb2c6-7724-44a4-83da-66697acb20af",
  kreekcraft: "2eaa14fb-6927-4136-897e-b096e0d907d6",
  tradelens: "c9617009-53cb-4885-8ffc-b655f7c128b3",
  weeknd: "4c7d1ede-2fca-406a-971d-f651880168aa",
  mack: "79d6abae-b305-42e9-9ebe-82e47583adb5",
  forge: "1db63081-715e-4e04-9b11-fbc1d4e8e700",
} as const;

const I = FINDER_IDS;
export const CARDS: MockCard[] = [
  {
    uuid: I.fundingpips,
    name: "Fundingpips Clipping",
    brand: "FundingPips",
    access: "open",
    kind: "cpm",
    pay: [p("youtube", 600, 10_000), p("tiktok", 600, 10_000), p("instagram", 600, 10_000)],
    budget: { totalCents: 400_000, spentCents: 233_121, leftCents: 166_879, usedBps: 5828, usedPct: 58 },
    categories: [{ id: "technology", name: "Technology" }],
    cantMake: false,
    sound: null,
    overlay: null,
    faceOnCamera: false,
    audience: false,
    hiddenRules: 4,
    launchedAt: "2026-05-26T11:21:33.000Z",
    namedLanguages: [],
    pageLanguage: "en",
    onDiscover: true,
  },
  {
    uuid: I.cod,
    name: "Call of Duty - MW4 DMZ Intel Briefing Clipping",
    brand: "Clipping Culture",
    access: "open",
    kind: "cpm",
    pay: [p("tiktok", 0, 120_000, { top: 200, geo: true }), p("instagram", 150, 120_000)],
    budget: { totalCents: 3_000_000, spentCents: 1_613_583, leftCents: 1_386_417, usedBps: 5378, usedPct: 54 },
    categories: [{ id: "entertainment", name: "Entertainment" }],
    cantMake: false,
    sound: null,
    overlay: null,
    faceOnCamera: false,
    audience: false,
    hiddenRules: 0,
    launchedAt: "2026-11-09T17:59:40.000Z",
    namedLanguages: [],
    pageLanguage: "en",
    onDiscover: true,
  },
  {
    uuid: I.pickleball,
    name: "Clip Pro Pickleball: CNPL Rallies & Highlights",
    brand: "Canadian National Pickleball League",
    access: "open",
    kind: "cpm",
    pay: [p("youtube", 150, 25_000), p("tiktok", 150, 25_000), p("instagram", 150, 25_000)],
    budget: { totalCents: 250_000, spentCents: 8_990, leftCents: 241_010, usedBps: 359, usedPct: 4 },
    categories: [
      { id: "sports-highlights", name: "Sports Highlights" },
      { id: "sports", name: "Sports" },
    ],
    cantMake: false,
    sound: null,
    overlay: null,
    faceOnCamera: false,
    audience: false,
    hiddenRules: 0,
    launchedAt: "2026-11-14T17:23:44.000Z",
    namedLanguages: [],
    pageLanguage: "en",
    onDiscover: true,
  },
  {
    uuid: I.santacruz,
    name: "Santa Cruz Medicinals Clipping",
    brand: "VitaClips",
    access: "open",
    kind: "cpm",
    pay: [p("youtube", 100, 20_000), p("tiktok", 100, 20_000), p("instagram", 100, 20_000)],
    budget: { totalCents: 1_186_463, spentCents: 660_584, leftCents: 525_879, usedBps: 5567, usedPct: 56 },
    categories: [{ id: "health-wellness", name: "Health & Wellness" }],
    cantMake: false,
    sound: null,
    overlay: null,
    faceOnCamera: false,
    audience: false,
    hiddenRules: 0,
    launchedAt: "2026-11-09T00:27:40.000Z",
    namedLanguages: [],
    pageLanguage: null,
    onDiscover: true,
  },
  {
    uuid: I.energy,
    name: "ENERGY DRINKS -  Beverages",
    brand: "ClipHaus",
    access: "open",
    kind: "cpm",
    pay: [p("youtube", 100, 20_000), p("tiktok", 100, 20_000), p("instagram", 100, 20_000), p("x", 100, 20_000)],
    budget: { totalCents: 1_000_000, spentCents: 11_248, leftCents: 988_752, usedBps: 112, usedPct: 1 },
    categories: [
      { id: "product", name: "Product" },
      { id: "consumer-brand", name: "Consumer Brand" },
    ],
    cantMake: false,
    sound: null,
    overlay: null,
    faceOnCamera: false,
    audience: true,
    hiddenRules: 1,
    launchedAt: "2026-11-17T20:56:20.000Z",
    namedLanguages: [],
    pageLanguage: "en",
    onDiscover: true,
  },
  {
    uuid: I.lanco,
    name: "$3,000 8lanco 'Every Little Thing' Sound Campaign",
    brand: "ClippedIn",
    access: "open",
    kind: "cpm",
    pay: [p("tiktok", 100, 20_000), p("instagram", 100, 20_000)],
    budget: { totalCents: 300_000, spentCents: 971, leftCents: 299_029, usedBps: 32, usedPct: 0 },
    categories: [{ id: "music", name: "Music" }],
    cantMake: false,
    sound: "maybe",
    overlay: null,
    faceOnCamera: false,
    audience: false,
    hiddenRules: 2,
    launchedAt: "2026-11-09T20:47:31.000Z",
    namedLanguages: [],
    pageLanguage: "en",
    onDiscover: true,
  },
  {
    uuid: I.ungodly,
    name: "UnGodly Mobile RPG | Boss Fights & Clutch Plays",
    brand: "Neuvant",
    access: "application",
    kind: "cpm",
    pay: [p("youtube", 175, 17_500), p("tiktok", 175, 17_500)],
    budget: { totalCents: 200_000, spentCents: 8_527, leftCents: 191_473, usedBps: 426, usedPct: 4 },
    categories: [{ id: "gaming", name: "Gaming" }],
    cantMake: false,
    sound: null,
    overlay: null,
    faceOnCamera: false,
    audience: true,
    hiddenRules: null,
    launchedAt: "2026-11-18T17:36:36.000Z",
    namedLanguages: [],
    pageLanguage: "en",
    onDiscover: true,
  },
  {
    uuid: I.hablando,
    name: "Clips Hablando - 1$ por cada 1000 visitas",
    brand: "Carlos Esparraga Clipping",
    access: "application",
    kind: "cpm",
    pay: [p("youtube", 20, 3_000), p("tiktok", 30, 5_000), p("instagram", 100, 10_000)],
    budget: { totalCents: 1_000_000, spentCents: 704_648, leftCents: 295_352, usedBps: 7046, usedPct: 70 },
    categories: [{ id: "personal-brand", name: "Personal Brand" }],
    cantMake: false,
    sound: null,
    overlay: null,
    faceOnCamera: false,
    audience: false,
    hiddenRules: null,
    launchedAt: "2026-11-04T16:26:17.000Z",
    namedLanguages: [],
    pageLanguage: null,
    onDiscover: true,
  },
  {
    uuid: I.kai,
    name: "Kai Cenat - $10,000 GTA 6 Pool Campaign",
    brand: "Clipped & Shipped",
    access: "open",
    kind: "pool",
    pay: [p("youtube", null, null), p("tiktok", null, null), p("instagram", null, null), p("x", null, null)],
    budget: { totalCents: 1_000_000, spentCents: 0, leftCents: 1_000_000, usedBps: 0, usedPct: 0 },
    categories: [
      { id: "streamer", name: "Streamer" },
      { id: "personal-brand", name: "Personal Brand" },
    ],
    cantMake: false,
    sound: null,
    overlay: null,
    faceOnCamera: false,
    audience: false,
    hiddenRules: 0,
    launchedAt: "2026-11-18T19:58:55.000Z",
    namedLanguages: [],
    pageLanguage: "en",
    onDiscover: true,
  },
  {
    uuid: I.splitscreen,
    name: "Split-Screen UGC [English]",
    brand: "Content Rewards",
    access: "open",
    kind: "cpm",
    pay: [p("youtube", 150, 50_000), p("tiktok", 300, 50_000), p("instagram", 300, 50_000), p("x", 300, 50_000)],
    budget: { totalCents: 1_800_000, spentCents: 1_415_711, leftCents: 384_289, usedBps: 7865, usedPct: 79 },
    categories: [],
    cantMake: false,
    sound: null,
    overlay: null,
    faceOnCamera: false,
    audience: true,
    hiddenRules: 1,
    launchedAt: "2026-05-19T20:25:22.000Z",
    namedLanguages: ["en"],
    pageLanguage: null,
    onDiscover: true,
  },
  {
    uuid: I.kreekcraft,
    name: "KreekCraft GTA 6 Clipping",
    brand: "ClipLaunch",
    access: "open",
    kind: "cpm",
    pay: [p("youtube", 50, 50_000), p("tiktok", 50, 50_000), p("instagram", 50, 50_000)],
    budget: { totalCents: 682_460, spentCents: 262_584, leftCents: 419_876, usedBps: 3847, usedPct: 38 },
    categories: [
      { id: "twitch", name: "Twitch" },
      { id: "personal-brand", name: "Personal Brand" },
      { id: "streamer", name: "Streamer" },
    ],
    cantMake: true,
    sound: null,
    overlay: null,
    faceOnCamera: false,
    audience: false,
    hiddenRules: 0,
    launchedAt: "2026-11-18T23:50:23.000Z",
    namedLanguages: [],
    pageLanguage: "en",
    onDiscover: true,
  },
  {
    uuid: I.tradelens,
    name: "TradeLens [SLIDESHOWS]",
    brand: "Reachify",
    access: "open",
    kind: "cpm",
    pay: [p("tiktok", 125, 40_000)],
    budget: { totalCents: 600_000, spentCents: 290_585, leftCents: 309_415, usedBps: 4843, usedPct: 48 },
    categories: [
      { id: "trading", name: "Trading" },
      { id: "finance", name: "Finance" },
    ],
    cantMake: true,
    sound: null,
    overlay: null,
    faceOnCamera: false,
    audience: false,
    hiddenRules: 1,
    launchedAt: "2026-09-03T14:20:17.000Z",
    namedLanguages: [],
    pageLanguage: null,
    onDiscover: true,
  },
  {
    uuid: I.weeknd,
    name: "The Weeknd - Hong Kong Performance Clipping",
    brand: "Artist Influence",
    access: "open",
    kind: "cpm",
    pay: [p("tiktok", 150, 15_000), p("instagram", 150, 15_000)],
    budget: { totalCents: 150_000, spentCents: 25_217, leftCents: 124_783, usedBps: 1681, usedPct: 17 },
    categories: [{ id: "music", name: "Music" }],
    cantMake: true,
    sound: null,
    overlay: null,
    faceOnCamera: false,
    audience: false,
    hiddenRules: 0,
    launchedAt: "2026-11-02T10:32:42.000Z",
    namedLanguages: [],
    pageLanguage: "en",
    onDiscover: true,
  },
  {
    uuid: I.mack,
    name: "Mack Camferdam - Twitch Clips",
    brand: "Mack Camferdam",
    access: "application",
    kind: "cpm",
    pay: [p("tiktok", 100, 50_000)],
    budget: { totalCents: 200_000, spentCents: 0, leftCents: 200_000, usedBps: 0, usedPct: 0 },
    categories: [
      { id: "pc-gaming", name: "PC Gaming" },
      { id: "gaming", name: "Gaming" },
    ],
    cantMake: true,
    sound: null,
    overlay: null,
    faceOnCamera: false,
    audience: false,
    hiddenRules: null,
    launchedAt: "2026-10-21T12:23:42.000Z",
    namedLanguages: [],
    pageLanguage: "en",
    onDiscover: true,
  },
  {
    uuid: I.forge,
    name: "Basic Clipping",
    brand: "BloxClips",
    access: "open",
    kind: "cpm",
    pay: [p("youtube", 50, 50_000), p("tiktok", 100, 100_000), p("instagram", 100, 100_000)],
    budget: { totalCents: 22_465_300, spentCents: 21_961_265, leftCents: 504_035, usedBps: 9775, usedPct: 98 },
    categories: [{ id: "technology", name: "Technology" }],
    cantMake: false,
    sound: null,
    overlay: null,
    faceOnCamera: false,
    audience: false,
    hiddenRules: 1,
    launchedAt: "2026-05-06T18:28:44.000Z",
    namedLanguages: [],
    pageLanguage: "en",
    onDiscover: true,
  },
];

// ---------- The words (§41.3 words.py, copied: rates always with cents, other amounts as gates.money) ----------

const money = (cents: number) => usdShort(cents);
function places(list: readonly Platform[]): string {
  const names = PLATFORM_ORDER.filter((x) => list.includes(x)).map((x) => PLATFORM_LABEL[x]);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
}

function payLine(c: MockCard, row: MockCard["pay"][number]): string {
  switch (c.kind) {
    case "pool":
      return "Shares the prize money";
    case "retainer":
      return "Pays picked creators each month";
    case "other":
      return "Pays in its own way. See its page.";
    case "per_post":
      return `${usd(row.perPostCents ?? 0)} for each approved post`;
    default:
      return `${row.geo ? `Up to ${usd(row.top)}` : usd(row.per1kCents)} per 1,000 views${row.maxPayoutCents != null ? ` · up to ${money(row.maxPayoutCents)} a clip` : ""}`;
  }
}

const SKIP_WORDS: Record<string, [string, string]> = {
  // [plural after the count, singular after "1 campaign"]
  low_pay: ["pay less than {min} per 1,000 views.", "pays less than {min} per 1,000 views."],
  budget_low: ["have less than {left} left.", "has less than {left} left."],
  budget_gone: ["have almost no money left.", "has almost no money left."],
  not_your_places: ["don't pay for the places you post.", "doesn't pay for the places you post."],
  apply: ["want you to apply first.", "wants you to apply first."],
  other_pay: ["pay per post or share a prize.", "pays per post or shares a prize."],
  cant_make: ["need something Clip Factory can't make.", "needs something Clip Factory can't make."],
  topic: ["are about other things.", "is about other things."],
  language: ["want another language.", "wants another language."],
  hidden: ["you said Not for me.", "you said Not for me."],
  own: ["are in your campaigns already.", "is in your campaigns already."],
};
const LEFT_WORDS: Record<number, string> = { 25: "a quarter of the money", 50: "half the money", 75: "three quarters of the money" };
/** Ties keep the order of §41.3's `skipped` words. */
const SKIP_ORDER = ["low_pay", "budget_low", "budget_gone", "not_your_places", "apply", "other_pay", "cant_make", "topic", "language", "hidden", "own"];

function skipText(code: string, n: number, want: FinderWant): string {
  const [many, one] = SKIP_WORDS[code]!;
  const fill = (t: string) => t.replace("{min}", usd(want.minPer1kCents)).replace("{left}", LEFT_WORDS[want.minLeftPct] ?? "a quarter of the money");
  return n === 1 ? `1 campaign ${fill(one)}` : `${n} ${fill(many)}`;
}

/** `finder.match.find` (§41.3), copied for the mock. */
export function find(
  cards: readonly MockCard[],
  want: FinderWant,
  opts: { places: readonly Platform[]; tiktokOk: boolean; own: ReadonlySet<string>; hidden: ReadonlySet<string>; asOf: string },
): Pick<Finder, "skipped"> & { matches: Omit<FinderMatch, "isNew" | "opened">[]; looked: number } {
  const skipped = new Map<string, number>();
  const refuse = (code: string) => skipped.set(code, (skipped.get(code) ?? 0) + 1);
  const kept: { m: Omit<FinderMatch, "isNew" | "opened">; key: (number | string)[] }[] = [];
  for (const c of cards) {
    if (opts.own.has(c.uuid)) {
      refuse("own");
      continue;
    }
    if (opts.hidden.has(c.uuid)) {
      refuse("hidden");
      continue;
    }
    if (!c.onDiscover) {
      refuse("not_listed");
      continue;
    }
    const heads: string[] = [];
    const notes: string[] = [];
    const cantTell: string[] = [];
    if (c.cantMake) {
      refuse("cant_make");
      continue;
    }
    if (c.sound === "maybe") heads.push("It may need its own sound. Clip Factory can't add one.");
    if (c.overlay === "maybe") heads.push("It may want its own picture on top of the video. Clip Factory can't add one.");
    if (c.faceOnCamera) heads.push("This brand wants your face on camera.");
    if (c.audience) heads.push("This brand only counts viewers from some countries. Check where yours are first.");
    if (c.budget.usedBps !== null && c.budget.usedBps >= 9500) {
      refuse("budget_gone");
      continue;
    }
    const paid = c.pay.map((r) => r.platform);
    const mine = c.pay.filter((r) => opts.places.includes(r.platform));
    if (!mine.length) {
      refuse("not_your_places");
      continue;
    }
    if (c.kind !== "cpm" && !want.otherPay) {
      refuse("other_pay");
      continue;
    }
    if (c.access === "application" && want.access === "open") {
      refuse("apply");
      continue;
    }
    const counted = c.kind === "cpm" ? mine.filter((r) => (r.top ?? 0) >= want.minPer1kCents) : mine;
    if (c.kind === "cpm" && !counted.length) {
      refuse("low_pay");
      continue;
    }
    if (c.budget.usedBps !== null && c.budget.usedBps > 10000 - 100 * want.minLeftPct) {
      refuse("budget_low");
      continue;
    }
    if (c.budget.usedBps === null) cantTell.push("I can't tell how much money is left.");
    let topicName: string | null = null;
    if (want.categories.length) {
      if (c.categories.length) {
        const hit = c.categories.find((x) => want.categories.includes(x.id));
        if (!hit) {
          refuse("topic");
          continue;
        }
        topicName = hit.name;
      } else cantTell.push("I can't tell what it's about.");
    }
    if (want.languages.length) {
      const picked = want.languages as readonly string[];
      if (c.namedLanguages.length) {
        if (!c.namedLanguages.some((l) => picked.includes(l))) {
          refuse("language");
          continue;
        }
      } else if (c.pageLanguage) {
        if (!picked.includes(c.pageLanguage)) heads.push(`Its page is in ${LANGUAGE_NAME[c.pageLanguage] ?? "another language"}.`);
      } else cantTell.push("I can't tell the language.");
    }
    // Notes, in the table's order: hidden rules, the other places it pays for, TikTok after its audit, countries.
    if (c.access === "open" && (c.hiddenRules ?? 0) > 0) notes.push(`It has ${c.hiddenRules} ${c.hiddenRules === 1 ? "rule" : "rules"} you see once you join.`);
    const others = paid.filter((x) => x !== "tiktok" && !opts.places.includes(x));
    if (others.length) notes.push(`Also pays on ${places(others)}.`);
    if (paid.includes("tiktok") && !opts.tiktokOk) notes.push("Also pays on TikTok, once TikTok checks Clip Factory.");
    if (c.kind === "cpm" && counted.some((r) => r.geo)) notes.push("Pays less in some countries.");

    const tops = counted.map((r) => r.top ?? 0);
    const best = tops.length ? tops.reduce((a, b) => (b > a ? b : a)) : 0;
    const oneRate = tops.every((t) => t === tops[0]) && !counted.some((r) => r.geo);
    const pay =
      c.kind === "cpm"
        ? `Pays ${oneRate ? "" : "up to "}${usd(best)} per 1,000 views`
        : c.kind === "pool"
          ? "Shares the prize money"
          : c.kind === "retainer"
            ? "Pays picked creators each month"
            : c.kind === "per_post"
              ? `Pays ${usd(counted[0]?.perPostCents ?? 0)} for each approved post`
              : "Pays in its own way";
    const left = c.budget.usedBps === null ? null : 100 - Math.ceil(c.budget.usedBps / 100);
    const why = `${pay} on ${places(counted.map((r) => r.platform))}.${topicName ? ` ${topicName}.` : ""}${left === null ? "" : ` ${left}% of the money left.`} ${c.access === "open" ? "Open to join." : "You apply first."}`;
    const payRows: FinderPay[] = PLATFORM_ORDER.flatMap((x) => mine.filter((r) => r.platform === x)).map((r) => ({
      platform: r.platform,
      line: payLine(c, r),
      per1kCents: r.per1kCents,
      topPer1kCents: r.top,
      perPostCents: r.perPostCents ?? null,
      maxPayoutCents: r.maxPayoutCents,
      geo: r.geo,
    }));
    const maxes = c.pay.map((r) => r.maxPayoutCents).filter((x): x is number => x !== null);
    const match: Omit<FinderMatch, "isNew" | "opened"> = {
      campaignId: c.uuid,
      url: crUrl(c.uuid),
      name: c.name,
      brand: c.brand,
      access: c.access,
      kind: c.kind,
      pay: payRows,
      maxPerClipCents: maxes.length ? maxes.reduce((a, b) => (b > a ? b : a)) : null,
      budget: {
        totalCents: c.budget.totalCents,
        leftCents: c.budget.leftCents,
        usedPct: c.budget.usedPct,
        line: c.budget.leftCents !== null && c.budget.totalCents !== null ? `${money(c.budget.leftCents)} left of ${money(c.budget.totalCents)}` : null,
        asOf: opts.asOf,
        tag: "Content Rewards' numbers",
      },
      categories: c.categories,
      why,
      notes: notes.slice(0, 3),
      headsUp: heads.slice(0, 3),
      cantTell: cantTell.slice(0, 3),
      hiddenRules: c.access === "open" ? c.hiddenRules : null,
      launchedAt: c.launchedAt,
      rank: 0,
    };
    const kindRank = { cpm: 0, per_post: 1, pool: 2, retainer: 3, other: 4 }[c.kind];
    kept.push({
      m: match,
      key: [heads.length || cantTell.length ? 1 : 0, kindRank, c.kind === "cpm" ? -best : 0, -(c.budget.leftCents ?? -1), -Date.parse(c.launchedAt), c.uuid],
    });
  }
  kept.sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) {
      const x = a.key[i]!;
      const y = b.key[i]!;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  });
  const matches = kept.slice(0, 20).map((k, i) => ({ ...k.m, rank: i + 1 }));
  const shown = SKIP_ORDER.filter((code) => (skipped.get(code) ?? 0) > 0)
    .map((code) => ({ code, count: skipped.get(code)!, text: skipText(code, skipped.get(code)!, want) }))
    .sort((a, b) => b.count - a.count);
  return { matches, skipped: shown, looked: cards.filter((c) => c.onDiscover).length };
}

const LANGUAGE_NAME: Record<string, string> = { en: "English", es: "Spanish", pt: "Portuguese", fr: "French", de: "German", it: "Italian" };

/** What Clip Factory's campaign card shows once the campaign is added (the CR mock's catalog entry). */
export interface FinderCatalog {
  name: string;
  brand: string;
  access: "open" | "application";
  type: Campaign["type"];
  state: Campaign["state"];
  pay: CrPay[];
  budget: Campaign["budget"];
  platformsPaid: Platform[];
  rules: CampaignRules | null;
  logoNeeded: boolean;
}

export function catalogOf(uuid: string, rules: (partial: Partial<CampaignRules>) => CampaignRules): FinderCatalog | null {
  const c = CARDS.find((x) => x.uuid === uuid);
  if (!c) return null;
  return {
    name: c.name,
    brand: c.brand,
    access: c.access,
    type: c.kind === "per_post" ? "per_post" : c.kind,
    state: "active",
    pay: c.pay.map((r) => ({
      platform: r.platform,
      per1kCents: r.geo ? r.top : r.per1kCents,
      perPostCents: r.perPostCents ?? null,
      minPayoutCents: null,
      maxPayoutCents: r.maxPayoutCents,
      minViews: null,
    })),
    budget: { totalCents: c.budget.totalCents, spentCents: c.budget.spentCents, leftCents: c.budget.leftCents, usedPct: c.budget.usedPct },
    platformsPaid: PLATFORM_ORDER.filter((x) => c.pay.some((r) => r.platform === x)),
    rules: rules({ requiredHashtags: ["#Ad"], lengthMinSec: 10, lengthMaxSec: 60 }),
    logoNeeded: false,
  };
}

// ---------- State ----------

interface FinderItem {
  want: FinderWant;
  createdAt: string;
  seenAt?: string;
  hidden: string[];
  opened: Record<string, string>;
  added: Record<string, string>;
  lookingSince?: string;
  lookWhy?: string;
  matches: Omit<FinderMatch, "isNew" | "opened">[];
  matchedAt?: string;
  shown: Record<string, string>;
  skipped: Finder["skipped"];
  looked: number;
  checkNow?: { at: string; day: string; n: number };
  joinedAt?: string;
  askedAt?: string;
}

interface State {
  item: FinderItem | null;
  /** A source state forced by a test (`down`, `blocked`, …), or "looking" held open. */
  forced?: FinderState;
  unavailable?: boolean;
  lastLookAt?: string;
  /** Campaigns he joined on Content Rewards (the next joined call adds them, as signed in). */
  joinedOnCr: string[];
}

const blank = (): State => ({ item: null, joinedOnCr: [] });

function load(): State {
  try {
    const raw = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(KEY);
    if (raw) return { ...blank(), ...(JSON.parse(raw) as State) };
  } catch {
    /* a broken copy starts over */
  }
  return blank();
}

function save(s: State) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode: kept for this page only */
  }
}

export interface FinderMockDeps {
  setup: () => SetupOverview;
  publish: (id: string) => void;
  /** Off (404) or switched off (503): the finder answers the same as Content Rewards. */
  guard: () => void;
  signedIn: () => boolean;
  setSignedIn: (on: boolean) => void;
  ownIds: () => string[];
  /** Adds the campaign to Content Rewards' mock (the add, or an adopt with `listed`). */
  add: (uuid: string, cat: FinderCatalog, how: { said?: "applied" | "joined_by_hand"; listed?: boolean }) => { campaign: Campaign; summary: CampaignSummary };
  rules: (partial: Partial<CampaignRules>) => CampaignRules;
}

export type FinderMockApi = Pick<Api, "crFinder" | "crPatchFinder" | "crFinderCheck" | "crFinderSaid" | "crFinderAdd" | "crFinderJoined" | "crFinderAsk">;

export interface FinderMock {
  api: FinderMockApi;
  overview(): CrFinderSummary | undefined;
}

const bad = (field: string) => new ApiError(400, "bad_request", "Pick one of the choices shown.", field);
const goneMatch = () => new ApiError(404, "not_found", "That campaign isn't in your matches any more. Tap Look again now.");

/** The want checks of §41.5. */
export function checkWant(w: Record<string, unknown>): Partial<FinderWant> {
  const keys = ["on", "minPer1kCents", "places", "minLeftPct", "access", "categories", "languages", "otherPay", "tellMe"];
  for (const k of Object.keys(w)) if (!keys.includes(k)) throw bad(k);
  for (const k of ["on", "otherPay", "tellMe"]) if (k in w && typeof w[k] !== "boolean") throw bad(k);
  if ("minPer1kCents" in w && ![50, 100, 200, 300].includes(w.minPer1kCents as number)) throw bad("minPer1kCents");
  if ("minLeftPct" in w && ![0, 25, 50, 75].includes(w.minLeftPct as number)) throw bad("minLeftPct");
  if ("access" in w && !["open", "any"].includes(w.access as string)) throw bad("access");
  if ("places" in w && w.places !== null) {
    const list = w.places as unknown[];
    if (!Array.isArray(list) || new Set(list).size !== list.length || list.some((x) => !PLATFORM_ORDER.includes(x as Platform))) throw bad("places");
  }
  if ("categories" in w) {
    const list = w.categories as unknown[];
    if (!Array.isArray(list) || list.length > 12 || new Set(list).size !== list.length || list.some((x) => typeof x !== "string" || !/^[a-z0-9-]{1,40}$/.test(x))) throw bad("categories");
  }
  if ("languages" in w) {
    const list = w.languages as unknown[];
    if (!Array.isArray(list) || new Set(list).size !== list.length || list.some((x) => !["en", "es", "pt", "fr", "de", "it"].includes(x as string))) throw bad("languages");
  }
  return w as Partial<FinderWant>;
}

export function finderMockApi(deps: FinderMockDeps): FinderMock {
  let state = load();
  const now = () => Date.now();
  const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
  const changed = () => {
    save(state);
    deps.publish("finder");
  };
  const guard = () => {
    deps.guard();
    if (state.unavailable) throw new ApiError(503, "unavailable", "Coming soon.");
  };

  function tiktokOk(): boolean {
    return deps.setup().platforms.find((x) => x.platform === "tiktok")?.gates.find((g) => g.key === "posting_audit")?.state === "ok";
  }
  function resolved(want: FinderWant): Platform[] {
    const ready = new Set(deps.setup().platforms.filter((x) => x.ready).map((x) => x.platform));
    const ok = tiktokOk();
    return PLATFORM_ORDER.filter((x) => (want.places ?? PLATFORM_ORDER).includes(x) && ready.has(x) && (x !== "tiktok" || ok));
  }

  function match(item: FinderItem, at: number) {
    const out = find(CARDS, item.want, {
      places: resolved(item.want),
      tiktokOk: tiktokOk(),
      own: new Set(deps.ownIds()),
      hidden: new Set(item.hidden),
      asOf: iso(state.lastLookAt ? Date.parse(state.lastLookAt) : at),
    });
    item.matches = out.matches;
    item.skipped = out.skipped;
    item.looked = out.looked;
    item.matchedAt = iso(at);
    for (const m of out.matches) if (!item.shown[m.campaignId]) item.shown[m.campaignId] = iso(at);
  }

  /** A look: `looking` for 3 s, then the matches (a scheduled or first look also reads the pages). */
  function startLook(why: "start" | "want" | "check_now") {
    const item = state.item;
    if (!item) return;
    item.lookingSince = iso(now());
    item.lookWhy = why;
    save(state);
    setTimeout(() => {
      if (!state.item || state.forced === "looking") return;
      const at = now();
      if (why !== "want") state.lastLookAt = iso(at);
      match(state.item, at);
      delete state.item.lookingSince;
      changed();
    }, LOOK_MS);
  }

  function view(): Finder {
    const item = state.item;
    const want = item?.want ?? { ...DEFAULTS };
    const at = now();
    const lookingNow = !!item?.lookingSince && (!item.matchedAt || item.lookingSince > item.matchedAt) && at - Date.parse(item.lookingSince) <= 10 * MIN;
    const st: FinderState = !want.on
      ? "off"
      : !item
        ? "new"
        : state.forced === "looking" || lookingNow
          ? "looking"
          : state.forced && state.forced !== "new" && state.forced !== "off"
            ? state.forced
            : "ok";
    const hidden = new Set(item?.hidden ?? []);
    const added = item?.added ?? {};
    const own = new Set(deps.ownIds());
    const seen = item?.seenAt;
    const matches: FinderMatch[] = (item?.matches ?? [])
      .filter((m) => !hidden.has(m.campaignId) && !added[m.campaignId] && !own.has(m.campaignId))
      .map((m) => ({
        ...m,
        isNew: !seen || (item!.shown[m.campaignId] ?? "") > seen,
        ...(item!.opened[m.campaignId] ? { opened: item!.opened[m.campaignId] } : {}),
      }));
    const counts = new Map<string, { id: string; name: string; count: number }>();
    for (const c of CARDS) for (const cat of c.categories) counts.set(cat.id, { ...cat, count: (counts.get(cat.id)?.count ?? 0) + 1 });
    const places = resolved(want);
    return {
      state: st,
      want: { ...want },
      resolvedPlaces: places,
      tiktokWaits: !tiktokOk(),
      matches: st === "off" ? [] : matches,
      newCount: st === "off" ? 0 : matches.filter((m) => m.isNew).length,
      hiddenCount: hidden.size,
      skipped: item?.skipped ?? [],
      looked: { campaigns: item?.looked ?? 0, pending: 0 },
      categories: [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 12),
      ...(state.lastLookAt ? { lastLookAt: state.lastLookAt, asOf: state.lastLookAt } : {}),
      ...(item?.checkNow ? { nextAllowedAt: nextAllowed(item.checkNow) } : {}),
      signedIn: deps.signedIn(),
      ...(item?.askedAt ? { askedAt: item.askedAt } : {}),
    };
  }

  function nextAllowed(c: { at: string; day: string; n: number }): string {
    const day = iso(now()).slice(0, 10);
    if (c.day === day && c.n >= 4) return `${iso(Date.parse(`${day}T00:00:00.000Z`) + DAY)}`;
    return iso(Date.parse(c.at) + 30 * MIN);
  }

  function create(want: Partial<FinderWant>) {
    state.item = { want: { ...DEFAULTS, ...want }, createdAt: iso(now()), hidden: [], opened: {}, added: {}, matches: [], shown: {}, skipped: [], looked: 0 };
  }

  function known(uuid: string): FinderItem {
    const item = state.item;
    if (!item || !(item.matches.some((m) => m.campaignId === uuid) || item.opened[uuid] || item.hidden.includes(uuid))) throw goneMatch();
    return item;
  }

  const controls = {
    /** n new matches now (a scheduled look found them): the first n of the matches are new to him. */
    newMatches(n = 3) {
      if (!state.item) create({});
      const item = state.item!;
      const at = now();
      state.lastLookAt = iso(at);
      delete state.forced;
      match(item, at);
      item.seenAt = iso(at - 1000);
      item.matches.forEach((m, i) => {
        item.shown[m.campaignId] = iso(i < n ? at : at - 2000);
      });
      changed();
    },
    setState(next: FinderState | "unavailable") {
      if (next === "unavailable") {
        state.unavailable = true;
      } else if (next === "new") {
        state = { ...blank(), unavailable: false };
      } else if (next === "off") {
        if (!state.item) create({});
        state.item!.want.on = false;
      } else {
        delete state.unavailable;
        if (!state.item) {
          create({});
          match(state.item!, now());
          state.lastLookAt = iso(now());
        }
        state.item!.want.on = true;
        if (next === "ok") delete state.forced;
        else state.forced = next;
      }
      changed();
    },
    joinedOnCr(uuid: string) {
      if (!state.joinedOnCr.includes(uuid)) state.joinedOnCr.push(uuid);
      save(state);
    },
    signedIn(on: boolean) {
      deps.setSignedIn(on);
      deps.publish("finder");
    },
    reset() {
      state = blank();
      changed();
    },
    ids: FINDER_IDS,
  };
  if (typeof window !== "undefined") {
    const w = window as unknown as { __cfMock?: Record<string, unknown> };
    w.__cfMock = { ...(w.__cfMock ?? {}), finder: controls };
  }

  const api: FinderMockApi = {
    async crFinder() {
      await wait();
      guard();
      return view();
    },
    async crPatchFinder(body) {
      await wait();
      guard();
      for (const k of Object.keys(body)) if (!["want", "seenAll", "unhideAll"].includes(k)) throw bad(k);
      if (body.want) {
        const want = checkWant(body.want as Record<string, unknown>);
        if (!state.item) {
          create(want);
          startLook("start");
        } else {
          state.item.want = { ...state.item.want, ...want };
          if (state.item.want.on) startLook("want");
        }
      }
      if (body.seenAll && state.item) state.item.seenAt = iso(now());
      if (body.unhideAll && state.item) {
        state.item.hidden = [];
        startLook("want");
      }
      changed();
      return view();
    },
    async crFinderCheck() {
      await wait();
      guard();
      const item = state.item;
      if (!item) return { started: false, nextAllowedAt: iso(now()) };
      const day = iso(now()).slice(0, 10);
      const c = item.checkNow;
      if (c && (now() - Date.parse(c.at) < 30 * MIN || (c.day === day && c.n >= 4))) return { started: false, nextAllowedAt: nextAllowed(c) };
      item.checkNow = { at: iso(now()), day, n: c && c.day === day ? c.n + 1 : 1 };
      startLook("check_now");
      changed();
      return { started: true, nextAllowedAt: nextAllowed(item.checkNow) };
    },
    async crFinderSaid(campaignId, said) {
      await wait();
      guard();
      const item = known(campaignId);
      if (said === "opened") item.opened[campaignId] = iso(now());
      else if (said === "not_for_me") item.hidden = [...new Set([...item.hidden, campaignId])];
      else item.hidden = item.hidden.filter((x) => x !== campaignId);
      changed();
      return view();
    },
    async crFinderAdd(campaignId) {
      await wait(160);
      guard();
      const item = known(campaignId);
      const cat = catalogOf(campaignId, deps.rules);
      if (!cat) throw goneMatch();
      const signed = deps.signedIn();
      const listed = signed && state.joinedOnCr.includes(campaignId);
      const said = cat.access === "application" ? ("applied" as const) : !signed ? ("joined_by_hand" as const) : undefined;
      const out = deps.add(campaignId, cat, { ...(said && !listed ? { said } : {}), listed });
      item.added[campaignId] = iso(now());
      changed();
      return out.campaign;
    },
    async crFinderJoined() {
      await wait();
      guard();
      const item = state.item;
      if (!item || !deps.signedIn()) return [];
      if (item.joinedAt && now() - Date.parse(item.joinedAt) < 30_000) return [];
      item.joinedAt = iso(now());
      const own = new Set(deps.ownIds());
      const out: CampaignSummary[] = [];
      for (const [uuid, at] of Object.entries(item.opened)) {
        if (out.length >= 5) break;
        if (now() - Date.parse(at) > 48 * HOUR || item.added[uuid] || own.has(uuid) || !state.joinedOnCr.includes(uuid)) continue;
        const cat = catalogOf(uuid, deps.rules);
        if (!cat) continue;
        out.push(deps.add(uuid, cat, { listed: true }).summary);
        item.added[uuid] = iso(now());
      }
      changed();
      return out;
    },
    async crFinderAsk() {
      await wait();
      guard();
      if (!deps.signedIn()) throw new ApiError(409, "conflict", "Connect Content Rewards first.");
      if (!state.item) create({});
      const item = state.item!;
      if (!item.askedAt || now() - Date.parse(item.askedAt) > 30 * DAY) item.askedAt = iso(now());
      changed();
      return { askedAt: item.askedAt };
    },
  };

  return {
    api,
    overview() {
      try {
        deps.guard();
      } catch {
        return undefined;
      }
      if (state.unavailable) return undefined;
      const v = view();
      return { on: v.want.on, started: !!state.item, newCount: v.newCount, matches: v.matches.length };
    },
  };
}
