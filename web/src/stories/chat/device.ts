// What the chat remembers on this device (docs/CONTRACTS.md §45.16.1, §45.32 #2): the last open conversation, as
// `lastConversationId` inside localStorage `cf.workspace` (the shell keeps the rest of that object: the workspace and
// the last pages). Only that one key is written here; every other key of the object is kept as it is. The value is
// also held for this visit, so a page change that rewrites cf.workspace from an older copy cannot lose it.
export const WORKSPACE_KEY = "cf.workspace";

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** This visit's choice: undefined until the chat opens or forgets one. */
let visit: string | null | undefined;

function readObject(): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(WORKSPACE_KEY) ?? "null");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The conversation the owner had open last on this device, or null. */
export function lastConversationId(): string | null {
  if (visit !== undefined) return visit;
  const id = readObject().lastConversationId;
  return typeof id === "string" && ID.test(id) ? id : null;
}

/** Remembers (or, with null, forgets) the open conversation. */
export function rememberConversation(id: string | null): void {
  if (id !== null && !ID.test(id)) return;
  visit = id;
  const obj = readObject();
  if ((obj.lastConversationId ?? null) === id) return;
  try {
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ ...obj, lastConversationId: id }));
  } catch {
    // Private mode or a full disk: it is simply not remembered after a reload.
  }
}

/** Test hook: forget this visit's copy (the next read is from localStorage). */
export function forgetVisit(): void {
  visit = undefined;
}
