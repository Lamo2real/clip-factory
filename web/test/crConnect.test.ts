// lib/crConnect.ts (docs/CONTRACTS.md §38.3, §38.15): where the page runs decides step 3's words, and one Connect
// in the Mac app goes listen → connect → open → result every 500 ms → finish, with every way it can end.
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import type { CrConnectResult, CrConnection } from "../src/api/types.ts";
import { connectPlace, crBridge, PLACE_WORDS, POLL_MS, runConnect, type CrBridge, type CrDoorResult } from "../src/lib/crConnect.ts";

const connection = { status: "connected", canSubmit: true, crLinked: {}, stepsDone: [], pilotEmail: { to: "", subject: "", body: "", mailto: "" } } as CrConnection;

function bridge(results: CrDoorResult[], over: Partial<CrBridge> = {}): CrBridge & { opened: string[]; canceled: number } {
  const b = {
    version: 1 as const,
    opened: [] as string[],
    canceled: 0,
    listen: vi.fn(async () => ({ port: 47812, expiresAt: "2026-11-21T10:05:00Z" })),
    open: vi.fn(async (url: string) => {
      b.opened.push(url);
      return {};
    }),
    result: vi.fn(async () => results.shift() ?? { status: "waiting" as const }),
    cancel: vi.fn(async () => {
      b.canceled++;
      return {};
    }),
    ...over,
  };
  return b;
}

const api = (finish: (body: unknown) => Promise<{ result: CrConnectResult; connection: CrConnection }> = vi.fn(async () => ({ result: "connected" as const, connection }))) => ({
  crConnect: vi.fn(async (port: number) => ({ authorizeUrl: `https://id.contentrewards.com/oauth2/authorize?port=${port}`, expiresAt: "x" })),
  crConnectFinish: finish,
});

const fast = { sleep: async () => undefined };

describe("connectPlace", () => {
  it("the Mac app with the door, an older Mac app, a phone, a computer's browser", () => {
    const door = { __CF_CR_CONNECT__: bridge([]), __CF_DESKTOP__: true };
    expect(connectPlace(door, false)).toBe("bridge");
    expect(connectPlace(door, true)).toBe("bridge");
    expect(connectPlace({ __CF_DESKTOP__: true, __CF_GLASS__: "liquid", __CF_DESKTOP_VERSION__: "1.4.0" }, false)).toMatch(/^old_app/);
    expect(connectPlace({}, true)).toBe("phone");
    expect(connectPlace({}, false)).toBe("browser");
    expect(connectPlace(undefined, false)).toBe("browser");
  });

  it("a bridge of another version, or with a command missing, is no bridge", () => {
    expect(crBridge({ __CF_CR_CONNECT__: { ...bridge([]), version: 2 as 1 } })).toBeNull();
    expect(crBridge({ __CF_CR_CONNECT__: { version: 1, listen: async () => ({ port: 1, expiresAt: "" }) } })).toBeNull();
  });

  it("each place's words", () => {
    expect(PLACE_WORDS.phone).toEqual(["Do this step on your Mac. Open Clip Factory there, then Settings, Set up posting, Content Rewards."]);
    expect(PLACE_WORDS.browser[0]).toBe("Connect works in the Clip Factory app on your Mac.");
    expect(PLACE_WORDS.old_app[0]).toBe("Update the Clip Factory app first.");
    expect(PLACE_WORDS.old_app_cant_update[0]).toBe("This copy can't update itself. Tap Get the app, install the new one, then open it.");
  });
});

describe("runConnect", () => {
  it("allowed: the code goes to the API at once, with the state and iss", async () => {
    const b = bridge([{ status: "waiting" }, { status: "done", code: "c0de", state: "s1", iss: "https://id.contentrewards.com" }]);
    const a = api();
    const opened = vi.fn();
    const out = await runConnect({ api: a, bridge: b, signal: new AbortController().signal, onOpened: opened, ...fast });
    expect(out).toEqual({ kind: "result", result: "connected", connection });
    expect(a.crConnect).toHaveBeenCalledWith(47812);
    expect(b.opened).toEqual(["https://id.contentrewards.com/oauth2/authorize?port=47812"]);
    expect(opened).toHaveBeenCalledOnce();
    expect(a.crConnectFinish).toHaveBeenCalledWith({ state: "s1", code: "c0de", iss: "https://id.contentrewards.com" });
    expect(POLL_MS).toBe(500);
  });

  it("Cancel on the consent page: the error and its description go to the API", async () => {
    const b = bridge([{ status: "error", error: "access_denied", state: "s1", errorDescription: "The user said no" }]);
    const a = api(vi.fn(async () => ({ result: "denied" as const, connection })));
    const out = await runConnect({ api: a, bridge: b, signal: new AbortController().signal, ...fast });
    expect(out).toMatchObject({ kind: "result", result: "denied" });
    expect(a.crConnectFinish).toHaveBeenCalledWith({ state: "s1", error: "access_denied", errorDescription: "The user said no" });
  });

  it("the door expired; it waited too long", async () => {
    expect(await runConnect({ api: api(), bridge: bridge([{ status: "expired" }]), signal: new AbortController().signal, ...fast })).toEqual({ kind: "result", result: "expired" });
    let t = 0;
    const out = await runConnect({ api: api(), bridge: bridge([]), signal: new AbortController().signal, sleep: async () => void (t += 60_000), now: () => t });
    expect(out).toEqual({ kind: "result", result: "expired" });
  });

  it("listen errors: no port, busy, and Windows (unsupported → the browser's words)", async () => {
    const fail = (code: string) => bridge([], { listen: vi.fn(async () => Promise.reject({ code })) });
    expect(await runConnect({ api: api(), bridge: fail("no_port"), signal: new AbortController().signal, ...fast })).toEqual({ kind: "result", result: "no_port" });
    expect(await runConnect({ api: api(), bridge: fail("busy"), signal: new AbortController().signal, ...fast })).toEqual({ kind: "result", result: "busy" });
    expect(await runConnect({ api: api(), bridge: fail("unsupported"), signal: new AbortController().signal, ...fast })).toEqual({ kind: "unsupported" });
  });

  it("the API refuses the start: its sentence, and the door is closed", async () => {
    const b = bridge([]);
    const a = { ...api(), crConnect: vi.fn(async () => Promise.reject(new ApiError(503, "unavailable", "Content Rewards is not switched on for this app yet."))) };
    expect(await runConnect({ api: a, bridge: b, signal: new AbortController().signal, ...fast })).toEqual({ kind: "failed", message: "Content Rewards is not switched on for this app yet." });
    expect(b.canceled).toBe(1);
    expect(b.opened).toEqual([]);
  });

  it("Cancel (or leaving the page) closes the door and posts nothing", async () => {
    const ctl = new AbortController();
    const b = bridge([]);
    const a = api();
    let n = 0;
    const out = await runConnect({
      api: a,
      bridge: b,
      signal: ctl.signal,
      sleep: async () => {
        if (++n === 2) ctl.abort();
      },
    });
    expect(out).toEqual({ kind: "canceled" });
    expect(b.canceled).toBe(1);
    expect(a.crConnectFinish).not.toHaveBeenCalled();
  });
});
