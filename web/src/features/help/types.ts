// Ask Clip Factory (docs/CONTRACTS.md §19): the shapes shared by the corpus, the retriever, the composer, the API
// client and the panel. The api package mirrors them in Python.
import type { DeviceOs } from "../../lib/device.ts";
import type { Route } from "../../lib/router.ts";

/** Live numbers the browser fetches with the owner's own token (§19.7). */
export type HelpMetric =
  | "best_clip_week_views"
  | "week_total_views"
  | "week_clips"
  | "review_waiting"
  | "jobs_running"
  | "clips_posted"
  | "latest_job"
  | "clip_views"
  | "skills_on"
  | "accounts_connected";

export const HELP_METRICS: readonly HelpMetric[] = [
  "best_clip_week_views",
  "week_total_views",
  "week_clips",
  "review_waiting",
  "jobs_running",
  "clips_posted",
  "latest_job",
  "clip_views",
  "skills_on",
  "accounts_connected",
];

export interface HelpAction {
  /** Unique in the corpus. */
  id: string;
  /** Button words, at most 24 characters. */
  label: string;
  /** App path, may carry ?query and #apple. */
  to: string;
  /** data-help ids to spotlight after going there. */
  highlight?: string[];
}

export interface HelpLiveSpec {
  metric: HelpMetric;
  /** With {value} (and for some metrics {hook}, {posted}, {progress}, {clips}, {platform}) placeholders. */
  text: string;
  range?: "this_week" | "last_week";
}

export type HelpDevice = "phone" | "tablet" | "desktop";

export interface HelpWhen {
  device?: HelpDevice[];
  os?: DeviceOs[];
  installed?: boolean;
}

export interface HelpDoc {
  id: string;
  kind: "page" | "apple" | "guide";
  route: string;
  hash?: string;
  where: string;
  title: string;
  keywords: string[];
  answer: string;
  steps: string[];
  actions: HelpAction[];
  highlight?: string[];
  when?: HelpWhen;
  live?: HelpLiveSpec;
  suggest?: boolean;
  /** Curated guides that §17 (Posting › Setup) will deepen. */
  extends?: string;
}

export interface HelpCorpus {
  version: string;
  app: "clip-factory";
  generatedFrom: string[];
  routes: string[];
  /** Everyday word or phrase → the app's own words, expanded into the question before scoring. */
  synonyms: Record<string, string>;
  stopwords: string[];
  docs: HelpDoc[];
}

export interface HelpTurn {
  role: "user" | "assistant";
  text: string;
  /** What that user turn's pictures showed (§26), ≤ 200 letters; user turns only. */
  seen?: string;
}

/** One picture in a question (§26): base64 JPEG without the data: prefix. */
export interface HelpPicture {
  type: "image/jpeg";
  data: string;
}

/** What the API did with the pictures (only when some were sent). */
export type HelpPictureResult = { read: true; seen: string } | { read: false; why: "off" | "limit" | "trouble" };

/**
 * The pages the API knows (docs/CONTRACTS.md §19.6, api routes/help.py PAGES). Every real route name is one; the
 * mock-only routes (`mock_oauth`, `motion_gallery`) are sent as "not_found" (`helpPage` in context.ts).
 */
export const HELP_PAGES = ["home", "jobs", "job", "review", "library", "clip", "money", "settings", "skill", "get_app", "not_found"] as const;

export type HelpPage = (typeof HELP_PAGES)[number] & Route["name"];

export interface HelpContext {
  device: HelpDevice;
  os: DeviceOs;
  installed: boolean;
  page: HelpPage;
}

export interface HelpAnswer {
  known: boolean;
  refused?: true;
  text: string;
  steps: string[];
  actions: HelpAction[];
  sources: string[];
  live?: HelpLiveSpec;
}

export type HelpMode = "model" | "kb" | "off";

export interface HelpStatus {
  enabled: boolean;
  mode: HelpMode;
  corpusVersion: string;
  /** Pictures can be added to a question (§26): only in model mode with the pictures switch on. */
  pictures?: boolean;
}

/** Limits shared with the API (§19.6). */
export const QUESTION_MAX = 300;
export const HISTORY_MAX = 4;
/** Pictures in one question (§26). */
export const PICTURES_MAX = 4;
export const SEEN_MAX = 200;
