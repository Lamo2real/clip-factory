// The conversation, in memory only (docs/CONTRACTS.md §19.8): nothing is stored, so closing the tab forgets it.
// Pictures (§26) are object URLs in this memory too: the tray waiting to be sent, then the pictures of each question.
// Ask as a full assistant (§28): any file can wait in the tray; a sent question keeps its files' Blobs in memory (at
// most 30 files / 100 MB) so a follow-up can carry them, and its answer streams into an "ai" entry.
// The reducer stays pure; `useRevokeDropped` lets go of every URL that leaves the state (Start over, take away,
// the 12-picture memory limit) and of all of them when Ask unmounts (sign-out).
import { useEffect, useRef } from "react";
import type { AskTurn } from "./askApi.ts";
import { applyEvent, newAnswer, type AskEvent, type StreamAnswer } from "./askStream.ts";
import { KEEP_BYTES, KEEP_FILES, type AskFile } from "./files.ts";
import type { LiveResult } from "./live.ts";
import type { Stroke } from "./markup.ts";
import { KEEP_MAX, PICTURES_MAX, type Pic } from "./pictures.ts";
import { HISTORY_MAX, SEEN_MAX, type HelpAnswer, type HelpTurn } from "./types.ts";

/** A picture shown in a question bubble; `url` is null once it was let go (the 12-picture memory limit). */
export interface SentPic {
  id: number;
  url: string | null;
  width: number;
  height: number;
}

/** A file of a sent question (§28): `blob` and `url` are null once let go (the 30-file / 100 MB memory limit). */
export interface SentFile {
  id: number;
  kind: AskFile["kind"];
  name: string;
  format: string;
  size: number;
  blob: Blob | null;
  url: string | null;
  width?: number;
  height?: number;
  marked?: boolean;
}

/** A ready tray file; a marked picture keeps its original and its marks in memory until the question is sent. */
export type TrayFile = AskFile & { busy?: false; original?: { blob: Blob; url: string; width: number; height: number }; strokes?: Stroke[] };

/** A tray tile: being made ready (shimmer), or ready to send. */
export type TrayPic = { id: number; busy: true } | TrayFile;

export type LiveState = { kind: "loading" } | { kind: "done"; result: LiveResult } | { kind: "failed" };

export type Entry =
  | { id: number; role: "user"; text: string; pictures?: SentPic[]; seen?: string; files?: SentFile[] }
  /** An assistant answer streaming in (§28); `note` is a soft line under it ("The answer was cut short…"). */
  | { id: number; role: "ai"; answer: StreamAnswer; note?: string }
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
  | { id: number; role: "notice"; tone: "busy" | "off" | "info"; text: string; until?: number; helpCode?: string | null; retry?: boolean };

export interface ChatState {
  entries: Entry[];
  thinking: boolean;
  /** Ask is off until this time (after a 429). */
  blockedUntil: number;
  /** Navigation waiting for "Leave anyway?". */
  confirm: { actionId: string; entryId: number } | null;
  /** Pictures waiting to go with the next question (kept by the launcher, so closing the panel keeps them). */
  tray: TrayPic[];
  /** The "ai" entry streaming now (Send is Stop meanwhile). */
  streaming: number | null;
  /** Upload progress per tray file id while a question goes (0..1). */
  uploads: Record<number, number>;
  /** Carried files the owner took away from the next follow-up. */
  dropped: number[];
}

export const initialChat: ChatState = { entries: [], thinking: false, blockedUntil: 0, confirm: null, tray: [], streaming: null, uploads: {}, dropped: [] };

let seq = 0;
/** A new entry id (ids only need to be unique while the page is open). */
export const entryId = () => ++seq;

export type ChatEvent =
  | { type: "ask"; id: number; text: string; pictures?: Pic[]; files?: TrayFile[]; carried?: number[] }
  | { type: "ai_start"; id: number; askId: string }
  | { type: "ai_event"; entryId: number; event: AskEvent }
  | { type: "ai_note"; entryId: number; note: string }
  | { type: "ai_end"; entryId: number }
  | { type: "upload"; id: number; fraction: number }
  | { type: "carry_drop"; id: number }
  /** A picture saved in the markup editor: the marked JPEG replaces the tray file (the original stays until sent). */
  | { type: "tray_marked"; id: number; blob: Blob; url: string; width: number; height: number; strokes: Stroke[]; original: { blob: Blob; url: string; width: number; height: number } }
  | { type: "tray_file"; file: TrayFile }
  | { type: "answer"; id: number; answer: HelpAnswer; requestId: string; trouble: boolean }
  | { type: "notice"; id: number; tone: "busy" | "off" | "info"; text: string; until?: number; helpCode?: string | null; retry?: boolean }
  | { type: "live"; entryId: number; live: LiveState }
  | { type: "confirm"; confirm: ChatState["confirm"] }
  | { type: "reset" }
  | { type: "tray_add"; id: number }
  | { type: "tray_ready"; pic: Pic | TrayFile }
  | { type: "tray_remove"; id: number }
  | { type: "tray_clear" }
  /** A question that could not be sent gives its pictures (or files) back, so "try again" is one tap. */
  | { type: "tray_restore"; pics: (Pic | TrayFile)[] }
  | { type: "seen"; entryId: number; seen: string };

/** A §26 picture as a tray file (the old picture flow adds plain Pics). */
export function asFile(p: Pic | TrayFile): TrayFile {
  return "kind" in p ? p : { ...p, kind: "image", name: `Picture.jpg`, format: "JPG", size: p.blob.size };
}

/** Lets go of the oldest sent files' memory once more than KEEP_FILES or KEEP_BYTES are kept. */
function keepFiles(entries: Entry[]): Entry[] {
  let files = 0;
  let bytes = 0;
  const out = [...entries];
  for (let i = out.length - 1; i >= 0; i--) {
    const e = out[i]!;
    if (e.role !== "user" || !e.files?.length) continue;
    let changed = false;
    const kept = e.files.map((f) => {
      if (!f.blob) return f;
      if (files < KEEP_FILES && bytes + f.size <= KEEP_BYTES) {
        files++;
        bytes += f.size;
        return f;
      }
      changed = true;
      return { ...f, blob: null, url: null };
    });
    if (changed) out[i] = { ...e, files: kept };
  }
  return out;
}

/** Lets go of the oldest sent pictures once more than KEEP_MAX are kept (tray included). */
function keepRecent(entries: Entry[], tray: readonly TrayPic[]): Entry[] {
  let kept = tray.length;
  const out = [...entries];
  for (let i = out.length - 1; i >= 0; i--) {
    const e = out[i]!;
    if (e.role !== "user" || !e.pictures?.length) continue;
    let changed = false;
    const pics = [...e.pictures].reverse().map((p) => {
      if (!p.url) return p;
      if (kept < KEEP_MAX) {
        kept++;
        return p;
      }
      changed = true;
      return { ...p, url: null };
    });
    if (changed) out[i] = { ...e, pictures: pics.reverse() };
  }
  return out;
}

export function chatReducer(s: ChatState, e: ChatEvent): ChatState {
  switch (e.type) {
    case "ask": {
      if (e.files) {
        // §28: the files go with the question; a marked picture's original is let go now (it never leaves the device).
        const files: SentFile[] = e.files.map((f) => ({
          id: f.id,
          kind: f.kind,
          name: f.name,
          format: f.format,
          size: f.size,
          blob: f.blob,
          url: f.url ?? null,
          ...(f.width ? { width: f.width, height: f.height } : {}),
          ...(f.marked ? { marked: true } : {}),
        }));
        const sent = new Set(e.files.map((f) => f.id));
        const entry: Entry = files.length ? { id: e.id, role: "user", text: e.text, files } : { id: e.id, role: "user", text: e.text };
        const tray = s.tray.filter((p) => !sent.has(p.id));
        return { ...s, confirm: null, tray, uploads: {}, entries: keepFiles([...s.entries, entry]) };
      }
      const pictures = e.pictures?.map(({ id, url, width, height }) => ({ id, url, width, height }));
      const sent = new Set(e.pictures?.map((p) => p.id));
      const entry: Entry = pictures?.length ? { id: e.id, role: "user", text: e.text, pictures } : { id: e.id, role: "user", text: e.text };
      const tray = s.tray.filter((p) => !sent.has(p.id));
      return { ...s, thinking: true, confirm: null, tray, entries: keepRecent([...s.entries, entry], tray) };
    }
    case "ai_start":
      return { ...s, thinking: false, streaming: e.id, entries: [...s.entries, { id: e.id, role: "ai", answer: newAnswer(e.askId) }] };
    case "ai_event":
      return {
        ...s,
        entries: s.entries.map((x) => (x.id === e.entryId && x.role === "ai" ? { ...x, answer: applyEvent(x.answer, e.event) } : x)),
      };
    case "ai_note":
      return { ...s, entries: s.entries.map((x) => (x.id === e.entryId && x.role === "ai" ? { ...x, note: e.note } : x)) };
    case "ai_end": {
      // An answer that never got a word is taken out (the plain answer or a notice takes its place).
      const entries = s.entries.filter((x) => !(x.id === e.entryId && x.role === "ai" && !x.answer.text && !x.answer.done));
      return { ...s, streaming: s.streaming === e.entryId ? null : s.streaming, uploads: {}, entries };
    }
    case "upload":
      return { ...s, uploads: { ...s.uploads, [e.id]: e.fraction } };
    case "carry_drop":
      return s.dropped.includes(e.id) ? s : { ...s, dropped: [...s.dropped, e.id] };
    case "tray_marked":
      return {
        ...s,
        tray: s.tray.map((p) =>
          p.id === e.id && !p.busy
            ? { ...p, blob: e.blob, url: e.url, width: e.width, height: e.height, size: e.blob.size, marked: e.strokes.length > 0, strokes: e.strokes, original: e.original }
            : p,
        ),
      };
    case "tray_file":
      return { ...s, tray: [...s.tray, e.file] };
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
        entries: [...s.entries, { id: e.id, role: "notice", tone: e.tone, text: e.text, until: e.until, helpCode: e.helpCode ?? null, ...(e.retry ? { retry: true } : {}) }],
      };
    case "live":
      return { ...s, entries: s.entries.map((x) => (x.id === e.entryId && x.role === "assistant" ? { ...x, live: e.live } : x)) };
    case "confirm":
      return { ...s, confirm: e.confirm };
    case "reset":
      return initialChat;
    case "tray_add":
      return { ...s, tray: [...s.tray, { id: e.id, busy: true }] };
    case "tray_ready": {
      if (!s.tray.some((p) => p.id === e.pic.id)) return s;
      const ready = asFile(e.pic);
      const tray = s.tray.map((p) => (p.id === e.pic.id ? { ...ready, busy: false as const } : p));
      return { ...s, tray, entries: keepRecent(s.entries, tray) };
    }
    case "tray_remove":
      return { ...s, tray: s.tray.filter((p) => p.id !== e.id) };
    case "tray_clear":
      return { ...s, tray: [] };
    case "tray_restore": {
      const have = new Set(s.tray.map((p) => p.id));
      const room = e.pics.some((p) => "kind" in p) ? 10 : PICTURES_MAX;
      const back = e.pics.filter((p) => !have.has(p.id)).slice(0, Math.max(0, room - s.tray.length));
      if (!back.length) return s;
      const tray: TrayPic[] = [...back.map((p) => ({ ...asFile(p), busy: false as const })), ...s.tray];
      return { ...s, tray, entries: keepRecent(s.entries, tray) };
    }
    case "seen":
      return {
        ...s,
        entries: s.entries.map((x) => (x.id === e.entryId && x.role === "user" ? { ...x, seen: e.seen.slice(0, SEEN_MAX) } : x)),
      };
  }
}

/** The last turns to send with a question (≤ 4), each as plain text. */
export function historyOf(entries: readonly Entry[]): HelpTurn[] {
  const turns: HelpTurn[] = [];
  for (const e of entries) {
    if (e.role === "user") turns.push(e.seen ? { role: "user", text: e.text, seen: e.seen } : { role: "user", text: e.text });
    else if (e.role === "assistant") turns.push({ role: "assistant", text: e.answer.text });
  }
  return turns.slice(-HISTORY_MAX);
}

/** The conversation for the assistant (§28): every turn as plain text, user turns with their files' names, answers
 * with their web sources (so "open that page you found" can be fetched again). The API
 * keeps at most 90,000 characters (askApi.trimHistory drops the oldest). */
export function askHistory(entries: readonly Entry[]): AskTurn[] {
  const turns: AskTurn[] = [];
  for (const e of entries) {
    if (e.role === "user") {
      const files = e.files?.map((f) => ({ name: f.name, format: f.format })) ?? (e.pictures?.length ? e.pictures.map(() => ({ name: "Picture.jpg", format: "JPG" })) : undefined);
      if (e.text || files?.length) turns.push(files?.length ? { role: "user", text: e.text, files } : { role: "user", text: e.text });
    } else if (e.role === "assistant") {
      const steps = e.answer.steps.map((x, i) => `${i + 1}. ${x}`).join("\n");
      turns.push({ role: "assistant", text: steps ? `${e.answer.text}\n${steps}` : e.answer.text });
    } else if (e.role === "ai" && e.answer.text) {
      const sources = e.answer.sources.flatMap((x) => (x.kind === "web" && x.url ? [{ title: x.title, url: x.url }] : []));
      turns.push(sources.length ? { role: "assistant", text: e.answer.text, sources } : { role: "assistant", text: e.answer.text });
    }
  }
  return turns;
}

/** The newest assistant entry's id: only its first button is vermilion. */
export function newestAnswerId(entries: readonly Entry[]): number | null {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i]!.role === "assistant" || entries[i]!.role === "ai") return entries[i]!.id;
  return null;
}

/** Every object URL the chat holds (tray and sent pictures). */
export function liveUrls(s: ChatState): Set<string> {
  const urls = new Set<string>();
  for (const p of s.tray) {
    if (p.busy) continue;
    if (p.url) urls.add(p.url);
    if (p.original) urls.add(p.original.url);
  }
  for (const e of s.entries) {
    if (e.role !== "user") continue;
    for (const p of e.pictures ?? []) if (p.url) urls.add(p.url);
    for (const f of e.files ?? []) if (f.url) urls.add(f.url);
  }
  return urls;
}

/** Lets go of every picture the chat holds (Start over, sign-out). */
export function revokeAll(s: ChatState): void {
  for (const url of liveUrls(s)) URL.revokeObjectURL(url);
}

/** Revokes each object URL once it leaves the chat, and all of them when the owner of the chat unmounts. */
export function useRevokeDropped(state: ChatState): void {
  const held = useRef<Set<string>>(new Set());
  useEffect(() => {
    const now = liveUrls(state);
    for (const url of held.current) if (!now.has(url)) URL.revokeObjectURL(url);
    held.current = now;
  }, [state]);
  useEffect(
    () => () => {
      for (const url of held.current) URL.revokeObjectURL(url);
      held.current = new Set();
    },
    [],
  );
}

/** The ready pictures in the tray, in order (the §19/§26 path sends pictures only). */
export function readyTray(s: Pick<ChatState, "tray">): Pic[] {
  return s.tray
    .filter((p): p is TrayFile => !p.busy && p.kind === "image" && !!p.url)
    .map((p) => ({ id: p.id, blob: p.blob, url: p.url!, width: p.width ?? 0, height: p.height ?? 0 }));
}

/** Every ready file in the tray, in order (§28). */
export function readyFiles(s: Pick<ChatState, "tray">): TrayFile[] {
  return s.tray.filter((p): p is TrayFile => !p.busy);
}
