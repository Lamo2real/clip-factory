// The Connect button's spinner (docs/CONTRACTS.md §17.1). In a browser, Connect leaves this page for the platform,
// so the spinner is never seen again. The desktop app opens the platform in the system browser instead and this page
// stays, so the spinner has to stop by itself: when the account changes (live `setup` events bring the new state),
// when the owner comes back to the window, or when the browser brings the page back with Back (bfcache).
import { useCallback, useEffect, useRef, useState } from "react";
import type { Account } from "../../../api/types.ts";

/** What counts as "the account changed": a new status, a new connection time or another account. */
export function accountKey(account: Account | null | undefined): string {
  if (!account) return "";
  return [account.status, account.connectedAt ?? "", account.handle ?? "", account.name ?? ""].join("|");
}

export interface Connecting {
  connecting: boolean;
  /** Press: the spinner starts, and the account as it is now is kept to notice the change. */
  start: () => void;
  /** The platform page was opened: from now on coming back to the window also stops the spinner. */
  opened: () => void;
  /** The platform page could not be opened (the caller shows why). */
  stop: () => void;
}

export function useConnecting(account: Account | null | undefined): Connecting {
  const [connecting, setConnecting] = useState(false);
  // True once the platform page was opened. Before that the address is still being fetched, and leaving the window
  // and coming back must not stop the spinner (a second press would start a second consent).
  const [away, setAway] = useState(false);
  const key = accountKey(account);
  const pressedWith = useRef<string | null>(null);

  const stop = useCallback(() => {
    pressedWith.current = null;
    setConnecting(false);
    setAway(false);
  }, []);
  const start = useCallback(() => {
    pressedWith.current = key;
    setAway(false);
    setConnecting(true);
  }, [key]);
  const opened = useCallback(() => setAway(true), []);

  // The account changed while the platform was open: done (connected, needs a pick, or logged out).
  useEffect(() => {
    if (connecting && pressedWith.current !== null && key !== pressedWith.current) stop();
  }, [connecting, key, stop]);

  // The page shown again from the browser's cache (Back from the platform): nothing is loading any more.
  useEffect(() => {
    if (!connecting) return;
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) stop();
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, [connecting, stop]);

  // Back in the window after the platform page opened: the owner is here.
  useEffect(() => {
    if (!connecting || !away) return;
    const onFocus = () => stop();
    const onVisible = () => {
      if (document.visibilityState === "visible") stop();
    };
    // Armed a moment after the page opened, so the hand-over to the system browser itself never stops it.
    const t = setTimeout(() => {
      window.addEventListener("focus", onFocus);
      document.addEventListener("visibilitychange", onVisible);
    }, 400);
    return () => {
      clearTimeout(t);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [connecting, away, stop]);

  return { connecting, start, opened, stop };
}
