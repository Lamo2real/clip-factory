// Does this clip fit the campaign? In the pretend app (docs/CONTRACTS.md §39.3). Mock builds only.
//
// A smaller copy of the API's contentrewards/fit.py over the pretend store, with the server's own words, so every
// verdict can be seen and tested offline: the campaign's stops, the deadline, the length, the places, the tags and
// #Ad (the web's own live port, lib/crFit.ts), the paid switches, the logo, "Paid partnership" on the video, the
// source, the language, banned content, what Clip Factory can't check, an earlier normal post, one campaign per
// moment, and who sends it. The copy (remake) is switched off like the API's `cr_remake_enabled` until a test or the
// start flag `cf-mock-cr-remake = "on"` turns it on.
import type { Campaign, CampaignFit, Clip, ClipFit, CrConnection, FitFix, FitItem, FitRule, FitState, Job, Platform, Post } from "../types.ts";
import { adLive, canUploadOf, headlineOf, isWait, joinList, newClipsHref, paidLive, placesLive, sortItems, tagsLive, verdictOf } from "../../lib/crFit.ts";
import { campaignPath, CR_SETUP_PATH } from "../../lib/contentRewards.ts";
import { PLATFORM_LABEL, PLATFORM_ORDER } from "../../lib/format.ts";
import { CR_DISCOVER, CR_SETTINGS } from "../../setup/contentrewards.ts";

const OWN_ROWS = new Set(["deadline", "logo_missing", "no_place", "tiktok_only"]);
const ELSEWHERE = new Set(["ended", "budget_gone", "drafts_first", "sound_needed", "overlay_needed", "cap_reached", "not_accepted"]);
const WAITS = new Set(["waiting", "held", "paused"]);
const SOFT_NOTES = new Set(["budget_half", "low_rate", "not_connected"]);
const SOFT_CHECKS = new Set(["face_needed", "audience"]);
const COPY_KEEPS = new Set<FitRule>(["campaign", "deadline", "length", "places", "source", "language", "one_campaign"]);
const READING = "Reading the rules… Look again in a minute.";
const GONE = "This video is gone from Clip Factory. Make new clips for this campaign.";
const AUTO_SEND = "After it posts, Clip Factory sends it to Content Rewards by itself.";
const HAND_SEND = "After it posts, send its link to Content Rewards within 30 minutes. I'll remind you.";
const SPOKEN = "The brand wants “paid partnership” said out loud. Clip Factory can't. This clip may be turned down.";
const TIKTOK_WAITS = "TikTok is left out for now. Until TikTok checks Clip Factory, TikTok posts are private, and private posts can't earn.";
const SOURCE_KEPT_MS = 13 * 86_400_000;
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LANGUAGES: [string, string][] = [
  ["en", "English"],
  ["es", "Spanish"],
  ["pt", "Portuguese"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["hi", "Hindi"],
  ["ar", "Arabic"],
  ["tr", "Turkish"],
  ["ru", "Russian"],
];

const label = (p: Platform) => PLATFORM_LABEL[p];
const possessive = (name: string) => (name.endsWith("s") ? `${name}'` : `${name}'s`);
const day = (iso: string) => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
};
const seconds = (n: number) => (n === 1 ? "1 second" : `${n} seconds`);
const item = (rule: FitRule, state: FitState, text: string, fix: FitFix | null = null, platform?: Platform): FitItem =>
  platform ? { rule, state, text, fix, platform } : { rule, state, text, fix };
const open = (labelText: string, href: string, external = false): FitFix => ({ kind: "open", label: labelText, href, ...(external ? { external: true } : {}) });
const readRules = (cid: string) => open("Read the rules", `${campaignPath(cid)}#rules`);
const findAnother = () => open("Find another campaign", CR_DISCOVER, true);
const settings = () => open("Open Content Rewards settings", CR_SETTINGS, true);

/** Every language of the table the rule text names (whole words, any case). */
function languagesIn(text: string): [string, string][] {
  const words = new Set(text.toLowerCase().split(/[^a-z]+/).filter(Boolean));
  return LANGUAGES.filter(([code, name]) => words.has(code) || words.has(name.toLowerCase()));
}

export interface FitInputs {
  clip: Clip;
  job: Job | null;
  campaign: Campaign;
  conn: CrConnection;
  posts: Post[];
  /** The campaigns of the clip's original and its other copies (one campaign per moment). */
  others: { campaignId: string; name: string }[];
  remakeOn: boolean;
  now: number;
}

const checklist = (clip: Clip, key: string) => clip.checklist.items.find((i) => i.key === key) ?? null;
const linkOf = (job: Job | null) => (job?.source.type === "link" || job?.source.fetchedBy === "mac" ? (job.source.url ?? null) : null);

export function sourceKept(job: Job | null, now: number): boolean {
  if (!job) return false;
  if (job.source.type === "link") return true;
  return now - Date.parse(job.createdAt) < SOURCE_KEPT_MS;
}

/** This clip against this campaign, with the server's words (a copy of fit.py's rows). */
export function fitOne(i: FitInputs): CampaignFit {
  const { clip, job, campaign: c, conn } = i;
  const cid = c.campaignId;
  const name = c.name;
  const brand = c.brand || name;
  const rules = c.rules;
  const mine = (clip.campaignId ?? job?.campaignId) === cid;
  const newClips = (rule: FitRule): FitFix => ({ kind: "new_clips", label: "Make new clips for this campaign", href: newClipsHref(cid, rule, linkOf(job)) });
  const remake = (): FitFix => ({ kind: "remake", label: `Make a ${name} copy` });
  const items: FitItem[] = [];

  // The campaign's own stops.
  for (const s of c.stops) {
    if (!s.hard) {
      if (s.code === "not_connected") items.push(item("soft", "note", s.text, open("Connect Content Rewards", CR_SETUP_PATH)));
      else if (SOFT_NOTES.has(s.code)) items.push(item("soft", "note", s.text));
      else if (SOFT_CHECKS.has(s.code)) items.push(item("soft", "check", s.text, readRules(cid)));
      continue;
    }
    if (OWN_ROWS.has(s.code)) continue;
    if (ELSEWHERE.has(s.code)) items.push(item("campaign", "no", s.text, findAnother()));
    else if (s.code === "rules_reading") items.push(item("campaign", "todo", READING));
    else if (WAITS.has(s.code)) items.push(item("campaign", "todo", s.text));
    else if (s.code === "not_checked") items.push(item("campaign", "todo", s.text, open("Connect Content Rewards", CR_SETUP_PATH)));
    else if (s.code === "not_joined" || s.code === "left") items.push(item("campaign", "todo", s.text, open("Open campaign", c.url, true)));
    else if (s.code === "apply_first") items.push(item("campaign", "todo", s.text, open("Yes, I applied", campaignPath(cid))));
    else if (s.code === "rules_failed") items.push(item("campaign", "todo", s.text, open("Open campaign", `${campaignPath(cid)}#rules`)));
    else items.push(item("campaign", "no", s.text, findAnother()));
  }

  // The deadline.
  if (rules?.clipUntil) {
    const today = new Date(i.now).toISOString().slice(0, 10);
    const last = rules.clipUntil.slice(0, 10);
    if (last > today) items.push(item("deadline", "ok", `Takes clips until ${day(last)}.`));
    else if (last === today) items.push(item("deadline", "note", `Today is the last day ${name} takes clips.`));
    else items.push(item("deadline", "no", `${name} stopped taking clips on ${day(last)}.`, findAnother()));
  }

  // The length.
  const lo = rules?.lengthMinSec ?? null;
  const hi = rules?.lengthMaxSec ?? null;
  if (lo !== null || hi !== null) {
    const takes = lo !== null && hi !== null ? `${lo} to ${hi}` : lo !== null ? `${lo} or more` : `up to ${hi}`;
    const secs = Math.floor(clip.durationSec + 0.5);
    if ((lo !== null && clip.durationSec < lo) || (hi !== null && clip.durationSec > hi)) {
      const shown = lo !== null && clip.durationSec < lo ? Math.min(secs, lo - 1) : Math.max(secs, (hi ?? 0) + 1);
      items.push(item("length", "no", `This clip is ${seconds(shown)}. ${name} takes ${takes} seconds.`, newClips("length")));
    } else items.push(item("length", "ok", `${seconds(secs)}. ${name} takes ${takes}.`));
  }

  // The places.
  const paid = PLATFORM_ORDER.filter((p) => c.platformsPaid.includes(p));
  const places = paid.length && paid.every((p) => p === "tiktok") ? [] : c.uploadPlaces;
  const named = new Set<Platform>();
  if (!paid.length) {
    if (c.membership === "in" || c.membership === "manual") items.push(item("places", "todo", `I can't tell where ${name} pays yet. Tap Check now.`, open("Open campaign", campaignPath(cid))));
  } else if (paid.every((p) => p === "tiktok")) {
    const stop = c.stops.find((s) => s.code === "tiktok_only");
    items.push(item("places", "no", stop?.text ?? `${name} only pays for TikTok.`, findAnother()));
  } else if (!places.length) {
    const first = paid.find((p) => p !== "tiktok") ?? paid[0]!;
    if (conn.crLinked[first] === false) {
      items.push(item("places", "todo", `Add ${label(first)} in Content Rewards first. Then tap I added it.`, settings(), first));
      named.add(first);
    } else items.push(item("places", "todo", `Set up ${label(first)} first. ${name} pays for ${joinList(paid.map(label))}.`, open(`Set up ${label(first)}`, `/settings/posting/setup/${first}`)));
  } else {
    for (const p of paid) {
      if (places.includes(p) || conn.crLinked[p] === false) continue;
      if (p === "tiktok") items.push(item("places", "note", TIKTOK_WAITS, null, p));
      else items.push(item("places", "note", `${label(p)} pays too. Set it up to earn there as well.`, open(`Set up ${label(p)}`, `/settings/posting/setup/${p}`), p));
    }
  }
  items.push(...placesLive(name, places, null));
  const added = conn.stepsDone.includes("ready-socials");
  for (const p of places) if (conn.crLinked[p] === undefined && !added) items.push(item("place_link", "check", `I couldn't check that Content Rewards knows your ${label(p)} account. Look under **Accounts** there.`, settings(), p));
  for (const p of PLATFORM_ORDER)
    if (paid.includes(p) && !places.includes(p) && !named.has(p) && conn.crLinked[p] === false)
      items.push(item("place_link", "note", `Content Rewards doesn't know your ${label(p)} account. Add it there, then tap I added it.`, settings(), p));

  // The tags, #Ad and the paid switches: only a campaign clip goes up the campaign way itself.
  const disclosure = rules?.disclosure.caption ?? "#Ad";
  const required = { disclosure, tokens: [...(rules?.requiredHashtags ?? []), ...(rules?.requiredTags ?? [])].filter((t, n, all) => all.findIndex((x) => x.toLowerCase() === t.toLowerCase()) === n), phrase: rules?.requiredCaptionText ?? null };
  const upload = mine ? places : [];
  items.push(...tagsLive(required, upload, clip.captions), ...adLive(required, upload, clip.captions), ...paidLive(upload, null, disclosure));

  // The logo and "Paid partnership" on the video.
  if (c.logo.needed) {
    const row = mine ? checklist(clip, "logo") : null;
    if (row?.pass || (mine && !row)) items.push(item("logo", "ok", `The ${brand} logo is on the whole clip.`));
    else if (c.logo.state === "ready") items.push(item("logo", "remake", `The ${brand} logo isn't on this clip.`, remake()));
    else items.push(item("logo", "todo", `Add the ${brand} logo on the campaign page first.`, open("Open campaign", campaignPath(cid))));
  }
  const words = rules?.disclosure.onScreen ?? "Paid partnership";
  const shown = mine ? (checklist(clip, "disclosure")?.pass ?? true) : false;
  items.push(shown ? item("on_screen", "ok", `“${words}” shows for the first 3 seconds.`) : item("on_screen", "remake", `“${words}” isn't on the video.`, remake()));

  // Where the video is from.
  const allowed = rules?.allowedSources;
  const owner = possessive(brand);
  if (allowed?.campaignProvidedOnly && rules?.sourceVideos.length) {
    const link = linkOf(job);
    if (link && rules.sourceVideos.some((v) => v.url === link)) items.push(item("source", "ok", `From a ${name} video.`));
    else items.push(item("source", "no", `${name} only pays for clips of its own videos.`, newClips("source")));
  } else if (allowed?.channels.length) {
    const video = (job?.source.channelKeys ?? [job?.source.channel ?? ""]).map((k) => k.toLowerCase().replace(/[\W_]+/g, "")).filter((k) => k.length >= 3);
    const wanted = allowed.channels.map((ch) => ch.name.toLowerCase().replace(/[\W_]+/g, "")).filter((k) => k.length >= 3);
    const matched = video.length ? video.some((v) => wanted.some((w) => v.includes(w) || w.includes(v))) : null;
    const site = job?.source.platform && job.source.platform !== "upload" ? PLATFORM_LABEL[job.source.platform] : null;
    if (matched === true) items.push(item("source", "ok", `From ${owner} ${site ?? "channel"}.`));
    else if (matched === false) items.push(item("source", "check", `This video may not be from ${owner} channels. ${name} only pays for those. Look yourself.`, readRules(cid)));
    else items.push(item("source", "check", `I couldn't check where this video is from. ${name} wants clips from ${owner} channels. Look yourself.`, readRules(cid)));
  } else items.push(item("source", "ok", `Any video is fine for ${name}.`));

  // The language.
  if (rules?.language?.trim()) {
    const wanted = languagesIn(rules.language);
    const wantWords = wanted.length ? joinList(wanted.map(([, n]) => n)).replace(/ and ([^,]+)$/, " or $1") : rules.language;
    const spoken = job?.sourceLanguage ? LANGUAGES.find(([code]) => code === job.sourceLanguage!.split("-")[0]!.toLowerCase()) : undefined;
    if (!wanted.length || !spoken) items.push(item("language", "check", `I couldn't check the language. ${name} wants ${wantWords}.`, readRules(cid)));
    else if (wanted.some(([code]) => code === spoken[0])) items.push(item("language", "ok", `In ${spoken[1]}.`));
    else items.push(item("language", "no", `This clip is in ${spoken[1]}. ${name} wants ${wantWords}.`, newClips("language")));
  }

  // Banned content.
  const banned = joinList((rules?.bannedContent ?? []).map((b) => b.replace(/^no\s+/i, ""))).replace(/ and ([^,]+)$/, " or $1");
  const judged = mine ? checklist(clip, "campaign_rules") : null;
  if (judged && judged.pass === false) items.push(item("banned", "no", judged.note ? `${judged.note.replace(/[.!?]+$/, "")}.` : `This clip doesn't follow ${possessive(name)} rules.`, newClips("banned")));
  else if (banned) {
    // The pretend agent judged every campaign clip against its rules (§38.13).
    if (mine) items.push(item("banned", "ok", `No ${banned}. Checked.`));
    else items.push(item("banned", "check", `I couldn't check: no ${banned}. Look yourself.`, readRules(cid)));
  }
  if (rules?.disclosure.spoken) items.push(item("spoken", "check", SPOKEN, readRules(cid)));
  const unsure = [...(rules?.uncertain.length ? rules.uncertain : c.uncertain), ...(!mine ? (rules?.otherRules ?? []) : [])].filter((l) => l.trim());
  for (const l of unsure.slice(0, 5)) items.push(item("uncertain", "check", `I couldn't check: ${l.replace(/[.!?]+$/, "")}. Look yourself.`, readRules(cid)));
  if (unsure.length > 5) items.push(item("uncertain", "note", `And ${unsure.length - 5} more on the campaign page.`, readRules(cid)));
  if (rules?.coverImageRequired) items.push(item("brief_only", "check", "I couldn't check: the brand's cover picture.", readRules(cid)));
  if (rules?.layoutNotes?.trim()) items.push(item("brief_only", "check", `I couldn't check: ${rules.layoutNotes.replace(/[.!?]+$/, "")}.`, readRules(cid)));

  // An earlier normal post, and one campaign per moment.
  const normal = i.posts.filter((p) => !p.campaignId && (p.status === "posted" || p.status === "queued"));
  if (normal.length) {
    const first = [...normal].sort((a, b) => (a.status === "posted" ? 0 : 1) - (b.status === "posted" ? 0 : 1) || PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform))[0]!;
    items.push(item("posted", "remake", `This clip is ${first.status === "posted" ? "already up on" : "already going up on"} ${label(first.platform)}. Content Rewards only takes a post sent in its first 30 minutes.`, remake()));
  }
  const owners = [clip.campaignId, job?.campaignId, ...i.posts.map((p) => p.campaignId), ...i.others.map((o) => o.campaignId)];
  const other = owners.find((x): x is string => !!x && x !== cid);
  if (other) items.push(item("one_campaign", "no", `This clip is for ${i.others.find((o) => o.campaignId === other)?.name || "another campaign"}. One clip can earn on one campaign only.`, newClips("one_campaign")));

  // Who sends it.
  const auto = conn.status === "connected" && conn.canSubmit && !conn.blocked && c.membership === "in";
  items.push(item("send", "note", auto ? AUTO_SEND : HAND_SEND));

  // A copy that can't be made (switched off, or the video is gone) is "make new clips".
  const kept = sourceKept(job, i.now);
  if (!i.remakeOn || !kept) {
    const reason = !i.remakeOn ? `Clip Factory can't make a ${name} copy yet. Make new clips for this campaign.` : GONE;
    let first = true;
    for (const it of items)
      if (it.state === "remake") {
        it.state = "no";
        it.fix = newClips(it.rule);
        if (first) it.text = `${it.text} ${reason}`;
        first = false;
      }
  }
  const sorted = sortItems(items);
  const verdict = verdictOf(sorted);
  const keeps = new Set(COPY_KEEPS);
  if (c.logo.state !== "ready") keeps.add("logo");
  const canRemake = i.remakeOn && kept && !sorted.some(isWait) && !sorted.some((x) => keeps.has(x.rule) && (x.state === "no" || x.state === "todo"));
  return {
    campaignId: cid,
    campaignName: name,
    verdict,
    headline: headlineOf(verdict, name, sorted),
    canUpload: canUploadOf(sorted),
    canRemake,
    items: sorted,
    softCodes: c.stops.filter((s) => !s.hard && s.code !== "not_connected" && !s.anyway).map((s) => s.code),
    required,
    uploadPlaces: [...places],
    checkedAt: new Date(i.now).toISOString(),
  };
}

/** ClipFit: a campaign clip against its campaign; a normal clip against every campaign he is in (newest first, 10). */
export function clipFit(clip: Clip, inputs: (campaign: Campaign) => FitInputs, campaigns: Campaign[]): ClipFit {
  const own = clip.campaignId;
  const remakes = clip.remakes ?? {};
  if (own) {
    const c = campaigns.find((x) => x.campaignId === own);
    return { clipId: clip.clipId, mode: "campaign", fits: c ? [fitOne(inputs(c))] : [], suggestion: null, remakes };
  }
  const mineNow = campaigns
    .filter((c) => c.membership === "in" || c.membership === "manual")
    .sort((a, b) => (b.inSince ?? "").localeCompare(a.inSince ?? ""))
    .slice(0, 10);
  const fits = mineNow.map((c) => fitOne(inputs(c)));
  const pick = fits.find((f) => f.canRemake && f.items.some((x) => x.rule === "source" && x.state === "ok"));
  return { clipId: clip.clipId, mode: "normal", fits, suggestion: pick ? { campaignId: pick.campaignId, name: pick.campaignName } : null, remakes };
}

/** The copy route's refusal words (§39.3), or null when the copy may be made. */
export function remakeRefusal(fit: CampaignFit, kept: boolean): string | null {
  if (fit.canRemake) return null;
  if (!kept) return GONE;
  const wait = fit.items.find(isWait);
  if (wait) return `Not yet for ${fit.campaignName}: ${wait.text}`;
  return fit.items.find((x) => x.state === "no" || x.state === "todo")?.text ?? `Clip Factory can't make a ${fit.campaignName} copy yet.`;
}

/** Confirm's refusal for a campaign clip (§39.3): the first no, remake or todo item. */
export function uploadRefusal(fit: CampaignFit): string | null {
  const first = fit.items.find((x) => x.state === "no" || x.state === "remake" || x.state === "todo");
  if (!first) return null;
  return isWait(first) ? `Not yet for ${fit.campaignName}: ${first.text}` : `This clip can't earn on ${fit.campaignName}: ${first.text}`;
}
