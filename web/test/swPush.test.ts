// The service worker's notifications (docs/CONTRACTS.md §32.6): a push shows the job's card with its tag (so the
// newest replaces the last), a progress card is quiet, the badge is set, and a tap opens the job in this app only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (event: unknown) => void;

function loadWorker() {
  const all: Record<string, Listener> = {};
  const windows: { url: string; focus: ReturnType<typeof vi.fn>; navigate: ReturnType<typeof vi.fn> }[] = [];
  const self = {
    location: { origin: "https://app.example" },
    addEventListener: (name: string, fn: Listener) => (all[name] = fn),
    registration: { showNotification: vi.fn(async () => {}) },
    navigator: { setAppBadge: vi.fn(async () => {}), clearAppBadge: vi.fn(async () => {}) },
    clients: { matchAll: vi.fn(async () => windows), openWindow: vi.fn(async () => null), claim: vi.fn() },
    skipWaiting: vi.fn(),
  };
  const source = readFileSync(join(import.meta.dirname, "../sw/sw.js"), "utf8")
    .replace("__CF_VERSION__", JSON.stringify("test"))
    .replace("__CF_PRECACHE__", "[]");
  new Function("self", "caches", "fetch", source)(self, {}, () => {});
  const listeners = { push: all.push!, notificationclick: all.notificationclick!, change: all.pushsubscriptionchange! };
  return { listeners, self, windows };
}

async function fire(listener: Listener, event: Record<string, unknown>) {
  let done: Promise<unknown> = Promise.resolve();
  listener({ ...event, waitUntil: (p: Promise<unknown>) => (done = p) });
  await done;
}

const pushOf = (data: unknown) => ({ data: { json: () => data } });

let w: ReturnType<typeof loadWorker>;
beforeEach(() => {
  w = loadWorker();
});

describe("push", () => {
  it("shows the job's card with its tag, and sets the badge", async () => {
    await fire(w.listeners.push, pushOf({ title: "Kai Cenat Scammed Me!.mp4", body: "Your clips are ready. Tap to look.", tag: "J1", url: "/jobs/J1", badge: 2 }));
    expect(w.self.registration.showNotification).toHaveBeenCalledWith(
      "Kai Cenat Scammed Me!.mp4",
      expect.objectContaining({ body: "Your clips are ready. Tap to look.", tag: "J1", renotify: true, silent: false, data: { url: "/jobs/J1" } }),
    );
    expect(w.self.navigator.setAppBadge).toHaveBeenCalledWith(2);
  });

  it("replaces a progress card quietly, and clears the badge at 0", async () => {
    await fire(w.listeners.push, pushOf({ title: "T", body: "Cutting the clips · step 7 of 10 · clip 3 of 10", tag: "J1", url: "/jobs/J1", quiet: true, badge: 0 }));
    expect(w.self.registration.showNotification).toHaveBeenCalledWith("T", expect.objectContaining({ tag: "J1", renotify: false, silent: true }));
    expect(w.self.navigator.clearAppBadge).toHaveBeenCalled();
  });

  it("always shows something, even for a broken message, and never keeps an outside link", async () => {
    await fire(w.listeners.push, { data: { json: () => { throw new Error("bad"); } } });
    expect(w.self.registration.showNotification).toHaveBeenCalledWith("Clip Factory", expect.objectContaining({ data: { url: "/" } }));
    await fire(w.listeners.push, pushOf({ title: "x", url: "https://evil.example/" }));
    await fire(w.listeners.push, pushOf({ title: "x", url: "//evil.example/" }));
    await fire(w.listeners.push, pushOf({ title: "x", url: "/\\evil.example" }));
    await fire(w.listeners.push, pushOf({ title: "x", url: "/\t/evil.example" }));
    await fire(w.listeners.push, pushOf({ title: "x", url: "/jobs/J1?next=//evil.example" }));
    const urls = w.self.registration.showNotification.mock.calls.map((c) => (c as unknown as [string, { data: { url: string } }])[1].data.url);
    expect(urls).toEqual(["/", "/", "/", "/", "/", "/"]);
  });
});

describe("a new subscription from the push service", () => {
  it("subscribes again with the same key and asks every open page to send it", async () => {
    const key = new Uint8Array([4, 1, 2]);
    const subscribe = vi.fn(async () => ({}));
    (w.self.registration as unknown as { pushManager: unknown }).pushManager = { subscribe };
    const post = vi.fn();
    w.windows.push({ url: "https://app.example/", postMessage: post } as never);
    await fire(w.listeners.change, { oldSubscription: { options: { applicationServerKey: key } } });
    expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: key });
    expect(post).toHaveBeenCalledWith({ type: "PUSH_SUBSCRIPTION_CHANGED" });
  });
});

describe("tapping a notification", () => {
  const click = (url: string) => ({ notification: { close: vi.fn(), data: { url } } });

  it("opens the job in a new window when the app is closed", async () => {
    await fire(w.listeners.notificationclick, click("/jobs/J1"));
    expect(w.self.clients.openWindow).toHaveBeenCalledWith("/jobs/J1");
  });

  it("brings the open app forward on the job", async () => {
    w.windows.push({ url: "https://app.example/", focus: vi.fn(async () => {}), navigate: vi.fn(async () => {}) });
    await fire(w.listeners.notificationclick, click("/jobs/J1"));
    expect(w.windows[0]!.focus).toHaveBeenCalled();
    expect(w.windows[0]!.navigate).toHaveBeenCalledWith("/jobs/J1");
    expect(w.self.clients.openWindow).not.toHaveBeenCalled();
  });
});
