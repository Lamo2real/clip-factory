// The conversation, in memory only (docs/CONTRACTS.md §19.8): nothing is stored, so closing the tab forgets it.
import type { LiveResult } from "./live.ts";
import { HISTORY_MAX, type HelpAnswer, type HelpTurn } from "./types.ts";

export type LiveState = { kind: "loading" } | { kind: "done"; result: LiveResult } | { kind: "failed" };

export type Entry =
  | { id: number; role: "user"; text: string }
  | {
      id: number;
      role: "assistant";
      answer: HelpAnswer;
      live: LiveState | null;
      /** The code that finds this answer's one log line (the server's requestId, or a client-made `c-<time>`). */
      requestId: string;
      /** True when this answer came from the local corpus after server trouble (the help code link shows). */
      trouble: boolean;
    }
  | { id: number; role: "notice"; tone: "busy" | "off" | "info"; text: string; until?: number; helpCode?: string | null };

export interface ChatState {
  entries: Entry[];
  thinking: boolean;
  /** Ask is off until this time (after a 429). */
  blockedUntil: number;
  /** Navigation waiting for "Leave anyway?". */
  confirm: { actionId: string; entryId: number } | null;
}

export const initialChat: ChatState = { entries: [], thinking: false, blockedUntil: 0, confirm: null };

let seq = 0;
/** A new entry id (ids only need to be unique while the page is open). */
export const entryId = () => ++seq;

export type ChatEvent =
  | { type: "ask"; id: number; text: string }
  | { type: "answer"; id: number; answer: HelpAnswer; requestId: string; trouble: boolean }
  | { type: "notice"; id: number; tone: "busy" | "off" | "info"; text: string; until?: number; helpCode?: string | null }
  | { type: "live"; entryId: number; live: LiveState }
  | { type: "confirm"; confirm: ChatState["confirm"] }
  | { type: "reset" };

export function chatReducer(s: ChatState, e: ChatEvent): ChatState {
  switch (e.type) {
    case "ask":
      return { ...s, thinking: true, confirm: null, entries: [...s.entries, { id: e.id, role: "user", text: e.text }] };
    case "answer":
      return {
        ...s,
        thinking: false,
        entries: [...s.entries, { id: e.id, role: "assistant", answer: e.answer, live: e.answer.live ? { kind: "loading" } : null, requestId: e.requestId, trouble: e.trouble }],
      };
    case "notice":
      return {
        ...s,
        thinking: false,
        blockedUntil: e.until ?? s.blockedUntil,
        entries: [...s.entries, { id: e.id, role: "notice", tone: e.tone, text: e.text, until: e.until, helpCode: e.helpCode ?? null }],
      };
    case "live":
      return { ...s, entries: s.entries.map((x) => (x.id === e.entryId && x.role === "assistant" ? { ...x, live: e.live } : x)) };
    case "confirm":
      return { ...s, confirm: e.confirm };
    case "reset":
      return initialChat;
  }
}

/** The last turns to send with a question (≤ 4), each as plain text. */
export function historyOf(entries: readonly Entry[]): HelpTurn[] {
  const turns: HelpTurn[] = [];
  for (const e of entries) {
    if (e.role === "user") turns.push({ role: "user", text: e.text });
    else if (e.role === "assistant") turns.push({ role: "assistant", text: e.answer.text });
  }
  return turns.slice(-HISTORY_MAX);
}

/** The newest assistant entry's id: only its first button is tomato. */
export function newestAnswerId(entries: readonly Entry[]): number | null {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i]!.role === "assistant") return entries[i]!.id;
  return null;
}
