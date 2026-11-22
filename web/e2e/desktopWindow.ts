import type { Page } from "@playwright/test";

/**
 * Pretends to be the macOS desktop window the way desktop/src-tauri/src/main.rs and init.js set it up: the wrapper
 * flag, Liquid Glass behind a see-through page, and the title bar laid over the page (`__CF_TITLEBAR__`, 28 px), so
 * the page keeps the traffic lights' band clear (docs/CONTRACTS.md §11.1, §12.3). `titlebar: 0` is a Windows or
 * Linux window (its frame sits outside the page).
 */
export async function asMacWindow(
  page: Page,
  { titlebar = 28, glass = "liquid", crConnect = false, crListen = null }: { titlebar?: number; glass?: string; crConnect?: boolean; crListen?: "no_port" | "unsupported" | null } = {},
) {
  await page.addInitScript(
    ({ titlebar, glass, crConnect, crListen }) => {
      const w = window as unknown as Record<string, unknown>;
      w.__CF_GLASS__ = glass;
      w.__CF_TITLEBAR__ = titlebar;
      w.__CF_DESKTOP__ = true;
      if (!crConnect) return;
      // The Content Rewards sign-in door (docs/CONTRACTS.md §38.15, §38.18), faked: `open` shows the pretend consent
      // page in a new tab, whose Allow or Cancel leaves the answer in localStorage for the next `result`.
      const KEY = "cf-mock-cr-door";
      let state = "";
      w.__CF_CR_CONNECT__ = Object.freeze({
        version: 1,
        listen: () => {
          localStorage.removeItem(KEY);
          return crListen ? Promise.reject({ code: crListen }) : Promise.resolve({ port: 47811, expiresAt: new Date(Date.now() + 300_000).toISOString() });
        },
        open: (url: string) => {
          state = new URL(url, location.origin).searchParams.get("state") ?? "";
          window.open(url, "_blank");
          return Promise.resolve({});
        },
        result: () => {
          const raw = localStorage.getItem(KEY);
          if (!raw) return Promise.resolve({ status: "waiting" });
          localStorage.removeItem(KEY);
          const got = JSON.parse(raw) as Record<string, string>;
          return Promise.resolve({ ...got, state: got.state || state });
        },
        cancel: () => {
          localStorage.removeItem(KEY);
          return Promise.resolve({});
        },
      });
    },
    { titlebar, glass, crConnect, crListen },
  );
}

/** Where the macOS traffic lights sit in a window with an overlay title bar (CSS px from the top left). */
export const TRAFFIC_LIGHTS = { x: 0, y: 0, width: 80, height: 28 } as const;
