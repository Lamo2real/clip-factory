import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api/index.ts";
import { friendlyMessage } from "../api/errors.ts";
import type { Me, Settings, SettingsPut } from "../api/types.ts";
import { auth } from "../lib/auth.ts";
import { config } from "../lib/config.ts";
import { startLive, stopLive, useLiveEvents, useLivePoll, type SocketLike } from "../lib/live.ts";
import { getPrefs, setPrefs, type Prefs } from "../lib/prefs.ts";
import { isBackgroundMode, isGlassStrength, normaliseColours } from "../lib/background.ts";
import { DEFAULT_CLICK_SOUND, DEFAULT_ERROR_SOUND, isSoundId } from "../lib/soundCatalog.ts";
import { useToast } from "../components/Toasts.tsx";

/**
 * What to save: the changed fields, or a function that builds them from the newest settings on screen (including
 * saves still on their way), so a list such as `setupSkipped` built from a copy read earlier cannot undo another change.
 */
export type SettingsPatch = Partial<Settings> | ((now: Settings) => Partial<Settings>);

/** How a save goes out, when it is not simply the change itself. */
export interface SaveOptions {
  /**
   * What PUT sends, when it is less than what the screen shows: only the keys that changed of a setting the server
   * merges key by key (auto-posting, §46.3), so a copy read earlier can never send another key back.
   */
  send?: SettingsPut;
  /** Waits for the save before it (of any `inOrder` save), so quick taps reach the server in the order they were made. */
  inOrder?: boolean;
}

interface Session {
  me: Me | null;
  refresh: () => Promise<void>;
  /** Saves settings on the server; sound (and which sounds) and motion also apply on this device straight away. */
  saveSettings: (patch: SettingsPatch, opts?: SaveOptions) => Promise<Settings | null>;
  signOut: () => void;
}

const Ctx = createContext<Session | null>(null);

/** Settings stored before the click and error sounds existed read as the owner's defaults (§15.4). */
export function withSoundDefaults(settings: Settings): Settings {
  return {
    ...settings,
    clickSound: isSoundId(settings.clickSound) ? settings.clickSound : DEFAULT_CLICK_SOUND,
    errorSound: isSoundId(settings.errorSound) ? settings.errorSound : DEFAULT_ERROR_SOUND,
  };
}

/** The settings this device keeps a copy of, so they apply before the server answers. */
function devicePrefs(patch: Partial<Settings>): Partial<Prefs> {
  const out: Partial<Prefs> = {};
  if (patch.soundEnabled !== undefined) out.soundEnabled = patch.soundEnabled;
  if (patch.reduceMotion !== undefined) out.reduceMotion = patch.reduceMotion;
  if (isSoundId(patch.clickSound)) out.clickSound = patch.clickSound;
  if (isSoundId(patch.errorSound)) out.errorSound = patch.errorSound;
  if (isBackgroundMode(patch.backgroundMode)) out.backgroundMode = patch.backgroundMode;
  if (patch.backgroundColours !== undefined) out.backgroundColours = normaliseColours(patch.backgroundColours);
  if (isGlassStrength(patch.glassStrength)) out.glassStrength = patch.glassStrength;
  return out;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}

/** The values `patch` is about to change, as they are now, so a failed save can put them back. */
function before<T extends object>(now: T, patch: Partial<T>): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(patch) as (keyof T)[]) out[key] = now[key];
  return out;
}

export function SessionProvider({ children, onSignOut }: { children: ReactNode; onSignOut: () => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const toast = useToast();
  // The settings on screen right now, kept in step synchronously so two quick saves each see the one before.
  const shown = useRef<Settings | null>(null);
  useEffect(() => {
    shown.current = me?.settings ?? null;
  }, [me]);

  // Bumped on every settings change, so a /me response that was already on its way cannot undo it.
  const settingsEdit = useRef(0);
  const refresh = useCallback(async () => {
    const asked = settingsEdit.current;
    const raw = await api().me();
    const next = { ...raw, settings: withSoundDefaults(raw.settings) };
    if (asked !== settingsEdit.current) {
      setMe((m) => (m ? { ...next, settings: m.settings } : next));
      return;
    }
    setMe(next);
    setPrefs(devicePrefs(next.settings));
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

  // The saves asked to go out one after another (SaveOptions.inOrder).
  const order = useRef<Promise<unknown>>(Promise.resolve());

  const saveSettings = useCallback(
    async (change: SettingsPatch, opts: SaveOptions = {}) => {
      // An updater reads the settings as they are this instant: `shown` already holds every save made before it.
      if (typeof change === "function" && !shown.current) return null;
      const patch = typeof change === "function" ? change(shown.current!) : change;
      const edit = (settingsEdit.current += 1);
      const local = devicePrefs(patch);
      const oldPrefs = before(getPrefs(), local);
      const oldSettings = shown.current ? before(shown.current, patch) : null;
      if (Object.keys(local).length) setPrefs(local);
      if (shown.current) shown.current = { ...shown.current, ...patch };
      setMe((m) => (m ? { ...m, settings: { ...m.settings, ...patch } } : m));
      try {
        const put = () => api().putSettings(opts.send ?? patch);
        let sent: Promise<Settings>;
        if (opts.inOrder) {
          sent = order.current.then(put, put);
          order.current = sent.catch(() => undefined);
        } else sent = put();
        const settings = withSoundDefaults(await sent);
        // Quick taps send several saves; only the newest answer may replace what is on screen, so an older
        // answer arriving late cannot flip a choice back.
        if (edit === settingsEdit.current) {
          setMe((m) => (m ? { ...m, settings } : m));
          setPrefs(devicePrefs(settings));
        }
        return settings;
      } catch (e) {
        toast.error(friendlyMessage(e));
        // Put the control back straight away, even with no network to ask the server what it has. A newer
        // change made since is left alone (it has its own save).
        if (edit === settingsEdit.current) {
          if (Object.keys(oldPrefs).length) setPrefs(oldPrefs);
          if (oldSettings) {
            if (shown.current) shown.current = { ...shown.current, ...oldSettings };
            setMe((m) => (m ? { ...m, settings: { ...m.settings, ...oldSettings } } : m));
          }
        }
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
