// The confirmed skips of the setup to-do list (docs/CONTRACTS.md §17.13), shared by the floating list and Settings ›
// Posting › Set up posting. Every save builds the new list from the newest settings on screen (not from a copy this
// component read earlier), so a skip, an un-skip and a dropped stale skip sent close together never undo each other.
import { useCallback } from "react";
import type { Platform } from "../../../api/types.ts";
import { useSession } from "../../../app/session.tsx";
import { withoutSkip, withSkip } from "../../../lib/setupTodo.ts";

const NONE: readonly Platform[] = [];

export interface Skips {
  /** The saved skips (Settings.setupSkipped); empty before the settings are in. */
  skipped: readonly Platform[];
  /** A confirmed skip. Resolves to false when the save failed (the session already showed why). */
  skip: (p: Platform) => Promise<boolean>;
  unskip: (p: Platform) => Promise<boolean>;
  /** Drops several skips at once (platforms that are ready now). */
  drop: (ps: readonly Platform[]) => Promise<boolean>;
}

export function useSkips(): Skips {
  const { me, saveSettings } = useSession();
  const skipped = me?.settings.setupSkipped ?? NONE;
  const skip = useCallback(
    async (p: Platform) => (await saveSettings((s) => ({ setupSkipped: withSkip(s.setupSkipped ?? [], p) }))) !== null,
    [saveSettings],
  );
  const unskip = useCallback(
    async (p: Platform) => (await saveSettings((s) => ({ setupSkipped: withoutSkip(s.setupSkipped ?? [], p) }))) !== null,
    [saveSettings],
  );
  const drop = useCallback(
    async (ps: readonly Platform[]) =>
      (await saveSettings((s) => ({ setupSkipped: ps.reduce<Platform[]>((list, p) => withoutSkip(list, p), [...(s.setupSkipped ?? [])]) }))) !== null,
    [saveSettings],
  );
  return { skipped, skip, unskip, drop };
}
