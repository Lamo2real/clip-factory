// The Follow creators routes of docs/CONTRACTS.md §24.1 in memory, with the same rules as the API: a link or a name
// (a name alone asks which site), the permission answer before following, Twitch and Kick found by name before the
// keys, masked key hints, and live badges pushed as { type: "follow" } events. Nothing here makes clips (part 2).
import { ApiError } from "../errors.ts";
import type {
  Api,
  Follow,
  FollowCreator,
  FollowKeyCheck,
  FollowKeyPlatform,
  FollowKeys,
  FollowKeySlot,
  FollowLive,
  FollowPlatform,
  FollowsView,
  LiveEvent,
} from "../types.ts";

export type FollowsApi = Pick<
  Api,
  "listFollows" | "lookupFollow" | "follow" | "setFollowAuto" | "unfollow" | "saveFollowKeys" | "deleteFollowKeys" | "checkFollowKeys"
>;

/** Test knobs, reachable as window.__cfMock.follows. */
export interface MockFollowControls {
  /** Follows the three demo creators (a live Twitch streamer, a Kick streamer waiting for keys, a YouTube channel). */
  seed(): void;
  /** Flips a followed creator live or offline and pushes it, like a webhook would. */
  setLive(followId: string, live: boolean, viewers?: number): void;
  /** A live stream ends: offline, and "Stream ended" is noticed (no clips are made in this part). */
  endStream(followId: string): void;
  /** A new long video was uploaded: "New video" is noticed. */
  newVideo(followId: string): void;
}

const bad = (msg: string, field?: string) => new ApiError(400, "bad_request", msg, field);
const notFound = (msg: string) => new ApiError(404, "not_found", msg);
const NOT_FOUND = "We could not find that streamer. Check the name or paste their link.";
const NOT_A_LINK = "That is not a YouTube, Twitch or Kick link. Paste the streamer's page, or type their name.";

const TWITCH = /^[A-Za-z0-9_]{4,25}$/;
const KICK = /^[A-Za-z0-9_-]{1,25}$/;
const HANDLE = /^@[\w.-]{3,30}$/;
const CHANNEL = /^UC[\w-]{22}$/;
const VIDEO = /^[\w-]{11}$/;
const HOSTS: Record<string, FollowPlatform> = {
  "youtube.com": "youtube",
  "www.youtube.com": "youtube",
  "m.youtube.com": "youtube",
  "youtu.be": "youtube",
  "twitch.tv": "twitch",
  "www.twitch.tv": "twitch",
  "m.twitch.tv": "twitch",
  "kick.com": "kick",
  "www.kick.com": "kick",
};

interface Known {
  name: string;
  handle: string;
  platformId: string;
  live?: FollowLive;
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

/** The creators the mock "platforms" know. Anything else is "not found" (when the keys are there). */
const DIRECTORY: Record<FollowPlatform, Record<string, Known>> = {
  twitch: {
    speedyspeedruns: { name: "SpeedySpeedruns", handle: "speedyspeedruns", platformId: "speedyspeedruns", live: { isLive: true, title: "Any% world record tries", viewers: 1200, startedAt: minutesAgo(95) } },
    cozycrafts: { name: "CozyCrafts", handle: "cozycrafts", platformId: "cozycrafts", live: { isLive: false } },
    pixelpanda: { name: "PixelPanda", handle: "pixelpanda", platformId: "pixelpanda", live: { isLive: false } },
  },
  kick: {
    nightowlplays: { name: "NightOwlPlays", handle: "nightowlplays", platformId: "nightowlplays", live: { isLive: true, title: "Late night chill", viewers: 430 } },
    racecarrick: { name: "RaceCarRick", handle: "racecarrick", platformId: "racecarrick", live: { isLive: false } },
  },
  youtube: {
    "@clipcitygames": { name: "Clip City Games", handle: "@ClipCityGames", platformId: "UCclipcitygames000000000" },
    "@lunalegoworld": { name: "Luna's Lego World", handle: "@LunaLegoWorld", platformId: "UClunalegoworld000000000" },
  },
};

interface Parsed {
  platform: FollowPlatform | "";
  value: string;
}

/** Same rules as api/.../follow/parse.py: exact hosts, no user info or port, ids that match their pattern. */
export function parseFollow(text: string, platform?: FollowPlatform): Parsed {
  const value = text.trim();
  if (!value) throw bad("Paste a link or type a name.", "text");
  if (value.length > 300) throw bad("That is too long. Paste just the streamer's link.", "text");
  const lower = value.toLowerCase();
  const looksLikeLink = lower.includes("://") || value.includes("/") || Object.keys(HOSTS).some((h) => lower.startsWith(h));
  if (looksLikeLink) {
    let url: URL;
    try {
      url = new URL(value.includes("://") ? value : `https://${value}`);
    } catch {
      throw bad(NOT_A_LINK, "text");
    }
    const site = HOSTS[url.hostname.toLowerCase()];
    if (!site || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) throw bad(NOT_A_LINK, "text");
    const parts = url.pathname.split("/").filter(Boolean);
    if (site === "youtube") {
      if (url.hostname === "youtu.be" && parts[0] && VIDEO.test(parts[0])) return { platform: "youtube", value: "@clipcitygames" };
      const v = url.searchParams.get("v");
      if (parts[0] === "watch" && v && VIDEO.test(v)) return { platform: "youtube", value: "@clipcitygames" };
      if (parts[0] === "channel" && parts[1] && CHANNEL.test(parts[1])) {
        const found = Object.entries(DIRECTORY.youtube).find(([, k]) => k.platformId === parts[1]);
        return { platform: "youtube", value: found ? found[0] : parts[1] };
      }
      if (parts[0]?.startsWith("@") && HANDLE.test(parts[0])) return { platform: "youtube", value: parts[0].toLowerCase() };
      throw bad("Paste the channel's page, the one with @ in its link, or a video of theirs.", "text");
    }
    const name = parts[0] ?? "";
    if (!name || ["videos", "directory", "categories", "browse", "search"].includes(name.toLowerCase())) {
      throw bad(`Paste the streamer's ${site === "twitch" ? "Twitch" : "Kick"} page, like ${site === "twitch" ? "twitch.tv" : "kick.com"}/name.`, "text");
    }
    if (!(site === "twitch" ? TWITCH : KICK).test(name)) throw bad("That name has letters we cannot use. Check it and try again.", "text");
    return { platform: site, value: name.toLowerCase() };
  }
  const bare = value.startsWith("@") ? value.slice(1) : value;
  if (!platform) {
    if (!(TWITCH.test(bare) || KICK.test(bare) || HANDLE.test(`@${bare}`))) throw bad("That name has letters we cannot use. Check it and try again.", "text");
    return { platform: "", value: bare };
  }
  if (platform === "youtube") {
    if (!HANDLE.test(`@${bare}`)) throw bad("That name has letters we cannot use. Check it and try again.", "text");
    return { platform, value: `@${bare.toLowerCase()}` };
  }
  if (!(platform === "twitch" ? TWITCH : KICK).test(bare)) {
    throw bad(platform === "twitch" ? "A Twitch name is 4 to 25 letters, numbers or _." : "A Kick name is letters, numbers, - or _.", "text");
  }
  return { platform, value: bare.toLowerCase() };
}

const channelUrl = (p: FollowPlatform, id: string, handle: string) =>
  p === "youtube" ? `https://www.youtube.com/${handle || `channel/${id}`}` : p === "twitch" ? `https://www.twitch.tv/${id}` : `https://kick.com/${id}`;

const hint = (name: string, v: string) => (name === "clientId" ? `${v.slice(0, 6)}…${v.slice(-4)}` : `••••${v.slice(-4)}`);

const FORMATS: Record<FollowKeyPlatform, Record<string, [RegExp, string]>> = {
  twitch: {
    clientId: [/^[a-z0-9]{20,40}$/, "The Twitch Client ID is about 30 small letters and numbers. Copy it again."],
    clientSecret: [/^[a-z0-9]{20,40}$/, "The Twitch Client Secret is about 30 small letters and numbers. Press New Secret, then copy it."],
  },
  kick: {
    clientId: [/^[A-Za-z0-9_-]{8,128}$/, "The Kick Client ID is a long line of letters and numbers. Copy it again."],
    clientSecret: [/^[A-Za-z0-9_-]{16,256}$/, "The Kick Client Secret is a long line of letters and numbers. Copy it again."],
  },
  "youtube-read": {
    apiKey: [/^AIza[0-9A-Za-z_-]{35}$/, "A YouTube key starts with AIza and is 39 letters long. Copy it again."],
  },
};
const LABEL: Record<FollowKeyPlatform, string> = { twitch: "Twitch", kick: "Kick", "youtube-read": "YouTube" };

export function followsApi(publish: (ev: LiveEvent) => void, delay: () => Promise<void>): { api: FollowsApi; controls: MockFollowControls } {
  const follows: Follow[] = [];
  // Twitch keys are already pasted in the demo; Kick waits for a grown-up; the YouTube read key is optional.
  const keys: Record<FollowKeyPlatform, { saved: boolean; hints?: Record<string, string>; savedAt?: string; check?: FollowKeyCheck }> = {
    twitch: { saved: true, hints: { clientId: "abcdef…0123", clientSecret: "••••9876" }, savedAt: minutesAgo(60 * 24 * 3) },
    kick: { saved: false },
    "youtube-read": { saved: false },
  };
  const clone = <T>(v: T): T => structuredClone(v);
  const push = (f: Follow) => publish({ type: "follow", op: "upsert", id: f.followId, item: clone(f) });

  function creator(platform: FollowPlatform, value: string): FollowCreator {
    const known = DIRECTORY[platform][value];
    const needsKeys = platform !== "youtube" && !keys[platform].saved;
    if (needsKeys) {
      return { platform, platformId: value, handle: value, name: value, avatarUrl: "", url: channelUrl(platform, value, value), resolved: false, needsKeys: true };
    }
    if (!known) throw notFound(NOT_FOUND);
    return {
      platform,
      platformId: known.platformId,
      handle: known.handle,
      name: known.name,
      avatarUrl: "",
      url: channelUrl(platform, known.platformId, known.handle),
      ...(known.live ? { live: clone(known.live) } : {}),
      resolved: true,
      needsKeys: false,
    };
  }

  function view(): FollowsView {
    const used = new Set(follows.map((f) => f.platform));
    const slots: FollowKeySlot[] = (["twitch", "kick", "youtube-read"] as FollowKeyPlatform[]).map((p) => ({
      platform: p,
      saved: keys[p].saved,
      needed: used.has(p as FollowPlatform),
      optional: p === "youtube-read",
      ...(keys[p].saved && keys[p].savedAt ? { savedAt: keys[p].savedAt } : {}),
      ...(keys[p].saved && keys[p].hints ? { hints: clone(keys[p].hints) } : {}),
      ...(keys[p].check ? { check: clone(keys[p].check) } : {}),
    }));
    return { follows: clone(follows), keys: slots, kickWebhookUrl: "https://mock-hooks.example/v1/hooks/kick" };
  }

  function add(platform: FollowPlatform, platformId: string): Follow {
    const id = `${platform}:${platformId}`;
    const existing = follows.find((f) => f.followId === id);
    if (existing) return existing;
    const key = platform === "youtube" ? (Object.entries(DIRECTORY.youtube).find(([, k]) => k.platformId === platformId)?.[0] ?? platformId) : platformId;
    const found = creator(platform, key);
    const now = new Date().toISOString();
    const f: Follow = {
      followId: id,
      platform,
      platformId: found.platformId,
      handle: found.handle,
      name: found.name,
      avatarUrl: "",
      url: found.url,
      autoClips: true,
      permissionAt: now,
      followedAt: now,
      resolved: found.resolved,
      ...(found.live ? { live: { ...found.live, checkedAt: now } } : {}),
    };
    follows.push(f);
    return f;
  }

  /** Twitch or Kick keys arrive: the names, pictures and badges fill in (the tick does this every 5 minutes). */
  function resolveAll(platform: FollowPlatform) {
    for (const f of follows.filter((x) => x.platform === platform && !x.resolved)) {
      const known = DIRECTORY[platform][f.platformId];
      if (!known) continue;
      f.name = known.name;
      f.handle = known.handle;
      f.resolved = true;
      if (known.live) f.live = clone(known.live);
      push(f);
    }
  }

  const find = (followId: string) => {
    const f = follows.find((x) => x.followId === followId);
    if (!f) throw notFound("You do not follow that streamer any more. Reload the page.");
    return f;
  };

  const api: FollowsApi = {
    async listFollows() {
      await delay();
      return view();
    },
    async lookupFollow(text, platform) {
      await delay();
      const parsed = parseFollow(text, platform);
      if (!parsed.platform) return { needsPlatform: true, name: parsed.value };
      return { needsPlatform: false, creator: creator(parsed.platform, parsed.value) };
    },
    async follow(platform, platformId) {
      await delay();
      if (follows.length >= 100) throw new ApiError(409, "conflict", "You can follow up to 100 streamers. Remove one first.");
      return clone(add(platform, platform === "youtube" ? platformId : platformId.toLowerCase()));
    },
    async setFollowAuto(platform, platformId, on) {
      await delay();
      const f = find(`${platform}:${platformId}`);
      f.autoClips = on;
      return clone(f);
    },
    async unfollow(platform, platformId) {
      await delay();
      const id = `${platform}:${platformId}`;
      find(id);
      follows.splice(
        follows.findIndex((f) => f.followId === id),
        1,
      );
    },
    async saveFollowKeys(platform, values: FollowKeys) {
      await delay();
      const rules = FORMATS[platform];
      const given = values as Record<string, unknown>;
      const extra = Object.keys(given).find((k) => !(k in rules));
      if (extra) throw bad(`Unknown field: ${extra}.`);
      const hints: Record<string, string> = {};
      for (const [name, [pattern, message]] of Object.entries(rules)) {
        const v = typeof given[name] === "string" ? (given[name] as string).trim() : "";
        if (!pattern.test(v)) throw bad(message, name);
        hints[name] = hint(name === "clientId" ? "clientId" : "secret", v);
      }
      keys[platform] = { saved: true, hints, savedAt: new Date().toISOString() };
      if (platform !== "youtube-read") resolveAll(platform);
      return view();
    },
    async deleteFollowKeys(platform) {
      await delay();
      keys[platform] = { saved: false };
    },
    async checkFollowKeys(platform) {
      await delay();
      const label = LABEL[platform];
      const check: FollowKeyCheck = keys[platform].saved
        ? { ok: true, code: "ok", message: `It works. Clip Factory can see who is live on ${label}.`, at: new Date().toISOString() }
        : { ok: false, code: "no_keys", message: `Paste the ${label} keys first.`, at: new Date().toISOString() };
      if (keys[platform].saved) keys[platform].check = check;
      return { check, ...view() };
    },
  };

  const controls: MockFollowControls = {
    seed() {
      if (follows.length) return;
      add("twitch", "speedyspeedruns");
      add("kick", "nightowlplays");
      add("youtube", "UCclipcitygames000000000");
      add("twitch", "cozycrafts");
      const yt = follows.find((f) => f.platform === "youtube");
      if (yt) yt.last = { state: "noticed", text: "New video", at: minutesAgo(40) };
      const cozy = follows.find((f) => f.platformId === "cozycrafts");
      if (cozy) cozy.last = { state: "noticed", text: "Stream ended", at: minutesAgo(180) };
      for (const f of follows) push(f);
    },
    setLive(followId, live, viewers = 250) {
      const f = find(followId);
      f.live = live ? { isLive: true, title: f.live?.title ?? "Live now", viewers, startedAt: new Date().toISOString(), checkedAt: new Date().toISOString() } : { isLive: false, checkedAt: new Date().toISOString() };
      push(f);
    },
    endStream(followId) {
      const f = find(followId);
      f.live = { isLive: false, checkedAt: new Date().toISOString() };
      f.last = { state: "noticed", text: "Stream ended", at: new Date().toISOString() };
      push(f);
    },
    newVideo(followId) {
      const f = find(followId);
      f.last = { state: "noticed", text: "New video", at: new Date().toISOString() };
      push(f);
    },
  };
  return { api, controls };
}
