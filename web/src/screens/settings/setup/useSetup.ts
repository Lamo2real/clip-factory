// GET /v1/setup for the setup screens and the floating setup list (§17.13), kept fresh by live `setup` events
// (docs/CONTRACTS.md §17.4).
import { useCallback } from "react";
import { api } from "../../../api/index.ts";
import type { PlatformSetup, SetupOverview } from "../../../api/types.ts";
import { useLoad } from "../../../lib/hooks.ts";
import { useLiveEvents } from "../../../lib/live.ts";

export interface SetupData {
  data: SetupOverview | null;
  error: string | null;
  reload: () => Promise<void>;
  /** Puts one platform's newer setup (from a PATCH, PUT or POST answer) into the overview. */
  put: (setup: PlatformSetup) => void;
}

export function useSetup(): SetupData {
  const { data, error, reload, setData } = useLoad(() => api().getSetup(), "", "setup");
  useLiveEvents(
    (e) => {
      if (e.type === "setup") void reload();
    },
    () => void reload(),
  );
  const put = useCallback(
    (setup: PlatformSetup) =>
      setData((d) => {
        if (!d) return d;
        const platforms = d.platforms.map((p) => (p.platform === setup.platform ? setup : p));
        return { ...d, platforms, ready: platforms.filter((p) => p.ready).length };
      }),
    [setData],
  );
  return { data, error, reload, put };
}
