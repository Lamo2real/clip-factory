// Ask Clip Factory's retriever (docs/CONTRACTS.md §19.4). The same rules as
// api/src/clipfactory_api/help/retrieve.py, kept honest by the shared eval file (helpEvals.json):
// * In-memory BM25F (k1 1.2, b 0.75) over the docs that pass the `when` filter. Field weights: title 3,
//   keywords 2.5, where 1.5, answer and steps 1. No vectors, no network.
// * Words are folded (lower case, no accents, no apostrophes), split on anything that is not a letter or digit,
//   stopwords dropped and stemmed. Every content word of the question is a group: its stem, the stems of a synonym
//   phrase it belongs to ("tik tok" → tiktok), and for stems of 5+ letters no doc uses, every doc stem of 5+
//   letters one edit away ("instagarm" → instagram).
// * Score = Σ over the distinct terms of weight × bm25 (weight 1 for the question, 0.5 for words merged in from the
//   previous question). +10 % for docs on the page the owner is on (a skill page counts as Settings). Ties go to guides, then the smaller id, and a
//   curated guide within 10 % of a generated doc on the same route (without #hash) wins that near tie (GUIDE_TIE).
// * Accepted only when score ≥ 2, at least half of the question's groups match, and one of the question's own
//   terms is in the doc's title or keywords.
// * Follow-ups: a question is ranked on its own first. It borrows the previous user question's words only when it
//   starts with a follow-up phrase ("and …", "what about …"), or when it is short (≤ 4 content words) and unknown
//   on its own. So "What does Keep do?" right after another question still answers Keep. The previous user turn's
//   words are its text plus `seen`, what its pictures showed (§26).
import type { HelpContext, HelpDoc, HelpTurn } from "./types.ts";

export const K1 = 1.2;
export const B = 0.75;
export const MIN_SCORE = 2.0;
export const MIN_MATCHED = 0.5;
export const MAX_CANDIDATES = 6;
export const PAGE_BOOST = 1.1;
export const FOLLOW_UP_WEIGHT = 0.5;
export const FOLLOW_UP_MAX_WORDS = 4;
export const FUZZY_MIN_LEN = 5;
/** A guide scoring at least this share of a generated doc's score on the same route goes first. */
export const GUIDE_TIE = 0.9;
const FIELD_WEIGHT = { title: 3, keywords: 2.5, where: 1.5, body: 1 } as const;
const FOLLOW_UP_STARTS = ["and ", "what about ", "how about ", "and on ", "where is that"];

export interface Words {
  synonyms: Readonly<Record<string, string>>;
  stopwords: readonly string[];
}

export interface Candidate {
  doc: HelpDoc;
  score: number;
}

export interface Ranked {
  /** The question that was ranked (a follow-up carries the previous question too). */
  question: string;
  known: boolean;
  refused: boolean;
  followUp: boolean;
  /** Best first, at most six; empty unless known. */
  candidates: Candidate[];
}

// ---------- Words ----------

/** Lower case without accents. */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");
}

/** Normalised words in order (apostrophes join: "don't" → "dont"). */
export function tokenize(s: string): string[] {
  return fold(s)
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const SUFFIXES: [string, string][] = [
  ["ies", "y"],
  ["ing", ""],
  ["ed", ""],
  ["ly", ""],
  ["es", ""],
  ["s", ""],
];

/** A light suffix stemmer: -ies→y, -es, -s, -ing, -ed, -ly; never below 3 letters. */
export function stem(word: string): string {
  if (/^\d+$/.test(word)) return word;
  for (const [suffix, repl] of SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length + repl.length >= 3) {
      if (suffix === "es" && !/(ches|shes|sses|xes|zes)$/.test(word)) continue;
      if (suffix === "s" && word.endsWith("ss")) continue;
      return word.slice(0, word.length - suffix.length) + repl;
    }
  }
  return word;
}

/** True when a and b differ by at most one insert, delete, change or swap of neighbours ("instagarm"). */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diff: number[] = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i);
    if (diff.length === 1) return true;
    const [i, j] = diff;
    return diff.length === 2 && j === i! + 1 && a[i!] === b[j!] && a[j!] === b[i!];
  }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < s.length && s[i] === l[i]) i++;
  return s.slice(i) === l.slice(i + 1);
}

function terms(text: string, stop: ReadonlySet<string>): string[] {
  return tokenize(text)
    .filter((w) => !stop.has(w))
    .map(stem);
}

export function contentWords(text: string, stop: ReadonlySet<string>): string[] {
  return tokenize(text).filter((w) => !stop.has(w));
}

// ---------- Refusals and follow-ups ----------

const REFUSE: RegExp[] = [
  /\b(passwords?|passcodes?|api ?keys?|access ?keys?|secret|secrets|tokens?|credentials?|private keys?)\b/i,
  /\b(show|read|see|print|give|tell)\b.{0,40}\bcookies?\b.{0,20}\b(file|txt|contents?|inside|say|says|values?)\b/i,
  /\b(what'?s|what is|whats)\s+(in|inside)\b.{0,20}\bcookies?\b/i,
  /\bcookies?\b.{0,20}\b(contents?|values?)\b/i,
  /\b(another|other|someone else'?s?|somebody else'?s?|other people'?s?)\s+(users?|persons?|people|owners?|creators?)\b/i,
  /\b(someone|somebody) else'?s?\b/i,
  /\bother people'?s?\b/i,
  /\b(your|clip factory'?s?|the app'?s?)\s+(servers?|database|backend|infrastructure|source code|aws|cloud|hosting)\b/i,
  /\bhow (is|are) (it|this|you|clip factory|the app) (hosted|built|run)\b/i,
  /\b(aws|amazon web services|dynamodb|lambda|bedrock|cognito|cloudfront|terraform|s3 bucket)\b/i,
];

/** Asks for secrets, the cookie file's contents, other people's things, or how Clip Factory itself is run. */
export function isRefused(question: string): boolean {
  const q = fold(question).replace(/’/g, "'");
  return REFUSE.some((r) => r.test(q));
}

/** Short enough (≤ 4 content words) or worded like a follow-up: may borrow the previous question's words. */
export function isFollowUp(question: string, stop: ReadonlySet<string>): boolean {
  return contentWords(question, stop).length <= FOLLOW_UP_MAX_WORDS || startsFollowUp(question);
}

/** The previous user turn's words: its text plus `seen`, what its pictures showed (§26). */
export function previousUserQuestion(history: readonly HelpTurn[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i]!;
    if (t.role !== "user" || typeof t.text !== "string") continue;
    const text = typeof t.seen === "string" && t.seen.trim() ? `${t.text} ${t.seen}` : t.text;
    if (text.trim()) return text.trim();
  }
  return null;
}

// ---------- When filter ----------

/** Docs the owner should see here (§19.1): device, OS and installed state only. No context: nothing is filtered. */
export function visibleDocs(docs: readonly HelpDoc[], context: HelpContext | null | undefined): HelpDoc[] {
  if (!context) return docs.slice();
  return docs.filter((d) => {
    const w = d.when;
    if (!w) return true;
    if (w.device && !w.device.includes(context.device)) return false;
    if (w.os && !w.os.includes(context.os)) return false;
    if (w.installed !== undefined && w.installed !== context.installed) return false;
    return true;
  });
}

/** The router's page name for an app path (a copy of lib/router.ts `match` rules, free of the DOM). */
export function pageOf(route: string): HelpContext["page"] {
  const path = (route.split("?")[0] ?? "").split("#")[0]!.replace(/\/+$/, "") || "/";
  if (path === "/") return "home";
  if (path === "/jobs") return "jobs";
  if (path.startsWith("/jobs/")) return "job";
  if (path === "/review") return "review";
  if (path === "/library") return "library";
  if (path.startsWith("/clips/")) return "clip";
  if (path === "/settings" || path.startsWith("/settings/")) return "settings";
  if (path === "/get-app") return "get_app";
  return "not_found";
}

// ---------- Index ----------

interface Index {
  docs: HelpDoc[];
  tf: Map<string, number>[];
  lengths: number[];
  titleTerms: Set<string>[];
  df: Map<string, number>;
  avgLen: number;
}

function build(docs: HelpDoc[], stop: ReadonlySet<string>): Index {
  const tf: Map<string, number>[] = [];
  const lengths: number[] = [];
  const titleTerms: Set<string>[] = [];
  const df = new Map<string, number>();
  for (const doc of docs) {
    const fields = {
      title: terms(doc.title, stop),
      keywords: doc.keywords.flatMap((k) => terms(k, stop)),
      where: terms(doc.where, stop),
      body: terms([doc.answer, ...doc.steps].join(" "), stop),
    };
    const counts = new Map<string, number>();
    let length = 0;
    for (const name of ["title", "keywords", "where", "body"] as const) {
      const weight = FIELD_WEIGHT[name];
      length += weight * fields[name].length;
      for (const t of fields[name]) counts.set(t, (counts.get(t) ?? 0) + weight);
    }
    tf.push(counts);
    lengths.push(length);
    titleTerms.push(new Set([...fields.title, ...fields.keywords]));
    for (const t of counts.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const avg = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 1;
  return { docs, tf, lengths, titleTerms, df, avgLen: avg || 1 };
}

function bm25(index: Index, n: number, term: string): number {
  const tf = index.tf[n]!.get(term) ?? 0;
  if (tf <= 0) return 0;
  const count = index.docs.length;
  const df = index.df.get(term) ?? 0;
  const idf = Math.log(1 + (count - df + 0.5) / (df + 0.5));
  const norm = K1 * (1 - B + (B * index.lengths[n]!) / index.avgLen);
  return (idf * tf * (K1 + 1)) / (tf + norm);
}

// ---------- Query ----------

interface Group {
  alternatives: Set<string>;
  weight: number;
  own: boolean;
}

function groups(text: string, weight: number, own: boolean, words: Words, stop: ReadonlySet<string>, vocab: readonly string[]): Group[] {
  const raw = tokenize(text);
  const extra = new Map<number, Set<string>>();
  for (const [phrase, canonical] of Object.entries(words.synonyms)) {
    const parts = tokenize(phrase);
    if (!parts.length) continue;
    const canon = tokenize(canonical)
      .filter((w) => !stop.has(w))
      .map(stem);
    for (let i = 0; i + parts.length <= raw.length; i++) {
      if (!parts.every((p, j) => raw[i + j] === p)) continue;
      for (let j = i; j < i + parts.length; j++) {
        const set = extra.get(j) ?? new Set<string>();
        for (const c of canon) set.add(c);
        extra.set(j, set);
      }
    }
  }
  const vocabSet = new Set(vocab);
  const out: Group[] = [];
  raw.forEach((word, i) => {
    if (stop.has(word) && !extra.has(i)) return;
    const alternatives = new Set<string>(stop.has(word) ? [] : [stem(word)]);
    for (const e of extra.get(i) ?? []) alternatives.add(e);
    for (const a of Array.from(alternatives)) {
      if (a.length < FUZZY_MIN_LEN || vocabSet.has(a)) continue;
      for (const v of vocab) if (v.length >= FUZZY_MIN_LEN && withinOneEdit(a, v)) alternatives.add(v);
    }
    if (alternatives.size) out.push({ alternatives, weight, own });
  });
  return out;
}

const routePath = (d: HelpDoc) => d.route.split("#")[0];

/** A curated guide wins a near tie (within 10 %) with a generated doc on the same route (retrieve.py _guides_first). */
function guidesFirst(scored: { score: number; n: number }[], docs: readonly HelpDoc[]): void {
  const top = docs[scored[0]!.n]!;
  if (top.kind === "guide") return;
  for (let i = 1; i < scored.length; i++) {
    const row = scored[i]!;
    if (row.score < GUIDE_TIE * scored[0]!.score) return;
    const doc = docs[row.n]!;
    if (doc.kind === "guide" && routePath(doc) === routePath(top)) {
      scored.splice(i, 1);
      scored.unshift(row);
      return;
    }
  }
}

/** The page a doc boost compares against: a skill page is part of Settings (§19.4). */
export function boostPage(page: HelpContext["page"] | null | undefined): HelpContext["page"] | null {
  if (!page) return null;
  return page === "skill" ? "settings" : page;
}

/** Starts with an explicit follow-up phrase ("and the error sound?", "what about TikTok?"). */
export function startsFollowUp(question: string): boolean {
  const lowered = `${tokenize(question).join(" ")} `;
  return FOLLOW_UP_STARTS.some((s) => lowered.startsWith(s));
}

function scoreGroups(index: Index, gs: Group[], context: HelpContext | null | undefined, merged: string, followUp: boolean): Ranked {
  const none: Ranked = { question: merged, known: false, refused: false, followUp, candidates: [] };
  if (!gs.length) return none;
  const weights = new Map<string, number>();
  for (const g of gs) for (const t of g.alternatives) weights.set(t, Math.max(weights.get(t) ?? 0, g.weight));
  const own = gs.filter((g) => g.own);
  const ownTerms = new Set(own.flatMap((g) => Array.from(g.alternatives)));
  const page = boostPage(context?.page);

  const scored: { score: number; guide: number; id: string; n: number }[] = [];
  index.docs.forEach((doc, n) => {
    let score = 0;
    for (const [t, w] of weights) score += w * bm25(index, n, t);
    if (score <= 0) return;
    if (page && pageOf(doc.route) === page) score *= PAGE_BOOST;
    scored.push({ score: Math.round(score * 1e6) / 1e6, guide: doc.kind === "guide" ? 0 : 1, id: doc.id, n });
  });
  if (!scored.length) return none;
  scored.sort((a, b) => b.score - a.score || a.guide - b.guide || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  guidesFirst(scored, index.docs);
  const best = scored[0]!;
  const tf = index.tf[best.n]!;
  const matched = own.filter((g) => Array.from(g.alternatives).some((t) => (tf.get(t) ?? 0) > 0)).length;
  const titleHit = Array.from(ownTerms).some((t) => index.titleTerms[best.n]!.has(t));
  if (best.score < MIN_SCORE || matched < MIN_MATCHED * own.length || !titleHit) return none;
  return {
    question: merged,
    known: true,
    refused: false,
    followUp,
    candidates: scored.slice(0, MAX_CANDIDATES).map((s) => ({ doc: index.docs[s.n]!, score: s.score })),
  };
}

/**
 * Ranks the docs the owner can see for one question. Refusals and unknowns carry no candidates (and never cost a
 * model call). The question is ranked on its own first. It is merged with the previous user question only when it
 * starts with a follow-up phrase ("and the error sound?"), or when it is short (≤ 4 content words) and unknown on
 * its own, so a complete question asked after another one still finds its own answer.
 */
export function rank(
  docs: readonly HelpDoc[],
  question: string,
  history: readonly HelpTurn[],
  context: HelpContext | null | undefined,
  words: Words,
): Ranked {
  if (isRefused(question)) return { question, known: false, refused: true, followUp: false, candidates: [] };
  const stop = new Set(words.stopwords.map((w) => w.toLowerCase()));
  const shown = visibleDocs(docs, context);
  if (!shown.length) return { question, known: false, refused: false, followUp: false, candidates: [] };
  const index = build(shown, stop);
  const vocab = Array.from(index.df.keys());
  const gs = groups(question, 1, true, words, stop, vocab);
  const previous = previousUserQuestion(history);
  if (previous === null || previous.trim() === question.trim()) return scoreGroups(index, gs, context, question, false);
  if (!startsFollowUp(question)) {
    const alone = scoreGroups(index, gs, context, question, false);
    if (alone.known || !isFollowUp(question, stop)) return alone;
  }
  const merged = gs.concat(groups(previous, FOLLOW_UP_WEIGHT, gs.length === 0, words, stop, vocab));
  return scoreGroups(index, merged, context, `${previous} ${question}`, true);
}
