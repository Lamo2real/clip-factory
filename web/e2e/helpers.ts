import type { Page } from "@playwright/test";
import { settingsPath, TREES } from "../src/lib/settingsTree.ts";

/** Every page of the settings tree (§15.1), and each platform's setup page (§17.1). */
export const SETUP_ROUTES: string[] = ["youtube", "tiktok", "instagram", "facebook", "x"].map((p) => `/settings/posting/setup/${p}`);
export const SETTINGS_ROUTES: string[] = [
  settingsPath(),
  ...TREES.flatMap((t) => [settingsPath(t.slug), ...t.branches.map((b) => settingsPath(t.slug, b.slug))]),
  ...SETUP_ROUTES,
];

export const ROUTES: string[] = [
  "/",
  "/jobs",
  "/jobs/:running",
  "/jobs/:failed",
  "/review",
  "/library",
  ...SETTINGS_ROUTES,
  "/get-app",
  "/mock-oauth/youtube",
  "/about.html",
  "/legal/privacy.html",
  "/legal/terms.html",
  "/nope",
];
export const WIDTHS = [320, 360, 375, 390, 414, 430, 768, 1024, 1280, 1440, 1920] as const;

/** Waits until the screen has its data (no skeletons) and entrance animations have settled. */
export async function settle(page: Page) {
  await page.waitForFunction(() => !document.querySelector(".skeleton, .boot"), undefined, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(650);
}

/** Resolves the ":running" / ":failed" placeholders to real job ids from the mock list. */
export async function resolveRoute(page: Page, route: string): Promise<string> {
  if (!route.includes(":")) return route;
  const want = route.endsWith(":running") ? "Ranked grind" : "Charity marathon";
  await page.goto("/jobs");
  await settle(page);
  const href = await page.locator(".job-row", { hasText: want }).first().getAttribute("href");
  if (!href) throw new Error(`no job for ${route}`);
  return href;
}

export interface Overflow {
  selector: string;
  text: string;
  scrollWidth: number;
  clientWidth: number;
}

/**
 * Every element that carries text (or media) and is wider inside than its box, ignoring boxes that are meant to
 * scroll or to clip with an ellipsis or line clamp. Also reports horizontal page scroll.
 */
export async function findOverflow(page: Page): Promise<{ page: number; viewport: number; items: Overflow[] }> {
  return page.evaluate(() => {
    const scrollable = (s: CSSStyleDeclaration) => /(auto|scroll)/.test(s.overflowX);
    const clipsOnPurpose = (s: CSSStyleDeclaration) =>
      s.textOverflow === "ellipsis" || (s.webkitLineClamp && s.webkitLineClamp !== "none");
    const items: { selector: string; text: string; scrollWidth: number; clientWidth: number }[] = [];
    const describe = (el: Element) => {
      const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
      return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}`;
    };
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      // The paper plane in flight leaves its button on purpose (it lands back inside).
      if (el.closest(".sr-only, svg, .backdrop, .confetti, .glass-defs, .fly.is-flying")) continue;
      if (["INPUT", "TEXTAREA", "SELECT", "OPTION", "SCRIPT", "STYLE", "CANVAS", "VIDEO"].includes(el.tagName)) continue;
      const s = getComputedStyle(el);
      if (s.display === "inline" || s.display === "none" || s.visibility === "hidden" || s.position === "fixed") continue;
      if (el.clientWidth === 0) continue;
      const hasText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent!.trim().length > 0);
      const hasMedia = !!el.querySelector(":scope > img, :scope > svg, :scope > video");
      if (!hasText && !hasMedia) continue;
      if (scrollable(s) || clipsOnPurpose(s)) continue;
      if (el.scrollWidth > el.clientWidth + 1) {
        items.push({ selector: describe(el), text: (el.textContent ?? "").trim().slice(0, 60), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
      }
      // A child box poking out of its parent's right edge (catches media and fixed-width children too).
      const r = el.getBoundingClientRect();
      const p = el.parentElement;
      if (p && !el.closest("[data-tip]")) {
        const ps = getComputedStyle(p);
        const pr = p.getBoundingClientRect();
        if (!scrollable(ps) && ps.display !== "inline" && r.width > 0 && r.right > pr.right + 1.5 && s.position !== "absolute") {
          items.push({ selector: `${describe(el)} > outside ${describe(p)}`, text: (el.textContent ?? "").trim().slice(0, 60), scrollWidth: Math.round(r.right), clientWidth: Math.round(pr.right) });
        }
      }
    }
    return { page: document.documentElement.scrollWidth, viewport: window.innerWidth, items };
  });
}

/** This week's mock clips (docs/CONTRACTS.md §16): every platform state appears on one of them. */
export const CLIPS = {
  /** Posted everywhere with numbers; TikTok has the most views (the crown). */
  all: "One shot. Whole lobby gone.",
  /** YouTube numbers, TikTok private, Instagram waiting, Facebook failed, X not posted. */
  mixed: "He finally lost it at 3 a.m.",
  /** YouTube posting, TikTok posted without numbers yet, the rest with numbers. */
  fresh: "Police chase in reverse",
} as const;

/**
 * Opens a clip's performance page from the Library, the way the owner does. (The mock makes new ids on every page
 * load, so a clip page is reached by clicking, never by typing its address.)
 */
export async function openClip(page: Page, hook: string) {
  await page.goto("/library");
  await settle(page);
  const card = page.locator(".lib-card", { has: page.locator(".lib-card__hook", { hasText: hook }) });
  await card.locator(".lib-card__link").click();
  await page.waitForURL(/\/clips\/[A-Z0-9]+$/);
  await page.locator("[data-stack]").nth(4).waitFor();
  await settle(page);
  // The lines draw in and the stacks rise over about 1.3 s; a fixed wait was too short on slow CI runners.
  await animationsDone(page);
}

/** Waits until every finite animation (draw-ins, rises, fades) has finished; endless ones (the backdrop) are ignored. */
export async function animationsDone(page: Page) {
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .every((a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity),
    undefined,
    { timeout: 15_000 },
  );
}
