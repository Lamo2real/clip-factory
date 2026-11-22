// The Connect spinner stops by itself in the desktop app (docs/CONTRACTS.md §17.1, src/screens/settings/setup/useConnecting.ts):
// the platform opens in the system browser and the setup page stays, so nothing navigates the spinner away.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Account } from "../src/api/types.ts";
import { accountKey, useConnecting, type Connecting } from "../src/screens/settings/setup/useConnecting.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const loggedOut: Account = { platform: "instagram", status: "needs_reconnect", handle: "@lamo_clips", reason: "token_dead" };
const connected: Account = { platform: "instagram", status: "connected", handle: "@lamo_clips", connectedAt: "2026-11-20T22:10:00Z" };

let root: Root;
let host: HTMLDivElement;
let hook: Connecting;

function Probe({ account }: { account: Account | null }) {
  hook = useConnecting(account);
  return null;
}

function show(account: Account | null) {
  act(() => root.render(<Probe account={account} />));
}

/** The press as SetupPlatform makes it (start, the platform page opens), then the arming delay. */
function press() {
  act(() => hook.start());
  act(() => hook.opened());
  act(() => vi.advanceTimersByTime(500));
}

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("accountKey", () => {
  it("changes with the status, the connection time and the account", () => {
    expect(accountKey(null)).toBe("");
    expect(accountKey(loggedOut)).not.toBe(accountKey(connected));
    expect(accountKey(connected)).not.toBe(accountKey({ ...connected, connectedAt: "2026-11-21T08:00:00Z" }));
    expect(accountKey(connected)).not.toBe(accountKey({ ...connected, handle: "@other" }));
    expect(accountKey(connected)).toBe(accountKey({ ...connected }));
  });
});

describe("useConnecting", () => {
  it("spins from the press until the account comes back connected", () => {
    show(loggedOut);
    expect(hook.connecting).toBe(false);
    press();
    expect(hook.connecting).toBe(true);
    // A refetch with the same account changes nothing.
    show({ ...loggedOut });
    expect(hook.connecting).toBe(true);
    // The live `setup` event brings the new connection: the spinner stops.
    show(connected);
    expect(hook.connecting).toBe(false);
  });

  it("stops when the owner comes back to the window", () => {
    show(connected);
    press();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(hook.connecting).toBe(false);
  });

  it("stops when the window is shown again", () => {
    show(connected);
    press();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(hook.connecting).toBe(false);
  });

  it("keeps spinning while the window is hidden", () => {
    show(connected);
    press();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(hook.connecting).toBe(true);
  });

  it("ignores coming back while the platform address is still being fetched", () => {
    show(connected);
    act(() => hook.start());
    act(() => vi.advanceTimersByTime(2000));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(hook.connecting).toBe(true);
    // The page opens: now coming back stops it.
    act(() => hook.opened());
    act(() => vi.advanceTimersByTime(500));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(hook.connecting).toBe(false);
  });

  it("ignores the focus that comes with the hand-over to the browser", () => {
    show(connected);
    act(() => hook.start());
    act(() => hook.opened());
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(hook.connecting).toBe(true);
  });

  it("stops when the browser shows the page again from its cache (Back)", () => {
    show(connected);
    act(() => hook.start());
    act(() => {
      const e = new Event("pageshow") as PageTransitionEvent;
      Object.defineProperty(e, "persisted", { value: true });
      window.dispatchEvent(e);
    });
    expect(hook.connecting).toBe(false);
  });

  it("stop() ends it at once, and a later account change does not restart anything", () => {
    show(loggedOut);
    press();
    act(() => hook.stop());
    expect(hook.connecting).toBe(false);
    show(connected);
    expect(hook.connecting).toBe(false);
  });
});
