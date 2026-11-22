// What the chat remembers on this device (docs/CONTRACTS.md §45.16.1, §45.32 #2): the last open conversation, as
// `lastConversationId` inside localStorage `cf.workspace`. The shell (web/src/stories/workspace.ts, builder F) owns
// that object and keeps a copy of it for the visit, so when the shell's module is there its own
// rememberConversation and currentChoice are used: then a later page change, which rewrites cf.workspace from the
// shell's copy, keeps what the chat said (a deleted chat stays forgotten after a reload). Without the shell (this
// part's own tests) the one key is written here, every other key of the object kept as it is, and the value is also
// held for this visit.
export const WORKSPACE_KEY = "cf.workspace";

const ID = /^[A-Za-z0-9_-]{1,64}$/;

interface Shell {
  currentChoice: () => { lastConversationId?: string | null };
  rememberConversation: (convId: string | null) => void;
  resetWorkspaceMemory?: () => void;
}

/** The shell's workspace module, when it is in the app (an empty match when it is not). */
const found = Object.values(import.meta.glob<Partial<Shell>>("../workspace.ts", { eager: true }))[0];
const shell: Shell | null = found && typeof found.currentChoice === "function" && typeof found.rememberConversation === "function" ? (found as Shell) : null;

/** This visit's choice: undefined until the chat opens or forgets one (used only without the shell). */
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
  const id = shell ? shell.currentChoice().lastConversationId : visit !== undefined ? visit : readObject().lastConversationId;
  return typeof id === "string" && ID.test(id) ? id : null;
}

/** Remembers (or, with null, forgets) the open conversation. */
export function rememberConversation(id: string | null): void {
  if (id !== null && !ID.test(id)) return;
  if (shell) return shell.rememberConversation(id);
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
  shell?.resetWorkspaceMemory?.();
}

/** Test hook: whether the shell's own workspace module is the one in use. */
export const usesShell = shell !== null;
