// The links a reference video may come from (docs/CONTRACTS.md §45.40, ADR-88): one allowlist, three copies. The
// API (api/src/clipfactory_api/workspaces/reflinks.py) and Clips Funded's agent (stories/agent/src/lamostories_agent/
// reflinks.py) have their own; all three give the answers in stories/agent/tests/fixtures/reference_links.json, and
// every suite reads that file (web/test/storiesRefLinkApi.test.ts here).
//
// refLink(text) takes what the owner pasted (share text too: the first link in it) and gives the cleaned link and its
// site: only https (http or no scheme: https:// is put in front), no user name or password, port 443 or none, at most
// 2048 characters, the host lower-cased (TikTok's tiktok.com and m.tiktok.com become www.tiktok.com, the host yt-dlp's
// TikTok extractor takes), the path as given, only the kept query keys, no fragment. Anything else says why: empty,
// not_a_link, other_site, or not_one_video (a profile, a folder, a page). The text is parsed by hand, the same way in
// every copy, so the three never differ on an odd link (the browser's URL parser would re-encode it). Facebook's own
// Share › Copy link (facebook.com/share/r/…, /share/v/…) and fb.watch/… are taken too: the agent opens them first and
// checks where they lead again.

export type RefSite = "youtube" | "tiktok" | "instagram" | "facebook" | "x" | "drive" | "dropbox";
export type RefLinkWhy = "empty" | "not_a_link" | "other_site" | "not_one_video";
export type RefLinkCheck = { ok: true; url: string; site: RefSite } | { ok: false; why: RefLinkWhy };

export const SITE_NAME: Record<RefSite, string> = {
  youtube: "YouTube",
  tiktok: "TikTok",
  instagram: "Instagram",
  facebook: "Facebook",
  x: "X",
  drive: "Google Drive",
  dropbox: "Dropbox",
};

/** The card's line for each refusal (the API answers the same sentences, field "url"). */
export const REF_LINK_REFUSED: Record<RefLinkWhy, string> = {
  empty: "Paste a video link.",
  not_a_link: "That isn't a link. Copy the video's link, then paste it here.",
  other_site: "We can't get videos from that site. Save the video, then upload it.",
  not_one_video: "That link isn't one video. Open the video, tap Share, then Copy link.",
};

const MAX_LINK = 2048;
const MAX_TEXT = 4096;

const HOSTS: Record<string, RefSite> = {
  "youtube.com": "youtube",
  "www.youtube.com": "youtube",
  "m.youtube.com": "youtube",
  "youtu.be": "youtube",
  "tiktok.com": "tiktok",
  "www.tiktok.com": "tiktok",
  "m.tiktok.com": "tiktok",
  "vm.tiktok.com": "tiktok",
  "vt.tiktok.com": "tiktok",
  "instagram.com": "instagram",
  "www.instagram.com": "instagram",
  "facebook.com": "facebook",
  "www.facebook.com": "facebook",
  "m.facebook.com": "facebook",
  "fb.watch": "facebook",
  "x.com": "x",
  "www.x.com": "x",
  "mobile.x.com": "x",
  "twitter.com": "x",
  "www.twitter.com": "x",
  "mobile.twitter.com": "x",
  "drive.google.com": "drive",
  "dropbox.com": "dropbox",
  "www.dropbox.com": "dropbox",
};
/** yt-dlp's TikTok extractors take only www.tiktok.com (and vm./vt.): the other two hosts are written as that one. */
const HOST_AS: Record<string, string> = { "tiktok.com": "www.tiktok.com", "m.tiktok.com": "www.tiktok.com" };

// Whitespace spelled out, so every copy (Python's str.isspace and JavaScript's \s differ) splits the same.
const WS_CHARS = " \\t\\n\\r\\f\\v\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff";
const WS = `[${WS_CHARS}]`;
const EDGES = new RegExp(`^${WS}+|${WS}+$`, "g");
const HAS_WS = new RegExp(WS);
const SPLIT_WS = new RegExp(`${WS}+`);
const LINK_IN_TEXT = new RegExp(`https?://[^<>"'${WS_CHARS}]+`, "i");
const BARE_IN_TEXT = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+\//;
const TRAILING = /[).,!?]+$/;
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const YT_ID = "[A-Za-z0-9_-]{11}";
const CODE = "[A-Za-z0-9_-]{1,64}";
const DIGITS = "[0-9]{1,30}";
const DRIVE_ID = "[A-Za-z0-9_-]{10,200}";
const YOUTUBE = ["youtube.com", "www.youtube.com", "m.youtube.com"];
const TIKTOK_SHORT = ["vm.tiktok.com", "vt.tiktok.com"];
const FACEBOOK = ["facebook.com", "www.facebook.com", "m.facebook.com"];
const SHARE_CODE = "[A-Za-z0-9_-]{1,64}";

interface Shape {
  site: RefSite;
  /** the site's hosts this shape is for; null: all of them */
  hosts: string[] | null;
  path: RegExp;
  /** the query key the path needs, and its value's pattern */
  key?: string;
  value?: RegExp;
}

const whole = (source: string) => new RegExp(`^(?:${source})$`);

const SHAPES: Shape[] = [
  { site: "youtube", hosts: ["youtu.be"], path: whole(`/${YT_ID}/?`) },
  { site: "youtube", hosts: YOUTUBE, path: whole("/watch/?"), key: "v", value: whole(YT_ID) },
  { site: "youtube", hosts: YOUTUBE, path: whole(`/shorts/${YT_ID}/?`) },
  { site: "tiktok", hosts: ["www.tiktok.com"], path: whole(`/@[A-Za-z0-9._-]{1,64}/video/${DIGITS}/?`) },
  { site: "tiktok", hosts: ["www.tiktok.com"], path: whole("/t/[A-Za-z0-9_]{1,64}/?") },
  { site: "tiktok", hosts: TIKTOK_SHORT, path: whole("/[A-Za-z0-9_]{1,64}/?") },
  { site: "instagram", hosts: null, path: whole(`/(reel|reels|p|tv)/${CODE}/?`) },
  { site: "facebook", hosts: FACEBOOK, path: whole(`/reel/${DIGITS}/?`) },
  { site: "facebook", hosts: FACEBOOK, path: whole("/watch/?"), key: "v", value: whole(DIGITS) },
  { site: "facebook", hosts: FACEBOOK, path: whole(`/[A-Za-z0-9._-]{1,100}/videos/${DIGITS}/?`) },
  { site: "facebook", hosts: FACEBOOK, path: whole(`/share/(r|v)/${SHARE_CODE}/?`) },
  { site: "facebook", hosts: ["fb.watch"], path: whole(`/${SHARE_CODE}/?`) },
  { site: "x", hosts: null, path: whole("/[A-Za-z0-9_]{1,15}/status/[0-9]{1,25}(/video/[0-9])?/?") },
  { site: "drive", hosts: null, path: whole(`/file/d/${DRIVE_ID}(/[^?#]*)?`) },
  { site: "drive", hosts: null, path: whole("/(open|uc)/?"), key: "id", value: whole(DRIVE_ID) },
  { site: "dropbox", hosts: null, path: whole(`/(s|scl/fi)/${CODE}/[^/?#]{1,255}/?`) },
];
/** A query key kept beside the path's own (Dropbox's rlkey opens a shared file). */
const EXTRA_KEYS: Partial<Record<RefSite, [string, RegExp]>> = { dropbox: ["rlkey", whole("[A-Za-z0-9]{1,100}")] };

/** The link in what was pasted: the text itself when it has no space, else its first https?:// link, else its first
 * word that looks like host/path; trailing ).,!? dropped. */
export function shareLink(text: string): string {
  const t = text.replace(EDGES, "");
  if (!HAS_WS.test(t)) return t;
  const found = LINK_IN_TEXT.exec(t);
  if (found) return found[0].replace(TRAILING, "");
  for (const word of t.split(SPLIT_WS)) if (BARE_IN_TEXT.test(word)) return word.replace(TRAILING, "");
  return t;
}

/** The first value of each key, as written (nothing decoded). */
function queryOf(query: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of query.split("&")) {
    const at = pair.indexOf("=");
    const key = at < 0 ? pair : pair.slice(0, at);
    const value = at < 0 ? "" : pair.slice(at + 1);
    if (key && !out.has(key)) out.set(key, value);
  }
  return out;
}

const refused = (why: RefLinkWhy): RefLinkCheck => ({ ok: false, why });

/** The cleaned https link and its site, or why it is refused. */
export function refLink(text: string): RefLinkCheck {
  if (typeof text !== "string" || text.length > MAX_TEXT) return refused("not_a_link");
  const link = shareLink(text);
  if (!link) return refused("empty");
  if (link.length > MAX_LINK || HAS_WS.test(link) || CONTROL.test(link)) return refused("not_a_link");
  const scheme = SCHEME.exec(link);
  // http is written as https: only https is ever fetched.
  if (scheme && !["https", "http"].includes(scheme[1]!.toLowerCase())) return refused("not_a_link");
  let rest = scheme ? link.slice(scheme[0].length) : link;
  const cuts = [rest.indexOf("/"), rest.indexOf("?"), rest.indexOf("#")].filter((i) => i >= 0);
  const cut = cuts.length ? Math.min(...cuts) : rest.length;
  const authority = rest.slice(0, cut);
  rest = rest.slice(cut);
  if (authority.includes("@")) return refused("not_a_link");
  const colon = authority.indexOf(":");
  let host = colon < 0 ? authority : authority.slice(0, colon);
  if (colon >= 0 && authority.slice(colon + 1) !== "443") return refused("not_a_link");
  host = host.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!HOST.test(host)) return refused("not_a_link");
  rest = rest.split("#", 1)[0]!;
  const q = rest.indexOf("?");
  const path = (q < 0 ? rest : rest.slice(0, q)) || "/";
  const query = q < 0 ? "" : rest.slice(q + 1);
  const site = Object.prototype.hasOwnProperty.call(HOSTS, host) ? HOSTS[host] : undefined;
  if (!site) return refused("other_site");
  host = HOST_AS[host] ?? host;
  const params = queryOf(query);
  for (const shape of SHAPES) {
    if (shape.site !== site || (shape.hosts && !shape.hosts.includes(host)) || !shape.path.test(path)) continue;
    const kept: string[] = [];
    if (shape.key) {
      const value = params.get(shape.key) ?? "";
      if (!shape.value!.test(value)) continue;
      kept.push(`${shape.key}=${value}`);
    }
    const extra = EXTRA_KEYS[site];
    if (extra && extra[1].test(params.get(extra[0]) ?? "")) kept.push(`${extra[0]}=${params.get(extra[0])}`);
    const url = `https://${host}${path}${kept.length ? `?${kept.join("&")}` : ""}`;
    if (url.length > MAX_LINK) return refused("not_a_link");
    return { ok: true, url, site };
  }
  return refused("not_one_video");
}

/** The site of a cleaned link ("From TikTok"), or null. */
export function siteOf(url: string): RefSite | null {
  const got = refLink(url);
  return got.ok ? got.site : null;
}
