// Lamo Stories mock: the memory part (docs/CONTRACTS.md §45.16.8, §45.27). Builder F2.
// What the creative director remembers (saved from the chat with `remember`) and what the owner added himself,
// newest first; the owner adds, edits and deletes them in Lamo Stories › Settings › Memory. Clip Factory never sees it.
import { ApiError } from "../../../api/errors.ts";
import type { MemoryItem, StoriesApi } from "../types.ts";
import { guardStories } from "./ai.ts";
import { delay, type MockStore } from "./store.ts";

export const KEYS = ["listMemory", "addMemory", "patchMemory", "deleteMemory"] as const;

/** The most a memory line may hold (§45.27). */
export const MEMORY_MAX = 300;

const MIN_MS = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

let counter = 0;
function newId(): string {
  counter += 1;
  return `01JMEM${Date.now().toString(36).toUpperCase()}${counter.toString(36).toUpperCase().padStart(4, "0")}`.slice(0, 26);
}

export function seed(store: MockStore): void {
  const now = Date.now();
  const items: [string, MemoryItem["source"], number][] = [
    ["Lamo likes slapstick endings: a little bounce and a dazed face.", "chat", 50 * MIN_MS],
    ["Pip the bean is the main character. Bolt the dog is his friend.", "chat", 26 * 60 * MIN_MS],
    ["Keep videos between 30 and 45 seconds unless I say so.", "owner", 3 * 24 * 60 * MIN_MS],
    ["Never show anyone using a phone while driving, not even as a joke.", "owner", 9 * 24 * 60 * MIN_MS],
  ];
  store.memory = items.map(([text, source, ago], i) => ({ memId: `01JMEMSEED000000000000000${i}`, text, source, createdAt: iso(now - ago), updatedAt: iso(now - ago) }));
}

function clean(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) throw new ApiError(400, "bad_request", "Type something to remember first.", "text");
  if (t.length > MEMORY_MAX) throw new ApiError(400, "bad_request", `Keep it under ${MEMORY_MAX} letters.`, "text");
  return t;
}

export function api(store: MockStore): Pick<StoriesApi, (typeof KEYS)[number]> {
  const find = (memId: string) => {
    const m = store.memory.find((x) => x.memId === memId);
    if (!m) throw new ApiError(404, "not_found", "That memory is already gone.");
    return m;
  };
  return {
    async listMemory(ws) {
      await delay();
      guardStories(store, ws);
      return [...store.memory].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((m) => ({ ...m }));
    },
    async addMemory(ws, text) {
      await delay();
      guardStories(store, ws);
      const now = iso(Date.now());
      const item: MemoryItem = { memId: newId(), text: clean(text), source: "owner", createdAt: now, updatedAt: now };
      store.memory.push(item);
      return { ...item };
    },
    async patchMemory(ws, memId, text) {
      await delay();
      guardStories(store, ws);
      const m = find(memId);
      m.text = clean(text);
      m.updatedAt = iso(Date.now());
      return { ...m };
    },
    async deleteMemory(ws, memId) {
      await delay();
      guardStories(store, ws);
      find(memId);
      store.memory = store.memory.filter((m) => m.memId !== memId);
    },
  };
}
