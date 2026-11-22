// Delete with Undo (docs/CONTRACTS.md §45.16.7, §45.27, §45.28): a deleted chat or reference video disappears at
// once and is only really deleted a few seconds later, unless the owner taps Undo. One at a time: a second delete
// finishes the first. Leaving the app finishes it too. Kept outside the pages, so a reference deleted on its own page
// can still be undone on the list it lands on.
import { useSyncExternalStore } from "react";

export const UNDO_MS = 6000;

export interface PendingDelete {
  kind: "conversation" | "reference";
  id: string;
  /** "Deleted “Pip's morning”." */
  text: string;
}

interface Slot extends PendingDelete {
  run: () => Promise<void>;
  timer: ReturnType<typeof setTimeout>;
}

let slot: Slot | null = null;
/** The last delete the server refused, as a sentence (cleared by the next delete). */
let refused: { kind: PendingDelete["kind"]; id: string; text: string } | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const fn of listeners) fn();
};

function commit(s: Slot): void {
  clearTimeout(s.timer);
  if (slot === s) slot = null;
  s.run().then(
    () => emit(),
    () => {
      refused = { kind: s.kind, id: s.id, text: "That did not delete. Try again." };
      emit();
    },
  );
  emit();
}

export function scheduleDelete(p: PendingDelete & { run: () => Promise<void> }, ms = UNDO_MS): void {
  if (slot) commit(slot);
  refused = null;
  const s: Slot = { ...p, timer: setTimeout(() => commit(s), ms) };
  slot = s;
  emit();
}

/** Undo: the item comes back and nothing is deleted. */
export function undoDelete(): PendingDelete | null {
  const s = slot;
  if (!s) return null;
  clearTimeout(s.timer);
  slot = null;
  emit();
  return { kind: s.kind, id: s.id, text: s.text };
}

/** Deletes now (the page is going away). */
export function flushDelete(): void {
  if (slot) commit(slot);
}

export function isPendingDelete(kind: PendingDelete["kind"], id: string): boolean {
  return !!slot && slot.kind === kind && slot.id === id;
}

export function refusedDelete(kind: PendingDelete["kind"]): string | null {
  return refused && refused.kind === kind ? refused.text : null;
}

let version = 0;
listeners.add(() => {
  version += 1;
});

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The delete waiting for its Undo, if it is of this kind; re-renders on every change (and after the real delete). */
export function usePendingDelete(kind: PendingDelete["kind"]): { pending: PendingDelete | null; version: number } {
  const v = useSyncExternalStore(subscribe, () => version);
  const pending = slot && slot.kind === kind ? { kind: slot.kind, id: slot.id, text: slot.text } : null;
  return { pending, version: v };
}

if (typeof window !== "undefined") window.addEventListener("pagehide", flushDelete);
