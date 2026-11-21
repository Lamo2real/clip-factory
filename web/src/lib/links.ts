export type LinkPlatform = "youtube" | "twitch" | "kick";

export type LinkCheck =
  | { state: "empty" }
  | { state: "ok"; platform: LinkPlatform; kind: "video" | "live" | "clip" | "channel"; url: string }
  | { state: "error"; platform?: LinkPlatform; message: string };

export const PLATFORM_NAMES: Record<LinkPlatform, string> = { youtube: "YouTube", twitch: "Twitch", kick: "Kick" };

const YT_ID = /^[\w-]{11}$/;

function parse(input: string): URL | null {
  const raw = input.trim();
  if (!raw) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
}

function host(u: URL): string {
  return u.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
}

function youtube(u: URL): LinkCheck {
  const h = host(u);
  const parts = u.pathname.split("/").filter(Boolean);
  let id: string | null = null;
  let kind: "video" | "live" = "video";
  if (h === "youtu.be") id = parts[0] ?? null;
  else if (parts[0] === "watch") id = u.searchParams.get("v");
  else if (parts[0] === "live" || parts[0] === "shorts" || parts[0] === "embed") {
    id = parts[1] ?? null;
    if (parts[0] === "live") kind = "live";
  }
  if (id && YT_ID.test(id)) return { state: "ok", platform: "youtube", kind, url: `https://www.youtube.com/watch?v=${id}` };
  return {
    state: "error",
    platform: "youtube",
    message: "That YouTube link does not point to a video. Copy the link from the video's Share button.",
  };
}

/** Twitch's own site pages: one-word paths that are not a channel (twitch.tv/directory is not a live channel). */
const TWITCH_PAGES = new Set([
  "directory", "settings", "videos", "search", "downloads", "jobs", "p", "turbo", "subscriptions", "inventory",
  "wallet", "drops", "friends", "messages", "prime", "store", "login", "signup", "logout", "following", "privacy",
  "legal", "help", "team", "products", "broadcast", "creatorcamp",
]);

/** Kick's own site pages, the same idea. */
const KICK_PAGES = new Set([
  "categories", "category", "browse", "search", "following", "dashboard", "settings", "terms-of-service",
  "privacy-policy", "community-guidelines", "dmca-policy", "login", "signup", "subscriptions", "help",
]);

const sitePage = (name: string) =>
  `That ${name} link goes to a ${name} page, not a video, clip or channel. Open the video or the channel and copy its link.`;

function twitch(u: URL): LinkCheck {
  const h = host(u);
  const parts = u.pathname.split("/").filter(Boolean);
  if (h === "clips.twitch.tv" && parts[0]) return { state: "ok", platform: "twitch", kind: "clip", url: u.toString() };
  if (parts[0] === "videos" && /^\d+$/.test(parts[1] ?? ""))
    return { state: "ok", platform: "twitch", kind: "video", url: `https://www.twitch.tv/videos/${parts[1]}` };
  if (parts[1] === "clip" && parts[2]) return { state: "ok", platform: "twitch", kind: "clip", url: u.toString() };
  if (parts.length === 1 && TWITCH_PAGES.has(parts[0]!.toLowerCase())) return { state: "error", platform: "twitch", message: sitePage("Twitch") };
  if (parts.length === 1 && /^\w{3,25}$/.test(parts[0]!))
    return { state: "ok", platform: "twitch", kind: "live", url: `https://www.twitch.tv/${parts[0]!.toLowerCase()}` };
  return {
    state: "error",
    platform: "twitch",
    message: "That Twitch link does not point to a video, clip or channel.",
  };
}

function kick(u: URL): LinkCheck {
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts[0] === "video" && parts[1]) return { state: "ok", platform: "kick", kind: "video", url: u.toString() };
  if (parts.length >= 3 && (parts[1] === "videos" || parts[1] === "clips"))
    return { state: "ok", platform: "kick", kind: parts[1] === "clips" ? "clip" : "video", url: u.toString() };
  if (parts.length === 1 && KICK_PAGES.has(parts[0]!.toLowerCase())) return { state: "error", platform: "kick", message: sitePage("Kick") };
  if (parts.length === 1 && /^[\w-]{2,40}$/.test(parts[0]!))
    return { state: "ok", platform: "kick", kind: "live", url: `https://kick.com/${parts[0]!.toLowerCase()}` };
  return { state: "error", platform: "kick", message: "That Kick link does not point to a video, clip or channel." };
}

/** Recognises YouTube, Twitch and Kick links as the owner types, and normalises them. */
export function checkLink(input: string): LinkCheck {
  if (!input.trim()) return { state: "empty" };
  const u = parse(input);
  if (!u || !/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) {
    return { state: "error", message: "That does not look like a link. Paste the full address, starting with https://." };
  }
  const h = host(u);
  if (h === "youtube.com" || h === "youtu.be" || h === "youtube-nocookie.com") return youtube(u);
  if (h === "twitch.tv" || h === "clips.twitch.tv") return twitch(u);
  if (h === "kick.com") return kick(u);
  return { state: "error", message: "Clip Factory works with YouTube, Twitch and Kick links." };
}

export const KIND_LABEL: Record<"video" | "live" | "clip" | "channel", string> = {
  video: "video",
  live: "live channel",
  clip: "clip",
  channel: "channel",
};

/**
 * Pulls the link out of whatever was pasted: share sheets often add words around it
 * ("Watch this! https://youtu.be/…"). Returns the input unchanged when it holds no link.
 */
export function extractLink(input: string): string {
  const text = input.trim();
  if (!/\s/.test(text)) return text;
  const m = /(https?:\/\/[^\s<>"']+)/i.exec(text) ?? /((?:www\.|m\.)?(?:youtube\.com|youtu\.be|twitch\.tv|clips\.twitch\.tv|kick\.com)\/[^\s<>"']*)/i.exec(text);
  return m ? m[1]!.replace(/[).,!?]+$/, "") : text;
}

// ---------- Content Rewards campaign links (docs/CONTRACTS.md §38.4; mirrors the API's links.parse_campaign_url) ----------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CampaignLink =
  /** One campaign (or, with `group`, a group of campaigns: the API answers `{ group }`). */
  | { kind: "campaign"; uuid: string; url: string; group: boolean }
  /** A Content Rewards or Whop link that is not one campaign: the sentence says what to do. */
  | { kind: "refused"; message: string }
  /** Not a campaign link at all: Home treats it as a video link. */
  | { kind: "none" };

export const INVITE_REFUSED =
  "That's an invite link. Open it, join, then copy the campaign's own link (share icon, **Copy campaign link**).";
export const CHECKOUT_REFUSED = "That's a Whop sign-up link. Open the campaign on contentrewards.com and copy its link there.";
export const CR_PAGE_REFUSED = "That's a Content Rewards page, not one campaign. Open the campaign, then copy its link.";

/** Recognises a Content Rewards campaign link (§38.4): the host after a leading `www.`, the uuid in any case. */
export function campaignLink(input: string): CampaignLink {
  const u = parse(extractLink(input));
  if (!u || !/^https?:$/.test(u.protocol)) return { kind: "none" };
  const h = u.hostname.toLowerCase().replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  const group = u.searchParams.get("group") === "1";
  const found = (raw: string | undefined): CampaignLink | null => {
    if (!raw || !UUID.test(raw)) return null;
    const uuid = raw.toLowerCase();
    return { kind: "campaign", uuid, url: `https://contentrewards.com/c/campaigns/${uuid}`, group };
  };
  if (h === "contentrewards.com") {
    const [a, b, c] = parts;
    const hit =
      (a === "c" && b === "campaigns" && parts.length === 3 ? found(c) : null) ??
      (a === "c" && b === "discover" && parts.length === 3 ? found(c) : null) ??
      (a === "discover" && parts.length === 2 ? found(b) : null);
    if (hit) return hit;
    if (a === "c" && b === "invite") return { kind: "refused", message: INVITE_REFUSED };
    return { kind: "refused", message: CR_PAGE_REFUSED };
  }
  if (h === "whop.com") {
    const [a, , c, d] = parts;
    if (a === "experiences" && c === "campaigns" && parts.length === 4) {
      const hit = found(d);
      if (hit) return hit;
    }
    if (a === "checkout") return { kind: "refused", message: CHECKOUT_REFUSED };
    return { kind: "none" };
  }
  return { kind: "none" };
}
