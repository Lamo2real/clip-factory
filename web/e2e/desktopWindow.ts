import type { Page } from "@playwright/test";

/**
 * Pretends to be the macOS desktop window the way desktop/src-tauri/src/main.rs and init.js set it up: the wrapper
 * flag, Liquid Glass behind a see-through page, and the title bar laid over the page (`__CF_TITLEBAR__`, 28 px), so
 * the page keeps the traffic lights' band clear (docs/CONTRACTS.md §11.1, §12.3). `titlebar: 0` is a Windows or
 * Linux window (its frame sits outside the page).
 */
export async function asMacWindow(page: Page, { titlebar = 28, glass = "liquid" }: { titlebar?: number; glass?: string } = {}) {
  await page.addInitScript(
    ({ titlebar, glass }) => {
      const w = window as unknown as Record<string, unknown>;
      w.__CF_GLASS__ = glass;
      w.__CF_TITLEBAR__ = titlebar;
      w.__CF_DESKTOP__ = true;
    },
    { titlebar, glass },
  );
}

/** Where the macOS traffic lights sit in a window with an overlay title bar (CSS px from the top left). */
export const TRAFFIC_LIGHTS = { x: 0, y: 0, width: 80, height: 28 } as const;
