// Clips Funded › Make a new video: drafts, main and villain, and vehicles in plural, in mock mode (docs/CONTRACTS.md
// §45.47; the owner's words of 24 Nov: "allow me to save drafts before making video", "the main character and the
// villain character for each video", "vehicles (in plural)"):
// * Save draft keeps the form ("Draft saved"), then it saves itself 2 s after a change ("Saving…", "Saved");
// * Production shows a Drafts group above the videos, and Open brings every pick back (?draft=);
// * Who is in it: the people, the Main character and Villain bars, and up to 2 vehicles (a third is held);
// * Make the video sends the main character first with the roles, and the draft is gone;
// * the page keeps the studio's rules (no sideways scroll, targets of 44 px, 48 on phones, contrast, sliding bars).
// Clips Funded is switched on with cf.storiesPreview = 1; nothing leaves the machine. The mock's store lives in the
// page, so the flow moves inside the app and never reloads.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { visibleEdges } from "./edges.ts";
import { findOverflow } from "./helpers.ts";

const C = { pip: "01JSTCH0000000000000000001", bolt: "01JSTCH0000000000000000002", rosso: "01JSTCH0000000000000000005" };
const BLUE = "01JSTCH00000000000000CAR98";
const GREEN = "01JSTCH00000000000000CAR97";

type Draft = { draftId: string; name: string; version: number; form: Record<string, unknown> };
type MockWindow = Window & {
  __cfStoriesMock?: {
    knobs?: Record<string, unknown>;
    store?: {
      knobs: Record<string, unknown>;
      drafts: Draft[];
      stories: { storyId: string; title: string; characterIds: string[]; roles?: { mainId: string; villainId?: string } }[];
      characters: { characterId: string; name: string; kind?: string; workspaceId: string }[];
    };
  };
};

async function context(browser: Browser, width: number, height: number, touch: boolean) {
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
  await ctx.addInitScript(() => {
    localStorage.setItem("cf.storiesPreview", "1");
    (window as MockWindow).__cfStoriesMock = { knobs: { jobSeconds: 3 } };
  });
  return ctx;
}

async function settle(page: Page) {
  await page.locator(".st-studio").first().waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => !document.querySelector(".st-studio .st-s-busy"), undefined, { timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
}

/** Moves inside the app without a reload, so the mock store keeps what the test made. */
async function go(page: Page, path: string) {
  await page.evaluate((to) => {
    history.pushState({}, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await settle(page);
}

const store = (page: Page) => page.evaluate(() => (window as MockWindow).__cfStoriesMock?.store);

/** The studio's measured rules on the page as it is now (the same as stories-studio.spec.ts). */
async function audit(page: Page, label: string, phone: boolean): Promise<string[]> {
  const out: string[] = [];
  const o = await findOverflow(page);
  if (o.page > o.viewport) out.push(`${label}: the page scrolls sideways (${o.page} > ${o.viewport})`);
  for (const i of o.items) if (/st-/.test(i.selector)) out.push(`${label}: ${i.selector} "${i.text}" ${i.scrollWidth} > ${i.clientWidth}`);
  for (const e of await visibleEdges(page)) if (/\.st-/.test(e)) out.push(`${label}: edge ${e}`);
  const axe = await new AxeBuilder({ page }).include(".st-studio").withRules(["color-contrast"]).analyze();
  for (const v of axe.violations) for (const n of v.nodes) out.push(`${label}: contrast ${n.target.join(" ")}: ${n.any.map((c) => c.message).join("; ")}`);
  const bad = await page.evaluate((min) => {
    const found: string[] = [];
    const vw = document.documentElement.clientWidth;
    for (const e of document.querySelectorAll<HTMLElement>(".st-studio button, .st-studio a, .st-studio input:not([type=radio]):not([type=file])")) {
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(e).display === "inline") continue;
      const name = (e.getAttribute("aria-label") || e.textContent || e.tagName).trim().slice(0, 40);
      if (r.height < min - 0.5 || r.width < min - 0.5) found.push(`"${name}" is ${Math.round(r.width)}x${Math.round(r.height)}`);
      if (r.right > vw + 0.5 || r.left < -0.5) found.push(`"${name}" is off the screen`);
      const cursor = getComputedStyle(e).cursor;
      if (cursor !== "default" && cursor !== "auto") found.push(`"${name}" changes the cursor (${cursor})`);
    }
    for (const bar of document.querySelectorAll(".st-studio [role=radiogroup]")) if (!bar.querySelector(":scope > .glide")) found.push(`a pick-one bar without its sliding highlight: ${bar.textContent?.slice(0, 40)}`);
    return found;
  }, phone ? 48 : 44);
  for (const b of bad) out.push(`${label}: ${b}`);
  return out;
}

const bar = (page: Page, label: string) => page.getByRole("radiogroup", { name: label });

for (const [w, h, touch] of [
  [390, 844, true],
  [1280, 800, false],
] as const)
  test(`a draft with a main character, a villain and two vehicles: saved, opened again, then made (${w})`, async ({ browser }) => {
    test.setTimeout(120_000);
    const ctx = await context(browser, w, h, touch);
    const page = await ctx.newPage();
    await page.goto("/stories/production/new");
    await settle(page);
    // two more vehicles beside Rosso, so a third can be held
    await page.evaluate(
      ({ blue, green, rosso }) => {
        const s = (window as MockWindow).__cfStoriesMock!.store!;
        const base = s.characters.find((c) => c.characterId === rosso)!;
        s.characters.push({ ...structuredClone(base), characterId: blue, name: "Blue" }, { ...structuredClone(base), characterId: green, name: "Green" });
      },
      { blue: BLUE, green: GREEN, rosso: C.rosso },
    );
    await go(page, "/stories/production");
    await page.getByRole("link", { name: "Make a new video" }).first().click();
    await settle(page);

    // The idea, in a few words.
    await page.locator(".st-s-pick__opt", { hasText: "Type an idea" }).click();
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("The big chase");
    await page.getByRole("textbox", { name: "What happens, in one line" }).fill("Bolt chases Pip and Rosso round the block.");
    await page.locator(".st-s-pick__opt", { hasText: "Funny" }).click();

    // Who is in it: two people, the main character and the villain, and two vehicles (a third is held).
    await expect(page.locator("#st-nv-2")).toHaveText("2 Who is in it");
    await page.locator(".st-s-casttile", { hasText: "Bolt" }).first().click();
    await page.locator(".st-s-casttile", { hasText: "Pip" }).first().click();
    await expect(bar(page, "Main character").locator(".st-s-pick__opt.is-on")).toHaveText("Bolt");
    await bar(page, "Main character").locator(".st-s-pick__opt", { hasText: "Pip" }).click();
    await bar(page, "Villain (you can skip this)").locator(".st-s-pick__opt", { hasText: "Bolt" }).click();
    await page.locator(".st-cast__cars .st-s-casttile", { hasText: "Rosso" }).click();
    await page.locator(".st-cast__cars .st-s-casttile", { hasText: "Blue" }).click();
    await expect(page.locator('.st-cast__cars .st-s-casttile[aria-pressed="true"]')).toHaveCount(2);
    await expect(page.locator(".st-cast__cars .st-s-casttile", { hasText: "Green" })).toHaveAttribute("aria-disabled", "true");
    expect(await audit(page, `Who is in it ${w}`, touch && w < 768)).toEqual([]);

    // Save draft: the toast, then the one word; a change saves itself.
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText("Draft saved")).toBeVisible();
    await expect(page.locator(".st-vd-state")).toHaveText("Saved");
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("The great chase");
    await expect(page.locator(".st-vd-state")).toHaveText("Saving…");
    await expect(page.locator(".st-vd-state")).toHaveText("Saved", { timeout: 10_000 });
    const saved = (await store(page))!.drafts;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ name: "The great chase", version: 2, form: { roles: { mainId: C.pip, villainId: C.bolt } } });

    // Production: the Drafts group above the videos; Open brings every pick back. Saved, so leaving does not ask.
    await page.getByRole("link", { name: "Production" }).first().click();
    await settle(page);
    await expect(page.getByRole("dialog", { name: "Leave without saving?" })).toHaveCount(0);
    await expect(page.locator("h2.st-s-section").first()).toHaveText("Drafts");
    expect(await audit(page, `Production with a draft ${w}`, touch && w < 768)).toEqual([]);
    await page.getByRole("link", { name: "Open The great chase" }).first().click();
    await settle(page);
    await expect(page).toHaveURL(new RegExp(`/stories/production/new\\?draft=${saved[0]!.draftId}$`));
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("The great chase");
    await expect(page.locator('.st-s-casttile[aria-pressed="true"]')).toHaveCount(4);
    await expect(bar(page, "Main character").locator(".st-s-pick__opt.is-on")).toHaveText("Pip");
    await expect(bar(page, "Villain (you can skip this)").locator(".st-s-pick__opt.is-on")).toHaveText("Bolt");
    await expect(page.locator(".st-vd-state")).toHaveText("Saved");

    // Make the video: the main character first, the roles with it, and the draft is gone.
    await page.getByRole("button", { name: "Make the video" }).click();
    await expect(page).toHaveURL(/\/stories\/production\/[0-9A-Z]{26}$/);
    const storyId = page.url().split("/").pop();
    const after = (await store(page))!;
    const made = after.stories.find((s) => s.storyId === storyId)!;
    expect(made.characterIds).toEqual([C.pip, C.bolt, C.rosso, BLUE]);
    expect(made.roles).toEqual({ mainId: C.pip, villainId: C.bolt });
    expect(after.drafts).toEqual([]);
    await ctx.close();
  });
