// Mock mode's posting setup (docs/CONTRACTS.md §17.10): the five setups, keys, Check it, the TikTok verification
// file, Connect with a pretend consent page (/mock-oauth/{platform}), Choose, Disconnect and TikTok creator info.
// State lives in sessionStorage (`cf-mock-setup`), so a reload, or the trip to the pretend consent page and back,
// resumes where the owner was. Only bundled into mock builds.
import { ApiError } from "../errors.ts";
import type {
  Account,
  ConnectResult,
  Gate,
  KeyCheck,
  Platform,
  PlatformSetup,
  ReviewState,
  SetupKeys,
  SetupOverview,
  SetupValues,
  TikTokCreator,
} from "../types.ts";
import { keyNames, keyProblem, KEY_LABEL, maskKey, normaliseKey } from "../../lib/keyFormats.ts";
import { computeReady } from "../../lib/setupProgress.ts";
import { allSteps, GUIDES, SETUP_ORDER } from "../../setup/index.ts";

const KEY = "cf-mock-setup";
const APP_URL = "https://dexample.cloudfront.net";
const HOOKS_URL = "https://hexample.execute-api.eu-north-1.amazonaws.com/v1";

export const MOCK_VALUES: SetupValues = {
  appName: "Clip Factory",
  websiteUrl: `${APP_URL}/about.html`,
  websitePrefix: `${APP_URL}/`,
  privacyUrl: `${APP_URL}/legal/privacy.html`,
  termsUrl: `${APP_URL}/legal/terms.html`,
  dataDeletionUrl: `${APP_URL}/legal/privacy.html#delete`,
  appDomain: "dexample.cloudfront.net",
  hooksDomain: "hexample.execute-api.eu-north-1.amazonaws.com",
  redirectUris: Object.fromEntries(SETUP_ORDER.map((p) => [p, `${HOOKS_URL}/oauth/${p}/callback`])) as Record<Platform, string>,
  scopes: {
    youtube: [
      "https://www.googleapis.com/auth/youtube.readonly",
      "https://www.googleapis.com/auth/yt-analytics.readonly",
      "https://www.googleapis.com/auth/youtube.upload",
    ],
    tiktok: ["user.info.basic", "video.publish", "video.list"],
    instagram: [
      "instagram_basic",
      "instagram_manage_insights",
      "instagram_content_publish",
      "pages_show_list",
      "pages_read_engagement",
    ],
    facebook: [
      "pages_show_list",
      "pages_read_engagement",
      "pages_manage_posts",
      "pages_manage_engagement",
      "read_insights",
      "business_management",
    ],
    x: ["tweet.read", "users.read", "tweet.write", "media.write", "offline.access"],
  },
  ownerEmail: "owner@example.com",
};

interface MockPlatform {
  stepsDone: string[];
  keys: { clientId: string; hints: Partial<Record<"clientId" | "clientSecret" | "configId", string>>; savedAt: string } | null;
  check?: KeyCheck;
  account: Account;
  reviewState: ReviewState;
  /** TikTok's posting audit passed (test knob). */
  audited: boolean;
  /** X ran out of credits (test knob). */
  creditsEmpty: boolean;
  files: string[];
  /** The state of the Connect that is under way. */
  pending?: string;
  /** Connected on the pretend consent page: the next start releases the posts waiting for it (§17.6). */
  justConnected?: boolean;
  updatedAt?: string;
}

type State = Record<Platform, MockPlatform>;

function fresh(): State {
  return Object.fromEntries(
    SETUP_ORDER.map((p) => [
      p,
      { stepsDone: [], keys: null, account: { platform: p, status: "not_connected" }, reviewState: "draft", audited: false, creditsEmpty: false, files: [] },
    ]),
  ) as unknown as State;
}

function load(): State {
  try {
    const raw = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(KEY);
    if (raw) return { ...fresh(), ...(JSON.parse(raw) as State) };
  } catch {
    /* a broken copy starts over */
  }
  return fresh();
}

function save(state: State) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* private mode: the state lives for this page only */
  }
}

const NAMES: Record<Platform, { handle: string; name: string }> = {
  youtube: { handle: "@clipfactorygaming", name: "Clip Factory Gaming" },
  tiktok: { handle: "@clipfactory.gg", name: "Clip Factory" },
  instagram: { handle: "@clipfactory.gg", name: "Clip Factory" },
  facebook: { handle: "Clip Factory Clips", name: "Clip Factory Clips" },
  x: { handle: "@clipfactorygg", name: "Clip Factory" },
};

const CHOICES: Partial<Record<Platform, { id: string; name: string }[]>> = {
  instagram: [
    { id: "17841400000000001", name: "@clipfactory.gg" },
    { id: "17841400000000002", name: "@clipfactory.backup" },
  ],
  facebook: [
    { id: "100000000000001", name: "Clip Factory Clips" },
    { id: "100000000000002", name: "Clip Factory Fans" },
  ],
};

/** A small round picture with the first letter, so no network is needed. */
export function avatar(name: string): string {
  const letter = (name.replace(/^@/, "")[0] ?? "C").toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2A5C4A"/><stop offset="1" stop-color="#0F372B"/></linearGradient></defs><rect width="96" height="96" fill="url(#g)"/><text x="48" y="62" font-family="Georgia,serif" font-style="italic" font-size="46" text-anchor="middle" fill="#EFE7DA">${letter}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function gatesOf(p: Platform, s: MockPlatform): Gate[] {
  const connected = s.account.status === "connected";
  switch (p) {
    case "youtube":
      return [{ key: "published_app", state: s.stepsDone.includes("key-publish") ? "ok" : "action" }];
    case "tiktok": {
      const review = s.reviewState === "live" ? "ok" : s.reviewState === "in_review" ? "waiting" : "limited";
      return [
        { key: "app_review", state: review },
        { key: "posting_audit", state: !connected ? "unknown" : s.audited ? "ok" : "limited" },
      ];
    }
    case "instagram":
    case "facebook":
      return [{ key: "app_live", state: s.stepsDone.includes("public-live") ? "ok" : "limited" }];
    case "x":
      return [{ key: "credits", state: s.creditsEmpty ? "action" : "ok" }];
    default:
      return [];
  }
}

function publicSetup(p: Platform, s: MockPlatform): PlatformSetup {
  const gates = gatesOf(p, s);
  const account = structuredClone(s.account);
  return {
    platform: p,
    stepsDone: [...s.stepsDone],
    ready: computeReady({ account, gates }),
    keys: s.keys ? { saved: true, hints: { ...s.keys.hints }, savedAt: s.keys.savedAt, ...(s.check ? { check: { ...s.check } } : {}) } : { saved: false },
    account,
    gates,
    ...(p === "tiktok" ? { files: [...s.files] } : {}),
    ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}),
  };
}

const bad = (msg: string) => new ApiError(400, "bad_request", msg);
const conflict = (msg: string) => new ApiError(409, "conflict", msg);

function connectedAccount(p: Platform, name = NAMES[p].handle): Account {
  return { platform: p, status: "connected", handle: name, name: NAMES[p].name, avatarUrl: avatar(name), connectedAt: new Date().toISOString() };
}

export interface SetupDeps {
  /** Mirrors account states into the main mock store (the numbers pages read them). */
  onAccounts?: (accounts: Account[]) => void;
  publish?: (platform: Platform) => void;
  /** An account just became connected: the posts waiting for it go out, like the API's release (§17.6). */
  onConnected?: (platform: Platform) => void;
}

/** The setup half of the mock API. */
export function setupApi({ onAccounts, publish, onConnected }: SetupDeps = {}) {
  let state = load();
  // Each account's status as last seen, so only a change to connected releases waiting posts.
  const seen = new Map(SETUP_ORDER.map((p) => [p, state[p].account.status]));

  const changed = (p: Platform) => {
    state[p].updatedAt = new Date().toISOString();
    save(state);
    onAccounts?.(SETUP_ORDER.map((x) => structuredClone(state[x].account)));
    const status = state[p].account.status;
    if (status === "connected" && seen.get(p) !== "connected") onConnected?.(p);
    seen.set(p, status);
    publish?.(p);
    return publicSetup(p, state[p]);
  };
  onAccounts?.(SETUP_ORDER.map((x) => structuredClone(state[x].account)));
  // Connected on the pretend consent page (a full page load since): release now, as the real callback does.
  for (const p of SETUP_ORDER) {
    if (!state[p].justConnected) continue;
    delete state[p].justConnected;
    save(state);
    if (state[p].account.status === "connected") onConnected?.(p);
  }

  const knownPlatform = (p: string): Platform => {
    if (!(SETUP_ORDER as readonly string[]).includes(p)) throw new ApiError(404, "not_found", "That platform does not exist.");
    return p as Platform;
  };

  /** Ticks every step and connects (tests: get a platform to Ready in one go). */
  function finish(p: Platform) {
    const s = state[p];
    s.stepsDone = allSteps(GUIDES[p])
      .filter((st) => !st.auto)
      .map((st) => st.id);
    s.keys = { clientId: "mock-client", hints: { clientId: "mock-c…ient", clientSecret: "••••cret" }, savedAt: new Date().toISOString() };
    if (p === "tiktok") s.files = ["tiktokMockVerify123.txt"];
    s.account = connectedAccount(p);
    changed(p);
  }

  const controls = {
    expireToken(p: Platform) {
      state[p].account = { ...state[p].account, status: "needs_reconnect", reason: "token_dead" };
      changed(p);
    },
    reset() {
      state = fresh();
      save(state);
      for (const p of SETUP_ORDER) changed(p);
    },
    finish,
    setAudit(passed: boolean) {
      state.tiktok.audited = passed;
      // TikTok's posting audit can only be asked for once App review says Live (§17, step 24).
      if (passed) state.tiktok.reviewState = "live";
      changed("tiktok");
    },
    /** Meta answered with several accounts: the picker shows (tests). */
    askToChoose(p: Platform) {
      const list = CHOICES[p] ?? [{ id: "1", name: NAMES[p].handle }];
      state[p].account = { platform: p, status: "choose_account", choices: list.map((c) => ({ ...c, avatarUrl: avatar(c.name) })) };
      changed(p);
    },
    setCreditsEmpty(empty: boolean) {
      state.x.creditsEmpty = empty;
      changed("x");
    },
  };
  if (typeof window !== "undefined") {
    const w = window as unknown as { __cfMock?: Record<string, unknown> };
    w.__cfMock = { ...(w.__cfMock ?? {}), setup: controls };
  }

  return {
    controls,
    /** Platforms whose account is connected (Upload posts to these). */
    connected(): Platform[] {
      return SETUP_ORDER.filter((p) => state[p].account.status === "connected");
    },
    accounts(): Account[] {
      return SETUP_ORDER.map((p) => structuredClone(state[p].account));
    },
    overview(): SetupOverview {
      const platforms = SETUP_ORDER.map((p) => publicSetup(p, state[p]));
      return { platforms, ready: platforms.filter((x) => x.ready).length, values: structuredClone(MOCK_VALUES) };
    },
    get(platform: string): PlatformSetup {
      const p = knownPlatform(platform);
      return publicSetup(p, state[p]);
    },
    setStep(platform: string, step: string, done: boolean): PlatformSetup {
      const p = knownPlatform(platform);
      const known = allSteps(GUIDES[p]).find((s) => s.id === step);
      if (!known) throw bad("That step does not exist. Reload the page.");
      const s = state[p];
      s.stepsDone = done ? Array.from(new Set([...s.stepsDone, step])) : s.stepsDone.filter((x) => x !== step);
      return changed(p);
    },
    setReview(review: ReviewState): PlatformSetup {
      if (!["draft", "in_review", "live", "not_approved"].includes(review)) throw bad("Pick one of the four.");
      state.tiktok.reviewState = review;
      return changed("tiktok");
    },
    saveKeys(platform: string, body: SetupKeys): PlatformSetup {
      const p = knownPlatform(platform);
      const values: Record<string, string> = {};
      for (const name of keyNames(p)) {
        const v = normaliseKey(name, body[name] ?? "");
        if (!v) throw bad(`Paste the ${KEY_LABEL[p][name]} first.`);
        const problem = keyProblem(p, name, v);
        if (problem) throw bad(problem);
        values[name] = v;
      }
      const s = state[p];
      const changedKeys = !!s.keys && s.keys.clientId !== values.clientId;
      s.keys = {
        clientId: values.clientId!,
        hints: Object.fromEntries(keyNames(p).map((k) => [k, maskKey(k, values[k]!)])),
        savedAt: new Date().toISOString(),
      };
      delete s.check;
      if (changedKeys && s.account.status !== "not_connected") s.account = { platform: p, status: "not_connected", reason: "keys_changed" };
      return changed(p);
    },
    deleteKeys(platform: string) {
      const p = knownPlatform(platform);
      state[p].keys = null;
      delete state[p].check;
      state[p].account = { platform: p, status: "not_connected" };
      changed(p);
    },
    check(platform: string): { check: KeyCheck; setup: PlatformSetup } {
      const p = knownPlatform(platform);
      const s = state[p];
      const at = new Date().toISOString();
      let check: KeyCheck;
      if (!s.keys) check = { at, ok: false, code: "keys_wrong", message: `Paste your ${GUIDES[p].name} keys first.` };
      else if (s.keys.clientId.includes("bad"))
        check = { at, ok: false, code: "keys_wrong", message: "The keys do not work. Copy them again with the copy icons, then press Save keys." };
      else if (s.account.status === "needs_reconnect")
        check = { at, ok: false, code: "token_dead", message: "Your keys work, but the connection stopped. Press Connect again.", account: "dead" };
      else if (p === "x" && s.creditsEmpty)
        check = { at, ok: false, code: "credits_empty", message: "Your X credits ran out. Buy more in Billing › Credits." };
      else if (s.account.status === "connected")
        check = { at, ok: true, code: "ok", message: `Everything works. Clip Factory can post to ${GUIDES[p].name}.`, account: "ok" };
      // Same as the API (§17.4): keys that work with nothing connected are ok with code not_connected.
      else check = { at, ok: true, code: "not_connected", message: `Your keys work. Now press Connect ${GUIDES[p].name}.`, account: "none" };
      s.check = check;
      return { check, setup: changed(p) };
    },
    uploadFile(filename: string, content: string): PlatformSetup {
      if (!/^tiktok[A-Za-z0-9_-]{4,64}\.txt$/.test(filename))
        throw bad("That is not TikTok's file. Its name starts with tiktok and ends with .txt.");
      if (content.length > 4096 || !/^[\x20-\x7E\r\n\t]*$/.test(content)) throw bad("That file is not TikTok's. Download it again from TikTok.");
      const s = state.tiktok;
      if (!s.files.includes(filename)) s.files.push(filename);
      return changed("tiktok");
    },
    deleteFile(filename: string) {
      state.tiktok.files = state.tiktok.files.filter((f) => f !== filename);
      changed("tiktok");
    },
    connect(platform: string): { authorizeUrl: string; expiresAt: string } {
      const p = knownPlatform(platform);
      const s = state[p];
      if (!s.keys) throw conflict(`Paste your ${GUIDES[p].name} keys first.`);
      s.pending = `v1.${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      save(state);
      return { authorizeUrl: `/mock-oauth/${p}?state=${encodeURIComponent(s.pending)}`, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
    },
    choose(platform: string, accountId: string): PlatformSetup {
      const p = knownPlatform(platform);
      const s = state[p];
      const pick = s.account.choices?.find((c) => c.id === accountId);
      if (s.account.status !== "choose_account" || !pick) throw conflict(`That choice has run out. Press Connect ${GUIDES[p].name} again.`);
      s.account = connectedAccount(p, pick.name);
      return changed(p);
    },
    disconnect(platform: string) {
      const p = knownPlatform(platform);
      state[p].account = { platform: p, status: "not_connected" };
      delete state[p].check;
      changed(p);
    },
    creator(): TikTokCreator {
      const s = state.tiktok;
      if (s.account.status !== "connected") throw conflict("Connect TikTok first in Settings › Posting › Set up posting.");
      return {
        nickname: NAMES.tiktok.name,
        username: NAMES.tiktok.handle.replace(/^@/, ""),
        avatarUrl: s.account.avatarUrl,
        privacyOptions: s.audited ? ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"] : ["SELF_ONLY"],
        commentDisabled: false,
        duetDisabled: false,
        stitchDisabled: true,
        maxDurationSec: 600,
      };
    },
  };
}

/**
 * The pretend consent page's answer: where the platform would send the owner back to. Allow connects (Meta asks
 * which account first), Cancel is `denied`, and a state that does not match the Connect under way is `expired`.
 */
export function mockAuthorize(platform: Platform, stateParam: string | null, allow: boolean): string {
  const state = load();
  const s = state[platform];
  let result: ConnectResult;
  if (!allow) result = "denied";
  else if (!s.pending || s.pending !== stateParam) result = "expired";
  else if (CHOICES[platform]) {
    s.account = {
      platform,
      status: "choose_account",
      choices: CHOICES[platform]!.map((c) => ({ ...c, avatarUrl: avatar(c.name) })),
    };
    result = "choose";
  } else {
    s.account = connectedAccount(platform);
    s.justConnected = true;
    result = "connected";
  }
  delete s.pending;
  s.updatedAt = new Date().toISOString();
  save(state);
  return `/settings/posting/setup/${platform}?result=${result}`;
}
