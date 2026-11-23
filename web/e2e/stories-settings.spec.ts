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

const SECTIONS = ["ai", "agents", "skills", "memory", "video", "storage", "look"] as const;

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

  test("on a phone the section pills are one row that scrolls sideways, with the chosen one in view", async ({ page }) => {
    await on(page);
    for (const width of [320, 375]) {
      await page.setViewportSize({ width, height: 812 });
      for (const section of ["ai", "storage", "look"] as const) {
        await openSection(page, section);
        const row = await page.evaluate(() => {
          const ul = document.querySelector<HTMLElement>(".st-stg-top .st-stg-tabs")!;
          const tops = Array.from(ul.querySelectorAll<HTMLElement>(".st-stg-tabs__cell")).map((c) => Math.round(c.getBoundingClientRect().top));
          const box = ul.getBoundingClientRect();
          const on = document.querySelector<HTMLElement>(".st-stg-tab.is-on")!.getBoundingClientRect();
          return { rows: new Set(tops).size, scrolls: ul.scrollWidth > ul.clientWidth, inView: on.left >= box.left - 1 && on.right <= box.right + 1, height: Math.round(on.height) };
        });
        expect(row, `${section} @${width}`).toEqual({ rows: 1, scrolls: true, inView: true, height: 48 });
      }
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
      // The first one on screen (the tasks' own buttons sit in their closed "Each task" fold).
      const el = page.locator(sel).filter({ visible: true }).first();
      await el.scrollIntoViewIfNeeded();
      const before = await el.evaluate((e) => `${getComputedStyle(e).backgroundColor}|${getComputedStyle(e).color}|${getComputedStyle(e).transform}`);
      await el.hover();
      // Read once the mouse really is over it and its own hover transitions have run: under load a transition can wait
      // pending (no frame yet) past a fixed wait, which read the old style although the hover rule works.
      await expect.poll(() => el.evaluate((e) => e.matches(":hover")), { message: `${section} ${sel}: under the mouse` }).toBe(true);
      await page.waitForTimeout(350);
      await el.evaluate((e) => Promise.all(e.getAnimations().map((a) => a.finished.catch(() => undefined))));
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
    // Every shape can be picked now (§45.34): the glide slides to it with a tap.
    await shape.getByRole("radio", { name: /1:1 square/ }).click();
    await expect(shape.getByRole("radio", { name: /1:1 square/ })).toHaveAttribute("aria-checked", "true");
    await page.waitForTimeout(500);
    const [sg, so] = await Promise.all([shape.locator(".glide").boundingBox(), shape.getByRole("radio", { name: /1:1 square/ }).boundingBox()]);
    expect(Math.abs(sg!.x - so!.x)).toBeLessThan(2);
    expect(await page.evaluate(() => (window.__cfSoundLog ?? []).map((e) => e.kind))).toEqual(["tap"]);
    // What cannot be used plays the deny sound: at 15 seconds, "shorter" goes no further.
    await page.getByRole("slider", { name: "Usual video length in seconds" }).fill("15");
    await expect(page.locator(".st-stg-length__value strong")).toHaveText("15");
    // Playwright waits for aria-disabled controls to be usable, so this tap skips that wait (the owner's tap does not).
    await page.getByRole("button", { name: "5 seconds shorter" }).click({ force: true });
    await expect(page.locator(".st-stg-length__value strong")).toHaveText("15");
    expect(await page.evaluate(() => (window.__cfSoundLog ?? []).map((e) => e.kind))).toEqual(["tap", "deny"]);
    const quality = page.getByRole("radiogroup", { name: "Video quality" });
    await quality.getByRole("radio", { name: /^Best/ }).click();
    await expect(quality.getByRole("radio", { name: /^Best/ })).toHaveAttribute("aria-checked", "true");
    // The glide settles under the chosen option.
    await page.waitForTimeout(500);
    const [g, o] = await Promise.all([quality.locator(".glide").boundingBox(), quality.getByRole("radio", { name: /^Best/ }).boundingBox()]);
    expect(Math.abs(g!.x - o!.x)).toBeLessThan(2);
    expect(Math.abs(g!.width - o!.width)).toBeLessThan(2);
    expect(await page.evaluate(() => (window.__cfSoundLog ?? []).map((e) => e.kind))).toEqual(["tap", "deny", "tap"]);
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
    // The tasks are folded under the agents (less text, the owner, 23 Nov): one tap opens them.
    await page.locator(".st-stg-tasks > summary").click();
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

test.describe("AI: add a model (§45.34)", () => {
  test("adds a Bedrock model, lists it as Added by you, checks it, changes it and removes it", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openSection(page, "ai");
    const add = card(page, "Add a model");
    await add.getByRole("button", { name: "Add a model" }).click();
    const form = page.getByRole("form", { name: "Add a model" });
    await form.getByLabel("Name").fill("Nova Premier");
    await form.getByRole("radiogroup", { name: "Who makes it" }).getByRole("radio", { name: "Amazon" }).click();
    await form.getByLabel("Model ID", { exact: true }).fill("eu.amazon.nova-premier-v1:0");
    await form.getByLabel("AWS Region").selectOption("eu-west-1");
    // How it is called (§45.35 D1): an Amazon model starts with no effort levels and no tools, the prompt cache on.
    await expect(form.getByRole("switch", { name: "It has effort levels" })).toHaveAttribute("aria-checked", "false");
    await expect(form.getByRole("switch", { name: "It can use tools" })).toHaveAttribute("aria-checked", "false");
    await expect(form.getByRole("switch", { name: "It can reuse its instructions" })).toHaveAttribute("aria-checked", "true");
    await expect(form.getByRole("button", { name: "Medium" })).toHaveCount(0);
    await form.getByRole("switch", { name: "It has effort levels" }).click();
    await form.getByRole("button", { name: "Medium" }).click();
    await expect(form.getByRole("button", { name: "Medium" })).toHaveAttribute("aria-pressed", "true");
    await expect(form.getByRole("radiogroup", { name: "Its own level" }).getByRole("radio", { name: "Medium" })).toHaveAttribute("aria-checked", "true");
    await form.getByRole("button", { name: "Add the model" }).click();
    await expect(page.locator(".toast").filter({ hasText: "Nova Premier is added!" })).toBeVisible();
    const row = add.locator(".st-stg-own").filter({ hasText: "Nova Premier" });
    await expect(row).toContainText("Added by you");
    await expect(row).toContainText("Not checked yet");
    await expect(page.getByRole("radiogroup", { name: "Default model" }).getByRole("radio", { name: /Nova Premier/ })).toContainText("Added by you");
    // Check models is suggested, for this one.
    await add.locator(".st-stg-suggest").getByRole("button", { name: "Check models" }).click();
    await expect(page.locator(".toast").filter({ hasText: "Checked it: it works!" })).toBeVisible({ timeout: 10_000 });
    await expect(row).toContainText("Works");
    // Moved to a Region that is not in the list: its last check was of the old one, so a new check is asked for.
    await row.getByRole("button", { name: "Edit Nova Premier" }).click();
    const moved = page.getByRole("form", { name: "Change Nova Premier" });
    await moved.getByLabel("AWS Region").selectOption("another");
    await moved.getByLabel("Its Region code").fill("mx-central-1");
    await moved.getByRole("button", { name: "Save the changes" }).click();
    await expect(row).toContainText("Check it again");
    await expect(row).toContainText("in mx-central-1");
    await expect(add.locator(".st-stg-suggest")).toContainText("Nova Premier is changed, so its last check no longer counts.");
    await add.locator(".st-stg-suggest").getByRole("button", { name: "Check models" }).click();
    await expect(row).toContainText("Works", { timeout: 10_000 });
    await expect(add.locator(".st-stg-suggest")).toHaveCount(0);
    // Change it, then remove it.
    await row.getByRole("button", { name: "Edit Nova Premier" }).click();
    await page.getByRole("form", { name: "Change Nova Premier" }).getByLabel("Name").fill("Nova Premier EU");
    await page.getByRole("button", { name: "Save the changes" }).click();
    const renamed = add.locator(".st-stg-own").filter({ hasText: "Nova Premier EU" });
    await expect(renamed).toContainText("Added by you");
    await renamed.getByRole("button", { name: "Remove Nova Premier EU" }).click();
    await renamed.getByRole("button", { name: "Yes, remove it" }).click();
    await expect(add.locator(".st-stg-own")).toHaveCount(0);
    await expect(add).toContainText("No models added yet.");
  });
});

test.describe("AI: the Add a model form keeps the owner's rules", () => {
  for (const [width, height] of [
    [320, 700],
    [1280, 900],
  ] as const)
    test(`${width} px: no overflow, the arrow cursor, AA contrast, no visible edges, big targets, a hover state on the toggles`, async ({ page }) => {
      await on(page);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width, height });
      await openSection(page, "ai");
      await card(page, "Add a model").getByRole("button", { name: "Add a model" }).click();
      const form = page.getByRole("form", { name: "Add a model" });
      await form.getByRole("button", { name: "High", exact: true }).click();
      await form.getByRole("switch", { name: "I know its price" }).click();
      await form.getByRole("radiogroup", { name: "Who makes it" }).getByRole("radio", { name: "Someone else" }).click();
      await form.getByLabel("AWS Region").selectOption("another");
      await expect(form.getByLabel("Its Region code")).toBeVisible();
      await page.waitForTimeout(300);
      const o = await findOverflow(page);
      expect(o.page).toBeLessThanOrEqual(o.viewport);
      expect(o.items).toEqual([]);
      expect(await page.evaluate(() => Array.from(document.querySelectorAll(".st-stg-modelform, .st-stg-modelform *")).map((el) => getComputedStyle(el).cursor).filter((c) => c !== "default" && c !== "auto"))).toEqual([]);
      const axe = await new AxeBuilder({ page }).include(".st-stg-modelform").withRules(["color-contrast"]).analyze();
      expect(axe.violations.flatMap((v) => v.nodes.map((n) => n.target.join(" ")))).toEqual([]);
      expect((await visibleEdges(page)).filter((e) => /st-stg-modelform|st-stg-toggle/.test(e))).toEqual([]);
      const need = width < 768 ? 48 : 44;
      const small = await page.evaluate((n) => {
        const out: string[] = [];
        for (const el of Array.from(document.querySelectorAll<HTMLElement>(".st-stg-modelform button, .st-stg-modelform input, .st-stg-modelform select, .st-stg-modelform [role=radio], .st-stg-modelform [role=switch]"))) {
          if (!el.checkVisibility()) continue;
          const r = el.getBoundingClientRect();
          if (r.width < n - 0.5 || r.height < n - 0.5) out.push(`${el.className} ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
        return out;
      }, need);
      expect(small).toEqual([]);
      const toggle = form.locator(".st-stg-toggle:not(.is-on)").first();
      const before = await toggle.evaluate((e) => `${getComputedStyle(e).backgroundColor}|${getComputedStyle(e).color}`);
      await toggle.hover();
      await page.waitForTimeout(300);
      expect(await toggle.evaluate((e) => `${getComputedStyle(e).backgroundColor}|${getComputedStyle(e).color}`)).not.toBe(before);
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
    await expect(box).toHaveValue(/You check Clips Funded videos/);
  });

  test("skills: write one, upload one with progress, bring back a version; built-ins stay read-only", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSection(page, "skills");
    const builtin = page.locator(".st-stg-skill").first();
    await expect(builtin).toContainText("Comes with Clips Funded");
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
  test("the makers with their state, the shape and its size, 30 fps, quality and length, and the makers' use and prices", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSection(page, "video");
    const maker = page.getByRole("radiogroup", { name: "Video maker" });
    await expect(maker.getByRole("radio", { name: /Built-in animator/ })).toHaveAttribute("aria-checked", "true");
    // Amazon ended Nova Reel on 30 Sep 2026 (§45.37): it reads ended and cannot be picked again.
    const ended = maker.getByRole("radio", { name: /Amazon Nova Reel/ });
    await expect(ended).toHaveAttribute("aria-disabled", "true");
    await expect(ended).toContainText("Ended by Amazon on 30 Sep 2026.");
    // Luma AI Ray2 is built but not ready until its Oregon bucket is switched on (§45.11.6): it can be picked, and says so.
    const reel = maker.getByRole("radio", { name: /Luma AI Ray2/ });
    await expect(reel).not.toHaveAttribute("aria-disabled", "true");
    await expect(reel).toContainText("Runs in the US (Oregon)");
    await reel.click();
    await expect(reel).toHaveAttribute("aria-checked", "true");
    // The API's own sentence (§45.34): it says what to do, and nothing switches to the built-in animation by itself.
    await expect(card(page, "Video maker").getByRole("status")).toContainText("Luma AI Ray2 is not ready yet: ");
    // Said on Settings › Video itself, it never sends the owner here again (§45.36 E17).
    await expect(card(page, "Video maker").getByRole("status")).toContainText("Pick Built-in animation above, or finish its setup.");
    await expect(card(page, "Video maker")).not.toContainText("in Settings › Video");
    // Said once, though the API's label (Luma AI Ray2 (AI video)) is not the name its sentence uses.
    await expect(card(page, "Video maker").getByRole("status")).toHaveText(/^Luma AI Ray2 is not ready yet: /);
    await expect(card(page, "Video maker").getByRole("status")).not.toContainText("(AI video) is not ready yet");
    await expect(reel).toContainText("Not ready yet");
    await maker.getByRole("radio", { name: /Built-in animator/ }).click();
    await expect(card(page, "Video maker").getByRole("status")).toHaveCount(0);
    // The shape and its size (§45.34): Shorts, Reels and TikTok want 9:16.
    const shape = page.getByRole("radiogroup", { name: "Shape of the video" });
    const size = page.getByRole("radiogroup", { name: "Size of the video" });
    await expect(shape.getByRole("radio", { name: /9:16 tall/ })).toContainText("For Shorts, Reels and TikTok");
    await expect(size.getByRole("radio")).toHaveText([/1080 × 1920/, /720 × 1280/]);
    await shape.getByRole("radio", { name: /16:9 wide/ }).click();
    await expect(size.getByRole("radio")).toHaveText([/1920 × 1080/, /1280 × 720/]);
    await expect(size.getByRole("radio", { name: /1920 × 1080/ })).toHaveAttribute("aria-checked", "true");
    await expect(card(page, "Shape and size").getByRole("status")).toHaveText("Shorts, Reels and TikTok want 9:16. A wide video shows smaller there, with bars around it.");
    await shape.getByRole("radio", { name: /9:16 tall/ }).click();
    await expect(card(page, "Shape and size").getByRole("status")).toHaveCount(0);
    await expect(page.getByText("30 frames a second (30 fps)")).toBeVisible();
    await page.getByRole("button", { name: "5 seconds longer" }).click();
    await expect(page.locator(".st-stg-length__value strong")).toHaveText("50");
    await expect(page.locator(".st-stg-saved")).toHaveText("Saved");
    // Saved in the workspace: another visit to the section shows it (the mock keeps it until the page reloads).
    await page.locator(".st-stg-tab", { hasText: "Storage" }).click();
    await ready(page);
    await page.locator(".st-stg-tab", { hasText: "Video" }).click();
    await ready(page);
    await expect(page.locator(".st-stg-length__value strong")).toHaveText("50");

    // The AI makers' prices: none is known, so the owner types one (a price for one unit, §45.34).
    const price = page.locator(".st-stg-price").filter({ hasText: "Luma AI Ray2" });
    await expect(price).toContainText("No price set.");
    await price.getByRole("button", { name: /Type a price for Luma AI Ray2/ }).click();
    await price.getByLabel("Price for one second").fill("0.08");
    await price.getByRole("button", { name: "Save the price" }).click();
    await expect(price).toContainText("Your price");
    await expect(price).toContainText("0.08 for a second of video");

    // Use and costs: render minutes per day, each maker by name with its units and cost (§45.34).
    const use = card(page, "Use and costs, last 30 days");
    await expect(use.locator(".st-stg-chart__day")).toHaveCount(30);
    await expect(use.locator(".st-stg-usage__row").filter({ hasText: "Built-in animator" })).toContainText("Free: it runs on Clips Funded's own computer");
    const canvas = use.locator(".st-stg-usage__row").filter({ hasText: "Amazon Nova Canvas" });
    await expect(canvas).toContainText("No price yet:");
    await expect(use).not.toContainText("builtin-rig");
    await canvas.getByRole("button", { name: "Add a price for Amazon Nova Canvas" }).click();
    const canvasPrice = page.locator(".st-stg-price").filter({ hasText: "Amazon Nova Canvas" });
    // The first price's save may land after this form opened (under load it does): it closes its own form only, never
    // this one. Its row's Remove button is switched off until that save is answered.
    await expect(price.getByRole("button", { name: /^Remove your price for Luma AI Ray2/ })).not.toHaveAttribute("aria-disabled", "true");
    await expect(price.getByRole("button", { name: "Save the price" })).toHaveCount(0);
    await expect(canvasPrice.getByRole("button", { name: "Save the price" })).toBeVisible();
    await canvasPrice.getByLabel("Price for one picture").fill("0.04");
    await expect(canvasPrice.getByLabel("Price for one picture")).toHaveValue("0.04");
    await canvasPrice.getByRole("button", { name: "Save the price" }).click();
    await expect(canvasPrice).toContainText("0.04 for a picture");
    await expect(canvas).not.toContainText("No price yet");
    await expect(canvas.locator(".st-stg-usage__cost")).toContainText("$");
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

  test("where files are, keeping them, Clean up now, other files, captions and this device's sounds and motion (§45.34)", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openSection(page, "storage");
    await expect(card(page, "Space used")).toContainText("Clips Funded's own folder in Clip Factory's media storage in Europe (Stockholm)");
    const file = card(page, "The finished file");
    await file.getByRole("switch", { name: "Also make a WebM file" }).click();
    await expect(file.getByRole("switch", { name: "Also make a WebM file" })).toHaveAttribute("aria-checked", "true");
    await file.getByRole("switch", { name: "Put the captions into the picture" }).click();
    await expect(file).toContainText("Only the captions are left out. Speech bubbles and the safety end card always stay in.");
    const keeping = card(page, "Keeping other files");
    await keeping.getByRole("radiogroup", { name: "Keep reference videos" }).getByRole("radio", { name: /Keep only the study/ }).click();
    await expect(keeping).toContainText("Clips Funded still learns from each study after its video is gone.");
    await keeping.getByRole("radiogroup", { name: "Keep chat pictures" }).getByRole("radio", { name: /90 days/ }).click();
    await expect(page.locator(".st-stg-saved")).toHaveText("Saved");
    await keeping.getByRole("button", { name: "Clean up now" }).click();
    await keeping.getByRole("button", { name: "Yes, clear them" }).click();
    await expect(keeping.getByRole("status")).toHaveText("Cleared 14 files (186 MB). The rest is kept.");
    await expect(page.locator("canvas.st-stg-burst")).toBeAttached();

    // Sounds and motion: this device's own choices for Lamo Stories, never Clip Factory's.
    const before = await page.evaluate(() => localStorage.getItem("cf.prefs"));
    const sm = card(page, "Sounds and motion");
    await sm.getByRole("switch", { name: "Less motion" }).click();
    await expect(sm.getByRole("switch", { name: "Less motion" })).toHaveAttribute("aria-checked", "true");
    // The click sound is picked by name and kept as its number, the shape Lamo Stories' sounds read.
    await sm.getByLabel("Click sound").selectOption({ label: "Bubble: rises a little" });
    const kept = await page.evaluate(() => (JSON.parse(localStorage.getItem("cf.stories.prefs") ?? "{}") as { more?: Record<string, unknown> }).more);
    expect(kept).toMatchObject({ "motion.reduce": true, "sound.click": 3 });
    await expect(sm).toContainText("For Clips Funded on this device.");
    // Hear it plays the pick once, never the usual click sound on top of it.
    // (The log keeps the last 200 sounds: it starts empty here, so only this click's sounds are in it. A tap within
    // 60 ms of the last one is one sound, so the pick's own sound is let go first.)
    await page.waitForTimeout(150);
    await page.evaluate(() => ((window as unknown as { __cfSoundLog?: unknown[] }).__cfSoundLog = []));
    await sm.getByRole("button", { name: "Hear it" }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __cfSoundLog?: { kind: string; sound: number }[] }).__cfSoundLog ?? [])).toEqual([expect.objectContaining({ kind: "tap", sound: 3 })]);
    expect(await page.evaluate(() => localStorage.getItem("cf.prefs"))).toBe(before);
    await page.reload();
    await ready(page);
    await expect(card(page, "Sounds and motion").getByRole("switch", { name: "Less motion" })).toHaveAttribute("aria-checked", "true");
    await expect(card(page, "Sounds and motion").getByLabel("Click sound")).toHaveValue("3");
    // By age only the video goes; its study stays.
    await expect(card(page, "Keeping other files").getByRole("radiogroup", { name: "Keep reference videos" }).getByRole("radio", { name: /30 days/ })).toContainText("Then the video goes; its study stays");
  });
});

test.describe("round 4 (§45.35)", () => {
  /** Lamo Stories on, with the mock's knobs for this test. */
  async function withKnobs(page: Page, knobs: Record<string, unknown>) {
    await on(page);
    await page.addInitScript((k) => {
      (window as unknown as { __cfStoriesMock?: unknown }).__cfStoriesMock = { knobs: k };
    }, knobs);
  }

  test("D2: Try it on Luma AI Ray2 makes one test shot; without the Oregon storage it says what is missing, and nothing switches", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openSection(page, "video");
    // Nova Reel's Try it is gone (Amazon ended it, §45.37); Luma AI Ray2 has it now.
    await expect(page.locator('[data-provider="nova-reel"]')).toHaveCount(0);
    const row = page.locator('[data-provider="luma-ray"]');
    await expect(row).toContainText("Try it makes one 5-second test shot. Amazon bills that one shot. Nothing is posted.");
    await row.getByRole("button", { name: "Try Luma AI Ray2" }).click();
    await expect(row.getByRole("progressbar", { name: "Trying Luma AI Ray2" })).toBeVisible();
    await expect(row).toContainText("It did not work", { timeout: 15_000 });
    await expect(row).toContainText("it needs a storage bucket in the United States (Oregon), which is switched off");
    await expect(page.locator(".toast").filter({ hasText: "storage bucket in the United States (Oregon)" })).toBeVisible();
    await expect(row.getByRole("button", { name: "Try Luma AI Ray2" })).toContainText("Try it again");
    // Nothing switched: the built-in animator still makes the videos.
    await expect(page.getByRole("radiogroup", { name: "Video maker" }).getByRole("radio", { name: /Built-in animator/ })).toHaveAttribute("aria-checked", "true");
    // The owner's rules on the row, on the smallest phone.
    await page.setViewportSize({ width: 320, height: 700 });
    await page.waitForTimeout(250);
    const o = await findOverflow(page);
    expect(o.page).toBeLessThanOrEqual(o.viewport);
    expect(o.items).toEqual([]);
    const axe = await new AxeBuilder({ page }).include('[data-provider="luma-ray"]').withRules(["color-contrast"]).analyze();
    expect(axe.violations.flatMap((v) => v.nodes.map((n) => n.target.join(" ")))).toEqual([]);
    expect((await visibleEdges(page)).filter((e) => /st-stg-try/.test(e))).toEqual([]);
    const button = (await row.getByRole("button", { name: "Try Luma AI Ray2" }).boundingBox())!;
    expect(button.height).toBeGreaterThanOrEqual(47.5);
  });

  test("D2: with the Oregon storage on, Try it works: the row and a toast say so, and Luma AI Ray2 shows Working once picked", async ({ page }) => {
    await withKnobs(page, { lumaBucket: true, tryMs: 1200 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSection(page, "video");
    const row = page.locator('[data-provider="luma-ray"]');
    await row.getByRole("button", { name: "Try Luma AI Ray2" }).click();
    await expect(row).toContainText("It worked", { timeout: 15_000 });
    await expect(row).toContainText("It is ready for cut-aways.");
    await expect(page.locator(".toast").filter({ hasText: "It works! Luma AI Ray2 made its test shot." })).toBeVisible();
    const reel = page.getByRole("radiogroup", { name: "Video maker" }).getByRole("radio", { name: /Luma AI Ray2/ });
    await reel.click();
    await expect(reel).toContainText("Working", { timeout: 10_000 });
  });

  test("D6 and D8: a model moved to another Region reads Not checked yet, also when the page is opened again; lines name the maker on its host", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSection(page, "ai");
    const add = card(page, "Add a model");
    await add.getByRole("button", { name: "Add a model" }).click();
    const form = page.getByRole("form", { name: "Add a model" });
    await form.getByLabel("Name").fill("Mistral Large");
    await form.getByRole("radiogroup", { name: "Who makes it" }).getByRole("radio", { name: "Mistral" }).click();
    await form.getByLabel("Model ID", { exact: true }).fill("mistral.mistral-large-2407-v1:0");
    await form.getByLabel("AWS Region").selectOption("eu-west-3");
    await form.getByRole("button", { name: "Add the model" }).click();
    const row = add.locator(".st-stg-own").filter({ hasText: "Mistral Large" });
    await expect(row).toContainText("Made by Mistral · on Amazon Bedrock in eu-west-3");
    await expect(row).toContainText("No effort levels · no tools · no prompt cache.");
    await expect(page.getByRole("radiogroup", { name: "Default model" }).getByRole("radio", { name: /Mistral Large/ })).toContainText("Mistral on Amazon Bedrock");
    await add.locator(".st-stg-suggest").getByRole("button", { name: "Check models" }).click();
    await expect(row).toContainText("Works", { timeout: 10_000 });
    await row.getByRole("button", { name: "Edit Mistral Large" }).click();
    const moved = page.getByRole("form", { name: "Change Mistral Large" });
    await moved.getByLabel("AWS Region").selectOption("eu-west-1");
    await moved.getByRole("button", { name: "Save the changes" }).click();
    await expect(row.locator(".st-stg-chip")).toHaveText(["Added by you", "Not checked yet"]);
    await expect(row).not.toContainText("Works");
    // Opened again later: still Not checked yet (the API cleared its check), everywhere it is picked.
    await page.locator(".st-rail .st-rail__item").filter({ hasText: "Dashboard" }).click();
    await expect(page).toHaveURL(/\/stories$/);
    await page.locator(".st-rail .st-rail__item").filter({ hasText: "Settings" }).click();
    await ready(page);
    await expect(card(page, "Add a model").locator(".st-stg-own").filter({ hasText: "Mistral Large" }).locator(".st-stg-chip")).toHaveText(["Added by you", "Not checked yet"]);
    await expect(page.getByRole("radiogroup", { name: "Default model" }).getByRole("radio", { name: /Mistral Large/ })).toContainText("Not checked yet");
  });
});

test.describe("the makers' models (§45.37)", () => {
  test("each maker's model with its price line and status, the Sound maker saves, a voice only on purpose, and an added model", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSection(page, "video");
    const pictures = page.getByRole("radiogroup", { name: "Picture maker" });
    await expect(pictures.getByRole("radio", { name: /Amazon Nova Canvas/ })).toHaveAttribute("aria-disabled", "true");
    await pictures.getByRole("radio", { name: /Stability AI/ }).click();
    const models = page.getByRole("radiogroup", { name: "Picture maker's model" });
    await expect(models.getByRole("radio")).toHaveText([/Stable Image Core/, /Stable Image Ultra/, /Stable Diffusion 3\.5 Large/]);
    await expect(models.getByRole("radio", { name: /Stable Image Ultra/ })).toContainText("Stability AI on Amazon Bedrock · Runs in the US (Oregon) · No price known");
    await models.getByRole("radio", { name: /Stable Image Ultra/ }).click();
    await expect(models.getByRole("radio", { name: /Stable Image Ultra/ })).toHaveAttribute("aria-checked", "true");
    await expect(page.locator(".st-stg-saved")).toHaveText("Saved");

    const sound = page.getByRole("radiogroup", { name: "Sound maker" });
    await expect(sound.getByRole("radio", { name: /Built-in sounds and music/ })).toHaveAttribute("aria-checked", "true");
    await expect(sound.getByRole("radio", { name: /A spoken voice \(Amazon Polly\)/ })).toContainText("Your videos are made without a voice unless you pick this.");
    await sound.getByRole("radio", { name: /ElevenLabs/ }).click();
    await expect(sound.getByRole("radio", { name: /ElevenLabs/ })).toHaveAttribute("aria-checked", "true");
    await sound.getByRole("radio", { name: /Amazon Polly/ }).click();
    await expect(card(page, "Sound maker")).toContainText("Your videos now have a spoken voice.");
    // Saved in the workspace: another visit still shows the voice picked.
    await page.locator(".st-stg-tab", { hasText: "Storage" }).click();
    await ready(page);
    await page.locator(".st-stg-tab", { hasText: "Video" }).click();
    await ready(page);
    await expect(page.getByRole("radiogroup", { name: "Sound maker" }).getByRole("radio", { name: /Amazon Polly/ })).toHaveAttribute("aria-checked", "true");
    await page.getByRole("radiogroup", { name: "Sound maker" }).getByRole("radio", { name: /Built-in sounds and music/ }).click();

    // Add a picture model on an OpenAI-compatible service, then check it (a free access check).
    const add = card(page, "Add a picture, video or sound model");
    await add.getByRole("button", { name: "Add a model" }).click();
    const form = page.getByRole("form", { name: "Add a picture, video or sound model" });
    await form.getByRole("radiogroup", { name: "Where it runs" }).getByRole("radio", { name: /An OpenAI-compatible service/ }).click();
    await form.getByLabel("Name", { exact: true }).fill("Soft paint");
    await form.getByLabel("Who makes it").fill("Acme");
    await form.getByLabel("The service's address").fill("https://api.example.com/v1");
    await form.getByLabel("Model name").fill("soft-paint-2");
    await form.getByRole("button", { name: "Add the model" }).click();
    const row = add.locator(".st-stg-own").filter({ hasText: "Soft paint" });
    await expect(row).toContainText("Added by you");
    await expect(row).toContainText("Made by Acme on api.example.com");
    await expect(row).toContainText("Paste your OpenAI-compatible API key under Prices and keys below");
    await add.getByRole("button", { name: "Check models" }).first().click();
    await expect(row).toContainText("No access", { timeout: 10_000 });
  });

  test("320 px: the maker cards and the add form fit, with AA contrast and big targets", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 320, height: 700 });
    await openSection(page, "video");
    await page.getByRole("radiogroup", { name: "Picture maker" }).getByRole("radio", { name: /Stability AI/ }).click();
    await card(page, "Add a picture, video or sound model").getByRole("button", { name: "Add a model" }).click();
    const form = page.getByRole("form", { name: "Add a picture, video or sound model" });
    await form.getByRole("radiogroup", { name: "Where it runs" }).getByRole("radio", { name: /An OpenAI-compatible service/ }).click();
    await page.waitForTimeout(300);
    const o = await findOverflow(page);
    expect(o.page).toBeLessThanOrEqual(o.viewport);
    expect(o.items).toEqual([]);
    const axe = await new AxeBuilder({ page }).include(".st-stg-section").withRules(["color-contrast"]).analyze();
    expect(axe.violations.flatMap((v) => v.nodes.map((n) => n.target.join(" ")))).toEqual([]);
    for (const b of await form.getByRole("button").all()) {
      const box = await b.boundingBox();
      if (box) expect(box.height).toBeGreaterThanOrEqual(43.5);
    }
  });
});

test.describe("round 5: Add a model and the status words (§45.36 E4, E14, E17)", () => {
  test("Anthropic's levels start ticked; a pasted ARN fills the Region; a Region that does not fit is refused naming both", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSection(page, "ai");
    const add = card(page, "Add a model");
    await add.getByRole("button", { name: "Add a model" }).click();
    const form = page.getByRole("form", { name: "Add a model" });
    // E17: an Anthropic model starts with its five levels ticked and its usual own level, so the first Add works.
    for (const level of ["Low", "Medium", "High", "Extra high", "Maximum"]) await expect(form.getByRole("button", { name: level, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(form.getByRole("radiogroup", { name: "Its own level" }).getByRole("radio", { name: "High", exact: true })).toHaveAttribute("aria-checked", "true");
    // E14: the first line is plain; inference profiles and ARNs are one tap away.
    await expect(form.getByText("inference profile", { exact: false })).toBeHidden();
    await form.getByText("Technical details").click();
    await expect(form.getByText("inference profile", { exact: false })).toBeVisible();
    // E4: a pasted ARN fills the Region in.
    await form.getByLabel("Name").fill("My Claude");
    await form.getByLabel("Model ID", { exact: true }).fill("arn:aws:bedrock:eu-west-3:123456789012:inference-profile/eu.anthropic.claude-x-v1:0");
    await expect(form.getByLabel("AWS Region")).toHaveValue("eu-west-3");
    // An eu. profile with a US Region: refused before sending, naming both.
    await form.getByLabel("Model ID", { exact: true }).fill("eu.anthropic.claude-x-v1:0");
    await form.getByLabel("AWS Region").selectOption("us-east-1");
    await form.getByRole("button", { name: "Add the model" }).click();
    await expect(form.getByRole("alert")).toHaveText(
      "This inference profile id starts with eu., so it runs in a Europe Region (like eu-north-1), not in us-east-1. Type a Europe Region as the Region, or paste the us. profile id instead.",
    );
    await form.getByLabel("AWS Region").selectOption("eu-north-1");
    await form.getByRole("button", { name: "Add the model" }).click();
    await expect(page.locator(".toast").filter({ hasText: "My Claude is added!" })).toBeVisible();
    // E17: its marks sit together at the row's right edge with the usual gap, in its row and in the Default model list.
    const row = add.locator(".st-stg-own").filter({ hasText: "My Claude" });
    const marks = await row.locator(".st-stg-own__head").evaluate((head) => {
      const chips = Array.from(head.querySelectorAll(".st-stg-chip")).map((c) => c.getBoundingClientRect());
      const h = head.getBoundingClientRect();
      return { gap: chips[1]!.left - chips[0]!.right, right: h.right - chips[chips.length - 1]!.right };
    });
    expect(marks.gap).toBeGreaterThanOrEqual(5);
    expect(marks.right).toBeLessThanOrEqual(1);
    const option = page.getByRole("radiogroup", { name: "Default model" }).getByRole("radio", { name: /My Claude/ });
    const inList = await option.evaluate((opt) => {
      const chips = Array.from(opt.querySelectorAll(".st-stg-chip")).map((c) => c.getBoundingClientRect());
      const top = opt.querySelector(".st-stg-pick__top")!.getBoundingClientRect();
      return { gap: chips[1]!.left - chips[0]!.right, right: top.right - chips[chips.length - 1]!.right };
    });
    expect(inList.gap).toBeGreaterThanOrEqual(5);
    expect(inList.right).toBeLessThanOrEqual(1);
    // E14: its exact ID is folded under Technical details.
    await expect(row.locator(".st-tech-fold code")).toBeHidden();
    await row.getByText("Technical details").click();
    await expect(row.locator(".st-tech-fold code")).toHaveText("eu.anthropic.claude-x-v1:0");
  });

  test("Settings › Video never sends the owner to Settings › Video; Settings has Open setup again", async ({ page }) => {
    await on(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSection(page, "video");
    const maker = page.getByRole("radiogroup", { name: "Video maker" });
    // Amazon ended Nova Reel (§45.37): Luma AI Ray2 is the AI video maker that can still be picked.
    await maker.getByRole("radio", { name: /Luma AI Ray2/ }).click();
    await expect(card(page, "Video maker").getByRole("status")).toContainText("Pick Built-in animation above");
    expect(await page.locator(".st-stg-section").evaluate((el) => (el as HTMLElement).innerText)).not.toContain("in Settings › Video");
    // E14: the maker's plain name first; its exact Bedrock model ID one tap away.
    const reelCard = card(page, "Video maker");
    await expect(reelCard.locator(".st-stg-active strong")).toHaveText("Luma AI Ray2");
    await expect(reelCard.getByText("luma.ray-v2:0", { exact: false })).toBeHidden();
    await reelCard.getByText("Technical details").click();
    await expect(reelCard.getByText("luma.ray-v2:0", { exact: false })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open setup again" })).toHaveAttribute("href", "/stories/setup");
    await openSection(page, "ai");
    expect(await card(page, "Prices").evaluate((el) => (el as HTMLElement).innerText)).not.toContain("Settings › AI");
  });
});
