// The shape of one platform's setup guide (docs/CONTRACTS.md §17.2). Each guide file is plain data: the screens
// draw it, the tests check it, and docs/SETUP_POSTING.md says the same words.
import type { ConnectResult, GateKey, KeyName, Platform } from "../api/types.ts";
import type { IconName } from "../components/Icon.tsx";

export const CHECKED_ON = "2026-11-19";

export interface SetupGuide {
  platform: Platform;
  name: string;
  /** The day these steps were last checked on the platform's own site ("YYYY-MM-DD"). */
  checkedOn: string;
  /** About how long the whole setup takes. */
  minutes: number;
  /** "Free", or what it costs. */
  cost: string;
  /** Extra words after the minutes ("+ TikTok's review time"). */
  timeNote?: string;
  parts: GuidePart[];
  /** Step ids to send the owner back to for each result (rendered as "step N", so numbers never drift). */
  fix: { keys: string; redirect: string; account: string[] };
  /** "Client ID and secret", "Client key and secret", "App ID, App secret and Configuration ID". */
  keyWords: string;
  /** Status lines shown at the top of Go public. */
  publicNote?: string;
}

export type PartId = "ready" | "key" | "connect" | "public";

export interface GuidePart {
  id: PartId;
  title: string;
  steps: GuideStep[];
}

export type ValueRefName =
  | "appName"
  | "appDescription"
  | "websiteUrl"
  | "websitePrefix"
  | "privacyUrl"
  | "termsUrl"
  | "dataDeletionUrl"
  | "redirectUri"
  | "appDomain"
  | "hooksDomain"
  | "scopes"
  | "ownerEmail"
  | "xUseCase"
  | "tiktokReviewText";

export type ValueRef = { ref: ValueRefName };

/** Pickers and notes a step can hold besides buttons. */
export type StepExtra = "youtube-privacy" | "tiktok-review" | "x-cost";

export interface GuideStep {
  /** ^[a-z0-9-]{1,40}$, unique per platform; stored on the server when ticked. */
  id: string;
  icon: IconName;
  /** Six words or fewer. */
  title: string;
  /** Short lines, one action each. **bold** = the platform's own button or label, word for word. */
  say: string[];
  /** Opens the exact page in a new tab (https only). */
  open?: { label: string; url: string };
  copy?: { label: string; value: string | ValueRef }[];
  /** The paste boxes of this step. */
  paste?: KeyName[];
  upload?: "tiktok-verification";
  download?: { label: string; href: "/brand/clip-factory-1024.png" };
  /** For anything the platform may show differently. */
  ifYouSee?: { see: string; do: string }[];
  /** Ticks itself from what the server knows: no "I did this". */
  auto?: "keys" | "connected" | "checked" | "files";
  /** Not counted in the ring. */
  optional?: boolean;
  /** This step shows that gate's status line. */
  gate?: GateKey;
  extra?: StepExtra;
}

export type ResultCopy = Record<ConnectResult, string>;

// ---------- Content Rewards (docs/CONTRACTS.md §38.3, §38.4, §38.7) ----------
// Its own guide, never one of the five above: SetupGuide is unchanged and CR_GUIDE is not in GUIDES.

/** What a Content Rewards step ticks itself from (GET /v1/contentrewards). */
export type CrAuto = "connected" | "can_submit" | "linked" | "membership" | "logo" | "job" | "money_moving" | "whop_linked" | "money_moved";

/** An unnumbered helper inside a step: a question that opens more lines. */
export interface CrFold {
  id: string;
  /** "Instagram says **Not a professional account**?" */
  question: string;
  say: string[];
  open?: { label: string; url: string };
  ifYouSee?: { see: string; do: string }[];
  openWhen?: "not_allowed_or_read_only";
}

export interface CrStep extends Omit<GuideStep, "auto" | "paste" | "upload" | "gate" | "extra"> {
  /** Also ticks itself from GET /v1/contentrewards; "I did this" stays unless manual: false. */
  auto?: CrAuto;
  /** Default true: shows "I did this" (PATCH /v1/contentrewards/connection {step, done}). */
  manual?: boolean;
  /** "Open email" (a mailto: link; the desktop app hands it to Mail). */
  mailto?: { label: string; href: string };
  /** A green answer button. */
  ask?: { label: string; said: "pilot_sent" };
  /** Unnumbered helpers inside the step. */
  folds?: CrFold[];
  /**
   * Money steps (§38.7): shown only for that answer to "Do you see Finance?". "both" is a step every answer shows
   * (Move money to Whop): the contract's table marks it "both", so it needs a value of its own here.
   */
  finance?: "yes" | "no" | "both";
  /** Done once (it folds away), or each time money moves. */
  repeat?: "once" | "each_time";
}

export interface CrGuide {
  name: "Content Rewards";
  checkedOn: "2026-11-21";
  minutes: number;
  cost: "Free";
  parts: { id: "setup" | "move" | "bank" | "join"; title: string; steps: CrStep[] }[];
}
