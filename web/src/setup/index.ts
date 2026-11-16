// The five setup guides (docs/CONTRACTS.md §17.2), the words Clip Factory gives the owner to paste, and the plain
// sentences for every connect result (§17.5) and gate (§17.4).
import type { ConnectResult, Gate, GateKey, Platform, SetupValues, YoutubePrivacy } from "../api/types.ts";
import { STATS_ORDER } from "../lib/metrics.ts";
import { facebook } from "./facebook.ts";
import { instagram } from "./instagram.ts";
import { tiktok } from "./tiktok.ts";
import type { GuideStep, ResultCopy, SetupGuide, ValueRef, ValueRefName } from "./types.ts";
import { x } from "./x.ts";
import { youtube } from "./youtube.ts";

export * from "./types.ts";

/** Same order as the numbers everywhere: YouTube, TikTok, Instagram, Facebook, X. */
export const SETUP_ORDER: readonly Platform[] = STATS_ORDER;

export const GUIDES: Record<Platform, SetupGuide> = { youtube, tiktok, instagram, facebook, x };

export const APP_NAME = "Clip Factory";
/** The Facebook app gets its own name: Meta does not allow two apps with one name in a portfolio. */
export const FACEBOOK_APP_NAME = "Clip Factory Pages";
export const APP_DESCRIPTION =
  "Clip Factory turns my gameplay recordings into short vertical clips and posts them to my own accounts when I press Keep.";
export const X_USE_CASE =
  "Post my own short video clips to my own X account and read their view and like counts in my personal Clip Factory app.";
export const TIKTOK_REVIEW_TEXT = [
  "Login Kit + user.info.basic: connect my TikTok and show my name and picture.",
  "video.publish: post clips I approved with Keep (Direct Post).",
  "video.list: show views and likes of my own posts on the Clip Factory dashboard.",
].join("\n");

export const VALUE_REFS: readonly ValueRefName[] = [
  "appName",
  "appDescription",
  "websiteUrl",
  "websitePrefix",
  "privacyUrl",
  "termsUrl",
  "dataDeletionUrl",
  "redirectUri",
  "appDomain",
  "hooksDomain",
  "scopes",
  "ownerEmail",
  "xUseCase",
  "tiktokReviewText",
];

/**
 * The text a Copy chip copies. Values the server knows come from GET /v1/setup; before it answers, the return
 * address can come from config.json's `oauthCallbackBase`. Null while it is not known yet.
 */
export function resolveValue(
  value: string | ValueRef,
  platform: Platform,
  values: SetupValues | null,
  callbackBase?: string,
): string | null {
  if (typeof value === "string") return value;
  switch (value.ref) {
    case "appName":
      return platform === "facebook" ? FACEBOOK_APP_NAME : (values?.appName ?? APP_NAME);
    case "appDescription":
      return APP_DESCRIPTION;
    case "xUseCase":
      return X_USE_CASE;
    case "tiktokReviewText":
      return TIKTOK_REVIEW_TEXT;
    case "redirectUri":
      return values?.redirectUris[platform] ?? (callbackBase ? `${callbackBase.replace(/\/+$/, "")}/${platform}/callback` : null);
    case "scopes":
      return values ? values.scopes[platform].join("\n") : null;
    default:
      return values ? values[value.ref] : null;
  }
}

/** Every step of a guide, numbered 1…N across all parts. */
export function allSteps(guide: SetupGuide): GuideStep[] {
  return guide.parts.flatMap((p) => p.steps);
}

/** The number the owner sees on a step ("step 11"). */
export function stepNumber(guide: SetupGuide, stepId: string): number {
  return allSteps(guide).findIndex((s) => s.id === stepId) + 1;
}

function steps(guide: SetupGuide, ids: string[]): string {
  const nums = ids.map((id) => stepNumber(guide, id));
  return nums.length === 1 ? `step ${nums[0]}` : `steps ${nums.slice(0, -1).join(", ")} and ${nums.at(-1)}`;
}

/** The plain sentence for each `?result=` code the hooks API sends back (§17.5). */
export function resultCopy(platform: Platform): ResultCopy {
  const g = GUIDES[platform];
  const name = g.name;
  const accountFix = `Do ${steps(g, g.fix.account)}, then connect again.`;
  return {
    connected: `${name} is connected!`,
    choose: "Pick the account your clips go to.",
    denied: `You pressed cancel. Press Connect ${name} to try again.`,
    expired: `That took too long. Press Connect ${name} again.`,
    keys_wrong: `The key does not work. Copy the ${g.keyWords} again (${steps(g, [g.fix.keys])}).`,
    redirect_wrong: `The return address does not match. Copy it again in ${steps(g, [g.fix.redirect])}.`,
    missing_permissions: "A permission box was not ticked. Connect again and tick every box.",
    no_channel:
      platform === "youtube" ? `This Google account has no YouTube channel. Make one first (${steps(g, ["ready-channel"])}).` : `${name} did not show your account. ${accountFix}`,
    no_accounts: platform === "instagram" ? `Instagram did not show a pro account. ${accountFix}` : `${name} did not show your account. ${accountFix}`,
    wrong_account_type:
      platform === "instagram" ? `Instagram did not show a pro account. ${accountFix}` : `${name} did not show your account. ${accountFix}`,
    no_pages: platform === "facebook" ? `Facebook did not show a Page you control. ${accountFix}` : `${name} did not show your account. ${accountFix}`,
    platform_down: `${name} did not answer. Try again in a few minutes.`,
    error: `Something went wrong. Press Connect ${name} again.`,
  };
}

export const RESULT_CODES: readonly ConnectResult[] = [
  "connected",
  "choose",
  "denied",
  "expired",
  "keys_wrong",
  "redirect_wrong",
  "missing_permissions",
  "no_channel",
  "no_accounts",
  "wrong_account_type",
  "no_pages",
  "platform_down",
  "error",
];

export function isResultCode(v: string | null): v is ConnectResult {
  return !!v && (RESULT_CODES as readonly string[]).includes(v);
}

/** The step a failed result sends the owner back to (for the "Go to step N" button). */
export function resultStep(platform: Platform, code: ConnectResult): string | null {
  const g = GUIDES[platform];
  switch (code) {
    case "keys_wrong":
      return g.fix.keys;
    case "redirect_wrong":
      return g.fix.redirect;
    case "no_channel":
    case "no_accounts":
    case "wrong_account_type":
    case "no_pages":
      return g.fix.account[0] ?? null;
    default:
      return null;
  }
}

/** The one plain line for a gate's state (§17.2). */
export function gateLine(gate: Gate, ctx: { reviewState?: string; youtubePrivacy?: YoutubePrivacy } = {}): string {
  const key: GateKey = gate.key;
  const { reviewState, youtubePrivacy = "public" } = ctx;
  switch (key) {
    case "published_app":
      return gate.state === "ok"
        ? `Works now. Your clips go up ${YOUTUBE_WHO[youtubePrivacy]}.`
        : "Publish the app, or YouTube stops working after 7 days.";
    case "app_review":
      if (gate.state === "ok") return "TikTok said yes. Your app is Live.";
      if (gate.state === "waiting") return "TikTok is checking your app. This can take days.";
      return reviewState === "not_approved"
        ? "TikTok said not yet. Read their comments, fix them and send it again."
        : "Finish the TikTok review steps to post outside the Sandbox.";
    case "posting_audit":
      if (gate.state === "ok") return "TikTok said yes. Your posts can be public.";
      if (gate.state === "unknown") return "Connect TikTok first. Then this shows what TikTok allows.";
      return "Works now, but your TikTok posts stay private until TikTok says yes.";
    case "app_live":
      return gate.state === "ok"
        ? "Works now. Everyone can see your Facebook Reels."
        : "Works now, but only you can see your Facebook Reels until the app is Live.";
    case "credits":
      return gate.state === "action"
        ? "Your X credits ran out. Buy more in **Billing** › **Credits**."
        : "Works now. Posts are public straight away.";
  }
}

/** Who sees new YouTube clips, in the owner's words. */
export const YOUTUBE_PRIVACY_LABEL: Record<YoutubePrivacy, string> = {
  public: "Everyone",
  unlisted: "Only people with the link",
  private: "Only me",
};
const YOUTUBE_WHO: Record<YoutubePrivacy, string> = {
  public: "for everyone",
  unlisted: "for people with the link",
  private: "for only you",
};

/** "About 20 minutes · Free". */
export function timeLine(guide: SetupGuide): string {
  return `About ${guide.minutes} minutes${guide.timeNote ? ` ${guide.timeNote}` : ""} · ${guide.cost}`;
}

/** "16 Nov 2026". */
export function checkedOnText(guide: SetupGuide): string {
  const [y, m, d] = guide.checkedOn.split("-").map(Number) as [number, number, number];
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1];
  return `${d} ${month} ${y}`;
}
