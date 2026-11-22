// The way back from a setup page (docs/CONTRACTS.md §39.1): `?back=` names the page the owner came from, so once the
// place is connected the "When it's done" vermilion takes him straight back there ("Back to FaZe Clips"). One pure
// function every setup page uses. Only these exact same-origin shapes count; anything else (another origin, `//`, a
// scheme, other paths, extra query keys) is ignored, so a link can never send him somewhere else.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Clip and job ids are ULIDs (the API's ids.py); a UUID is accepted too. */
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;
const isId = (v: string) => ULID.test(v) || UUID.test(v);

export type BackKind = "campaign" | "campaigns" | "find" | "clip" | "money" | "getpaid" | "setup";

/** Get paid's places (§40.1), its Your bank page (§40.5.2) and the setup pages' places (§17.1, §38.3), for the back shapes. */
const GETPAID_PLACES = ["youtube", "tiktok", "instagram", "facebook", "x", "contentrewards", "bank"];
const SETUP_NAMES: Record<string, string> = { youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram", facebook: "Facebook", x: "X", contentrewards: "Content Rewards" };

export interface BackLink {
  /** The page to go back to (always a same-origin path). */
  href: string;
  kind: BackKind;
  /** For `campaign`: the campaign's id (its name is looked up by the page). */
  campaignId?: string;
  /** For `setup`: whose setup page it is ("YouTube"). */
  placeName?: string;
}

/** Reads `?back=` from a page's query (`location.search`). */
export function backLink(search: string | URLSearchParams): BackLink | null {
  const q = typeof search === "string" ? new URLSearchParams(search) : search;
  const all = q.getAll("back");
  if (all.length !== 1) return null;
  return parseBack(all[0]!);
}

/** One `back` value against the shapes (the six of §39.1, `/campaigns/find` from §41.6 change 7, Get paid's two of §40.1 and a setup page). */
export function parseBack(raw: string): BackLink | null {
  if (typeof raw !== "string" || raw.length > 200 || !raw.startsWith("/") || raw.startsWith("//") || /[\\\s#]/.test(raw)) return null;
  const at = raw.indexOf("?");
  const path = at < 0 ? raw : raw.slice(0, at);
  const query = at < 0 ? null : raw.slice(at + 1);
  if (path === "/review") {
    if (query === null) return { href: "/review", kind: "clip" };
    const q = new URLSearchParams(query);
    const keys = [...q.keys()];
    const job = q.get("job");
    if (keys.length === 1 && keys[0] === "job" && job && isId(job)) return { href: `/review?job=${job}`, kind: "clip" };
    return null;
  }
  if (query !== null) return null;
  if (path === "/campaigns") return { href: "/campaigns", kind: "campaigns" };
  if (path === "/campaigns/find") return { href: "/campaigns/find", kind: "find" };
  if (path === "/money") return { href: "/money", kind: "money" };
  if (path === "/settings/posting/getpaid") return { href: path, kind: "getpaid" };
  const getpaid = /^\/settings\/posting\/getpaid\/([a-z]+)$/.exec(path);
  if (getpaid && GETPAID_PLACES.includes(getpaid[1]!)) return { href: path, kind: "getpaid" };
  const setup = /^\/settings\/posting\/setup\/([a-z]+)$/.exec(path);
  if (setup && SETUP_NAMES[setup[1]!]) return { href: path, kind: "setup", placeName: SETUP_NAMES[setup[1]!] };
  const campaign = /^\/campaigns\/([^/]+)$/.exec(path);
  if (campaign && UUID.test(campaign[1]!)) {
    const id = campaign[1]!.toLowerCase();
    return { href: `/campaigns/${id}`, kind: "campaign", campaignId: id };
  }
  const clip = /^\/clips\/([^/]+)$/.exec(path);
  if (clip && isId(clip[1]!)) return { href: `/clips/${clip[1]}`, kind: "clip" };
  return null;
}

/** The back button's words: "Back to FaZe Clips" ("Back to your campaign" until the name loads). */
export function backLabel(back: BackLink, campaignName?: string | null): string {
  switch (back.kind) {
    case "campaign":
      return campaignName ? `Back to ${campaignName}` : "Back to your campaign";
    case "campaigns":
      return "Back to your campaigns";
    case "find":
      return "Back to Find campaigns";
    case "clip":
      return "Back to your clip";
    case "money":
      return "Back to Money";
    case "getpaid":
      // Your bank's own page says where it really goes (§40.5.2); Get paid's list and place pages say Get paid.
      return back.href === "/settings/posting/getpaid/bank" ? "Back to Your bank" : "Back to Get paid";
    case "setup":
      return `Back to ${back.placeName ?? "the"} setup`;
  }
}

/** The result card's extra line after Connect: "Next: back to FaZe Clips." */
export function backNext(back: BackLink, campaignName?: string | null): string {
  const label = backLabel(back, campaignName);
  return `Next: ${label.charAt(0).toLowerCase()}${label.slice(1)}.`;
}

/**
 * A setup page's address with the way back to `from` (the page the link is on). Only a `from` of the six shapes is
 * added; a setup href that already carries a `back` keeps its own.
 */
export function withBack(setupHref: string, from: string): string {
  if (!setupHref.startsWith("/settings/posting/setup/")) return setupHref;
  const at = setupHref.indexOf("?");
  const q = new URLSearchParams(at < 0 ? "" : setupHref.slice(at + 1));
  if (q.has("back")) return setupHref;
  const back = parseBack(from);
  if (!back) return setupHref;
  return `${setupHref}${at < 0 ? "?" : "&"}back=${back.href}`;
}

/** The current page as a `back` value (path and query, no hash), for links to a setup page. */
export function herePath(): string {
  return typeof location === "undefined" ? "/" : `${location.pathname}${location.search}`;
}
