// Does this clip fit the campaign? (docs/CONTRACTS.md §39.3, ADR-63). The API decides the fit (contentrewards/fit.py,
// GET /v1/contentrewards/fit); the web never does. While the owner types or taps on the Review card, only the four
// items that change there (`tags`, `ad`, `paid_switch`, `places`) are worked out again here, with `liveFit`: a port of
// fit.py `live`, checked against the API's golden cases (api/tests/fixtures/cr_fit_live_cases.json). The rest of this
// file draws nothing: which control of the fit block is the screen's one vermilion, Upload's words while it is off,
// "I read them. They're OK" and "Not now" (this device only), and the shared GET /v1/contentrewards/fit store.
import { useCallback, useSyncExternalStore } from "react";
import { api } from "../api/index.ts";
import type { CampaignFit, Captions, ClipFit, FitFix, FitItem, FitRule, FitState, FitVerdict, Platform, TikTokPostOptions } from "../api/types.ts";
import { crAvailability } from "./contentRewards.ts";
import { PLATFORM_LABEL, PLATFORM_ORDER } from "./format.ts";
import { onLiveSignal } from "./live.ts";

// ---------- The rules' order and the four live items (a port of fit.py) ----------

export const RULES: readonly FitRule[] = [
  "campaign",
  "soft",
  "deadline",
  "length",
  "places",
  "place_link",
  "tags",
  "ad",
  "paid_switch",
  "logo",
  "on_screen",
  "source",
  "language",
  "banned",
  "spoken",
  "uncertain",
  "brief_only",
  "posted",
  "one_campaign",
  "send",
];
/** The order items show in: problems first, then the ok ones. */
export const STATES: readonly FitState[] = ["no", "todo", "remake", "fix", "check", "note", "ok"];
export const LIVE_RULES: readonly FitRule[] = ["tags", "ad", "paid_switch", "places"];
/** Where a failing item's "Make new clips for this campaign" keeps the clip's own link (the same video is fine). */
export const SAME_VIDEO: readonly FitRule[] = ["length", "banned", "posted", "one_campaign"];
/** The caption each place sends (the YouTube title keeps no tags: the description carries them). */
export const CAPTION_OF: Record<Platform, keyof Captions> = {
  youtube: "youtubeDescription",
  tiktok: "tiktok",
  instagram: "instagram",
  facebook: "facebook",
  x: "x",
};
const DEFAULT_DISCLOSURE = "#Ad";
const DISCLOSURES = ["#Ad", "#ad", "#Sponsored", "#sponsored", "#PaidPartnership"];
const AD_LIKE = new Set(DISCLOSURES.map((d) => d.toLowerCase()));
/** B's DISCLOSURE_WINDOW: the disclosure counts when it starts in the first 30 characters. */
export const DISCLOSURE_WINDOW = 30;
const COUNTS: Record<number, string> = { 1: "it", 2: "both", 3: "all three", 4: "all four", 5: "all five" };

// Python's `\w` (letters, digits and _ in any language).
const W = "[\\p{L}\\p{N}_]";
const TOKEN = new RegExp(`^[#@](?:${W}|\\.)*${W}$`, "u");
const HASHTAG = new RegExp(`#${W}+`, "gu");
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A `#` or `@` token (`#FaZe`, `@FaZe.Clan`), not a phrase. */
export function isToken(item: string): boolean {
  return TOKEN.test(item);
}

/**
 * B's match (`campaign_caption.has_item`): a whole `#`/`@` token, case-insensitive ("#FaZe" is not in "#FaZeClan", a
 * full stop after it is fine); a phrase with its spaces folded.
 */
export function hasItem(text: string, item: string): boolean {
  if (isToken(item)) return new RegExp(`(?<![\\p{L}\\p{N}_#@])${escape(item)}(?!${W}|\\.${W})`, "iu").test(text);
  const fold = (s: string) => s.split(/\s+/).filter(Boolean).join(" ").toLowerCase();
  return fold(text).includes(fold(item));
}

/** B's disclosure-first rule (`campaign_caption.ad_first`): an `#ad`-like tag (or the brand's own one) starts in the
 * first 30 characters. */
export function adFirst(text: string, disclosure: string): boolean {
  const asked = disclosure.toLowerCase();
  const counts = asked === DEFAULT_DISCLOSURE.toLowerCase() ? AD_LIKE : new Set([asked]);
  for (const m of text.matchAll(HASHTAG)) {
    if ((m.index ?? 0) >= DISCLOSURE_WINDOW) return false;
    if (counts.has(m[0].toLowerCase())) return true;
  }
  return false;
}

const label = (p: Platform) => PLATFORM_LABEL[p];
/** "a", "a and b", "a, b and c". */
export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function item(rule: FitRule, state: FitState, text: string, fix: FitFix | null = null, platform?: Platform): FitItem {
  return platform ? { rule, state, text, fix, platform } : { rule, state, text, fix };
}

const CAPTIONS_FIX: FitFix = { kind: "captions", label: "Fix it for me" };

export function placesLive(name: string, uploadPlaces: readonly Platform[], chosen: readonly Platform[] | null): FitItem[] {
  const going = uploadPlaces.filter((p) => chosen === null || chosen.includes(p));
  const out: FitItem[] = [];
  if (going.length) out.push(item("places", "ok", `Goes to ${joinList(going.map(label))}. ${name} pays for ${COUNTS[going.length] ?? "all of them"}.`));
  for (const p of uploadPlaces) if (!going.includes(p)) out.push(item("places", "note", `${label(p)} pays too. Turn it on to earn there as well.`, null, p));
  return out;
}

const shown = (w: string, phrase: string | null) => (w === phrase ? `“${w}”` : w);

export function tagsLive(required: CampaignFit["required"], going: readonly Platform[], captions: Partial<Captions>): FitItem[] {
  const phrase = required.phrase;
  const wanted = [...required.tokens, ...(phrase ? [phrase] : [])];
  if (!wanted.length || !going.length) return [];
  const out: FitItem[] = [];
  for (const p of going) {
    const text = String(captions[CAPTION_OF[p]] ?? "");
    const missing = wanted.filter((w) => !hasItem(text, w)).map((w) => shown(w, phrase));
    if (missing.length) {
      const them = missing.length === 1 ? "it" : "them";
      out.push(item("tags", "fix", `The ${label(p)} words are missing ${joinList(missing)}. I'll put ${them} back when it uploads.`, { ...CAPTIONS_FIX }, p));
    }
  }
  if (!out.length) out.push(item("tags", "ok", `Every caption has ${joinList(wanted.map((w) => shown(w, phrase)))}.`));
  return out;
}

export function adLive(required: CampaignFit["required"], going: readonly Platform[], captions: Partial<Captions>): FitItem[] {
  const disclosure = required.disclosure || DEFAULT_DISCLOSURE;
  if (!going.length) return [];
  const out = going
    .filter((p) => !adFirst(String(captions[CAPTION_OF[p]] ?? ""), disclosure))
    .map((p) => item("ad", "fix", `${disclosure} isn't at the start of the ${label(p)} words. I'll put it there when it uploads.`, { ...CAPTIONS_FIX }, p));
  return out.length ? out : [item("ad", "ok", `${disclosure} is at the start of every caption.`)];
}

/** YouTube and X: the publisher turns paid promotion on. TikTok: Branded content is the owner's own tap (§17.8), so it
 * is checked only once the card's TikTok choices are known. Instagram and Facebook: no switch. */
export function paidLive(going: readonly Platform[], tiktok: Pick<TikTokPostOptions, "brandContent"> | null, disclosure = DEFAULT_DISCLOSURE): FitItem[] {
  const out: FitItem[] = [];
  const auto = going.filter((p) => p === "youtube" || p === "x");
  if (auto.length) out.push(item("paid_switch", "ok", `Paid promotion goes on for ${joinList(auto.map(label))}.`));
  if (going.includes("tiktok") && tiktok !== null) {
    if (tiktok.brandContent === true) out.push(item("paid_switch", "ok", "Branded content is on for TikTok.", null, "tiktok"));
    else out.push(item("paid_switch", "fix", "Branded content is off on TikTok.", { kind: "tiktok_branded", label: "Turn on Branded content" }, "tiktok"));
  }
  const meta = going.filter((p) => p === "instagram" || p === "facebook").map(label);
  if (meta.length)
    out.push(item("paid_switch", "note", `${joinList(meta)} ${meta.length === 1 ? "doesn't" : "don't"} let apps turn on Paid partnership. ${disclosure} and the words on the video tell viewers.`));
  return out;
}

/** A `todo` with no fix passes by itself (a wait item). */
export const isWait = (i: Pick<FitItem, "state" | "fix">) => i.state === "todo" && !i.fix;

function order(i: FitItem): [number, number, number] {
  return [STATES.indexOf(i.state), RULES.indexOf(i.rule), i.platform ? PLATFORM_ORDER.indexOf(i.platform) : -1];
}

/** Problems first (no, todo, remake, fix, check, note), then ok; inside a state by rule, then by place. Stable. */
export function sortItems(items: readonly FitItem[]): FitItem[] {
  return [...items].sort((a, b) => {
    const x = order(a);
    const y = order(b);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
}

export function verdictOf(items: readonly FitItem[]): FitVerdict {
  const states = new Set(items.map((i) => i.state));
  if (states.has("no")) return "doesnt_fit";
  if (items.some(isWait)) return "wait";
  if (states.has("remake") || states.has("todo") || items.some((i) => i.rule === "paid_switch" && i.state === "fix")) return "fixable";
  return states.has("check") ? "cant_tell" : "fits";
}

export function headlineOf(found: FitVerdict, name: string, items: readonly FitItem[]): string {
  if (found === "fits") return `Can earn on ${name}`;
  if (found === "wait") return `Wait a little for ${name}`;
  if (found === "doesnt_fit") return `This clip can't earn on ${name}`;
  if (found === "cant_tell") {
    const n = items.filter((i) => i.state === "check").length;
    return n === 1 ? "Check 1 thing, then upload" : `Check ${n} things, then upload`;
  }
  if (items.some((i) => i.state === "todo")) return `One thing first for ${name}`;
  if (items.some((i) => i.state === "remake")) return `${name} needs a copy of this clip`;
  return `Almost ready for ${name}`;
}

/** The campaign way may go up now: no `no`, `remake` or `todo`, and TikTok's Branded content is on. */
export function canUploadOf(items: readonly FitItem[]): boolean {
  return !items.some((i) => i.state === "no" || i.state === "remake" || i.state === "todo" || (i.rule === "paid_switch" && i.state === "fix"));
}

/** What the card holds right now. `chosen` null: every allowed place; `tiktok` null: TikTok's choices not known yet. */
export interface LiveCard {
  captions: Partial<Captions>;
  chosen: readonly Platform[] | null;
  tiktok: Pick<TikTokPostOptions, "brandContent"> | null;
}

/**
 * The fit again for what the card holds (fit.py `live`): the four live items are made again, then the verdict, the
 * headline and `canUpload` (`canRemake` stays: no live item changes what a copy can do).
 */
export function liveFit(cf: CampaignFit, card: LiveCard): CampaignFit {
  const uploadPlaces = cf.uploadPlaces;
  const going = uploadPlaces.filter((p) => card.chosen === null || card.chosen.includes(p));
  const kept = cf.items.filter(
    (i) => i.rule !== "tags" && i.rule !== "ad" && i.rule !== "paid_switch" && !(i.rule === "places" && (i.state === "ok" || (i.platform && uploadPlaces.includes(i.platform)))),
  );
  const required = cf.required;
  const items = sortItems([
    ...kept,
    ...placesLive(cf.campaignName, uploadPlaces, card.chosen),
    ...tagsLive(required, going, card.captions),
    ...adLive(required, going, card.captions),
    ...paidLive(going, card.tiktok, required.disclosure || DEFAULT_DISCLOSURE),
  ]);
  const verdict = verdictOf(items);
  return { ...cf, items, verdict, headline: headlineOf(verdict, cf.campaignName, items), canUpload: canUploadOf(items) };
}

// ---------- What the block draws (the words are the server's; these only pick) ----------

/** The block's own vermilion control (§39.3's last column), or null when Upload is the vermilion. */
export function fitMain(cf: CampaignFit): FitItem | null {
  if (cf.verdict === "doesnt_fit") return cf.items.find((i) => i.state === "no" && i.fix && (i.fix.kind === "new_clips" || i.fix.kind === "open")) ?? null;
  if (cf.verdict !== "fixable") return null;
  const todo = cf.items.find((i) => i.state === "todo" && i.fix);
  if (todo) return todo;
  return cf.items.find((i) => i.state === "remake" && i.fix?.kind === "remake") ?? null;
}

/** Upload's words while the fit keeps it off (null when it may go). */
export function uploadOffWords(cf: CampaignFit): string | null {
  if (cf.canUpload) return null;
  if (cf.verdict === "wait") return cf.items.find(isWait)?.text ?? `Wait a little for ${cf.campaignName}.`;
  if (cf.verdict === "doesnt_fit") return `This clip can't earn on ${cf.campaignName}.`;
  const todo = cf.items.find((i) => i.state === "todo");
  if (todo) return todo.text;
  const remake = cf.items.find((i) => i.state === "remake");
  if (remake) return `Tap ${remake.fix?.label ?? `Make a ${cf.campaignName} copy`} first.`;
  if (cf.items.some((i) => i.rule === "paid_switch" && i.state === "fix")) return "Turn on Branded content for TikTok first.";
  return `This clip can't earn on ${cf.campaignName}.`;
}

/** "Fixed: #Ad and #FaZe are back." for the toast after "Fix it for me" (what was missing on the card). */
export function fixedWords(cf: CampaignFit, going: readonly Platform[], captions: Partial<Captions>): string {
  const back: string[] = [];
  const disclosure = cf.required.disclosure || DEFAULT_DISCLOSURE;
  if (going.some((p) => !adFirst(String(captions[CAPTION_OF[p]] ?? ""), disclosure))) back.push(disclosure);
  const phrase = cf.required.phrase;
  for (const w of [...cf.required.tokens, ...(phrase ? [phrase] : [])])
    if (going.some((p) => !hasItem(String(captions[CAPTION_OF[p]] ?? ""), w))) back.push(shown(w, phrase));
  if (!back.length) return "Fixed: every caption is ready.";
  return `Fixed: ${joinList(back)} ${back.length === 1 ? "is" : "are"} back.`;
}

/** "Make new clips for this campaign": the campaign way, with the clip's own link only when the same video is fine
 * (a length, banned, posted or one-campaign problem of a link job). The API makes the same href; the mock uses this. */
export function newClipsHref(campaignId: string, rule: FitRule, link: string | null | undefined): string {
  const base = `/?campaign=${encodeURIComponent(campaignId)}`;
  return SAME_VIDEO.includes(rule) && link && /^https:\/\//.test(link) ? `${base}&link=${encodeURIComponent(link)}` : base;
}

/** Only a same-origin path, or an https page in a new tab: anything else is dropped. */
export function safeFixHref(fix: FitFix | null | undefined): { href: string; external: boolean } | null {
  const href = fix?.href;
  if (!href) return null;
  if (href.startsWith("/") && !href.startsWith("//") && !/[\\\s]/.test(href)) return { href, external: false };
  if (/^https:\/\/[^\s]+$/.test(href)) return { href, external: true };
  return null;
}

/** The "Read the rules" (and other) Open buttons of `check` items: one per different page, never one per line. */
export function checkPages(items: readonly FitItem[]): FitFix[] {
  const seen = new Set<string>();
  const out: FitFix[] = [];
  for (const i of items) {
    if (i.state !== "check" || i.fix?.kind !== "open" || !i.fix.href || seen.has(i.fix.href)) continue;
    seen.add(i.fix.href);
    out.push(i.fix);
  }
  return out;
}

/** The suggestion's soft-stop sentence ("Half the money is used. Post soon."), when the copy accepts one. */
export function softText(cf: CampaignFit): string | null {
  if (!cf.softCodes.length) return null;
  return cf.items.find((i) => i.rule === "soft" && i.fix?.label !== "Connect Content Rewards")?.text ?? null;
}

// ---------- This device's own answers (never sent, never needed to upload) ----------

const CHECKED = "cf-cr-checked";
const NOT_NOW = "cf-cr-not-now";
export const DEVICE_MAX = 200;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw) as unknown;
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, v: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(v));
    return true;
  } catch {
    return false;
  }
}

const checkedKey = (clipId: string, campaignId: string) => `${clipId}:${campaignId}`;

/** "I read them. They're OK" holds while every `check` line now is one he read (a new or changed line opens it). */
export function isChecked(clipId: string, campaignId: string, texts: readonly string[]): boolean {
  const all = readJson<Record<string, unknown>>(CHECKED, {});
  const saved = all && typeof all === "object" ? all[checkedKey(clipId, campaignId)] : undefined;
  if (!Array.isArray(saved) || !texts.length) return false;
  return texts.every((t) => saved.includes(t));
}

export function saveChecked(clipId: string, campaignId: string, texts: readonly string[]): boolean {
  const raw = readJson<Record<string, unknown>>(CHECKED, {});
  const all: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  const key = checkedKey(clipId, campaignId);
  delete all[key];
  all[key] = [...texts];
  const keys = Object.keys(all);
  for (const k of keys.slice(0, Math.max(0, keys.length - DEVICE_MAX))) delete all[k];
  return writeJson(CHECKED, all);
}

/** "Not now" on the "could earn" line hides it for that clip on this device. */
export function isNotNow(clipId: string): boolean {
  const list = readJson<unknown>(NOT_NOW, []);
  return Array.isArray(list) && list.includes(clipId);
}

export function saveNotNow(clipId: string): boolean {
  const raw = readJson<unknown>(NOT_NOW, []);
  const list = (Array.isArray(raw) ? raw : []).filter((x) => x !== clipId);
  list.push(clipId);
  return writeJson(NOT_NOW, list.slice(-DEVICE_MAX));
}

// ---------- GET /v1/contentrewards/fit: one shared store, batched, read again on live news ----------

export type FitLoad = { state: "loading"; data: null } | { state: "off"; data: null } | { state: "error"; data: ClipFit | null } | { state: "ok"; data: ClipFit };

const LOADING: FitLoad = { state: "loading", data: null };
const OFF: FitLoad = { state: "off", data: null };
const cache = new Map<string, FitLoad>();
const subs = new Map<string, Set<() => void>>();
let pending = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let liveTimer: ReturnType<typeof setTimeout> | null = null;
let stale = new Set<string>();
let unlisten: (() => void) | null = null;
/** An API before §39 (404) or Content Rewards switched off (503): nothing is asked again until a reload. */
let off = false;
export const FIT_BATCH = 20;
export const LIVE_DEBOUNCE_MS = 1000;

function put(clipId: string, v: FitLoad) {
  cache.set(clipId, v);
  for (const fn of subs.get(clipId) ?? []) fn();
}

async function flush() {
  flushTimer = null;
  const ids = [...pending];
  pending = new Set();
  for (let i = 0; i < ids.length; i += FIT_BATCH) {
    const chunk = ids.slice(i, i + FIT_BATCH);
    try {
      // Always the list form: an unknown clip is just left out (200), so a 404 can only mean an API from before §39.
      const list = await api().crFits(chunk);
      for (const fit of list) if (fit && typeof fit.clipId === "string") put(fit.clipId, { state: "ok", data: fit });
      for (const id of chunk) if (cache.get(id)?.state === "loading") put(id, OFF);
    } catch (e) {
      const kind = crAvailability(e);
      if (kind !== "error") {
        off = true;
        for (const id of chunk) put(id, OFF);
      } else for (const id of chunk) put(id, { state: "error", data: cache.get(id)?.data ?? null });
    }
  }
}

function ask(clipId: string) {
  if (off) {
    if (cache.get(clipId)?.state !== "off") put(clipId, OFF);
    return;
  }
  pending.add(clipId);
  if (!flushTimer) flushTimer = setTimeout(() => void flush(), 0);
}

function listen() {
  if (unlisten) return;
  unlisten = onLiveSignal((s) => {
    const watched = [...subs.keys()];
    let hit: string[] = [];
    if (s.kind === "resync") hit = watched;
    else {
      const e = s.event;
      if (e.type === "contentrewards" || e.type === "setup") hit = watched;
      else if (e.type === "clip") {
        hit = watched.filter((id) => id === e.id || (e.item && e.item.remakeOf?.clipId === id));
      } else if (e.type === "post") hit = watched.filter((id) => e.item?.clipId === id);
    }
    if (!hit.length) return;
    for (const id of hit) stale.add(id);
    if (liveTimer) clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      liveTimer = null;
      const ids = [...stale].filter((id) => subs.has(id));
      stale = new Set();
      for (const id of ids) ask(id);
    }, LIVE_DEBOUNCE_MS);
  });
}

/** Forgets everything (sign-out, tests). */
export function resetFits(): void {
  cache.clear();
  pending = new Set();
  stale = new Set();
  if (flushTimer) clearTimeout(flushTimer);
  if (liveTimer) clearTimeout(liveTimer);
  flushTimer = null;
  liveTimer = null;
  off = false;
  unlisten?.();
  unlisten = null;
}

/** Asks the fit of one clip again now (after a copy was asked for, or Fix it for me). */
export function reloadFit(clipId: string): void {
  ask(clipId);
}

/** One clip's fit, from the shared store (`enabled` false: nothing is asked). */
export function useClipFit(clipId: string | null, enabled = true): FitLoad & { reload: () => void } {
  const on = !!clipId && enabled;
  const subscribe = useCallback(
    (fn: () => void) => {
      if (!on || !clipId) return () => undefined;
      const set = subs.get(clipId) ?? new Set();
      set.add(fn);
      subs.set(clipId, set);
      listen();
      if (!cache.has(clipId)) {
        cache.set(clipId, LOADING);
        ask(clipId);
      }
      return () => {
        set.delete(fn);
        if (!set.size) subs.delete(clipId);
        if (!subs.size) {
          unlisten?.();
          unlisten = null;
        }
      };
    },
    [clipId, on],
  );
  const snap = useSyncExternalStore(
    subscribe,
    () => (on && clipId ? (cache.get(clipId) ?? LOADING) : OFF),
    () => OFF,
  );
  const reload = useCallback(() => {
    if (clipId) ask(clipId);
  }, [clipId]);
  return { ...snap, reload };
}
