// Notifications on this device (docs/CONTRACTS.md §32.8): an iPhone Safari tab gets the Home Screen steps and is
// never asked for permission; the installed app asks only inside the tap, then subscribes and saves the device; a
// refusal shows where to turn them back on; the choices save to settings; the job page card asks once.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, Me, Settings } from "../src/api/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";

const calls: string[] = [];
const savePushDevice = vi.fn(async (deviceId: string, body: { deviceLabel: string }) => ({
  deviceId,
  kind: "webpush" as const,
  deviceLabel: body.deviceLabel,
  createdAt: "",
  updatedAt: "",
}));
const current: Partial<Api> = {
  pushKey: async () => {
    calls.push("key");
    return KEY;
  },
  savePushDevice,
  deletePushDevice: vi.fn(async () => {}),
  sendTestPush: vi.fn(async () => ({ sent: 1, devices: 1 })),
  listJobs: async () => ({ jobs: [], nextCursor: null }),
};
vi.mock("../src/api/index.ts", async (orig) => ({ ...(await orig<object>()), api: () => current as Api }));

const saveSettings = vi.fn(async (patch: Partial<Settings>) => patch);
const me = { user: { id: "u", email: "a@b.c" }, settings: { notify: { ready: true, stopped: true, resumed: false, steps: false } } } as unknown as Me;
vi.mock("../src/app/session.tsx", () => ({ useSession: () => ({ me, saveSettings }) }));

const { NotifyBranch, NotifyCard } = await import("../src/screens/settings/NotifyBranch.tsx");
const { ToastProvider } = await import("../src/components/Toasts.tsx");
const push = await import("../src/lib/push.ts");

let host: HTMLElement;
let root: Root;
let permission: NotificationPermission;
let answer: NotificationPermission;
let subscription: { endpoint: string; toJSON(): unknown; unsubscribe(): Promise<boolean> } | null;
const subscribe = vi.fn(async (opts: { applicationServerKey: Uint8Array }) => {
  calls.push("subscribe");
  expect(opts.applicationServerKey).toHaveLength(65);
  subscription = {
    endpoint: "https://web.push.apple.com/abc",
    toJSON: () => ({ endpoint: "https://web.push.apple.com/abc", keys: { p256dh: "p", auth: "a" } }),
    unsubscribe: async () => true,
  };
  return subscription;
});
const requestPermission = vi.fn(() => {
  calls.push("permission");
  permission = answer;
  return Promise.resolve(answer);
});

function device(ua: string, standalone: boolean, withPush = true) {
  Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
  Object.defineProperty(navigator, "maxTouchPoints", { value: ua === IPHONE ? 5 : 0, configurable: true });
  Object.defineProperty(navigator, "standalone", { value: standalone, configurable: true });
  const g = globalThis as Record<string, unknown>;
  if (withPush) {
    g.Notification = { get permission() { return permission; }, requestPermission };
    g.PushManager = function PushManager() {};
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistration: async () => ({ pushManager: { getSubscription: async () => subscription, subscribe } }) },
    });
  } else {
    delete g.Notification;
    delete g.PushManager;
  }
}

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const text = () => host.textContent ?? "";
const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);

async function render(node: React.ReactNode) {
  act(() => root.render(<ToastProvider>{node}</ToastProvider>));
  await flush();
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  calls.length = 0;
  vi.clearAllMocks();
  permission = "default";
  answer = "granted";
  subscription = null;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("pushState", () => {
  const base = { os: "ios" as const, installed: true, hasNotification: true, hasPushManager: true, hasServiceWorker: true, permission: "default" as const, subscribed: false };
  it("needs the Home Screen on iPhone, works when installed", () => {
    expect(push.pushState({ ...base, installed: false, hasNotification: false })).toBe("needs-install");
    expect(push.pushState(base)).toBe("off");
    expect(push.pushState({ ...base, permission: "granted", subscribed: true })).toBe("on");
    expect(push.pushState({ ...base, permission: "denied" })).toBe("blocked");
  });
  it("is unsupported without Web Push off iPhone", () => {
    expect(push.pushState({ ...base, os: "mac", installed: false, hasPushManager: false })).toBe("unsupported");
    expect(push.pushState({ ...base, os: "mac", installed: false })).toBe("off");
  });
  it("names the device from a fixed list", () => {
    expect(push.deviceLabel("ios", IPHONE)).toBe("iPhone");
    expect(push.deviceLabel("mac", MAC)).toBe("Mac");
    expect(push.deviceLabel("unknown", "")).toBe("This device");
  });
  it("turns the key into 65 bytes", () => {
    expect(push.keyBytes(KEY)).toHaveLength(65);
  });
});

describe("Settings › Notifications", () => {
  it("in a Safari tab on iPhone shows the Home Screen steps and never asks", async () => {
    device(IPHONE, false, false);
    await render(<NotifyBranch />);
    expect(text()).toContain("Add Clip Factory to your Home Screen first");
    expect(button("Turn on")).toBeUndefined();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("in the Home Screen app asks inside the tap, then subscribes and saves this iPhone", async () => {
    device(IPHONE, true);
    await render(<NotifyBranch />);
    const on = button("Turn on");
    expect(on).toBeDefined();
    act(() => on!.click());
    // Asked in the same tap, before anything was awaited (Safari forgets the tap after an await).
    expect(calls[0]).toBe("permission");
    await flush();
    await flush();
    expect(calls).toEqual(["permission", "key", "subscribe"]);
    expect(savePushDevice).toHaveBeenCalledWith(expect.stringMatching(/^[A-Za-z0-9_-]{8,64}$/), {
      endpoint: "https://web.push.apple.com/abc",
      keys: { p256dh: "p", auth: "a" },
      deviceLabel: "iPhone",
    });
    expect(text()).toContain("This device gets them, even when Clip Factory is closed.");
  });

  it("after Don't Allow says where to turn them back on", async () => {
    device(IPHONE, true);
    answer = "denied";
    await render(<NotifyBranch />);
    act(() => button("Turn on")!.click());
    await flush();
    expect(text()).toContain("Turn them on in Settings > Notifications > Clip Factory.");
    expect(savePushDevice).not.toHaveBeenCalled();
  });

  it("saves the choices; every step is off by default", async () => {
    device(MAC, false);
    await render(<NotifyBranch />);
    const steps = host.querySelector<HTMLButtonElement>('button[aria-labelledby="notify-steps-name"]');
    expect(steps?.getAttribute("aria-checked")).toBe("false");
    act(() => steps!.click());
    expect(saveSettings).toHaveBeenCalledWith({ notify: { ready: true, stopped: true, resumed: false, steps: true } });
    expect(text()).toContain("Lock Screen widgets only come with App Store apps.");
  });
});

describe("keeping \"On\" true", () => {
  let clock = Date.now();
  beforeEach(() => {
    clock += 3_600_000; // past the once-a-minute throttle of every earlier test
    vi.spyOn(Date, "now").mockReturnValue(clock);
  });
  afterEach(() => vi.restoreAllMocks());

  function subscribed() {
    permission = "granted";
    subscription = { endpoint: "https://web.push.apple.com/abc", toJSON: () => ({ endpoint: "https://web.push.apple.com/abc", keys: { p256dh: "p", auth: "a" } }), unsubscribe: vi.fn(async () => true) };
  }

  it("says the subscription to the server again when Settings opens", async () => {
    device(IPHONE, true);
    subscribed();
    await render(<NotifyBranch />);
    expect(savePushDevice).toHaveBeenCalledTimes(1);
    expect(text()).toContain("This device gets them");
  });

  it("shows Off with Turn on when the server cannot take it", async () => {
    device(IPHONE, true);
    subscribed();
    savePushDevice.mockRejectedValueOnce(new Error("offline"));
    await render(<NotifyBranch />);
    expect(button("Turn on")).toBeDefined();
    expect(text()).not.toContain("This device gets them");
  });

  it("a test the server answers 404 to says it again and tells the owner", async () => {
    device(IPHONE, true);
    subscribed();
    await render(<NotifyBranch />);
    (current.sendTestPush as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error("none"), { status: 404 }));
    savePushDevice.mockClear();
    act(() => button("Send a test")!.click());
    await flush();
    await flush();
    expect(savePushDevice).toHaveBeenCalled();
    expect(text()).toContain("Fixed it. Tap Send a test again.");
  });

  it("signing out forgets this device on the server and in the browser", async () => {
    device(IPHONE, true);
    subscribed();
    const sub = subscription!;
    await push.forgetDevice();
    expect(current.deletePushDevice).toHaveBeenCalledTimes(1);
    expect(sub.unsubscribe).toHaveBeenCalled();
  });

  it("signing out with nothing on does nothing", async () => {
    device(IPHONE, true);
    await push.forgetDevice();
    expect(current.deletePushDevice).not.toHaveBeenCalled();
  });

  it("the blocked help sits in the announced status region", async () => {
    device(IPHONE, true);
    permission = "denied";
    await render(<NotifyBranch />);
    const status = host.querySelector(".notify-device [role=status]");
    expect(status?.textContent).toContain("Settings > Notifications > Clip Factory.");
  });
});

describe("the job page card", () => {
  it("asks once; Not now hides it for good", async () => {
    device(MAC, false);
    await render(<NotifyCard />);
    expect(text()).toContain("Get told when your clips are ready");
    act(() => button("Not now")!.click());
    expect(text()).toBe("");
    await render(<NotifyCard />);
    expect(text()).toBe("");
  });

  it("never shows in a Safari tab on iPhone", async () => {
    device(IPHONE, false, false);
    await render(<NotifyCard />);
    expect(text()).toBe("");
  });
});
