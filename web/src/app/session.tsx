import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../api/index.ts";
import { friendlyMessage } from "../api/errors.ts";
import type { Me, Settings } from "../api/types.ts";
import { usePoll } from "../lib/hooks.ts";
import { setPrefs } from "../lib/prefs.ts";
import { useToast } from "../components/Toasts.tsx";

interface Session {
  me: Me | null;
  refresh: () => Promise<void>;
  /** Saves settings on the server; sound and motion also apply on this device straight away. */
  saveSettings: (patch: Partial<Settings>) => Promise<Settings | null>;
  signOut: () => void;
}

const Ctx = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}

export function SessionProvider({ children, onSignOut }: { children: ReactNode; onSignOut: () => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const toast = useToast();

  const refresh = useCallback(async () => {
    const next = await api().me();
    setMe(next);
    setPrefs({ soundEnabled: next.settings.soundEnabled, reduceMotion: next.settings.reduceMotion });
  }, []);

  useEffect(() => {
    refresh().catch((e) => toast.error(friendlyMessage(e)));
  }, [refresh, toast]);

  // Keeps the review badge and running count fresh; quicker while a job is working.
  usePoll(refresh, true, me && me.counts.running > 0 ? 10_000 : 30_000);

  const saveSettings = useCallback(
    async (patch: Partial<Settings>) => {
      if ("soundEnabled" in patch || "reduceMotion" in patch) {
        setPrefs({
          ...(patch.soundEnabled !== undefined ? { soundEnabled: patch.soundEnabled } : {}),
          ...(patch.reduceMotion !== undefined ? { reduceMotion: patch.reduceMotion } : {}),
        });
      }
      setMe((m) => (m ? { ...m, settings: { ...m.settings, ...patch } } : m));
      try {
        const settings = await api().putSettings(patch);
        setMe((m) => (m ? { ...m, settings } : m));
        return settings;
      } catch (e) {
        toast.error(friendlyMessage(e));
        await refresh().catch(() => undefined);
        return null;
      }
    },
    [refresh, toast],
  );

  const value = useMemo(() => ({ me, refresh, saveSettings, signOut: onSignOut }), [me, refresh, saveSettings, onSignOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
