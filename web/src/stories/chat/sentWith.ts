// The "just this message" choice each answer was asked with (docs/CONTRACTS.md §45.34): Try again sends it again, and
// the director's "Remake these scenes" and "Analyze this reference video" buttons on that answer start from it. The
// API returns it on each answer (`Message.requested`, §45.35 D4), which wins, so it works on every device. For an API
// older than that, this device also remembers it by workspace and answer id: for this visit, and in localStorage
// `cf.stories.sentWith` (the newest 200), so a reload or a later visit still finds it. Without storage (private mode, a
// full disk) that copy lasts for this visit only.
import { EFFORT_LABEL, type Effort, type Message, type ModelOverride } from "../api/types.ts";

export const SENT_WITH_KEY = "cf.stories.sentWith";
/** How many answers' choices are kept on this device (the oldest go first). */
export const SENT_WITH_MAX = 200;

/** This visit's copy, read from localStorage once (undefined until the first read). */
let visit: Map<string, ModelOverride> | undefined;
const MODEL = /^[A-Za-z0-9._:-]{1,100}$/;

const keyOf = (ws: string, msgId: string) => `${ws}/${msgId}`;

function clean(raw: unknown): ModelOverride | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: ModelOverride = {};
  if (typeof r.model === "string" && MODEL.test(r.model)) out.model = r.model;
  if (typeof r.effort === "string" && r.effort in EFFORT_LABEL) out.effort = r.effort as Effort;
  return out.model || out.effort ? out : null;
}

function readAll(): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SENT_WITH_KEY) ?? "null");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function kept(): Map<string, ModelOverride> {
  if (!visit) {
    visit = new Map();
    for (const [k, v] of Object.entries(readAll())) {
      const c = clean(v);
      if (c) visit.set(k, c);
    }
  }
  return visit;
}

/** The choice the answer `msgId` was asked with, or null (it ran on the conversation's own setting). */
export function sentWith(ws: string, msgId: string): ModelOverride | null {
  return kept().get(keyOf(ws, msgId)) ?? null;
}

/**
 * The choice an answer was asked with: the answer's own `requested` when the API sends it (null there means none,
 * whatever this device kept), else this device's copy (an API older than §45.35 D4).
 */
export function askedWith(ws: string, m: Pick<Message, "msgId" | "requested">): ModelOverride | null {
  if (m.requested !== undefined) return clean(m.requested);
  return sentWith(ws, m.msgId);
}

/** Remembers the choice an answer was asked with. */
export function rememberSentWith(ws: string, msgId: string, override: ModelOverride): void {
  const c = clean(override);
  if (!c) return;
  const all = kept();
  const k = keyOf(ws, msgId);
  all.delete(k);
  all.set(k, c);
  for (const old of [...all.keys()].slice(0, Math.max(0, all.size - SENT_WITH_MAX))) all.delete(old);
  try {
    localStorage.setItem(SENT_WITH_KEY, JSON.stringify(Object.fromEntries(all)));
  } catch {
    // Private mode or a full disk: it is remembered for this visit only.
  }
}

/** Test hook: forget this visit's copy (the next read is from localStorage, as after a reload). */
export function forgetSentWithVisit(): void {
  visit = undefined;
}
