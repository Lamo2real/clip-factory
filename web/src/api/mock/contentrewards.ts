// Mock mode's Content Rewards (docs/CONTRACTS.md §38.18): the routes of §38.8 with their state in sessionStorage
// (`cf-mock-cr`), so a reload or the trip to the pretend consent page and back resumes where the owner was. The
// sentences come from lib/contentRewards.ts, the same words the API sends. The desktop bridge is never faked here
// (Playwright fakes window.__CF_CR_CONNECT__ in e2e/desktopWindow.ts). Only bundled into mock builds.
//
// Start states for tests, read once per page load from sessionStorage before the app starts:
//   cf-mock-cr-start = "fresh"   not connected, no campaigns (the first-time owner)
//   cf-mock-cr-off   = "404"     an API from before §38 (every Content Rewards part hides)
//   cf-mock-cr-off   = "503"     switched off ("Coming soon")
//   cf-mock-cr-review = "1"      one Review clip is for the FaZe Clips campaign
//   cf-mock-cr-remake = "on"     campaign copies are switched on (like the API's cr_remake_enabled, off by default)
//   cf-mock-cr-remake = "fail"   on, and each copy's job fails (the copy can be asked for again)
//   cf-mock-cr-overview = "500"  GET /v1/contentrewards fails (a 5xx; read on every call, so a test can clear it)
import { ApiError } from "../errors.ts";
import type {
  Api,
  Campaign,
  CampaignRules,
  CampaignStop,
  CampaignSummary,
  Clip,
  ClipPostOptions,
  CrConnectResult,
  CrConnection,
  CrMoney,
  CrOverview,
  CrPay,
  CrSubmission,
  CrSubState,
  GroupChoice,
  Membership,
  Platform,
  Post,
  SaidAnswer,
  SetupOverview,
  StopCode,
  TikTokPostOptions,
} from "../types.ts";
import {
  PROOF_OPEN,
  SOFT_STOPS,
  membershipStop,
  nextStepFor,
  signedIn,
  stopText,
  subLineFor,
  usd,
} from "../../lib/contentRewards.ts";
import { PLATFORM_LABEL, PLATFORM_ORDER } from "../../lib/format.ts";
import { campaignLink } from "../../lib/links.ts";
import { CR_PILOT_EMAIL, CR_SUBMISSIONS, pilotMailto } from "../../setup/contentrewards.ts";

const KEY = "cf-mock-cr";
const MIN = 60_000;
const DAY = 86_400_000;

export const CR_IDS = {
  faze: "200ea21b-be80-4db8-b552-8e32b148604e",
  apply: "a1cefc3b-4533-438f-8e70-a7299550f1cf",
  logo: "3b1e6c3e-1f0a-4a55-9a8e-6f2b9d1c4e70",
  paused: "4c2f7d4f-2a1b-4b66-8b9f-7a3c0e2d5f81",
  tiktok: "5d3a8e50-3b2c-4c77-9caf-8b4d1f3e6a92",
  group: "6e4b9f61-4c3d-4d88-adb0-9c5e2a4f7ba3",
  season1: "7f5cab72-5d4e-4e99-8ec1-ad6f3b5a8cb4",
  season2: "8a6dbc83-6e5f-4faa-9fd2-be7a4c6b9dc5",
  manual: "9b7ecd94-7f6a-4abb-a0e3-cf8b5d7cae06",
  money: "0c8fdea5-8a7b-4bcc-b1f4-d09c6e8dbf17",
} as const;

const crUrl = (uuid: string) => `https://contentrewards.com/c/campaigns/${uuid}`;
const iso = (ms: number) => new Date(ms).toISOString();

/** A campaign as Content Rewards has it (its public page and, once joined, its brief). */
interface Catalog {
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
  sourceVideos?: Campaign["sourceVideos"];
  channels?: Campaign["channels"];
}

function rules(partial: Partial<CampaignRules>): CampaignRules {
  return {
    lengthMinSec: null,
    lengthMaxSec: null,
    requiredHashtags: [],
    requiredTags: [],
    requiredCaptionText: null,
    disclosure: { caption: "#Ad", onScreen: "Paid partnership", spoken: false },
    logo: { required: false, rules: null },
    overlayRequired: false,
    coverImageRequired: false,
    layoutNotes: null,
    language: null,
    bannedContent: [],
    sourceVideos: [],
    allowedSources: { campaignProvidedOnly: false, youtube: true, twitch: true, kick: true, channels: [], notes: null },
    clipUntil: null,
    keepPublicDays: null,
    minViewsForPayout: null,
    postSubmissionRules: [],
    audience: null,
    draftsFirst: false,
    soundRequired: false,
    faceOnCamera: false,
    otherRules: [],
    uncertain: [],
    ...partial,
  };
}

const cpm = (platform: Platform, per1k: number, max: number | null = 20_000, min: number | null = 200): CrPay => ({
  platform,
  per1kCents: per1k,
  perPostCents: null,
  minPayoutCents: min,
  maxPayoutCents: max,
  minViews: null,
});

const CATALOG: Record<string, Catalog> = {
  [CR_IDS.faze]: {
    name: "FaZe Clips",
    brand: "FaZe Clan",
    access: "open",
    type: "cpm",
    state: "active",
    pay: [
      {
        ...cpm("youtube", 100),
        countryRates: [{ name: "US & UK", per1kCents: 200, countries: ["US", "GB"] }],
        otherCountriesPer1kCents: 20,
      },
      cpm("instagram", 100),
    ],
    budget: { totalCents: 850_000, spentCents: 61_000, leftCents: 789_000, usedPct: 7, asOf: iso(Date.now() - 20 * MIN) },
    platformsPaid: ["youtube", "instagram"],
    rules: rules({
      lengthMinSec: 15,
      lengthMaxSec: 60,
      requiredHashtags: ["#FaZe"],
      requiredTags: ["@FaZeClan"],
      allowedSources: {
        campaignProvidedOnly: false,
        youtube: true,
        twitch: true,
        kick: false,
        channels: [{ name: "FaZe Clan", url: "https://www.youtube.com/@FaZeClan" }],
        notes: null,
      },
      bannedContent: ["swearing", "gambling"],
      postSubmissionRules: [{ text: "After 48 hours, send a screen recording of the views.", afterHours: 48, atViews: null, where: null }],
      keepPublicDays: 30,
    }),
    logoNeeded: false,
    channels: [{ name: "FaZe Clan", href: "https://www.youtube.com/@FaZeClan/videos" }],
  },
  [CR_IDS.apply]: {
    name: "Rumble League Highlights",
    brand: "Rumble Games",
    access: "application",
    type: "cpm",
    state: "active",
    pay: [cpm("youtube", 150), cpm("x", 120)],
    budget: { totalCents: 500_000, spentCents: 280_000, leftCents: 220_000, usedPct: 56, asOf: iso(Date.now() - 2 * 60 * MIN) },
    platformsPaid: ["youtube", "x"],
    rules: rules({ lengthMinSec: 20, lengthMaxSec: 90, requiredHashtags: ["#RumbleLeague"] }),
    logoNeeded: false,
  },
  [CR_IDS.logo]: {
    name: "Valor Esports Clips",
    brand: "Valor Esports",
    access: "open",
    type: "cpm",
    state: "active",
    pay: [cpm("youtube", 120), cpm("instagram", 110), cpm("facebook", 80)],
    budget: { totalCents: 300_000, spentCents: 30_000, leftCents: 270_000, usedPct: 10 },
    platformsPaid: ["youtube", "instagram", "facebook"],
    rules: rules({ lengthMaxSec: 45, requiredHashtags: ["#Valor"], logo: { required: true, rules: "Top right, the whole clip." } }),
    logoNeeded: true,
  },
  [CR_IDS.paused]: {
    name: "Nova Energy Plays",
    brand: "Nova Energy",
    access: "open",
    type: "cpm",
    state: "paused",
    pay: [cpm("youtube", 90)],
    budget: { totalCents: 200_000, spentCents: 120_000, leftCents: 80_000, usedPct: 60 },
    platformsPaid: ["youtube"],
    rules: rules({ requiredHashtags: ["#NovaEnergy"] }),
    logoNeeded: false,
  },
  [CR_IDS.tiktok]: {
    name: "DanceDrop Moments",
    brand: "DanceDrop",
    access: "open",
    type: "cpm",
    state: "active",
    pay: [cpm("tiktok", 60)],
    budget: { totalCents: 100_000, spentCents: 10_000, leftCents: 90_000, usedPct: 10 },
    platformsPaid: ["tiktok"],
    rules: rules({ requiredHashtags: ["#DanceDrop"] }),
    logoNeeded: false,
  },
  [CR_IDS.season1]: {
    name: "Arena Cup Season 1",
    brand: "Arena Cup",
    access: "open",
    type: "per_post",
    state: "active",
    pay: [{ platform: "youtube", per1kCents: null, perPostCents: 500, minPayoutCents: null, maxPayoutCents: null, minViews: 1000 }],
    budget: { totalCents: 100_000, spentCents: 5_000, leftCents: 95_000, usedPct: 5 },
    platformsPaid: ["youtube"],
    rules: rules({ requiredHashtags: ["#ArenaCup"] }),
    logoNeeded: false,
  },
  [CR_IDS.season2]: {
    name: "Arena Cup Season 2",
    brand: "Arena Cup",
    access: "open",
    type: "cpm",
    state: "active",
    pay: [cpm("youtube", 50, 10_000, 100)],
    budget: { totalCents: 100_000, spentCents: 0, leftCents: 100_000, usedPct: 0 },
    platformsPaid: ["youtube"],
    rules: rules({ requiredHashtags: ["#ArenaCup"] }),
    logoNeeded: false,
  },
  [CR_IDS.manual]: {
    name: "Pixel Pals Funny Moments",
    brand: "Pixel Pals",
    access: "open",
    type: "cpm",
    state: "active",
    pay: [cpm("youtube", 110)],
    budget: { totalCents: 400_000, spentCents: 40_000, leftCents: 360_000, usedPct: 10 },
    platformsPaid: ["youtube"],
    rules: null,
    logoNeeded: false,
  },
  [CR_IDS.money]: {
    name: "GameFuel Clips",
    brand: "GameFuel",
    access: "open",
    type: "cpm",
    state: "active",
    pay: [cpm("youtube", 130), cpm("instagram", 100), cpm("facebook", 90)],
    budget: { totalCents: 1_000_000, spentCents: 420_000, leftCents: 580_000, usedPct: 42 },
    platformsPaid: ["youtube", "instagram", "facebook"],
    rules: rules({ lengthMinSec: 10, lengthMaxSec: 60, requiredHashtags: ["#GameFuel"], keepPublicDays: 14 }),
    logoNeeded: false,
  },
};

function catalogFor(uuid: string): Catalog {
  return (
    CATALOG[uuid] ?? {
      name: "Clip Campaign",
      brand: "A brand",
      access: "open",
      type: "cpm",
      state: "active",
      pay: [cpm("youtube", 100)],
      budget: { totalCents: 200_000, spentCents: 20_000, leftCents: 180_000, usedPct: 10 },
      platformsPaid: ["youtube"],
      rules: rules({ requiredHashtags: ["#Clips"] }),
      logoNeeded: false,
    }
  );
}

/** Clip Factory's copy of one campaign (the CAMPAIGN# item). */
interface Stored {
  campaignId: string;
  /** Content Rewards lists it for this owner (he joined, or the brand said yes). */
  listed: boolean;
  wasListed?: boolean;
  said?: SaidAnswer;
  anyway: StopCode[];
  rulesState: Campaign["rulesState"];
  /** When a rules read started (it ends after a moment). */
  readingSince?: number;
  /** How long this read takes, in ms (a test can make it longer than a slow machine's clicks). */
  readingMs?: number;
  pastedRules?: string;
  logo: Campaign["logo"];
  held?: boolean;
  /** "You're in!" still to show. */
  celebrate?: boolean;
  /** The owner saw it already (no second confetti). */
  celebrated?: boolean;
  addedAt: string;
  checkedAt: string;
  waitingSince?: string;
}

/** One campaign post on Content Rewards (the CRSUB# item), keyed by the post's clip hook and platform. */
interface SubState {
  key: string;
  campaignId: string;
  state: CrSubState;
  at: number;
  reason?: CrSubmission["reason"];
  views?: number | null;
  earned?: CrSubmission["earned"];
  appealedAt?: string;
  proofDue?: boolean;
  proofDoneAt?: string;
  flagged?: boolean;
  /** Walks sending → sent → approved by itself (a fresh upload in mock). */
  walking?: boolean;
  /** When a send by hand must be done (ms), kept across reloads (the seeded posts are made fresh each load). */
  sendBy?: number;
}

interface State {
  connection: CrConnection;
  campaigns: Stored[];
  subs: SubState[];
  money: CrMoney;
  nextResult: CrConnectResult | null;
  seen: string[];
  lastMoveCents?: number;
  /** Content Rewards' paid payouts by day (CRMONEY.paidByDay, §39.2): cents per yyyy-mm-dd. */
  paidByDay?: Record<string, number>;
}

function blankConnection(): CrConnection {
  return {
    status: "not_connected",
    canSubmit: false,
    crLinked: {},
    stepsDone: [],
    pilotEmail: { ...CR_PILOT_EMAIL, mailto: pilotMailto() },
  };
}

function connectedConnection(now = Date.now(), canSubmit = true): CrConnection {
  const connectedAt = now - 3 * DAY;
  return {
    ...blankConnection(),
    status: canSubmit ? "connected" : "read_only",
    canSubmit,
    connectedAt: iso(connectedAt),
    signInBy: iso(connectedAt + 90 * DAY),
    warnFrom: iso(connectedAt + 83 * DAY),
    crLinked: { youtube: true },
    stepsDone: ["ready-account", "ready-socials"],
    lastResult: canSubmit ? "connected" : "read_only",
  };
}

function noMoney(state: CrMoney["state"]): CrMoney {
  return {
    state,
    tag: "Content Rewards' numbers",
    stillEarningCents: null,
    onItsWayCents: null,
    readyToMoveCents: null,
    paidSoFarCents: null,
    waitingForBrand: 0,
    campaigns: [],
    celebrations: [],
  };
}

function seedMoney(now = Date.now()): CrMoney {
  return {
    state: "ok",
    tag: "Content Rewards' numbers",
    asOf: iso(now - 20 * MIN),
    stillEarningCents: 420,
    onItsWayCents: 0,
    readyToMoveCents: 1825,
    paidSoFarCents: 6240,
    lastPaidAt: iso(now - 3 * DAY),
    lastPaidCents: 421,
    waitingForBrand: 3,
    campaigns: [
      { campaignId: CR_IDS.money, name: "GameFuel Clips", paidCents: 5410, pendingCents: 420 },
      { campaignId: CR_IDS.faze, name: "FaZe Clips", paidCents: 830, pendingCents: 0 },
    ],
    celebrations: [],
  };
}

function stored(campaignId: string, partial: Partial<Stored> = {}, now = Date.now()): Stored {
  const cat = catalogFor(campaignId);
  return {
    campaignId,
    listed: false,
    anyway: [],
    rulesState: cat.rules ? (cat.access === "open" && !partial.listed ? "waiting_for_join" : "ready") : "waiting_for_join",
    logo: { needed: cat.logoNeeded, state: "none" },
    addedAt: iso(now - 2 * DAY),
    checkedAt: iso(now - 2 * MIN),
    ...partial,
  };
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** The seeded payouts by day: $4.21 three days ago and $3.79 twelve days ago reached the balance in the last 30 days. */
function seedPaidByDay(now = Date.now()): Record<string, number> {
  return { [dayOf(now - 3 * DAY)]: 421, [dayOf(now - 12 * DAY)]: 379, [dayOf(now - 45 * DAY)]: 5440 };
}

function seedFull(now = Date.now()): State {
  const campaigns: Stored[] = [
    stored(CR_IDS.faze, { listed: true, wasListed: true, rulesState: "ready", addedAt: iso(now - 1 * DAY), celebrated: true }),
    stored(CR_IDS.apply, { rulesState: "ready", addedAt: iso(now - 2 * DAY), waitingSince: iso(now - 2 * DAY) }),
    stored(CR_IDS.logo, { listed: true, wasListed: true, rulesState: "ready", addedAt: iso(now - 3 * DAY), celebrated: true }),
    stored(CR_IDS.paused, { listed: true, wasListed: true, rulesState: "ready", addedAt: iso(now - 4 * DAY), celebrated: true }),
    stored(CR_IDS.tiktok, { listed: true, wasListed: true, rulesState: "ready", addedAt: iso(now - 5 * DAY), celebrated: true }),
    stored(CR_IDS.manual, {
      said: "joined_by_hand",
      rulesState: "ready",
      pastedRules: "Clips 20 to 60 seconds. Use #PixelPals and @PixelPalsGame in every caption. No swearing.",
      addedAt: iso(now - 6 * DAY),
    }),
    stored(CR_IDS.money, { listed: true, wasListed: true, rulesState: "ready", addedAt: iso(now - 9 * DAY), celebrated: true }),
  ];
  return { connection: connectedConnection(now), campaigns, subs: [], money: seedMoney(now), nextResult: null, seen: [], paidByDay: seedPaidByDay(now) };
}

function seedFresh(): State {
  return { connection: blankConnection(), campaigns: [], subs: [], money: noMoney("not_connected"), nextResult: null, seen: [] };
}

function readFlag(name: string): string | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(name);
  } catch {
    return null;
  }
}

function load(): State {
  try {
    const raw = readFlag(KEY);
    if (raw) return JSON.parse(raw) as State;
  } catch {
    /* a broken copy starts over */
  }
  return readFlag("cf-mock-cr-start") === "fresh" ? seedFresh() : seedFull();
}

function save(state: State) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* private mode: kept for this page only */
  }
}

/** The plain rules a mock "read" finds in pasted text (the API asks Claude; here a few patterns do). */
function rulesFromPaste(text: string): CampaignRules {
  const tags = [...new Set(text.match(/#\w{1,60}/g) ?? [])].slice(0, 8);
  const ats = [...new Set(text.match(/@[\w.]{1,60}/g) ?? [])].slice(0, 5);
  const len = /(\d{1,3})\s*(?:to|-|–)\s*(\d{1,3})\s*(?:s|sec|seconds)/i.exec(text);
  return rules({
    requiredHashtags: tags,
    requiredTags: ats,
    lengthMinSec: len ? Number(len[1]) : null,
    lengthMaxSec: len ? Number(len[2]) : null,
    bannedContent: /swear/i.test(text) ? ["swearing"] : [],
  });
}

function plainRulesOf(r: CampaignRules | null, platformsPaid: Platform[], brand: string, logoNeeded: boolean): string[] {
  if (!r) return [];
  const out: string[] = [];
  if (r.lengthMinSec && r.lengthMaxSec) out.push(`Clips are ${r.lengthMinSec} to ${r.lengthMaxSec} seconds long.`);
  else if (r.lengthMaxSec) out.push(`Clips are under ${r.lengthMaxSec} seconds long.`);
  else if (r.lengthMinSec) out.push(`Clips are at least ${r.lengthMinSec} seconds long.`);
  const tags = [...r.requiredHashtags, ...r.requiredTags];
  if (tags.length) out.push(`Every caption has ${tags.length > 1 ? `${tags.slice(0, -1).join(", ")} and ${tags.at(-1)}` : tags[0]}.`);
  out.push(`${r.disclosure.caption} goes at the start of each caption.`);
  out.push(`'${r.disclosure.onScreen}' shows on the video for the first 3 seconds.`);
  if (logoNeeded || r.logo.required) out.push(`The ${brand} logo stays on screen the whole clip, away from faces and the game.`);
  if (r.allowedSources.channels.length) out.push(`Only clips from ${r.allowedSources.channels.map((c) => c.name).join(" and ")}'s videos.`);
  if (r.bannedContent.length) out.push(`No ${r.bannedContent.slice(0, 5).join(" or ")}.`);
  // As the API (rules.py): only when a paid place can be posted to (never "It goes up on nowhere only").
  const places = platformsPaid.filter((p) => p !== "tiktok");
  if (places.length) out.push(`It goes up on ${placeWords(places)} only.`);
  return out.slice(0, 12);
}

function placeWords(list: Platform[]): string {
  const names = PLATFORM_ORDER.filter((p) => list.includes(p)).map((p) => PLATFORM_LABEL[p]);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "nowhere");
}

function thingsYouDoOf(r: CampaignRules | null): string[] {
  if (!r) return [];
  const out = r.postSubmissionRules.map((p) => (p.afterHours ? `After ${p.afterHours} hours, send a screen recording of this clip's views. I'll remind you.` : p.text));
  if (r.keepPublicDays) out.push(`Keep each clip up for ${r.keepPublicDays} days. Don't delete it.`);
  if (r.disclosure.spoken) out.push("Say “paid partnership” out loud in the first 10 seconds.");
  if (r.audience) out.push("Show the brand where your viewers live if it asks.");
  return out;
}

export interface CrMockDeps {
  store: { clips: Clip[]; posts: Post[] };
  setup: () => SetupOverview;
  publish: (id: string) => void;
}

export type CrMockApi = Pick<
  Api,
  | "crOverview"
  | "crConnect"
  | "crConnectFinish"
  | "crCheck"
  | "crPatchConnection"
  | "crDisconnect"
  | "crCampaigns"
  | "crAddCampaign"
  | "crCampaign"
  | "crReadCampaign"
  | "crPatchCampaign"
  | "crLogoUpload"
  | "crLogoDone"
  | "crLogoLink"
  | "crDeleteLogo"
  | "crRemoveCampaign"
  | "crSubmissions"
  | "crCheckSubmissions"
  | "crSendSubmission"
  | "crPatchSubmission"
  | "crMoney"
  | "crRefreshMoney"
  | "crSeen"
>;

const unavailable = () => new ApiError(503, "unavailable", "Content Rewards is not switched on for this app yet.");
const missing = () => new ApiError(404, "not_found", "Not found.");
const notFound = () => new ApiError(404, "not_found", "Add the campaign again.");
const conflict = (m: string) => new ApiError(409, "conflict", m);
const bad = (m: string) => new ApiError(400, "bad_request", m);

export interface CrMock {
  api: CrMockApi;
  /** A campaign clip was uploaded: its posts go to Content Rewards (sending → sent → approved on the clock). */
  onPosts(clip: Clip, posts: Post[]): void;
  /** POST /v1/jobs with a campaignId (§38.5): refused while the campaign has a hard stop. */
  jobCheck(campaignId: string, anyway: readonly StopCode[]): Promise<void>;
  /** Confirm for a campaign clip (§38.14): the same refusals as the API. */
  confirmCheck(clip: Clip, chosen: Platform[] | undefined, options: ClipPostOptions | undefined, tiktok: TikTokPostOptions | undefined): Promise<void>;
  /** §39: the campaigns as served (for the fit), the connection, and the money items for All your money. */
  served(): Campaign[];
  connection(): CrConnection;
  moneyItems(): { crconn: CrConnection | null; crmoney: Record<string, unknown> | null; on: boolean };
  /** Switched off (503) or before §38 (404): the §39 routes answer the same. */
  guard(): void;
}

export function crMockApi({ store, setup, publish }: CrMockDeps): CrMock {
  let state = load();
  const off = readFlag("cf-mock-cr-off");
  const guard = () => {
    if (off === "404") throw missing();
    if (off === "503") throw unavailable();
  };
  const changed = (id = "connection") => {
    save(state);
    publish(id);
  };

  // One Review clip for a campaign (tests and screenshots): the first waiting clip of the newest ready job.
  const reviewFlag = readFlag("cf-mock-cr-review");
  if (reviewFlag === "1" || reviewFlag === "tiktok") {
    const clip = store.clips.find((c) => c.status === "review");
    if (clip) clip.campaignId = CR_IDS.faze;
  }
  // "tiktok": FaZe Clips pays for TikTok too, so the Review card shows TikTok left out until its audit (§38.5).
  if (reviewFlag === "tiktok") {
    const faze = CATALOG[CR_IDS.faze]!;
    if (!faze.platformsPaid.includes("tiktok")) {
      faze.platformsPaid = [...faze.platformsPaid, "tiktok"];
      faze.pay = [...faze.pay, cpm("tiktok", 100)];
    }
  }

  // GameFuel Clips: the posted clips' first five posts with a link (three approved, two not approved).
  // The oldest ones (last week's), so this week's clips keep the faces other tests know.
  const seeded = store.posts
    .filter((p) => p.status === "posted" && p.url && p.platform !== "tiktok" && p.platform !== "x")
    .sort((a, b) => (a.postedAt ?? "").localeCompare(b.postedAt ?? ""))
    .slice(0, 5);
  const keyOf = (p: Post) => `${store.clips.find((c) => c.clipId === p.clipId)?.hook ?? p.clipId}|${p.platform}`;
  if (!state.subs.length && state.campaigns.some((c) => c.campaignId === CR_IDS.money)) {
    seeded.forEach((p, i) => {
      const approved = i < 3;
      state.subs.push({
        key: keyOf(p),
        campaignId: CR_IDS.money,
        state: approved ? "approved" : "rejected",
        at: Date.now() - (i + 2) * DAY,
        views: approved ? [12_300, 8_450, 31_020][i]! : 2_100,
        earned: approved ? { paidCents: [310, 1240, 2100][i]!, pendingCents: i === 0 ? 120 : 0 } : null,
        reason: approved ? undefined : { code: "refused", text: "", brandSaid: i === 3 ? "Logo missing in the first seconds." : undefined },
      });
    });
    save(state);
  }

  const now = () => Date.now();
  const find = (id: string) => {
    const c = state.campaigns.find((x) => x.campaignId === id);
    if (!c) throw notFound();
    return c;
  };

  function membership(c: Stored): Membership {
    if (c.said === "not_eligible") return "not_accepted";
    if (signedIn(state.connection)) {
      if (c.listed) return "in";
      if (c.said === "joined_by_hand") return "manual";
      if (c.wasListed) return "left";
      const cat = catalogFor(c.campaignId);
      if (cat.access === "application") return c.said === "applied" ? "waiting" : "apply_first";
      return "not_joined";
    }
    return c.said === "joined_by_hand" ? "manual" : "unknown";
  }

  /** A rules read ends after a moment and says so on the live connection, like cf-prod-campaigns writing the item. */
  function startReading(c: Stored, ms = 1200) {
    c.rulesState = "reading";
    c.readingSince = now();
    c.readingMs = ms;
    setTimeout(() => {
      tick(c);
      publish(`campaign:${c.campaignId}`);
    }, ms + 100);
  }

  function tick(c: Stored) {
    if (c.rulesState === "reading" && c.readingSince && now() - c.readingSince > (c.readingMs ?? 1200)) {
      c.rulesState = "ready";
      delete c.readingSince;
      delete c.readingMs;
      save(state);
    }
    const m = membership(c);
    if (m === "in" && c.rulesState === "waiting_for_join" && catalogFor(c.campaignId).rules) {
      startReading(c);
      save(state);
    }
  }

  function rulesOf(c: Stored): CampaignRules | null {
    const cat = catalogFor(c.campaignId);
    if (c.pastedRules) return rulesFromPaste(c.pastedRules);
    return c.rulesState === "ready" ? cat.rules : null;
  }

  function readyPlaces(): { ready: Platform[]; tiktokAudit: boolean } {
    const o = setup();
    const ready = o.platforms.filter((p) => p.ready).map((p) => p.platform);
    const tiktokAudit = o.platforms.find((p) => p.platform === "tiktok")?.gates.find((g) => g.key === "posting_audit")?.state === "ok";
    return { ready, tiktokAudit };
  }

  function serve(c: Stored): Campaign {
    tick(c);
    const cat = catalogFor(c.campaignId);
    const m = membership(c);
    const r = rulesOf(c);
    const { ready, tiktokAudit } = readyPlaces();
    const conn = state.connection;
    const uploadPlaces = PLATFORM_ORDER.filter(
      (p) => cat.platformsPaid.includes(p) && ready.includes(p) && conn.crLinked[p] !== false && (p !== "tiktok" || tiktokAudit),
    );
    const stops: CampaignStop[] = [];
    const add = (code: StopCode, extra: Partial<CampaignStop> = {}) => {
      const hard = !SOFT_STOPS.includes(code);
      stops.push({ code, hard, text: stopText(code, { platformsPaid: cat.platformsPaid, leftCents: cat.budget.leftCents, bestPer1kCents: bestRate(cat), clipUntil: r?.clipUntil, audience: r?.audience }), ...extra, ...(hard ? {} : { anyway: c.anyway.includes(code) }) });
    };
    const ms = membershipStop(m);
    if (ms) add(ms);
    if (m === "manual" && !signedIn(conn)) add("not_connected");
    if (cat.state === "paused") add("paused");
    if (cat.state === "ended") add("ended");
    if (cat.platformsPaid.length && cat.platformsPaid.every((p) => p === "tiktok")) add("tiktok_only");
    else if (!uploadPlaces.length) {
      const first = PLATFORM_ORDER.find((p) => cat.platformsPaid.includes(p) && p !== "tiktok");
      add("no_place", first ? { fixHref: `/settings/posting/setup/${first}` } : {});
    }
    if (c.held) add("held");
    if ((cat.budget.usedPct ?? 0) >= 95) add("budget_gone");
    else if ((cat.budget.usedPct ?? 0) > 50) add("budget_half");
    const rates = cat.pay.map((p) => p.per1kCents).filter((x): x is number => x !== null);
    if (rates.length && rates.every((x) => x < 100)) add("low_rate");
    if (c.rulesState === "reading") add("rules_reading");
    if (c.rulesState === "failed") add("rules_failed");
    if ((m === "in" || m === "manual") && c.logo.needed && c.logo.state !== "ready") add("logo_missing");
    if (r?.draftsFirst) add("drafts_first");
    if (r?.soundRequired) add("sound_needed");
    if (r?.overlayRequired) add("overlay_needed");
    if (r?.faceOnCamera) add("face_needed");
    if (r?.disclosure.spoken) add("spoken_needed");
    if (r?.audience) add("audience");
    const canSayIn = !!c.addedAt && now() - Date.parse(c.addedAt) > 2 * MIN;
    const nextStep = nextStepFor({
      campaignId: c.campaignId,
      url: crUrl(c.campaignId),
      membership: m,
      state: cat.state,
      access: cat.access,
      said: c.said,
      rulesState: c.rulesState,
      hasRules: !!r && (r.requiredHashtags.length > 0 || r.lengthMaxSec !== null),
      logoNeeded: c.logo.needed,
      logoReady: c.logo.state === "ready",
      anyway: c.anyway,
      stops,
      ownVideosOnly: !!r?.allowedSources.campaignProvidedOnly && !!cat.sourceVideos?.length,
      connection: conn,
      canSayIn,
    });
    const subs = subsFor({ campaignId: c.campaignId });
    const clipCounts = {
      approved: subs.filter((s) => s.state === "approved").length,
      waiting: subs.filter((s) => s.state === "sent" || s.state === "sending" || s.state === "sent_by_hand").length,
      notApproved: subs.filter((s) => s.state === "rejected").length,
    };
    return {
      campaignId: c.campaignId,
      url: crUrl(c.campaignId),
      name: cat.name,
      brand: cat.brand,
      access: cat.access,
      type: cat.type,
      state: cat.state,
      membership: m,
      ...(m === "in" ? { inSince: c.addedAt } : {}),
      ...(c.waitingSince ? { waitingSince: c.waitingSince } : {}),
      ...(c.said ? { said: c.said } : {}),
      pay: structuredClone(cat.pay),
      budget: structuredClone(cat.budget),
      platformsPaid: [...cat.platformsPaid],
      uploadPlaces,
      rulesState: c.rulesState,
      rules: r,
      plainRules: plainRulesOf(r, cat.platformsPaid, cat.brand, c.logo.needed),
      thingsYouDo: thingsYouDoOf(r),
      uncertain: r?.uncertain ?? [],
      logo: { ...c.logo },
      sourceVideos: cat.sourceVideos ?? [],
      channels: cat.channels ?? [],
      stops,
      anyway: [...c.anyway],
      nextStep,
      clipCounts,
      waitingClips: clipCounts.waiting,
      ...(c.celebrate && !c.celebrated && m === "in" ? { celebrate: "in" as const } : {}),
      checkedAt: c.checkedAt,
      addedAt: c.addedAt,
      sourceRuleText: sourceRuleText(cat.name, cat.brand, r),
      languageRuleText: r?.language?.trim() ? `${cat.name} wants clips in ${languageWords(r.language)}.` : null,
    };
  }

  function summary(c: Stored): CampaignSummary {
    const full = serve(c);
    return {
      campaignId: full.campaignId,
      name: full.name,
      brand: full.brand,
      state: full.state,
      membership: full.membership,
      uploadPlaces: full.uploadPlaces,
      waitingClips: full.waitingClips,
      clipCounts: full.clipCounts,
      ...(full.celebrate ? { celebrate: full.celebrate } : {}),
      checkedAt: full.checkedAt,
      chip: full.nextStep.chip,
      nextStepText: full.nextStep.text,
      hardStops: full.stops.filter((s) => s.hard).length,
      nextStepKind: full.nextStep.kind,
    };
  }

  /** The submissions of the seeded and uploaded campaign posts, made fresh from the store. */
  function subsFor(q: { clipId?: string; campaignId?: string }): CrSubmission[] {
    const out: CrSubmission[] = [];
    for (const s of state.subs) {
      const [hook, platform] = s.key.split("|") as [string, Platform];
      const clip = store.clips.find((c) => c.hook === hook && store.posts.some((p) => p.clipId === c.clipId && p.platform === platform));
      if (!clip) continue;
      const post = store.posts.find((p) => p.clipId === clip.clipId && p.platform === platform);
      if (!post) continue;
      if (q.clipId && clip.clipId !== q.clipId) continue;
      if (q.campaignId && s.campaignId !== q.campaignId) continue;
      if (s.walking) walk(s, post);
      const cat = catalogFor(s.campaignId);
      const postedAt = post.postedAt ?? iso(s.at);
      const sendBy = s.sendBy ?? Date.parse(postedAt) + 30 * MIN;
      const minutesLeft = Math.max(0, Math.ceil((sendBy - now()) / MIN));
      const stateNow: CrSubState = s.state === "send_by_hand" && minutesLeft <= 0 ? "missed" : s.state;
      const base: CrSubmission = {
        postId: post.postId,
        clipId: clip.clipId,
        clipTitle: clip.captions.youtubeTitle || clip.hook,
        campaignId: s.campaignId,
        campaignName: cat.name,
        platform,
        ...(post.url ? { url: post.url } : {}),
        postedAt,
        state: stateNow,
        line: "",
        ...(stateNow === "send_by_hand" ? { minutesLeft, sendBy: iso(sendBy) } : {}),
        ...(s.reason ? { reason: s.reason } : {}),
        ...(s.flagged ? { flagged: true } : {}),
        ...(post.paidLabel ? { paidLabel: post.paidLabel } : {}),
        views: s.views ?? null,
        ...(s.views != null ? { viewsAt: iso(now() - 30 * MIN) } : {}),
        earned: s.earned ?? null,
        ...(stateNow === "rejected"
          ? {
              appeal: {
                href: CR_SUBMISSIONS,
                words: `This clip follows the brief: #Ad is at the start of the caption, 'Paid partnership' shows for the first 3 seconds, and it has ${(cat.rules?.requiredHashtags ?? []).join(" and ") || "the campaign's tags"}.`,
                ...(s.appealedAt ? { askedAt: s.appealedAt } : {}),
              },
            }
          : {}),
        ...(s.proofDue
          ? {
              proof: {
                text: "To do: send the brand a screen recording of this clip's views.",
                steps: ["1 Open this clip's views.", "2 Record your screen while they show.", "3 Open the campaign. Tap **Support**. Send it to the brand there."],
                dueAt: iso(s.at + 48 * 3_600_000),
                due: true,
                open: PROOF_OPEN[platform],
                ...(s.proofDoneAt ? { doneAt: s.proofDoneAt } : {}),
              },
            }
          : {}),
        openCampaignHref: crUrl(s.campaignId),
        ...(stateNow === "sent" || stateNow === "approved" || stateNow === "rejected" ? { sentAt: iso(s.at) } : {}),
        updatedAt: iso(s.at),
      };
      base.line = subLineFor(base);
      out.push(base);
    }
    return out.sort((a, b) => (b.postedAt ?? "").localeCompare(a.postedAt ?? ""));
  }

  /** A fresh mock upload walks sending → sent → approved on the clock (§38.18). */
  function walk(s: SubState, post: Post) {
    // The walk starts when the post is live (as cf-prod-clip-flow sends it then): the first read that sees it posted
    // says "Sending…", then 1.5 s later "Sent ✓", then 6 s after it went "Approved ✓".
    if (post.status !== "posted" || s.state === "waiting_for_post") {
      const first = post.status === "posted";
      s.state = first ? "sending" : "waiting_for_post";
      s.at = now();
      save(state);
      return;
    }
    const age = now() - s.at;
    const next: CrSubState = age < 1500 ? "sending" : age < 6000 ? "sent" : "approved";
    if (next !== s.state) {
      s.state = next;
      if (next === "approved") {
        s.walking = false;
        s.views = 1_240;
      }
      save(state);
    }
  }

  function overview(): CrOverview {
    const campaigns = [...state.campaigns].sort((a, b) => b.addedAt.localeCompare(a.addedAt)).map(summary);
    const all = subsFor({});
    return {
      connection: structuredClone(state.connection),
      campaigns,
      money: structuredClone(state.money),
      waitingSends: all.filter((s) => s.state === "send_by_hand" && (s.minutesLeft ?? 0) > 0),
    };
  }

  function addCampaign(uuid: string): { c: Stored; created: boolean } {
    const had = state.campaigns.find((c) => c.campaignId === uuid);
    if (had) {
      had.checkedAt = iso(now());
      return { c: had, created: false };
    }
    const cat = catalogFor(uuid);
    const c = stored(uuid, { addedAt: iso(now()), checkedAt: iso(now()), waitingSince: iso(now()), rulesState: cat.access === "application" && cat.rules ? "ready" : "waiting_for_join" });
    state.campaigns.push(c);
    changed(`campaign:${uuid}`);
    return { c, created: true };
  }

  function subByPost(postId: string): SubState {
    const post = store.posts.find((p) => p.postId === postId);
    if (!post) throw new ApiError(404, "not_found", "That clip is gone.");
    const key = keyOf(post);
    let s = state.subs.find((x) => x.key === key);
    if (!s) {
      s = { key, campaignId: post.campaignId ?? CR_IDS.money, state: "sent", at: now() };
      state.subs.push(s);
    }
    return s;
  }

  function oneSub(postId: string): CrSubmission {
    const post = store.posts.find((p) => p.postId === postId);
    const sub = subsFor({ clipId: post?.clipId }).find((x) => x.postId === postId);
    if (!sub) throw new ApiError(404, "not_found", "That clip is gone.");
    return sub;
  }

  // Test knobs (§38.18): window.__cfMock.cr.
  const controls = {
    setResult(code: CrConnectResult | null) {
      state.nextResult = code;
      save(state);
    },
    connect(canSubmit = true) {
      state.connection = connectedConnection(now(), canSubmit);
      if (state.money.state === "not_connected") state.money = { ...noMoney("none_yet"), asOf: iso(now()) };
      changed();
    },
    join(uuid: string) {
      const c = state.campaigns.find((x) => x.campaignId === uuid);
      if (!c) return;
      c.listed = true;
      c.wasListed = true;
      if (!c.celebrated) c.celebrate = true;
      changed(`campaign:${uuid}`);
    },
    sayYes(uuid: string) {
      controls.join(uuid);
    },
    leave(uuid: string) {
      const c = state.campaigns.find((x) => x.campaignId === uuid);
      if (!c) return;
      c.listed = false;
      changed(`campaign:${uuid}`);
    },
    hold(uuid: string, on = true) {
      const c = state.campaigns.find((x) => x.campaignId === uuid);
      if (c) c.held = on;
      changed(`campaign:${uuid}`);
    },
    sendFails(postId: string, code: "not_sent_by_app" | "not_visible_yet" | "no_connection" = "no_connection") {
      const s = subByPost(postId);
      s.sendBy = now() + 12 * MIN;
      s.state = "send_by_hand";
      s.walking = false;
      s.reason = { code, text: "" };
      changed(`submission:${postId}`);
    },
    approve(postId: string) {
      const s = subByPost(postId);
      s.state = "approved";
      s.walking = false;
      s.views = 12_300;
      changed(`submission:${postId}`);
    },
    reject(postId: string, text?: string) {
      const s = subByPost(postId);
      s.state = "rejected";
      s.walking = false;
      s.reason = { code: "refused", text: "", ...(text ? { brandSaid: text } : {}) };
      changed(`submission:${postId}`);
    },
    flag(postId: string) {
      const s = subByPost(postId);
      s.state = "sent";
      s.flagged = true;
      changed(`submission:${postId}`);
    },
    pay(cents: number) {
      const today = dayOf(now());
      state.paidByDay = { ...(state.paidByDay ?? {}), [today]: (state.paidByDay?.[today] ?? 0) + cents };
      const m = state.money;
      const first = !m.paidSoFarCents;
      state.money = {
        ...m,
        state: "ok",
        paidSoFarCents: (m.paidSoFarCents ?? 0) + cents,
        readyToMoveCents: (m.readyToMoveCents ?? 0) + cents,
        lastPaidAt: iso(now()),
        lastPaidCents: cents,
        asOf: iso(now()),
        celebrations: [
          ...m.celebrations,
          first
            ? { key: `first-${now()}`, kind: "first_money", text: "Your first money from Content Rewards!" }
            : { key: `paid-${now()}`, kind: "money_arrived", text: `Money from Content Rewards! ${usd(cents)} is in your balance.` },
        ],
      };
      changed("money");
    },
    moveToWhop() {
      const m = state.money;
      state.lastMoveCents = m.readyToMoveCents ?? 0;
      state.money = { ...m, onItsWayCents: m.readyToMoveCents ?? 0, readyToMoveCents: 0 };
      changed("money");
    },
    moneyArrivedOnWhop() {
      // As the API (contentrewards/money.py): a move that finishes is kept as movedAt, for every device.
      const moved = (state.money.onItsWayCents ?? 0) > 0;
      state.money = { ...state.money, onItsWayCents: 0, ...(moved ? { movedAt: iso(now()) } : {}) };
      changed("money");
    },
    proofDue(postId: string) {
      const s = subByPost(postId);
      s.proofDue = true;
      changed(`submission:${postId}`);
    },
    setReadOnly(on: boolean) {
      state.connection = connectedConnection(now(), !on);
      changed();
    },
    expireSoon() {
      const at = now();
      state.connection = {
        ...state.connection,
        reason: "expires_soon",
        signInBy: iso(at + 5 * DAY),
        warnFrom: iso(at - 2 * DAY),
      };
      changed();
    },
    signOut() {
      state.connection = { ...state.connection, status: "needs_reconnect", reason: "token_dead", canSubmit: false };
      changed();
    },
    /** Connect said the account can't connect apps (the pilot email waits, §38.3). */
    refuse() {
      state.connection = { ...state.connection, status: "not_connected", canSubmit: false, lastResult: "not_allowed" };
      changed();
    },
    /** Content Rewards refused a place as not linked (crLinked false, §38.11). */
    unlink(platform: Platform) {
      state.connection = { ...state.connection, crLinked: { ...state.connection.crLinked, [platform]: false } };
      changed();
    },
    /** The brand changed the rules: a read starts without any news yet (it says so when it ends, like the API).
     * `ms` is how long the read takes (longer in a test, so a slow machine still sees "Reading the rules…"). */
    rulesChanged(uuid: string, ms?: number) {
      const c = state.campaigns.find((x) => x.campaignId === uuid);
      if (!c) return;
      startReading(c, ms);
      save(state);
    },
    readFails(uuid: string) {
      const c = state.campaigns.find((x) => x.campaignId === uuid);
      if (c) c.rulesState = "failed";
      changed(`campaign:${uuid}`);
    },
    /** Changes a campaign's rules in place (tests: a length, a language, a deadline, a source rule). */
    setRules(uuid: string, patch: Partial<CampaignRules>) {
      const cat = CATALOG[uuid];
      if (!cat?.rules) return;
      cat.rules = { ...cat.rules, ...patch };
      changed(`campaign:${uuid}`);
    },
    reset(start: "full" | "fresh" = "full") {
      state = start === "fresh" ? seedFresh() : seedFull();
      changed();
    },
    ids: CR_IDS,
  };
  if (typeof window !== "undefined") {
    const w = window as unknown as { __cfMock?: Record<string, unknown> };
    w.__cfMock = { ...(w.__cfMock ?? {}), cr: controls };
  }

  const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
  let lastCheck = 0;

  function onPosts(clip: Clip, posts: Post[]) {
    const campaignId = clip.campaignId;
    if (!campaignId) return;
    for (const p of posts) {
      p.campaignId = campaignId;
      const key = keyOf(p);
      state.subs = state.subs.filter((s) => s.key !== key);
      state.subs.push({ key, campaignId, state: "waiting_for_post", at: now(), walking: true });
    }
    save(state);
  }

  async function jobCheck(campaignId: string, anyway: readonly StopCode[]) {
    guard();
    const c = state.campaigns.find((x) => x.campaignId === campaignId);
    if (!c) throw notFound();
    const full = serve(c);
    if (full.rulesState === "reading") throw new ApiError(409, "conflict", stopText("rules_reading"), undefined, 30);
    const hard = full.stops.find((x) => x.hard);
    if (hard) throw conflict(hard.text);
    const soft = full.stops.find((x) => !x.hard && x.code !== "not_connected" && !full.anyway.includes(x.code) && !anyway.includes(x.code));
    if (soft) throw conflict(soft.text);
  }

  async function confirmCheck(clip: Clip, chosen: Platform[] | undefined, options: ClipPostOptions | undefined, tiktok: TikTokPostOptions | undefined) {
    if (!clip.campaignId) return;
    const c = state.campaigns.find((x) => x.campaignId === clip.campaignId);
    if (!c) throw conflict("Add the campaign again on the Campaigns page.");
    const full = serve(c);
    if (!chosen?.length) throw bad("Pick where it goes, then tap Upload.");
    const off = chosen.find((p) => !full.uploadPlaces.includes(p));
    if (off) throw bad(`This campaign doesn't pay for ${PLATFORM_LABEL[off]}. Turn it off, then tap Upload.`);
    if (full.membership !== "in" && full.membership !== "manual") throw conflict(full.nextStep.text);
    const stop = full.stops.find((x) => x.hard && (x.code === "held" || x.code === "paused" || x.code === "ended"));
    if (stop) throw conflict(stop.text);
    if (chosen.includes("youtube") && options?.youtube && options.youtube.privacy !== "public") throw bad("Campaign clips must be public. Pick Everyone.");
    if (options?.youtube?.madeForKids) throw bad("Campaign clips are never made for kids.");
    if (chosen.includes("tiktok")) {
      if (tiktok?.privacyLevel !== "PUBLIC_TO_EVERYONE") throw bad("Campaign clips must be public. Pick Everyone.");
      if (!tiktok.brandContent) throw bad("Turn on Branded content on TikTok for campaign clips.");
    }
  }

  const api: CrMockApi = {
    async crOverview() {
      await wait();
      guard();
      if (readFlag("cf-mock-cr-overview") === "500") throw new ApiError(500, "internal", "Something went wrong on our side. Try again in a moment.");
      return overview();
    },
    async crConnect(port) {
      await wait();
      guard();
      if (![47811, 47812, 47813, 47814, 47815].includes(port)) throw bad("Pick a port Clip Factory knows.");
      return { authorizeUrl: `/mock-cr-consent?state=mock-${now()}`, expiresAt: iso(now() + 5 * MIN) };
    },
    async crConnectFinish(body) {
      await wait();
      guard();
      let result: CrConnectResult;
      if ("error" in body) result = body.error === "access_denied" ? "denied" : /connect apps|pilot|not allowed/i.test(body.errorDescription ?? "") ? "not_allowed" : "error";
      else result = state.nextResult ?? "connected";
      state.nextResult = null;
      if (result === "connected" || result === "read_only") {
        state.connection = connectedConnection(now(), result === "connected");
        state.connection.connectedAt = iso(now());
        state.connection.signInBy = iso(now() + 90 * DAY);
        state.connection.warnFrom = iso(now() + 83 * DAY);
        state.connection.crLinked = {};
        if (state.money.state === "not_connected") state.money = { ...noMoney("none_yet"), asOf: iso(now()) };
      } else {
        state.connection = { ...state.connection, lastResult: result };
      }
      state.connection.lastResult = result;
      changed();
      return { result, connection: structuredClone(state.connection) };
    },
    async crCheck() {
      await wait();
      guard();
      const c = state.connection;
      const code = c.blocked ? "blocked" : c.status === "needs_reconnect" ? "token_dead" : c.status === "read_only" ? "read_only" : c.status === "connected" ? "ok" : "not_connected";
      const messages = {
        ok: "Content Rewards answers. You're signed in.",
        read_only: "You're signed in. Content Rewards hasn't let Clip Factory send clips yet.",
        token_dead: "Content Rewards signed you out. Tap Connect again.",
        blocked: "Content Rewards stopped Clip Factory for now. You send clips yourself until it's fixed.",
        not_connected: "Content Rewards isn't connected. Tap Connect Content Rewards.",
      } as const;
      const check = { at: iso(now()), ok: code === "ok" || code === "read_only", code, message: messages[code] } as const;
      if (now() - lastCheck > 60_000) lastCheck = now();
      state.connection = { ...c, check: { ...check } };
      save(state);
      return { check: { ...check }, connection: structuredClone(state.connection) };
    },
    async crPatchConnection(body) {
      await wait();
      guard();
      const c = state.connection;
      if ("step" in body) {
        if (!/^[a-z0-9-]{1,40}$/.test(body.step)) throw bad("That step is not in the guide.");
        const set = new Set(c.stepsDone);
        if (body.done) set.add(body.step);
        else set.delete(body.step);
        c.stepsDone = [...set];
        // "I did this" on ready-socials makes every refused place unknown again (§38.11).
        if (body.step === "ready-socials" && body.done) for (const p of PLATFORM_ORDER) if (c.crLinked[p] === false) delete c.crLinked[p];
      } else if ("relinked" in body) {
        delete c.crLinked[body.relinked];
      } else if ("finance" in body) {
        if (body.finance === null) delete c.finance;
        else c.finance = body.finance;
      } else if ("said" in body) {
        if (body.said === "cant_connect") {
          // He says Content Rewards refused at sign-in (it never sends the browser back): like a not_allowed Connect,
          // and it proves he has an account (step 1).
          c.lastResult = "not_allowed";
          c.stepsDone = [...new Set([...c.stepsDone, "ready-account"])];
        } else if (body.said === null) delete c.pilotSentAt;
        else c.pilotSentAt = iso(now());
      }
      changed();
      return structuredClone(c);
    },
    async crDisconnect() {
      await wait();
      guard();
      state.connection = { ...blankConnection(), stepsDone: state.connection.stepsDone };
      changed();
    },
    async crCampaigns() {
      await wait();
      guard();
      return overview().campaigns;
    },
    async crAddCampaign(url) {
      await wait(200);
      guard();
      const link = campaignLink(url);
      if (link.kind === "refused") throw bad(link.message.replace(/\*\*/g, ""));
      if (link.kind === "none") throw bad("That isn't a Content Rewards campaign link. Open the campaign, then copy its link.");
      if (link.group || link.uuid === CR_IDS.group) {
        const choices: GroupChoice[] = [CR_IDS.season1, CR_IDS.season2].map((id) => {
          const cat = catalogFor(id);
          return { campaignId: id, url: crUrl(id), name: cat.name, brand: cat.brand, access: cat.access, pay: id === CR_IDS.season1 ? structuredClone(cat.pay) : null };
        });
        return { group: { name: "Arena Cup", choices } };
      }
      const { c } = addCampaign(link.uuid);
      return { campaign: serve(c) };
    },
    async crCampaign(campaignId) {
      await wait();
      guard();
      return serve(find(campaignId));
    },
    async crReadCampaign(campaignId, pastedRules) {
      await wait(160);
      guard();
      const c = find(campaignId);
      c.checkedAt = iso(now());
      if (pastedRules !== undefined) {
        if (pastedRules.length > 8000) throw bad("That's too much text. Copy only the Brief and Content requirements.");
        c.pastedRules = pastedRules;
        startReading(c);
      } else if (c.rulesState === "failed") {
        startReading(c);
      }
      changed(`campaign:${campaignId}`);
      return serve(c);
    },
    async crPatchCampaign(campaignId, body) {
      await wait();
      guard();
      const c = find(campaignId);
      if (body.said !== undefined) {
        if (body.said === null) delete c.said;
        else c.said = body.said;
        if (body.said === "applied") c.waitingSince = iso(now());
      }
      if (body.anyway) {
        if (body.anyway.some((x) => !SOFT_STOPS.includes(x) || x === "not_connected")) throw bad("Only soft stops can be skipped.");
        // As the API: the list replaces the one before (the web sends every soft stop he accepted).
        c.anyway = [...new Set(body.anyway)].sort();
      }
      changed(`campaign:${campaignId}`);
      return serve(c);
    },
    async crLogoUpload(campaignId, body) {
      await wait();
      guard();
      find(campaignId);
      if (!["image/png", "image/jpeg", "image/webp"].includes(body.contentType)) throw bad("Clip Factory needs a PNG, JPG or WebP picture. Save the logo as PNG and try again.");
      if (body.size > 10 * 1024 * 1024) throw new ApiError(413, "too_large", "That picture is too big. Use one under 10 MB.");
      return { key: `campaigns/mock-owner/${campaignId}/logo-1.png`, uploadUrl: "mock://upload", headers: { "Content-Type": body.contentType } };
    },
    async crLogoDone(campaignId) {
      await wait();
      guard();
      const c = find(campaignId);
      c.logo = { ...c.logo, state: "ready", url: LOGO_ART };
      changed(`campaign:${campaignId}`);
      return serve(c);
    },
    async crLogoLink(campaignId, url) {
      await wait();
      guard();
      const c = find(campaignId);
      let u: URL;
      try {
        u = new URL(url.trim());
      } catch {
        throw bad("Paste a Google Drive or Dropbox link, or drop the file.");
      }
      const host = u.hostname.replace(/^www\./, "");
      const error = /\/drive\/folders\/|\/sh\/|\/scl\/fo\//.test(u.pathname)
        ? "That's a folder. Open the logo file in it, then copy that link."
        : !["drive.google.com", "docs.google.com", "dropbox.com", "dl.dropboxusercontent.com", "drive.usercontent.google.com"].includes(host)
          ? "Paste a Google Drive or Dropbox link, or drop the file."
          : /private/.test(u.pathname)
            ? host.includes("dropbox")
              ? "That file isn't shared. In Dropbox tap Share, then Copy link."
              : "That file isn't shared. In Google Drive tap Share, then Anyone with the link, then paste it again."
            : null;
      if (error && error.startsWith("Paste")) throw bad(error);
      c.logo = error ? { ...c.logo, state: "failed", error } : { ...c.logo, state: "ready", url: LOGO_ART };
      changed(`campaign:${campaignId}`);
      return serve(c);
    },
    async crDeleteLogo(campaignId) {
      await wait();
      guard();
      const c = find(campaignId);
      c.logo = { needed: c.logo.needed, state: "none" };
      changed(`campaign:${campaignId}`);
      return serve(c);
    },
    async crRemoveCampaign(campaignId) {
      await wait();
      guard();
      state.campaigns = state.campaigns.filter((c) => c.campaignId !== campaignId);
      changed(`campaign:${campaignId}`);
    },
    async crSubmissions(q) {
      await wait();
      guard();
      // As the API: only ?clipId= or ?campaignId= (§38.8).
      if (!q.clipId && !q.campaignId) throw bad("Send clipId or campaignId.");
      return subsFor(q);
    },
    async crCheckSubmissions(clipId) {
      await wait(120);
      guard();
      return subsFor({ clipId });
    },
    async crSendSubmission(postId) {
      await wait(200);
      guard();
      const sub = oneSub(postId);
      if (sub.state !== "send_by_hand") throw conflict("Too late for this one.");
      const s = subByPost(postId);
      if (!signedIn(state.connection) || !state.connection.canSubmit) return sub;
      s.state = "sent";
      s.at = now();
      changed(`submission:${postId}`);
      return oneSub(postId);
    },
    async crPatchSubmission(postId, said) {
      await wait();
      guard();
      const s = subByPost(postId);
      if (said === "sent_by_hand") {
        if (s.state !== "send_by_hand" && s.state !== "missed") throw conflict("That clip isn't waiting to be sent.");
        s.state = "sent_by_hand";
      } else if (said === "appealed") {
        if (s.state !== "rejected") throw conflict("Only a clip that was not approved can be asked again.");
        s.appealedAt = iso(now());
      } else if (said === "proof_sent") {
        if (!s.proofDue) throw conflict("No proof is due for this clip.");
        s.proofDoneAt = iso(now());
      } else if (said === null) {
        if (s.state === "sent_by_hand") s.state = "send_by_hand";
        delete s.appealedAt;
        delete s.proofDoneAt;
      }
      changed(`submission:${postId}`);
      return oneSub(postId);
    },
    async crMoney() {
      await wait();
      guard();
      return structuredClone(state.money);
    },
    async crRefreshMoney() {
      await wait();
      guard();
      return { started: true, nextAllowedAt: iso(now() + 10 * MIN) };
    },
    async crSeen(key) {
      await wait(30);
      guard();
      state.seen.push(key);
      if (key.startsWith("in:")) {
        const c = state.campaigns.find((x) => `in:${x.campaignId}` === key);
        if (c) {
          c.celebrate = false;
          c.celebrated = true;
        }
      }
      state.money = { ...state.money, celebrations: state.money.celebrations.filter((x) => x.key !== key) };
      changed(key.startsWith("in:") ? `campaign:${key.slice(3)}` : "money");
    },
  };

  function moneyItems() {
    const on = off !== "404" && off !== "503";
    const m = state.money;
    const connected = signedIn(state.connection) || state.connection.status === "needs_reconnect";
    const crmoney: Record<string, unknown> | null = !connected
      ? null
      : m.state === "error"
        ? { error: "cr_down" }
        : m.state === "checking"
          ? { firstReadDone: false, ...(m.asOf ? { asOf: m.asOf } : {}) }
          : {
              firstReadDone: true,
              paidByDayDone: true,
              paidTotalCents: m.paidSoFarCents ?? 0,
              stillEarningCents: m.stillEarningCents ?? 0,
              readyToMoveCents: m.readyToMoveCents ?? 0,
              onItsWayCents: m.onItsWayCents ?? 0,
              ...(m.asOf ? { asOf: m.asOf } : {}),
              ...(m.lastPaidAt ? { lastPaidAt: m.lastPaidAt } : {}),
              paidByDay: { ...(state.paidByDay ?? {}) },
            };
    return { crconn: structuredClone(state.connection), crmoney, on };
  }

  return {
    api,
    onPosts,
    jobCheck,
    confirmCheck,
    served: () => state.campaigns.map(serve),
    connection: () => structuredClone(state.connection),
    moneyItems,
    guard,
  };
}

/** The campaign's source rule as one line under Home's link box (§39.1), as the API's campaigns.py says it. */
function sourceRuleText(name: string, brand: string, r: CampaignRules | null): string | null {
  if (!r) return null;
  const a = r.allowedSources;
  const sites = (["youtube", "twitch", "kick"] as const).filter((s) => a[s]);
  const labels = sites.map((s) => PLATFORM_LABEL[s]);
  const owner = brand.endsWith("s") ? `${brand}'` : `${brand}'s`;
  const join = (l: string[]) => (l.length > 1 ? `${l.slice(0, -1).join(", ")} and ${l.at(-1)}` : (l[0] ?? ""));
  if (a.campaignProvidedOnly) return `${name} pays only for clips of its own videos. Pick one below.`;
  if (a.channels.some((c) => c.name)) return `${name} pays only for clips of ${owner} ${labels.length && labels.length < 3 ? join(labels) : "channels"}.`;
  if (labels.length && labels.length < 3) return `${name} pays only for clips of ${join(labels)} videos.`;
  return null;
}

const LANGUAGE_NAMES: [string, string][] = [
  ["en", "English"],
  ["es", "Spanish"],
  ["pt", "Portuguese"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["hi", "Hindi"],
  ["ar", "Arabic"],
  ["tr", "Turkish"],
  ["ru", "Russian"],
];
/** The languages the fit knows in the rule text ("English or Spanish"), else the brief's own words. */
function languageWords(text: string): string {
  const words = new Set(text.toLowerCase().split(/[^a-z]+/).filter(Boolean));
  const found = LANGUAGE_NAMES.filter(([code, n]) => words.has(code) || words.has(n.toLowerCase())).map(([, n]) => n);
  if (!found.length) return text.trim();
  return found.length > 1 ? `${found.slice(0, -1).join(", ")} or ${found.at(-1)}` : found[0]!;
}

function bestRate(cat: Catalog): number | null {
  const rates = cat.pay.map((p) => p.per1kCents).filter((x): x is number => x !== null);
  return rates.length ? rates.reduce((a, b) => (b > a ? b : a)) : null;
}

/** A small logo picture for the "Logo added" tile (no outside image, CSP unchanged). */
const LOGO_ART =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="64" viewBox="0 0 160 64"><rect width="160" height="64" rx="14" fill="#1f3b2d"/><text x="80" y="41" text-anchor="middle" font-family="Inter, sans-serif" font-size="26" font-weight="800" fill="#f4efe6">LOGO</text></svg>`,
  );
