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

function twitch(u: URL): LinkCheck {
  const h = host(u);
  const parts = u.pathname.split("/").filter(Boolean);
  if (h === "clips.twitch.tv" && parts[0]) return { state: "ok", platform: "twitch", kind: "clip", url: u.toString() };
  if (parts[0] === "videos" && /^\d+$/.test(parts[1] ?? ""))
    return { state: "ok", platform: "twitch", kind: "video", url: `https://www.twitch.tv/videos/${parts[1]}` };
  if (parts[1] === "clip" && parts[2]) return { state: "ok", platform: "twitch", kind: "clip", url: u.toString() };
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
