// Lamo Stories › Settings › Video › Prices and keys (docs/CONTRACTS.md §45.34 "Provider usage and cost"), against the
// in-memory API: a maker's price is shown at once and saved after, so a save that ends after the owner opened another
// maker's form closes only its own form, never the one he is typing in.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ToastProvider } from "../src/components/Toasts.tsx";
import { forgetLoaded } from "../src/lib/hooks.ts";
import { setStoriesApi } from "../src/stories/api/client.ts";
import { mockStoriesApi } from "../src/stories/api/mock/index.ts";
import { setMockLatency } from "../src/stories/api/mock/store.ts";
import type { StoriesApi } from "../src/stories/api/types.ts";
import { forgetOnboarding } from "../src/stories/ui.tsx";
import { resetWorkspaceMemory } from "../src/stories/workspace.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SettingsScreen } = await import("../src/stories/screens/Settings.tsx");

let host: HTMLElement;
let root: Root;
/** Holds every putAi until let go, as a slow network would. */
let letGo: (() => void) | null = null;

function start() {
  (window as unknown as { __cfStoriesMock?: unknown }).__cfStoriesMock = { knobs: { checkModelsMs: 20 } };
  const real = mockStoriesApi() as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const api = new Proxy(real, {
    get(target, key: string) {
      const fn = target[key]!;
      if (key !== "putAi") return fn;
      return async (...args: unknown[]) => {
        await new Promise<void>((r) => (letGo = r));
        return fn(...args);
      };
    },
  }) as unknown as StoriesApi;
  setStoriesApi(api);
}

async function settle(times = 8) {
  for (let i = 0; i < times; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
}
const $$ = <T extends Element = HTMLElement>(sel: string, from: ParentNode = document) => Array.from(from.querySelectorAll<T>(sel));
function byText<T extends HTMLElement = HTMLElement>(sel: string, text: string | RegExp, from: ParentNode = document): T {
  const el = $$<T>(sel, from).find((e) => (typeof text === "string" ? e.textContent?.trim() === text : text.test(e.textContent ?? "")));
  if (!el) throw new Error(`no ${sel} with ${String(text)}; have: ${$$(sel, from).map((e) => e.textContent?.trim()).join(" | ")}`);
  return el;
}
async function click(el: Element) {
  await act(async () => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await settle();
}
function fill(form: HTMLElement, label: string, value: string) {
  const l = $$<HTMLLabelElement>("label", form).find((x) => x.textContent === label);
  const el = l ? form.querySelector<HTMLInputElement>(`#${CSS.escape(l.htmlFor)}`) : null;
  if (!el) throw new Error(`no field ${label}`);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const row = (name: string) => byText<HTMLElement>(".st-stg-price", new RegExp(`^${name}`));
const form = (el: HTMLElement) => el.querySelector<HTMLFormElement>("form.st-stg-price__form");

beforeEach(() => {
  letGo = null;
  localStorage.clear();
  resetWorkspaceMemory();
  forgetOnboarding();
  setMockLatency(0);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  setStoriesApi(null);
});

it("a price saved late closes only its own form: the maker the owner opened since stays open", async () => {
  start();
  forgetLoaded();
  await act(async () =>
    root.render(
      <ToastProvider>
        <SettingsScreen ws="stories" page={{ name: "settings", section: "video" }} />
      </ToastProvider>,
    ),
  );
  await settle();
  await click(byText("button", /^Type a price$/, row("Luma AI Ray2")));
  fill(form(row("Luma AI Ray2"))!, "Price for one second", "0.08");
  await act(async () => form(row("Luma AI Ray2"))!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await settle();
  // Shown at once, while the save is still on its way.
  expect(row("Luma AI Ray2").textContent).toContain("Your price");
  expect(letGo).not.toBeNull();
  // The owner opens the next maker's form before the save comes back.
  await click(byText("button", /^Type a price$/, row("Stability AI")));
  expect(form(row("Stability AI"))).not.toBeNull();
  await act(async () => letGo!());
  await settle();
  expect(row("Luma AI Ray2").textContent).toContain("0.08 for a second of video");
  expect(form(row("Luma AI Ray2"))).toBeNull();
  // Still open: only the Luma AI Ray2 form was closed by its save.
  expect(form(row("Stability AI"))).not.toBeNull();
});
