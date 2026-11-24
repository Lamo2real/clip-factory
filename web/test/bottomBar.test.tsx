import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seed } from "../src/api/mock/fixtures.ts";
import { mockApi } from "../src/api/mock/index.ts";
import type { Api } from "../src/api/types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let current: Api;
vi.mock("../src/api/index.ts", () => ({ api: () => current }));
vi.mock("../src/lib/config.ts", () => ({ config: () => ({ wsUrl: "ws://test" }), isMock: true }));
vi.mock("../src/lib/live.ts", async (orig) => ({
  ...(await orig<typeof import("../src/lib/live.ts")>()),
  startLive: () => undefined,
  stopLive: () => undefined,
  useLiveEvents: () => undefined,
  useLivePoll: () => undefined,
}));

const { SessionProvider } = await import("../src/app/session.tsx");
const { ToastProvider } = await import("../src/components/Toasts.tsx");
const { TabBar } = await import("../src/components/Nav.tsx");

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

// Dropdown keeps an opened list above the phone's bottom tab bar of the app on screen, found by data-bottom-bar so the
// shared component names neither app's classes (and Clips Funded's stay out of Clip Factory's main bundle). Clips
// Funded's .st-tabbar is checked in storiesApp.test.tsx; this is Clip Factory's.
describe("Clip Factory's bottom tab bar", () => {
  it("carries the shared mark Dropdown keeps its list above", async () => {
    current = mockApi(seed());
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(
        <ToastProvider>
          <SessionProvider onSignOut={() => undefined}>
            <TabBar />
          </SessionProvider>
        </ToastProvider>,
      ),
    );
    expect(host.querySelector("nav.tabbar[data-bottom-bar]")).not.toBeNull();
  });
});
