// Screens tell Ask Clip Factory when leaving would lose something (docs/CONTRACTS.md §19.8): Review while a caption
// edit is not saved yet, Home while a pasted link is not sent yet. The panel then asks before it navigates.
import { useEffect, useRef } from "react";

const checks = new Set<() => boolean>();

export function registerUnsaved(check: () => boolean): () => void {
  checks.add(check);
  return () => {
    checks.delete(check);
  };
}

/** True when any mounted screen has a change that is not saved yet. */
export function hasUnsaved(): boolean {
  for (const c of checks) {
    try {
      if (c()) return true;
    } catch {
      /* a broken check never blocks navigation */
    }
  }
  return false;
}

/** Registers `check` while the component is mounted (always the latest closure). */
export function useUnsaved(check: () => boolean): void {
  const ref = useRef(check);
  ref.current = check;
  useEffect(() => registerUnsaved(() => ref.current()), []);
}
