import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seed } from "../src/api/mock/fixtures.ts";
import { mockApi } from "../src/api/mock/index.ts";
import type { Api, Platform, Settings, SettingsPut } from "../src/api/types.ts";
import { withSkip } from "../src/lib/setupTodo.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The session talks to whatever `api()` returns; each test swaps in a mock it can break.
let current: Api;
vi.mock("../src/api/index.ts", () => ({ api: () => current }));
vi.mock("../src/lib/config.ts", () => ({ config: () => ({ wsUrl: "ws://test" }), isMock: true }));
vi.mock("../src/lib/live.ts", () => ({
  startLive: () => undefined,
  stopLive: () => undefined,
  useLiveEvents: () => undefined,
  useLivePoll: () => undefined,
}));

const { SessionProvider, useSession } = await import("../src/app/session.tsx");
const { ToastProvider } = await import("../src/components/Toasts.tsx");
const { getPrefs, setPrefs } = await import("../src/lib/prefs.ts");

type SessionValue = ReturnType<typeof useSession>;
let session: SessionValue;
function Probe() {
  session = useSession();
  return null;
}

let root: Root;
let host: HTMLElement;
const flush = (ms = 0) => act(async () => new Promise((r) => setTimeout(r, ms)));
async function until(ok: () => boolean) {
  for (let i = 0; i < 100 && !ok(); i++) await flush(20);
  expect(ok()).toBe(true);
}

beforeEach(async () => {
  current = mockApi(seed());
  setPrefs({ soundEnabled: true, clickSound: 6, errorSound: 5 });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <ToastProvider>
        <SessionProvider onSignOut={() => undefined}>
          <Probe />
        </SessionProvider>
      </ToastProvider>,
    ),
  );
  await until(() => !!session.me);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("saving settings", () => {
  it("applies a change at once and keeps it when the server stores it", async () => {
    expect(session.me?.settings.clickSound).toBe(6);
    await act(async () => void (await session.saveSettings({ clickSound: 12 })));
    expect(session.me?.settings.clickSound).toBe(12);
    expect(getPrefs().clickSound).toBe(12);
  });

  it("puts the control back when the save fails, even when the refresh after it fails too (offline)", async () => {
    const offline = new Error("Failed to fetch");
    current = {
      ...current,
      putSettings: () => Promise.reject(offline),
      me: () => Promise.reject(offline),
    };
    let result: unknown;
    await act(async () => {
      result = await session.saveSettings({ clickSound: 12, soundEnabled: false });
    });
    expect(result).toBeNull();
    expect(session.me?.settings.clickSound).toBe(6);
    expect(session.me?.settings.soundEnabled).toBe(true);
    // The sound engine reads these: it must go back to the sound the server really has.
    expect(getPrefs().clickSound).toBe(6);
    expect(getPrefs().soundEnabled).toBe(true);
    // And it said so.
    expect(host.ownerDocument.querySelector(".toast--error")).not.toBeNull();
  });

  it("a failed older save does not undo a newer change", async () => {
    let failFirst!: (e: Error) => void;
    const real = current;
    let calls = 0;
    current = {
      ...real,
      putSettings: (patch) => {
        calls++;
        if (calls === 1) return new Promise((_, reject) => (failFirst = reject));
        return real.putSettings(patch);
      },
    };
    let first!: Promise<unknown>;
    await act(async () => {
      first = session.saveSettings({ clickSound: 12 });
    });
    await act(async () => void (await session.saveSettings({ clickSound: 20 })));
    await act(async () => {
      failFirst(new Error("Failed to fetch"));
      await first;
    });
    await flush(600);
    expect(session.me?.settings.clickSound).toBe(20);
    expect(getPrefs().clickSound).toBe(20);
  });

  it("an updater builds on the newest settings, saves still on their way included, so two list changes both land", async () => {
    // The setup list's skips (§17.13): the floating list and Settings each change the one shared list.
    const real = current;
    const sent: SettingsPut[] = [];
    let release!: () => void;
    current = {
      ...real,
      putSettings: async (patch) => {
        sent.push(patch);
        if (sent.length === 1) await new Promise<void>((r) => (release = r));
        return real.putSettings(patch);
      },
    };
    const add = (p: Platform) => (s: Settings) => ({ setupSkipped: withSkip(s.setupSkipped ?? [], p) });
    let first!: Promise<unknown>;
    await act(async () => {
      first = session.saveSettings(add("x"));
    });
    await act(async () => void (await session.saveSettings(add("tiktok"))));
    expect(sent.map((p) => p.setupSkipped)).toEqual([["x"], ["tiktok", "x"]]);
    await act(async () => {
      release();
      await first;
    });
    await flush(50);
    expect(session.me?.settings.setupSkipped).toEqual(["tiktok", "x"]);
  });

  it("auto-posting: the screen gets the whole setting, the server only the changed key, in the order of the taps", async () => {
    // §46.3: the server merges each key, so a copy read before a change on another device never sends "on" back.
    const real = current;
    const sent: SettingsPut[] = [];
    let release!: () => void;
    current = {
      ...real,
      putSettings: async (patch) => {
        sent.push(patch);
        if (sent.length === 1) await new Promise<void>((r) => (release = r));
        return real.putSettings(patch);
      },
    };
    const whole = { on: false, everyHours: 5, perRun: 1, practice: false };
    let first!: Promise<unknown>;
    await act(async () => {
      first = session.saveSettings({ autoPost: { ...whole, on: true } }, { send: { autoPost: { on: true } }, inOrder: true });
    });
    let second!: Promise<unknown>;
    await act(async () => {
      second = session.saveSettings({ autoPost: { ...whole, on: false } }, { send: { autoPost: { on: false } }, inOrder: true });
    });
    // On screen at once; the second save waits for the first to be answered.
    expect(session.me?.settings.autoPost).toEqual(whole);
    expect(sent).toEqual([{ autoPost: { on: true } }]);
    await act(async () => {
      release();
      await Promise.all([first, second]);
    });
    expect(sent).toEqual([{ autoPost: { on: true } }, { autoPost: { on: false } }]);
    expect((await real.getSettings()).autoPost).toMatchObject({ on: false });
    expect(session.me?.settings.autoPost).toMatchObject({ on: false });
  });
});
