import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api/index.ts";
import { friendlyMessage } from "../api/errors.ts";
import type { Me, Settings } from "../api/types.ts";
import { auth } from "../lib/auth.ts";
import { config } from "../lib/config.ts";
import { startLive, stopLive, useLiveEvents, useLivePoll, type SocketLike } from "../lib/live.ts";
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

  // Bumped on every settings change, so a /me response that was already on its way cannot undo it.
  const settingsEdit = useRef(0);
  const refresh = useCallback(async () => {
    const asked = settingsEdit.current;
    const next = await api().me();
    if (asked !== settingsEdit.current) {
      setMe((m) => (m ? { ...next, settings: m.settings } : next));
      return;
    }
    setMe(next);
    setPrefs({ soundEnabled: next.settings.soundEnabled, reduceMotion: next.settings.reduceMotion });
  }, []);

  useEffect(() => {
    refresh().catch((e) => toast.error(friendlyMessage(e)));
  }, [refresh, toast]);

  // One live connection while signed in (docs/CONTRACTS.md §14.2). Closed on sign-out (this provider unmounts).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let createSocket: ((url: string) => SocketLike) | undefined;
      // Tested on import.meta.env directly so production builds drop the mock socket entirely.
      if (import.meta.env.VITE_MOCK === "1") createSocket = (await import("../api/mock/live.ts")).createMockSocket;
      if (cancelled) return;
      startLive({
        url: config().wsUrl,
        token: (fresh) => auth().accessToken(fresh),
        ...(createSocket ? { createSocket } : {}),
      });
    })();
    return () => {
      cancelled = true;
      stopLive();
    };
  }, []);

  // The review badge and the running count follow job and clip changes (a short pause batches a burst of them).
  const soon = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshSoon = useCallback(() => {
    clearTimeout(soon.current);
    soon.current = setTimeout(() => void refresh().catch(() => undefined), 800);
  }, [refresh]);
  useEffect(() => () => clearTimeout(soon.current), []);
  useLiveEvents((e) => {
    if (e.type === "job" || e.type === "clip") refreshSoon();
  }, refreshSoon);

  // Keeps the review badge and running count fresh; quicker while a job is working (every 30 s while live).
  useLivePoll(refresh, true, me && me.counts.running > 0 ? 10_000 : 30_000);

  const saveSettings = useCallback(
    async (patch: Partial<Settings>) => {
      settingsEdit.current += 1;
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
        settingsEdit.current += 1;
        await refresh().catch(() => undefined);
        return null;
      }
    },
    [refresh, toast],
  );

  const value = useMemo(() => ({ me, refresh, saveSettings, signOut: onSignOut }), [me, refresh, saveSettings, onSignOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
