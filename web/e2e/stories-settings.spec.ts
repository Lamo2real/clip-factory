import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { visibleEdges } from "./edges.ts";
import { findOverflow, WIDTHS } from "./helpers.ts";

// Lamo Stories › Settings (docs/CONTRACTS.md §45.25–§45.27, §45.29, §45.31) in the mock app: every section keeps the
// owner's rules from 320 to 1920 px (no overflow, the arrow cursor only, AA contrast, no visible edges, targets of
// 44 px and 48 px on phones, a hover state on every control, pick-one bars on <Glide>, the deny sound for what cannot
// be used), and the owner's controls really work: the default model and effort, Check models, each agent's and task's
// model, prices, agents on and off, instructions with Reset, skills written, uploaded and restored, memory, the
// makers, the video's shape, quality, length and the makers' prices, and storage. Lamo Stories is switched on with
// cf.storiesPreview = 1. It needs the shell and the workspace mock (builder F) and getTask (builder G) merged first.

const SECTIONS = ["ai", "agents", "skills", "memory", "video", "storage"] as const;

async function on(page: Page) {
  await page.addInitScript(() => localStorage.setItem("cf.storiesPreview", "1"));
}

/** The shell has checked its workspace and the section has its words. */
async function ready(page: Page) {
  await page.locator(".stories-app").waitFor({ timeout: 15_000 });
  await page.locator(".st-stg-section .st-stg-card").first().waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => !document.querySelector(".st-stg-loading, .boot"), undefined, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(350);
}

async function openSection(page: Page, section: (typeof SECTIONS)[number]) {
  await page.goto(`/stories/settings/${section}`);
  await ready(page);
}

const card = (page: Page, title: string) => page.locator(".st-stg-card").filter({ has: page.getByRole("heading", { level: 3, name: title, exact: true }) });

test.describe("every section keeps the owner's rules", () => {
  for (const section of SECTIONS)
    test(`${section}: nothing overflows from 320 to 1920 px`, async ({ page }) => {
      await on(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await openSection(page, section);
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(250);
        const o = await findOverflow(page);
        expect(o.page, `${section} @${width}: the page scrolls sideways`).toBeLessThanOrEqual(o.viewport);
        expect(o.items, `${section} @${width}`).toEqual([]);
      }
    });

  // Phones, the tablet switch, small laptops, desktops and wide screens: every layout the settings change at.
  for (const [width, height] of [
    [320, 700],
    [390, 844],
    [768, 1024],
    [1024, 768],
    [1440, 900],
    [1920, 1080],
  ] as const)
    test(`${width} px: the arrow cursor, AA contrast, no visible edges, big targets, Glide under every pick`, async ({ page }) => {
      await on(page);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width, height });
      const phone = width < 768;
      for (const section of SECTIONS) {
        await openSection(page, section);
        const cursors = await page.evaluate(() =>
          Array.from(document.querySelectorAll(".st-stg, .st-stg *"))
            .map((el) => getComputedStyle(el).cursor)
            .filter((c) => c !== "default" && c !== "auto"),
        );
        expect(cursors, `${section}: cursor`).toEqual([]);
        const axe = await new AxeBuilder({ page }).include(".st-stg").withRules(["color-contrast"]).analyze();
        expect(axe.violations.flatMap((v) => v.nodes.map((n) => `${n.target.join(" ")}: ${n.any.map((c) => c.message).join("; ")}`)), `${section}: contrast`).toEqual([]);
        expect((await visibleEdges(page)).filter((e) => !/st-rail|st-tabbar|st-top|st-needs|ws-switch/.test(e)), `${section}: edges`).toEqual([]);
        const small = await page.evaluate((need) => {
          const out: string[] = [];
          for (const el of Array.from(document.querySelectorAll<HTMLElement>(".st-stg a[href], .st-stg button, .st-stg [role=radio], .st-stg [role=switch], .st-stg input, .st-stg select, .st-stg label.st-btn"))) {
            if (el.closest(".sr-only") || !el.checkVisibility()) continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0) continue;
            if (r.width < need - 0.5 || r.height < need - 0.5) out.push(`${el.tagName.toLowerCase()}.${el.className}: ${Math.round(r.width)}×${Math.round(r.height)} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)}"`);
          }
          return out;
        }, phone ? 48 : 44);
        expect(small, `${section}: targets`).toEqual([]);
        const glideless = await page.evaluate(() => Array.from(document.querySelectorAll(".st-stg [role=radiogroup]")).filter((g) => !g.querySelector(":scope > .glide")).map((g) => g.getAttribute("aria-label")));
        expect(glideless, `${section}: Glide`).toEqual([]);
        expect(await page.locator(".st-stg [disabled]").count(), `${section}: disabled`).toBe(0);
      }
    });

  test("every control shows itself on hover", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    const checks: [(typeof SECTIONS)[number], string][] = [
      ["ai", ".st-stg-tab:not(.is-on)"],
      ["ai", ".st-stg-pick__opt:not(.is-on):not(.is-off)"],
      ["ai", ".st-stg-select"],
      ["ai", ".st-stg-btn:not(.st-stg-btn--main):not(.st-stg-btn--quiet)"],
      ["ai", ".st-stg-btn--main"],
      ["ai", ".st-stg-btn--quiet"],
      ["agents", ".st-stg-switch"],
      ["agents", ".st-stg-textarea"],
      ["memory", ".st-stg-btn--danger"],
      ["video", ".st-stg-round"],
    ];
    for (const [section, sel] of checks) {
      await openSection(page, section);
      const el = page.locator(sel).first();
      await el.scrollIntoViewIfNeeded();
      const before = await el.evaluate((e) => `${getComputedStyle(e).backgroundColor}|${getComputedStyle(e).color}|${getComputedStyle(e).transform}`);
      await el.hover();
      await page.waitForTimeout(350);
      const after = await el.evaluate((e) => `${getComputedStyle(e).backgroundColor}|${getComputedStyle(e).color}|${getComputedStyle(e).transform}`);
      expect(after, `${section} ${sel}`).not.toBe(before);
      await page.mouse.move(0, 0);
    }
  });

  test("the section bar and the pick bars slide the owner's highlight; what cannot be picked plays the deny sound", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSection(page, "video");
    await expect(page.locator(".st-stg-tabs")).toHaveClass(/has-glide/);
    const shape = page.getByRole("radiogroup", { name: "Shape of the video" });
    await expect(shape).toHaveClass(/has-glide/);
    await page.evaluate(() => (window.__cfSoundLog = []));
    // Playwright waits for aria-disabled controls to be usable, so this tap skips that wait (the owner's tap does not).
    await shape.getByRole("radio", { name: /1:1 square/ }).click({ force: true });
    await expect(shape.getByRole("radio", { name: /9:16 tall/ })).toHaveAttribute("aria-checked", "true");
    expect(await page.evaluate(() => (window.__cfSoundLog ?? []).map((e) => e.kind))).toEqual(["deny"]);
    const quality = page.getByRole("radiogroup", { name: "Video quality" });
    await quality.getByRole("radio", { name: /^Best/ }).click();
    await expect(quality.getByRole("radio", { name: /^Best/ })).toHaveAttribute("aria-checked", "true");
    // The glide settles under the chosen option.
    await page.waitForTimeout(500);
    const [g, o] = await Promise.all([quality.locator(".glide").boundingBox(), quality.getByRole("radio", { name: /^Best/ }).boundingBox()]);
    expect(Math.abs(g!.x - o!.x)).toBeLessThan(2);
    expect(Math.abs(g!.width - o!.width)).toBeLessThan(2);
    expect(await page.evaluate(() => (window.__cfSoundLog ?? []).map((e) => e.kind))).toEqual(["deny", "tap"]);
  });
});

test.describe("AI", () => {
  test("the default model with its provider and status, efforts it offers, and Check models", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSection(page, "ai");
    const models = page.getByRole("radiogroup", { name: "Default model" });
    await expect(models.getByRole("radio")).toHaveCount(6);
    await expect(models.getByRole("radio", { name: /Claude Opus 5\.5/ })).toHaveAttribute("aria-checked", "true");
    await expect(models.getByRole("radio", { name: /Claude Fable 5\.1/ })).toContainText("No access");
    await expect(page.locator(".st-stg-active").first()).toContainText("Model: Claude Opus 5.5");
    await expect(page.getByRole("radiogroup", { name: "Default effort" }).getByRole("radio")).toHaveText(["Low", "MediumThe model's own level", "High", "Extra high", "Maximum"]);

    await models.getByRole("radio", { name: /Claude Fable 5\.2/ }).click();
    await expect(page.locator(".st-stg-saved")).toHaveText("Saved");
    await expect(page.locator(".st-stg-active").first()).toContainText("Model: Claude Fable 5.2");
    await models.getByRole("radio", { name: /Amazon Nova Pro/ }).click();
    await expect(card(page, "Default effort")).toContainText("This model has no effort setting; it runs at its own level.");
    await models.getByRole("radio", { name: /Claude Fable 5\.1/ }).click();
    await expect(card(page, "Default model").getByRole("alert")).toContainText("Claude Fable 5.1 said no last time");
    await models.getByRole("radio", { name: /Claude Opus 5\.5/ }).click();
    await page.getByRole("radiogroup", { name: "Default effort" }).getByRole("radio", { name: "Maximum" }).click();
    await expect(page.locator(".st-stg-active").first()).toContainText("Effort: Maximum");

    await page.getByRole("button", { name: "Check models" }).click();
    await expect(page.getByRole("progressbar", { name: "Checking 6 models" })).toBeVisible();
    await expect(page.locator(".toast").filter({ hasText: "Checked 6 models: 5 work, 1 said no." })).toBeVisible({ timeout: 10_000 });
    await expect(models.getByRole("radio", { name: /Claude Sonnet 5\.5/ })).toContainText("Works");
  });

  test("each agent and task gets its own model or Workspace default; prices for a model with none", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSection(page, "ai");
    const row = page.locator(".st-stg-assign__row").filter({ has: page.locator(".st-stg-assign__title", { hasText: /^Write the story$/ }) });
    await expect(row).toContainText("Suggested: High");
    await row.getByRole("combobox", { name: "Model for Write the story" }).selectOption("fable-5-2");
    await expect(row.locator(".st-stg-assign__uses")).toHaveText("Claude Fable 5.2 · High");
    await expect(row).toContainText("set for this task");
    await row.getByRole("combobox", { name: "Model for Write the story" }).selectOption("");
    await expect(row).toContainText("the agent's setting");

    const nova = card(page, "Prices").locator(".st-stg-price").filter({ hasText: "Amazon Nova Pro" });
    await expect(nova).toContainText("No price set.");
    await nova.getByRole("button", { name: "Type a price for Amazon Nova Pro" }).click();
    await nova.getByLabel("Reading, per million tokens").fill("0.8");
    await nova.getByLabel("Writing, per million tokens").fill("3.2");
    await nova.getByRole("button", { name: "Save the price" }).click();
    await expect(nova).toContainText("Your price");
    await expect(card(page, "Usage and cost, last 30 days").locator(".st-stg-usage__row").filter({ hasText: "Amazon Nova Pro" })).not.toContainText("No price set.");
  });
});

test.describe("Agents, skills and memory", () => {
  test("the quality agent off keeps the driving-safety rule; instructions save and Reset", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSection(page, "agents");
    await page.getByRole("radiogroup", { name: "Pick an agent" }).getByRole("radio", { name: /Quality check/ }).click();
    await expect(page.getByText("Driving-safety videos are always checked.").first()).toBeVisible();
    await page.getByRole("switch", { name: "Quality check is on" }).click();
    await expect(page.getByRole("switch", { name: "Quality check is off" })).toHaveAttribute("aria-checked", "false");
    await expect(page.getByRole("status").filter({ hasText: "Quality check is off." })).toBeVisible();

    const box = page.getByLabel("What Quality check should do");
    await box.fill("Check every fact twice.");
    await page.getByRole("button", { name: "Save the words" }).click();
    await expect(page.locator(".st-stg-instr")).toContainText("Your words");
    await page.getByRole("button", { name: "Reset" }).click();
    await page.getByRole("button", { name: "Yes, reset" }).click();
    await expect(page.locator(".st-stg-instr")).toContainText("The original");
    await expect(box).toHaveValue(/You check Lamo Stories videos/);
  });

  test("skills: write one, upload one with progress, bring back a version; built-ins stay read-only", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSection(page, "skills");
    const builtin = page.locator(".st-stg-skill").first();
    await expect(builtin).toContainText("Comes with Lamo Stories");
    await builtin.getByRole("button", { name: /^Open / }).click();
    await expect(builtin.locator(".st-stg-pre")).toContainText("name: nonverbal-storytelling");
    await expect(builtin.getByRole("button", { name: /Change it|Delete/ })).toHaveCount(0);

    await page.getByRole("button", { name: "Write one here" }).click();
    await page.getByLabel("Its name").fill("Bounce");
    await page.getByLabel("When to use it").fill("When someone falls");
    await page.getByLabel("What to do").fill("Bounce once.");
    await page.getByRole("button", { name: "Save the skill" }).click();
    const mine = page.locator(".st-stg-skill").filter({ hasText: "Bounce" });
    await expect(mine).toContainText("Written by you");
    await mine.getByRole("button", { name: "Change it" }).click();
    await mine.getByLabel("What to do").fill("Bounce twice.");
    await mine.getByRole("button", { name: "Save as a new version" }).click();
    await expect(mine.locator(".st-stg-versions__row")).toHaveCount(2);
    await mine.getByRole("button", { name: "Bring back version 1" }).click();
    await expect(mine.locator(".st-stg-versions__row")).toHaveCount(3);
    await expect(mine.locator(".st-stg-pre")).toContainText("Bounce once.");
    await mine.getByRole("switch", { name: "Creative director" }).click();
    await expect(mine).toContainText("Used by: Creative director");

    await page.locator('.st-stg-card input[type="file"]').first().setInputFiles({ name: "funny-falls.md", mimeType: "text/markdown", buffer: Buffer.from("---\nname: funny-falls\ndescription: Falls\n---\nFall well.") });
    await expect(page.getByRole("progressbar", { name: "Upload progress" })).toBeVisible();
    await expect(page.locator(".st-stg-skill").filter({ hasText: "Funny falls" })).toContainText("Uploaded file");
  });

  test("memory: add, change and delete", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openSection(page, "memory");
    await page.getByLabel("Remember this").fill("Pip always waves at the end");
    await page.getByRole("button", { name: "Remember it" }).click();
    const first = page.locator(".st-stg-mem").first();
    await expect(first).toContainText("Pip always waves at the end");
    await expect(first).toContainText("You added it");
    await first.getByRole("button", { name: /^Change: / }).click();
    await first.getByLabel("Change this memory").fill("Pip waves twice at the end");
    await first.getByRole("button", { name: "Save" }).click();
    await expect(first).toContainText("Pip waves twice at the end");
    const before = await page.locator(".st-stg-mem").count();
    await first.getByRole("button", { name: /^Delete: / }).click();
    await expect(page.locator(".st-stg-mem")).toHaveCount(before - 1);
    await expect(page.locator(".toast").filter({ hasText: "Forgotten." })).toBeVisible();
  });
});

test.describe("Video and storage", () => {
  test("the makers with their state, 1080 × 1920, 9:16 only, 30 fps, quality and length", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSection(page, "video");
    const maker = page.getByRole("radiogroup", { name: "Video maker" });
    await expect(maker.getByRole("radio", { name: /Built-in animator/ })).toHaveAttribute("aria-checked", "true");
    // Nova Reel is built but not ready until its US bucket is switched on (§45.11.6): it can be picked, and says so.
    const reel = maker.getByRole("radio", { name: /Amazon Nova Reel/ });
    await expect(reel).not.toHaveAttribute("aria-disabled", "true");
    await reel.click();
    await expect(reel).toHaveAttribute("aria-checked", "true");
    await expect(card(page, "Video maker").getByRole("status")).toContainText("is not ready yet.");
    await expect(reel).toContainText("Not ready yet");
    await maker.getByRole("radio", { name: /Built-in animator/ }).click();
    await expect(card(page, "Video maker").getByRole("status")).toHaveCount(0);
    await expect(page.getByText("1080 × 1920, the built-in animator's only size")).toBeVisible();
    await expect(page.getByText("30 fps, the built-in animator's only rate")).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: "Shape of the video" }).getByRole("radio", { name: /16:9 wide/ })).toContainText("Not with the built-in animator yet");
    await page.getByRole("button", { name: "5 seconds longer" }).click();
    await expect(page.locator(".st-stg-length__value strong")).toHaveText("50");
    await expect(page.locator(".st-stg-saved")).toHaveText("Saved");
    // Saved in the workspace: another visit to the section shows it (the mock keeps it until the page reloads).
    await page.locator(".st-stg-tab", { hasText: "Storage" }).click();
    await ready(page);
    await page.locator(".st-stg-tab", { hasText: "Video" }).click();
    await ready(page);
    await expect(page.locator(".st-stg-length__value strong")).toHaveText("50");

    // The AI makers' prices: none is known, so the owner types one.
    const price = page.locator(".st-stg-price").filter({ hasText: "Amazon Nova Reel" });
    await expect(price).toContainText("No price set.");
    await price.getByRole("button", { name: /Type a price for Amazon Nova Reel/ }).click();
    await price.getByLabel("Price for one second").fill("0.08");
    await price.getByRole("button", { name: "Save the price" }).click();
    await expect(price).toContainText("Your price");
    await expect(price).toContainText("0.08 for a second of video");
  });

  test("storage by kind and the production settings", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSection(page, "storage");
    await expect(card(page, "The finished file")).toContainText("MP4: H.264 picture and AAC sound");
    await page.getByRole("radiogroup", { name: "Scenes drawn at a time" }).getByRole("radio", { name: /Three at a time/ }).click();
    await page.getByRole("radiogroup", { name: "Keep old versions" }).getByRole("radio", { name: /Keep only the last few/ }).click();
    await page.getByRole("button", { name: "Keep one more" }).click();
    await expect(page.locator(".st-stg-stepper__value")).toContainText("The last 4 versions");
    await expect(page.locator(".st-stg-saved")).toHaveText("Saved");
  });
});
