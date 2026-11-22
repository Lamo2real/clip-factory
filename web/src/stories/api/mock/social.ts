// Lamo Stories mock: the social part (docs/CONTRACTS.md §45.13, §45.16.8). The seed has an account in every
// connection state (connected, choose_account with Lamo Clips' own Page among the choices, needs_reconnect,
// same_as_clips, not_connected) and one with the Meta check's warning, next to Lamo Clips' own destinations (names
// only). Connect lands straight back on Lamo Stories › Social accounts with a result, as the real callback does.
// Each platform's developer app is the owner's choice (§45.30): Lamo Stories' own keys (always for Facebook and
// Instagram, one Meta app) or Clip Factory's on purpose (YouTube, TikTok, X); never a silent default.
// §45.37 G8 (the owner's hard rule): an account is never shared with Clip Factory. It is Clip Factory's own when any
// stable identity matches Clip Factory's account there (YouTube the channel id, Facebook the Page id, Instagram the
// user id or username, TikTok the username or handle, X the user id or handle), at connect and before every post, also
// when Clip Factory connects it later (then same_as_clips with reason clips_now). There is no share route. Every
// same_as_clips account carries the API's warning (public_of): the at-connect sentence, or the "now" one.
import { ApiError } from "../../../api/errors.ts";
import type { KeyName } from "../../../api/types.ts";
import { cleanKey, extractConfigId, keyNames, keyProblem } from "../../../lib/keyFormats.ts";
import { SHARED_APP_PLATFORMS, STORIES_PLATFORMS, type KeyCheck, type Platform, type SocialAccount, type StoriesApi, type TikTokCreator } from "../types.ts";
import { ago, DAY, delay, HOUR, type MockStore } from "./store.ts";
import { storiesWorkspace } from "./workspace.ts";

export const KEYS = ["social", "connectSocial", "chooseSocial", "checkSocial", "tiktokCreatorInfo", "disconnectSocial", "setSocialApp", "checkSocialApp", "deleteSocialApp"] as const;

export const PLATFORM_NAME: Record<Platform, string> = { youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram", facebook: "Facebook", x: "X" };

/**
 * §45.13.5 in plain words: what each platform allows for a second account, with Clip Factory's app shared. Clip
 * Factory's posts always go first (§45.37 G6): Lamo Stories uses only what is left of the app's quotas.
 */
export const LIMITS: Record<Platform, string[]> = {
  youtube: [
    "One Google sign-in can hold several channels.",
    "Lamo Stories posts to the one channel you pick in Google's list. To use a different one, tap Pick another channel.",
    "Both channels share Clip Factory's daily uploads, about 6 a day in all. Clip Factory's come first: Lamo Stories uses what is left, and a post waits for the next day when none are left.",
  ],
  instagram: [
    "It needs its own professional account (Business or Creator), linked to a Facebook Page.",
    "Facebook asks which Pages the app may use for your whole Facebook login. If you untick Lamo Clips' Page there, Lamo Clips loses it.",
    "Lamo Stories checks Lamo Clips afterwards and tells you if something went wrong.",
  ],
  facebook: [
    "It needs its own Facebook Page, run by the same Facebook login.",
    "When Facebook asks which Pages, keep Lamo Clips' Page ticked too.",
  ],
  tiktok: [
    "While TikTok is still checking the app, only test accounts added in TikTok's Sandbox can connect.",
    "Until TikTok says yes, the account must be private and posts are seen by you only.",
    "When TikTok says yes, Lamo Stories asks you to connect again.",
    "Clip Factory's posts come first: Lamo Stories uses what is left of the app's daily posts.",
  ],
  x: [
    "It needs its own X account. X connects the account that is signed in on x.com.",
    "Posts use Clip Factory's X app. Clip Factory's posts come first: Lamo Stories uses what is left of the month's credits.",
    // The API's lines (social._LIMITS["x"], shared_room.X_OVER_LIMIT, §45.37 G6).
    "Stories uses only what Clip Factory's share of your monthly X limit leaves.",
    "Clip Factory does not count Stories' X posts, so if Clip Factory posts much more than planned, the month can go over your X limit by what Stories spent.",
  ],
};

/** The same rules with Lamo Stories' own developer app (§45.30): quotas, credits and reviews are its own. */
export const LIMITS_OWN: Record<Platform, string[]> = {
  youtube: [
    "One Google sign-in can hold several channels.",
    "Lamo Stories posts to the one channel you pick in Google's list. To use a different one, tap Pick another channel.",
    "Your own Google project has its own daily uploads: about 6 a day.",
  ],
  instagram: [
    "It needs its own professional account (Business or Creator), linked to a Facebook Page.",
    "Lamo Stories uses its own Meta app, so Lamo Clips' Meta connection is never touched.",
    "While the Meta app is in Development mode, only you (its admin) can connect. Going Live needs Meta's App Review.",
  ],
  facebook: [
    "It needs its own Facebook Page, run by the same Facebook login.",
    "Lamo Stories uses its own Meta app, so Lamo Clips' Pages stay as they are. Tick only the Lamo Stories Page.",
  ],
  tiktok: [
    "A new TikTok app starts in Sandbox: only test accounts added there can connect, and they must be private.",
    "TikTok checks a new app before posts can be public. That can take days to weeks.",
  ],
  x: [
    "It needs its own X account. X connects the account that is signed in on x.com.",
    "Your own X app has its own credits and its own monthly limit (Lamo Stories › Settings).",
  ],
};

/** Lamo Clips' own accounts in the Lamo Clips mock (web/src/api/mock/setup.ts), by name only. */
const CLIPS_NAMES: Record<Platform, string> = {
  youtube: "Clip Factory Gaming",
  tiktok: "Clip Factory",
  instagram: "clipfactory.gg",
  facebook: "Clip Factory Clips",
  x: "Clip Factory",
};

export const CLIPS_IDS: Record<Platform, string> = {
  youtube: "UCclipfactorygaming00000",
  tiktok: "-000clipfactory-open-id",
  instagram: "17841400000000002",
  facebook: "102030405060708",
  x: "1500000000000000001",
};

/** Clip Factory's own handles there (its ACCOUNT# items' username or handle; YouTube and Facebook compare ids only). */
export const CLIPS_HANDLES: Partial<Record<Platform, string>> = { tiktok: "@clipfactory", instagram: "clipfactory.gg", x: "@clipfactorygg" };

/**
 * Clip Factory's identity on a platform: the mock's own, or the one a test says Clip Factory connected later
 * (`store.knobs.clipsIdentity[platform] = { id?, handle? }`).
 */
function clipsIdentity(platform: Platform, store?: MockStore): { id: string | null; handle: string | null } {
  const later = (store?.knobs.clipsIdentity as Partial<Record<Platform, { id?: string; handle?: string }>> | undefined)?.[platform];
  return later ? { id: later.id ?? null, handle: later.handle ?? null } : { id: CLIPS_IDS[platform], handle: CLIPS_HANDLES[platform] ?? null };
}

const plainHandle = (h: string | null | undefined) => (h ?? "").trim().replace(/^@/, "").toLowerCase();

/**
 * Any stable identity matches Clip Factory's account on that platform (§45.37 G8 (b)): the channel, Page or user id,
 * or, where the platform has one, the username or handle (TikTok gives each app its own open_id, so there the handle
 * is what both sides have).
 */
export function matchesClips(platform: Platform, who: { externalAccountId?: string | null; handle?: string | null; accountName?: string | null }, store?: MockStore): boolean {
  const clips = clipsIdentity(platform, store);
  if (who.externalAccountId && clips.id && who.externalAccountId === clips.id) return true;
  if (platform === "youtube" || platform === "facebook") return false;
  const theirs = plainHandle(clips.handle);
  if (!theirs) return false;
  return plainHandle(who.handle) === theirs || (platform === "instagram" && plainHandle(who.accountName) === theirs);
}

/**
 * Clip Factory's own account on this platform (§45.34, §45.35 D11, §45.37 G8): a stored same_as_clips, or a stored
 * "connected" whose account Clip Factory connected later. Never shared: a stored sharedWithClips is ignored.
 */
export function sameAsClips(a: Pick<SocialAccount, "platform" | "connectionStatus" | "externalAccountId" | "handle" | "accountName">, store?: MockStore): boolean {
  if (a.connectionStatus === "same_as_clips") return true;
  return a.connectionStatus === "connected" && matchesClips(a.platform, a, store);
}

/** The API's same_as_clips sentences (social.SAME_AT_CONNECT and SAME_LATER), word for word. */
export const SAME_AT_CONNECT = "This is Clip Factory's own account. Clip Factory Stories needs its own separate account: sign in with a different one.";
export const SAME_LATER = "This is Clip Factory's account now. Connect a different account made for Clip Factory Stories.";

/**
 * The account as Social accounts shows it (the API's public_of): one Clip Factory connected later reads same_as_clips
 * with reason clips_now, blocked from posting; one no longer Clip Factory's is connected again. A same_as_clips
 * account carries the API's warning (SAME_LATER for clips_now, else SAME_AT_CONNECT); no other account keeps one.
 */
function settled(a: SocialAccount, store: MockStore): SocialAccount {
  const { sharedWithClips: _gone, ...plain } = a;
  let out: SocialAccount = plain;
  if (plain.connectionStatus === "connected" && sameAsClips(plain, store)) out = { ...plain, connectionStatus: "same_as_clips", reason: "clips_now" };
  else if (plain.connectionStatus === "same_as_clips" && plain.reason === "clips_now" && !matchesClips(plain.platform, plain, store)) out = { ...plain, connectionStatus: "connected", reason: null };
  const sameWarning = out.warning === SAME_AT_CONNECT || out.warning === SAME_LATER;
  if (out.connectionStatus === "same_as_clips") return { ...out, warning: out.reason === "clips_now" ? SAME_LATER : SAME_AT_CONNECT };
  return sameWarning ? { ...out, warning: null } : out;
}

/** What a connect in the pretend app finds for each platform: the Lamo Stories account the owner picked. */
const STORIES_IDENTITY: Record<Platform, { id: string; name: string; handle: string }> = {
  youtube: { id: "UC7stories0lamo00000000a", name: "Lamo Stories", handle: "@lamostories" },
  tiktok: { id: "-000lamostories-open-id", name: "Lamo Stories", handle: "@lamo.stories" },
  instagram: { id: "17841400000000001", name: "lamo.stories", handle: "@lamo.stories" },
  facebook: { id: "109876543210987", name: "Lamo Stories", handle: "Lamo Stories" },
  x: { id: "1600000000000000002", name: "Lamo Stories", handle: "@lamostories" },
};

/** A little round face as a pretend profile picture (`_name` only tells the seeds apart when reading them). */
function avatar(_name: string, bg: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="${bg}"/><circle cx="24" cy="28" r="4" fill="#FFF6E5"/><circle cx="40" cy="28" r="4" fill="#FFF6E5"/><path d="M22 40c6 6 14 6 20 0" stroke="#FFF6E5" stroke-width="4" fill="none" stroke-linecap="round"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** No developer app picked yet (Facebook and Instagram can only ever pick Lamo Stories' own). */
const NO_APP: SocialAccount["app"] = { choice: null, saved: false };

/** The masked hints of §17.4: clientId first 6 + "…" + last 4, secrets "••••" + last 4, configId last 4. */
export function hintsOf(keys: Partial<Record<KeyName, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  if (keys.clientId) out.clientId = keys.clientId.length > 10 ? `${keys.clientId.slice(0, 6)}…${keys.clientId.slice(-4)}` : `…${keys.clientId.slice(-4)}`;
  if (keys.clientSecret) out.clientSecret = `••••${keys.clientSecret.slice(-4)}`;
  if (keys.configId) out.configId = `…${keys.configId.slice(-4)}`;
  return out;
}

function base(ws: string, platform: Platform, app: SocialAccount["app"] = NO_APP): SocialAccount {
  return {
    socialAccountId: `${ws}.${platform}`,
    workspaceId: ws,
    platform,
    app: structuredClone(app),
    lastCheckedAt: null,
    connectionStatus: "not_connected",
    externalAccountId: null,
    accountName: null,
    handle: null,
    avatarUrl: null,
    connectedAt: null,
    missing: [],
    reason: null,
    reconnectBy: null,
    choices: null,
    limits: limitsFor(platform, app.choice),
    warning: null,
  };
}

/** The `limits` sentences follow the app chosen (§45.30). */
export function limitsFor(platform: Platform, choice: SocialAccount["app"]["choice"]): string[] {
  return choice === "own" ? LIMITS_OWN[platform] : LIMITS[platform];
}

function connectedAs(a: SocialAccount, who: { id: string; name: string; handle: string }, bg = "#62C6FF"): SocialAccount {
  return {
    ...a,
    connectionStatus: "connected",
    externalAccountId: who.id,
    accountName: who.name,
    handle: who.handle,
    avatarUrl: avatar(who.name, bg),
    connectedAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
    reason: null,
    reconnectBy: null,
    choices: null,
    missing: [],
  };
}

/** The API's warning while an account is needs_reconnect because the chosen app's keys changed. */
export const keysChangedSentence = (p: Platform) => `The ${PLATFORM_NAME[p]} app keys changed. Connect again.`;

const META_WARNING = (p: Platform) => `Lamo Clips may have lost ${PLATFORM_NAME[p]}. Connect it again in Lamo Clips, keeping its Page ticked.`;

/** A Meta app's keys as the seed saved them (the same app for Instagram and Facebook). */
const SEED_META = { clientId: "1234567890123456", clientSecret: "0123456789abcdef0123456789abcdef", configId: "9876543210987654" };
/** Clip Factory's app on purpose (§45.30): no keys of Lamo Stories' own. */
const CLIPS_APP: SocialAccount["app"] = { choice: "clips", saved: true };
const META_APP: SocialAccount["app"] = { choice: "own", saved: true, hints: hintsOf(SEED_META) };

export function seed(store: MockStore): void {
  const ws = "stories";
  // A brand-new studio (the first time, §45.29): nothing connected, no developer app picked.
  if (store.knobs.fresh) {
    store.social = STORIES_PLATFORMS.map((p) => base(ws, p));
    store.clips = STORIES_PLATFORMS.map((p) => ({ platform: p, connected: true, name: CLIPS_NAMES[p] }));
    return;
  }
  const yt = connectedAs(base(ws, "youtube", CLIPS_APP), STORIES_IDENTITY.youtube, "#FF6F61");
  yt.connectedAt = ago(6 * DAY);
  yt.lastCheckedAt = ago(5 * HOUR);
  const tiktok: SocialAccount = {
    ...base(ws, "tiktok", CLIPS_APP),
    connectionStatus: "needs_reconnect",
    externalAccountId: STORIES_IDENTITY.tiktok.id,
    accountName: STORIES_IDENTITY.tiktok.name,
    handle: STORIES_IDENTITY.tiktok.handle,
    avatarUrl: avatar("TikTok", "#47D6A0"),
    connectedAt: ago(12 * DAY),
    lastCheckedAt: ago(2 * DAY),
    // A code, as the API sends it (§45.6; the web says it in words), and the API's own warning for that code.
    reason: "keys_changed",
    warning: keysChangedSentence("tiktok"),
  };
  const instagram: SocialAccount = {
    ...base(ws, "instagram", META_APP),
    connectionStatus: "choose_account",
    choices: [
      { id: STORIES_IDENTITY.instagram.id, name: "lamo.stories", avatarUrl: avatar("lamo.stories", "#62C6FF"), usedByClips: false },
      { id: CLIPS_IDS.instagram, name: CLIPS_NAMES.instagram, avatarUrl: avatar("clipfactory.gg", "#0F372B"), usedByClips: true },
    ],
    warning: META_WARNING("instagram"),
  };
  // Facebook: the same own Meta app as Instagram (its keys entered once), not connected yet.
  const facebook = base(ws, "facebook", META_APP);
  const x: SocialAccount = {
    ...base(ws, "x", CLIPS_APP),
    connectionStatus: "same_as_clips",
    externalAccountId: CLIPS_IDS.x,
    accountName: CLIPS_NAMES.x,
    handle: CLIPS_HANDLES.x!,
    avatarUrl: avatar("Clip Factory", "#0F372B"),
    connectedAt: ago(3 * HOUR),
  };
  store.social = [yt, tiktok, instagram, facebook, x];
  store.clips = STORIES_PLATFORMS.map((p) => ({ platform: p, connected: true, name: CLIPS_NAMES[p] }));
}

/** The platforms one developer app serves: the own Meta app is Instagram's and Facebook's, as the API's app_platforms. */
export function appPlatforms(platform: Platform): Platform[] {
  return platform === "instagram" || platform === "facebook" ? ["instagram", "facebook"] : [platform];
}

function account(store: MockStore, ws: string, platform: string): SocialAccount {
  storiesWorkspace(store, ws);
  if (!(STORIES_PLATFORMS as string[]).includes(platform)) throw new ApiError(404, "not_found", "We could not find that app.");
  let a = store.social.find((s) => s.workspaceId === ws && s.platform === platform);
  if (!a) {
    a = base(ws, platform as Platform);
    store.social.push(a);
  }
  return a;
}

function replace(store: MockStore, next: SocialAccount): SocialAccount {
  store.social = store.social.map((s) => (s.socialAccountId === next.socialAccountId ? next : s));
  return structuredClone(next);
}

/** Where the pretend platform sends the owner back: Lamo Stories › Social accounts, like the real callback (§45.13.3). */
const landing = (platform: Platform, result: string, ws: string) =>
  `/stories/connections?platform=${platform}&result=${encodeURIComponent(result)}&ws=${encodeURIComponent(ws)}`;

export function api(store: MockStore): Pick<StoriesApi, (typeof KEYS)[number]> {
  return {
    async social(ws) {
      await delay(160);
      storiesWorkspace(store, ws);
      // Settled as the API's public_of does: Lamo Clips connecting the same account later shows here (§45.35 D11).
      const accounts = STORIES_PLATFORMS.map((p) => replace(store, settled(account(store, ws, p), store)));
      return { accounts: structuredClone(accounts), clips: structuredClone(store.clips) };
    },
    async connectSocial(ws, platform) {
      // Knob `connectMs`: a slow answer (a test switches away while it is on its way).
      await delay(typeof store.knobs.connectMs === "number" ? store.knobs.connectMs : 220);
      const a = account(store, ws, platform);
      // One helper picks the keys (§45.30): no choice asks, own keys must be saved, Clip Factory's must exist.
      if (a.app.choice === null) throw new ApiError(409, "conflict", `Pick which ${PLATFORM_NAME[platform]} app Lamo Stories uses first.`);
      if (a.app.choice === "own" && !a.app.saved) throw new ApiError(409, "conflict", `Paste your Lamo Stories ${PLATFORM_NAME[platform]} app keys first.`);
      if (a.app.choice === "clips" && store.knobs.noAppKeys === platform)
        throw new ApiError(
          409,
          "conflict",
          `Lamo Clips has no ${PLATFORM_NAME[platform]} app keys yet. Set up ${PLATFORM_NAME[platform]} in Lamo Clips first (Settings › Posting › Set up posting, up to the keys step).`,
        );
      // A test can pick what the pretend platform answers; otherwise each platform does what it does for real.
      const forced = typeof store.knobs.connectResult === "string" ? (store.knobs.connectResult as string) : null;
      const who = STORIES_IDENTITY[platform];
      // The same-account check at connect (§45.37 G8): the account signed in with is Clip Factory's by any identity.
      const theirs = matchesClips(platform, { externalAccountId: who.id, handle: who.handle, accountName: who.name }, store);
      const result = forced ?? (platform === "instagram" || platform === "facebook" ? "choose" : theirs ? "same_as_clips_signed_in" : "connected");
      if (result === "connected") replace(store, connectedAs(a, who));
      else if (result === "same_as_clips_signed_in") replace(store, { ...connectedAs(a, who), connectionStatus: "same_as_clips" });
      else if (result === "choose")
        replace(store, {
          ...a,
          connectionStatus: "choose_account",
          externalAccountId: null,
          accountName: null,
          handle: null,
          avatarUrl: null,
          choices: [
            { id: STORIES_IDENTITY[platform].id, name: STORIES_IDENTITY[platform].name, avatarUrl: avatar(STORIES_IDENTITY[platform].name, "#62C6FF"), usedByClips: false },
            { id: CLIPS_IDS[platform], name: CLIPS_NAMES[platform], avatarUrl: avatar(CLIPS_NAMES[platform], "#0F372B"), usedByClips: true },
          ],
          warning: null,
        });
      else if (result === "same_as_clips")
        // Signed in with Clip Factory's own account: refused at connect (§45.37 G8), kept only so the card says why.
        replace(store, {
          ...connectedAs(a, { id: CLIPS_IDS[platform], name: CLIPS_NAMES[platform], handle: CLIPS_HANDLES[platform] ?? CLIPS_NAMES[platform] }, "#0F372B"),
          connectionStatus: "same_as_clips",
        });
      else if (result === "clips_meta_check") replace(store, { ...connectedAs(a, STORIES_IDENTITY[platform]), warning: META_WARNING(platform) });
      return { authorizeUrl: landing(platform, result === "same_as_clips_signed_in" ? "same_as_clips" : result, ws), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
    },
    async chooseSocial(ws, platform, choiceId) {
      await delay(200);
      if (platform !== "instagram" && platform !== "facebook") throw new ApiError(400, "bad_request", "Only Instagram and Facebook have a list to pick from.");
      const a = account(store, ws, platform);
      const choice = a.choices?.find((c) => c.id === choiceId);
      if (!choice) throw new ApiError(409, "conflict", "That list is old. Tap Connect again.");
      // Clip Factory's own is never connected for posting (§45.37 G8): it stays same_as_clips, and the card says why.
      const clipsOwn = choice.usedByClips || matchesClips(platform, { externalAccountId: choice.id, handle: choice.name, accountName: choice.name }, store);
      const next = connectedAs(a, { id: choice.id, name: choice.name, handle: choice.name }, clipsOwn ? "#0F372B" : "#62C6FF");
      return replace(store, { ...next, connectionStatus: clipsOwn ? "same_as_clips" : "connected", warning: a.warning });
    },
    async checkSocial(ws, platform) {
      await delay(400);
      const a = account(store, ws, platform);
      if (a.connectionStatus === "not_connected") throw new ApiError(409, "conflict", `Lamo Stories' ${PLATFORM_NAME[platform]} is not connected. Tap Connect first.`);
      // A live profile call: a dead token turns the account to needs_reconnect (a test knob plays that).
      if (store.knobs.tokenDead === platform) return replace(store, { ...a, connectionStatus: "needs_reconnect", reason: "token_dead", lastCheckedAt: new Date().toISOString() });
      // Check it settles the account as the page does: Clip Factory connecting it later blocks it (§45.37 G8).
      return replace(store, { ...settled(a, store), lastCheckedAt: new Date().toISOString() });
    },
    async tiktokCreatorInfo(ws) {
      await delay(200);
      const a = account(store, ws, "tiktok");
      if (a.connectionStatus !== "connected") throw new ApiError(409, "conflict", "Lamo Stories' TikTok is not connected. Connect it in Lamo Stories › Social accounts.");
      const creator: TikTokCreator = {
        nickname: a.accountName ?? "Lamo Stories",
        username: (a.handle ?? "@lamo.stories").replace(/^@/, ""),
        avatarUrl: a.avatarUrl,
        privacyOptions: ["SELF_ONLY"],
        commentDisabled: false,
        duetDisabled: false,
        stitchDisabled: false,
        maxDurationSec: 600,
      };
      return creator;
    },
    async disconnectSocial(ws, platform) {
      await delay(220);
      const a = account(store, ws, platform);
      // Only this workspace's token goes: no platform revoke call, ever (§45.13.6). The app choice stays.
      replace(store, base(ws, a.platform, a.app));
    },
    async setSocialApp(ws: string, platform: Platform, body: { choice: "clips" } | { choice: "own"; clientId: string; clientSecret: string; configId?: string }) {
      await delay(300);
      const a = account(store, ws, platform);
      const name = PLATFORM_NAME[platform];
      if (body.choice === "clips") {
        if (!SHARED_APP_PLATFORMS.includes(platform))
          throw new ApiError(400, "bad_request", `${name} always uses Lamo Stories' own Meta app, so Lamo Clips' Meta connection is never touched.`);
        const changed = a.app.choice !== "clips";
        const next = changed ? base(ws, platform, CLIPS_APP) : a;
        return replace(store, { ...next, app: CLIPS_APP, limits: limitsFor(platform, "clips") });
      }
      const keys: Partial<Record<KeyName, string>> = { clientId: cleanKey(body.clientId ?? ""), clientSecret: cleanKey(body.clientSecret ?? "") };
      if (platform === "instagram" || platform === "facebook") keys.configId = extractConfigId(body.configId ?? "");
      for (const k of keyNames(platform)) {
        if (!keys[k]) throw new ApiError(400, "bad_request", "Fill in every box.", k);
        const problem = keyProblem(platform, k, keys[k]!);
        if (problem) throw new ApiError(400, "bad_request", problem, k);
      }
      const hints = hintsOf(keys);
      // One own Meta app serves Instagram and Facebook (entered once): its keys are saved for both, and each one
      // whose app changed (another client id, or Clip Factory's app or none before) is disconnected first (§45.30).
      for (const each of appPlatforms(platform)) {
        const b = each === platform ? a : account(store, ws, each);
        const changed = b.app.choice !== "own" || !b.app.saved || b.app.hints?.clientId !== hints.clientId;
        const app = { choice: "own" as const, saved: true, hints };
        const next = changed ? base(ws, each, app) : { ...b, app };
        replace(store, { ...next, app, limits: limitsFor(each, "own") });
      }
      return structuredClone(account(store, ws, platform));
    },
    async checkSocialApp(ws, platform) {
      await delay(500);
      const a = account(store, ws, platform);
      const name = PLATFORM_NAME[platform];
      if (a.app.choice !== "own" || !a.app.saved) throw new ApiError(409, "conflict", `Paste your Lamo Stories ${name} app keys first.`);
      const wrong = store.knobs.keysWrong === platform;
      const check: KeyCheck = wrong
        ? { at: new Date().toISOString(), ok: false, code: "keys_wrong", message: `${name} said these keys are wrong. Copy them again from your ${name} app.` }
        : a.connectionStatus === "not_connected"
          ? { at: new Date().toISOString(), ok: true, code: "not_connected", message: `Your keys work. Now press Connect ${name}.` }
          : { at: new Date().toISOString(), ok: true, code: "ok", message: "Your keys work." };
      replace(store, { ...a, app: { ...a.app, check } });
      return check;
    },
    async deleteSocialApp(ws, platform) {
      await delay(220);
      const a = account(store, ws, platform);
      if (a.app.choice !== "own") throw new ApiError(409, "conflict", "Lamo Stories has no keys of its own here.");
      // Disconnects first; only Lamo Stories' own keys go (Clip Factory's are never touched). The own Meta app is one
      // app: its keys go for Instagram and Facebook together.
      for (const each of appPlatforms(platform)) {
        const b = account(store, ws, each);
        if (b.app.choice === "own") replace(store, base(ws, each));
      }
    },
  };
}
