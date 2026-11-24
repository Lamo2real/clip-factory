import { expect, test, type Page } from "@playwright/test";
import { settle } from "./helpers.ts";

// Settings as a tree, and choosing your click sounds (docs/CONTRACTS.md §15).

type Entry = { kind: string; sound: number; muted: boolean };
const soundLog = (page: Page) => page.evaluate(() => (window.__cfSoundLog ?? []) as Entry[]);
const clearLog = (page: Page) => page.evaluate(() => (window.__cfSoundLog = []));
/** The sound log after a click, once the click's 60 ms de-duplication window has passed. */
const settleSound = (page: Page) => page.waitForTimeout(90);

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("field → tree → branch → apple, with breadcrumb and a big Back", async ({ page }) => {
    await page.goto("/settings");
    await settle(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Make it yours.");
    // No folder panel on phones: drill-down pages instead.
    await expect(page.getByRole("navigation", { name: "Settings sections" })).toBeHidden();

    await page.getByRole("link", { name: /^Look & feel/ }).click();
    await expect(page).toHaveURL(/\/settings\/look-and-feel$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Look & feel");
    await expect(page).toHaveTitle("Look & feel · Settings · Clip Factory");
    const back = page.getByRole("link", { name: "Back to Settings" });
    await expect(back).toBeVisible();
    expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(48);

    await page.getByRole("link", { name: /^Sounds/ }).click();
    await expect(page).toHaveURL(/\/settings\/look-and-feel\/sounds$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sounds");
    const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(crumbs.getByRole("listitem")).toHaveText(["Settings", "Look & feel", "Sounds"]);
    await expect(crumbs.getByText("Sounds")).toHaveAttribute("aria-current", "page");
    // The apples, each with its leaf.
    await expect(page.locator("#sounds-on")).toContainText("Sounds only play when you tap, never when you scroll.");
    await expect(page.getByRole("heading", { name: "When it works" })).toBeVisible();

    await page.getByRole("link", { name: "Back to Look & feel" }).click();
    await expect(page).toHaveURL(/\/settings\/look-and-feel$/);
    // Every part of the breadcrumb is a full 48 px tap target on a phone.
    for (const link of await crumbs.getByRole("link").all()) expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(48);
    await crumbs.getByRole("link", { name: "Settings" }).click();
    await expect(page).toHaveURL(/\/settings$/);
  });

  test("the breadcrumb stays on one row at 320-414 px, truncating from the left", async ({ page }) => {
    for (const width of [320, 375, 414]) {
      await page.setViewportSize({ width, height: 844 });
      for (const path of [
        "/settings/app/account",
        "/settings/posting/setup/tiktok",
        "/settings/posting/setup/instagram",
        "/settings/clip-making/skills/new",
        "/settings/clip-making/skills/01JZ8S00000000000000000001/edit",
      ]) {
        await page.goto(path);
        await settle(page);
        const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
        const shown = await crumbs.locator(".crumbs__item").filter({ visible: true }).evaluateAll((els) =>
          els.map((e) => ({ top: Math.round(e.getBoundingClientRect().top), right: e.getBoundingClientRect().right })),
        );
        const list = await crumbs.locator(".crumbs__list").evaluate((el) => ({ h: el.getBoundingClientRect().height, right: el.getBoundingClientRect().right }));
        // One row: every visible level on the same line, none past the list's right edge.
        expect(new Set(shown.map((s) => s.top)).size, `${path} at ${width}`).toBe(1);
        expect(list.h, `${path} at ${width}`).toBeLessThan(60);
        for (const s of shown) expect(s.right, `${path} at ${width}`).toBeLessThanOrEqual(list.right + 1);
        // The page you are on is always the last thing shown.
        await expect(crumbs.locator('[aria-current="page"]')).toBeVisible();
        for (const link of await crumbs.getByRole("link").all()) {
          const box = (await link.boundingBox())!;
          expect(box.height).toBeGreaterThanOrEqual(48);
          expect(box.width).toBeGreaterThanOrEqual(48);
        }
      }
    }
  });

  test("switches have a 48 px tap area", async ({ page }) => {
    await page.goto("/settings/look-and-feel/sounds");
    await settle(page);
    const area = await page.getByRole("switch", { name: "Sounds" }).evaluate((el) => {
      const s = getComputedStyle(el, "::before");
      const r = el.getBoundingClientRect();
      return { h: r.height - parseFloat(s.top) - parseFloat(s.bottom), w: r.width - parseFloat(s.left) - parseFloat(s.right) };
    });
    expect(area.h).toBeGreaterThanOrEqual(48);
    expect(area.w).toBeGreaterThanOrEqual(48);
  });

  test("Find a setting jumps to the apple and lights it up", async ({ page }) => {
    await page.goto("/settings");
    await settle(page);
    const box = page.getByLabel("Find a setting");
    await box.fill("error sound");
    await expect(page.getByRole("status").filter({ hasText: "found" })).toContainText("found");
    const hit = page.getByRole("listbox", { name: "Settings found" }).getByRole("option").first();
    await expect(hit).toContainText("Error sound");
    await expect(hit).toContainText("Look & feel › Sounds");
    await hit.click();
    await expect(page).toHaveURL(/\/settings\/look-and-feel\/sounds#error-sound$/);
    const apple = page.locator("#error-sound");
    await expect(apple).toHaveClass(/is-found/);
    await expect(apple).toBeFocused();
    await expect(apple).toBeInViewport();
    // A tall apple (30 cards) lands at the top, so its heading and leaf are on screen, not scrolled away above.
    await expect(page.getByRole("heading", { name: "When it can't" })).toBeInViewport();
    await expect(apple.locator(".apple__leaf")).toBeInViewport();
    // The light fades after 2 seconds (measured in the page, so a busy test machine cannot make it flaky).
    const lit = await apple.evaluate(
      (el) =>
        new Promise<number>((resolve) => {
          const start = performance.now();
          const watch = new MutationObserver(() => {
            if (!el.classList.contains("is-found")) {
              watch.disconnect();
              resolve(performance.now() - start);
            }
          });
          watch.observe(el, { attributes: true, attributeFilter: ["class"] });
        }),
    );
    expect(lit).toBeLessThan(2100);
  });

  test("searching “write a skill” finds Add a skill, which leads to Write a skill (§18.7)", async ({ page }) => {
    await page.goto("/settings");
    await settle(page);
    await page.getByLabel("Find a setting").fill("write a skill");
    const hit = page.getByRole("listbox", { name: "Settings found" }).getByRole("option").first();
    await expect(hit).toContainText("Add a skill");
    await expect(hit).toContainText("Clip making › Skills");
    await hit.click();
    await expect(page).toHaveURL(/\/settings\/clip-making\/skills#add-skill$/);
    await expect(page.locator("#add-skill")).toBeFocused();
    await page.getByRole("link", { name: "Write a skill" }).click();
    await expect(page).toHaveURL(/\/settings\/clip-making\/skills\/new$/);
    await expect(page.getByLabel("What is the skill called?")).toBeVisible();
  });

  test("searching for “clip” does not list Sign out or Get the app", async ({ page }) => {
    await page.goto("/settings");
    await settle(page);
    await page.getByLabel("Find a setting").fill("clip");
    const hits = page.getByRole("listbox", { name: "Settings found" }).getByRole("option");
    await expect(hits.first()).toBeVisible();
    await expect(hits.filter({ hasText: "Sign out" })).toHaveCount(0);
    await expect(hits.filter({ hasText: "Get the app" })).toHaveCount(0);
  });
});

// The light of "Find a setting" traces the panel's own lines (§15): an apple alone in its panel lights the whole
// panel, whatever else the panel holds; one of several lights its row from the panel's left edge to its right edge.
for (const width of [390, 1440]) {
  test.describe(`the found light at ${width} px`, () => {
    test.use({ viewport: { width, height: 900 } });
    for (const c of [
      { path: "/settings/look-and-feel/sounds#try-sounds", id: "try-sounds", whole: true },
      { path: "/settings/look-and-feel/sounds#error-sound", id: "error-sound", whole: true },
      { path: "/settings/look-and-feel/background#glass-strength", id: "glass-strength", whole: false },
      { path: "/settings/look-and-feel/background#background-picture", id: "background-picture", whole: false },
    ]) {
      test(`#${c.id} is lit along the panel's edges`, async ({ page }) => {
        await page.goto(c.path);
        await settle(page);
        const apple = page.locator(`#${c.id}`);
        await expect(apple).toHaveClass(/is-found/);
        const m = await apple.evaluate((el) => {
          const panel = el.closest(".apple-panel")!;
          const p = panel.getBoundingClientRect();
          const a = el.getBoundingClientRect();
          const s = getComputedStyle(el, "::after");
          return {
            panel: { w: p.width, h: p.height },
            apple: { h: a.height },
            light: { w: parseFloat(s.width), h: parseFloat(s.height), radius: s.borderTopLeftRadius },
            panelRadius: getComputedStyle(panel).borderTopLeftRadius,
            outline: getComputedStyle(el).outlineColor,
            ring: getComputedStyle(el).boxShadow,
          };
        });
        expect(Math.abs(m.light.w - m.panel.w)).toBeLessThanOrEqual(1);
        if (c.whole) {
          expect(Math.abs(m.light.h - m.panel.h)).toBeLessThanOrEqual(1);
          expect(m.light.radius).toBe(m.panelRadius);
        } else {
          expect(m.light.h).toBeLessThan(m.panel.h);
        }
        // No ring of its own around the apple: only the light on the panel's lines.
        expect(m.ring).toBe("none");
      });
    }
  });
}

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the folder panel shows the whole tree; folders fold and stay folded", async ({ page }) => {
    await page.goto("/settings");
    await settle(page);
    const panel = page.getByRole("navigation", { name: "Settings sections" });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("link", { name: "All settings" })).toHaveAttribute("aria-current", "page");
    // No Back button on wide screens; the breadcrumb is enough.
    await expect(page.locator(".trail__back")).toHaveCount(0);
    // A first visit on the field: no tree is current, so every folder starts shut.
    for (const name of ["Clip making", "Posting", "Look & feel", "App & account"])
      await expect(panel.getByRole("button", { name })).toHaveAttribute("aria-expanded", "false");

    // Branch links go straight to the branch, highlighted.
    await panel.getByRole("button", { name: "Look & feel" }).click();
    await panel.getByRole("link", { name: "Sounds" }).click();
    await expect(page).toHaveURL(/\/settings\/look-and-feel\/sounds$/);
    await expect(panel.getByRole("link", { name: "Sounds" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("link", { name: "Back to Look & feel" })).toBeHidden();

    // Open "Posting", then fold it shut.
    const posting = panel.getByRole("button", { name: "Posting" });
    await expect(posting).toHaveAttribute("aria-expanded", "false");
    await posting.click();
    await expect(posting).toHaveAttribute("aria-expanded", "true");
    await expect(panel.getByRole("link", { name: "Set up posting" })).toBeVisible();
    await posting.click();
    await expect(posting).toHaveAttribute("aria-expanded", "false");
    await expect(panel.getByRole("link", { name: "Set up posting" })).toBeHidden();

    // Remembered after a reload.
    await page.reload();
    await settle(page);
    await expect(panel.getByRole("button", { name: "Posting" })).toHaveAttribute("aria-expanded", "false");
    await expect(panel.getByRole("link", { name: "Set up posting" })).toBeHidden();

    // Unfold it again.
    await panel.getByRole("button", { name: "Posting" }).click();
    await expect(panel.getByRole("link", { name: "Set up posting" })).toBeVisible();

    // Going into a folded tree opens its folder so the current page shows.
    await expect(panel.getByRole("button", { name: "Clip making" })).toHaveAttribute("aria-expanded", "false");
    await page.goto("/settings/clip-making/skills");
    await settle(page);
    await expect(panel.getByRole("button", { name: "Clip making" })).toHaveAttribute("aria-expanded", "true");
    await expect(panel.getByRole("link", { name: "Skills" })).toHaveAttribute("aria-current", "page");
  });

  test("on a tree page the folder panel marks that tree: one aria-current, green and the vermilion dot; 260 px wide", async ({ page }) => {
    await page.goto("/settings/clip-making");
    await settle(page);
    const panel = page.getByRole("navigation", { name: "Settings sections" });
    await expect(panel.locator('[aria-current="page"]')).toHaveCount(1);
    const row = panel.getByRole("button", { name: "Clip making" });
    await expect(row).toHaveAttribute("aria-current", "page");
    await expect(row).toHaveClass(/is-current/);
    const look = await row.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, dot: getComputedStyle(el, "::after").content }));
    // The bone pill, as in the main menu.
    expect(look.bg).toContain("239, 231, 218");
    expect(look.dot).not.toBe("none");
    expect(Math.round((await panel.boundingBox())!.width)).toBe(260);
    // On a branch page the branch is current, not its tree.
    await panel.getByRole("link", { name: "Skills" }).click();
    await expect(panel.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(panel.getByRole("link", { name: "Skills" })).toHaveAttribute("aria-current", "page");
  });

  test("a first visit to a branch opens only its tree", async ({ page }) => {
    await page.goto("/settings/posting/where");
    await settle(page);
    const panel = page.getByRole("navigation", { name: "Settings sections" });
    await expect(panel.getByRole("button", { name: "Posting" })).toHaveAttribute("aria-expanded", "true");
    for (const name of ["Clip making", "Look & feel", "App & account"])
      await expect(panel.getByRole("button", { name })).toHaveAttribute("aria-expanded", "false");
  });

  test("the folder panel works with the arrow keys", async ({ page }) => {
    await page.goto("/settings/look-and-feel/motion");
    await settle(page);
    const panel = page.getByRole("navigation", { name: "Settings sections" });
    const home = panel.getByRole("link", { name: "All settings" });
    const clipMaking = panel.getByRole("button", { name: "Clip making" });
    await home.focus();
    await page.keyboard.press("ArrowDown");
    await expect(clipMaking).toBeFocused();
    // Right opens a folder, Right again steps into it, Left steps back out, Left closes it.
    await page.keyboard.press("ArrowRight");
    await expect(clipMaking).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("ArrowRight");
    await expect(panel.getByRole("link", { name: "Clips" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(panel.getByRole("link", { name: "Skills" })).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(clipMaking).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(clipMaking).toHaveAttribute("aria-expanded", "false");
    // Down skips the branches of a shut folder; Up goes back; End goes to the last row.
    await page.keyboard.press("ArrowDown");
    await expect(panel.getByRole("button", { name: "Posting" })).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(clipMaking).toBeFocused();
    await page.keyboard.press("End");
    await expect(panel.getByRole("button", { name: "App & account" })).toBeFocused();
    await page.keyboard.press("Home");
    await expect(home).toBeFocused();
    // Enter follows a link.
    await panel.getByRole("link", { name: "Background" }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/settings\/look-and-feel\/background$/);
  });

  test("the folder panel has its own Find a setting, a listbox for the keyboard", async ({ page }) => {
    await page.goto("/settings/look-and-feel/motion");
    await settle(page);
    const panel = page.getByRole("navigation", { name: "Settings sections" });
    const box = panel.getByRole("combobox", { name: "Find a setting" });
    await box.fill("sound");
    const list = panel.getByRole("listbox", { name: "Settings found" });
    const options = list.getByRole("option");
    await expect(options.first()).toBeVisible();
    await box.press("ArrowDown");
    await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
    await box.press("ArrowDown");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(options.nth(0)).toHaveAttribute("aria-selected", "false");
    await box.press("ArrowUp");
    await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
    await expect(box).toHaveAttribute("aria-activedescendant", (await options.nth(0).getAttribute("id"))!);
    // Escape clears.
    await box.press("Escape");
    await expect(box).toHaveValue("");
    await expect(list).toBeHidden();
    // Enter opens the one marked.
    await box.fill("error sound");
    await box.press("ArrowDown");
    await box.press("Enter");
    await expect(page).toHaveURL(/\/settings\/look-and-feel\/sounds#error-sound$/);
    await expect(box).toHaveValue("");
  });

  test("tree cards, branch cards, and every branch has its apples", async ({ page }) => {
    await page.goto("/settings");
    await settle(page);
    const trees = page.getByRole("list", { name: "Settings groups" }).getByRole("link");
    await expect(trees).toHaveCount(4);
    await expect(trees.nth(0)).toContainText("Clip making");
    // Each card names what is inside, with no count.
    await expect(trees.nth(0)).toContainText("Clips, Skills, What it learned");
    await expect(trees.nth(0)).not.toContainText("11 settings");

    await trees.nth(3).click();
    await expect(page).toHaveURL(/\/settings\/app$/);
    const branches = page.getByRole("list", { name: "App & account sections" }).getByRole("link");
    await expect(branches).toHaveText([/Get the app/, /Notifications/, /Updates/, /Ask/, /Account/]);

    await branches.nth(2).click();
    await expect(page.locator("#this-version")).toBeVisible();
    await page.getByRole("button", { name: "Check for updates" }).click();
    await expect(page.getByText("You have the newest version.")).toBeVisible();

    await page.goto("/settings/app/account");
    await settle(page);
    await expect(page.locator("#signed-in")).toContainText("owner@example.com");
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  });

  test("Enter in Find a setting jumps to the best match; nothing found says what to try", async ({ page }) => {
    await page.goto("/settings");
    await settle(page);
    const box = page.getByLabel("Find a setting");
    await box.fill("wallpaper");
    // Found by its leaf and words, not its name.
    await expect(page.getByRole("listbox", { name: "Settings found" }).getByRole("option").first()).toContainText("Background picture");
    await box.press("Enter");
    await expect(page).toHaveURL(/\/settings\/look-and-feel\/background#background-picture$/);
    await expect(page.locator("#background-picture")).toHaveClass(/is-found/);

    await page.goto("/settings");
    await settle(page);
    await page.getByLabel("Find a setting").fill("zebra");
    await expect(page.getByText("Nothing found for “zebra”.", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Clear the search" }).click();
    await expect(page.getByLabel("Find a setting")).toHaveValue("");
  });
});

test.describe("layout details", () => {
  test("sound cards: green number tiles (4.5:1 on the tint), name and feel kept together when a row stretches", async ({ page }) => {
    for (const width of [375, 414, 768]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/settings/look-and-feel/sounds");
      await settle(page);
      await expect(page.locator(".sound-group.is-tap .sound-card:not(.is-picked) .sound-card__num").first()).toHaveCSS("color", "rgb(228, 242, 218)");
      const gaps = await page.locator(".sound-card").evaluateAll((cards) =>
        cards.map((c) => c.querySelector(".sound-card__feel")!.getBoundingClientRect().top - c.querySelector(".sound-card__name")!.getBoundingClientRect().bottom),
      );
      expect(Math.max(...gaps) - Math.min(...gaps), `name-to-feel gaps at ${width}: ${gaps.join(", ")}`).toBeLessThanOrEqual(1);
    }
  });

  test("tree and branch card lines never leave one word alone on their last line", async ({ page }) => {
    const lonely = (sel: string) =>
      page.locator(sel).evaluateAll((els) =>
        els.flatMap((el) => {
          const words: { word: string; top: number }[] = [];
          const text = el.textContent ?? "";
          const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          for (let node = walk.nextNode(); node; node = walk.nextNode()) {
            const own = node.textContent ?? "";
            const re = /\S+/g;
            for (let m = re.exec(own); m; m = re.exec(own)) {
              const r = document.createRange();
              r.setStart(node, m.index);
              r.setEnd(node, m.index + m[0].length);
              words.push({ word: m[0], top: Math.round(r.getBoundingClientRect().top) });
            }
          }
          const lines = new Set(words.map((w) => w.top));
          if (lines.size < 2) return [];
          const last = Math.max(...lines);
          const onLast = words.filter((w) => w.top === last);
          return onLast.length === 1 && onLast[0]!.word !== "·" ? [`${text} → "${onLast[0]!.word}"`] : [];
        }),
      );
    for (const [width, path] of [
      [1440, "/settings"],
      [1920, "/settings/clip-making"],
    ] as const) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(path);
      await settle(page);
      await page.evaluate(() => document.fonts.ready);
      const found = await lonely(".tree-card__line, .branch-card__line, .tree-card__count");
      expect(found, `${path} at ${width}`).toEqual([]);
    }
  });
});

test("old one-page Settings links go to the right branch", async ({ page }) => {
  for (const [from, to] of [
    ["/settings#skills", /\/settings\/clip-making\/skills$/],
    ["/settings#accounts", /\/settings\/posting\/setup$/],
    ["/settings/posting/accounts", /\/settings\/posting\/setup$/],
    ["/settings?account=x&status=coming_soon", /\/settings\/posting\/setup\/x$/],
    ["/settings/posting/accounts?account=tiktok&status=coming_soon", /\/settings\/posting\/setup\/tiktok$/],
    ["/settings#clips", /\/settings\/clip-making\/clips$/],
    ["/settings#appearance", /\/settings\/look-and-feel$/],
    ["/settings#app", /\/settings\/app$/],
    ["/settings#get-app", /\/settings\/app\/get-the-app$/],
  ] as const) {
    await page.goto(from);
    await expect(page).toHaveURL(to);
    await settle(page);
    await expect(page.locator("h1")).toHaveCount(1);
  }
  // Unknown places are a friendly not-found page, never a blank screen.
  await page.goto("/settings/look-and-feel/nope");
  await expect(page.getByText("This page does not exist")).toBeVisible();
});

test.describe("Sounds", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("the owner's picks are chosen; tapping a card plays it, picks it and saves it", async ({ page }) => {
    await page.goto("/settings/look-and-feel/sounds");
    await settle(page);
    const click6 = page.getByRole("button", { name: /^Click sound 6: Water drop/ });
    const error5 = page.getByRole("button", { name: /^Error sound 5: Nope nope nope/ });
    await expect(click6).toHaveAttribute("aria-pressed", "true");
    await expect(click6).toContainText("Pick");
    await expect(error5).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".sound-card[aria-pressed='true']")).toHaveCount(2);

    await clearLog(page);
    const puts = () => page.evaluate(() => (window as unknown as { __cfMockCalls: Record<string, number> }).__cfMockCalls.putSettings ?? 0);
    const before = await puts();
    const click12 = page.getByRole("button", { name: /^Click sound 12: Coin/ });
    await click12.click();
    await expect(click12).toHaveAttribute("aria-pressed", "true");
    await expect(click6).toHaveAttribute("aria-pressed", "false");
    // The card plays its own recipe, once, and the usual click sound stays out of the way.
    expect(await soundLog(page)).toMatchObject([{ kind: "tap", sound: 12, muted: false }]);
    await expect.poll(puts).toBe(before + 1);
    await expect(page.locator(".try-it__picks")).toContainText("Click 12: Coin");

    await settleSound(page);
    const error21 = page.getByRole("button", { name: /^Error sound 21: Two-tone down/ });
    await error21.click();
    await expect(error21).toHaveAttribute("aria-pressed", "true");
    expect((await soundLog(page)).at(-1)).toMatchObject({ kind: "deny", sound: 21, muted: false });

    // From now on every tap in the app plays Coin, and every error plays Two-tone down.
    await settleSound(page);
    await clearLog(page);
    const panel = page.getByRole("navigation", { name: "Settings sections" });
    await panel.getByRole("link", { name: "Motion" }).click();
    await expect(page).toHaveURL(/\/motion$/);
    await settle(page);
    expect(await soundLog(page)).toMatchObject([{ kind: "tap", sound: 12 }]);
    await panel.getByRole("button", { name: "Posting" }).click();
    await panel.getByRole("link", { name: "Set up posting" }).click();
    await expect(page).toHaveURL(/\/setup$/);
    await settle(page);
    // A platform's Save keys is switched off until the keys look right: it plays the error sound.
    await page.locator(".setup-card[data-platform='youtube']").click();
    await expect(page).toHaveURL(/\/setup\/youtube$/);
    await settle(page);
    await page.locator("[data-step='key-paste'] .gstep__head").click();
    const save = page.getByRole("button", { name: "Save keys" });
    await save.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await clearLog(page);
    await save.click({ force: true });
    await expect.poll(async () => (await soundLog(page)).map((e) => [e.kind, e.sound])).toEqual([["deny", 21]]);
  });

  test("Try it: Sign in plays the click sound with a green toast, or fails with the error sound, a shake and a vermilion toast", async ({ page }) => {
    await page.goto("/settings/look-and-feel/sounds");
    await settle(page);
    const tryIt = page.getByRole("button", { name: "Try it: Sign in" });
    await clearLog(page);
    await tryIt.click();
    await expect(page.locator(".toast--success", { hasText: "Signed in" })).toBeVisible();
    expect(await soundLog(page)).toMatchObject([{ kind: "tap", sound: 6, muted: false }]);

    await settleSound(page);
    await page.getByRole("switch", { name: "Make it fail" }).click();
    await expect(page.getByRole("switch", { name: "Make it fail" })).toHaveAttribute("aria-checked", "true");
    await settleSound(page);
    await clearLog(page);
    await tryIt.click();
    await expect(page.locator(".toast--error", { hasText: "Wrong password. Try again." })).toBeVisible();
    await expect(tryIt).toHaveClass(/is-shaking/);
    // Only the error sound: the error toast's own sound is the same one, not a second sound.
    expect((await soundLog(page)).map((e) => [e.kind, e.sound])).toEqual([["deny", 5]]);
    // Practice toasts replace each other instead of piling up over the panel.
    await expect(page.locator(".toast")).toHaveCount(1);
    await settleSound(page);
    await page.getByRole("switch", { name: "Make it fail" }).click();
    await settleSound(page);
    await tryIt.click();
    await expect(page.locator(".toast--success", { hasText: "Signed in" })).toBeVisible();
    await expect(page.locator(".toast")).toHaveCount(1);
    // And they go away quickly.
    await expect(page.locator(".toast")).toHaveCount(0, { timeout: 4000 });
  });

  test("with Sounds off, every part of the page says so, nothing is picked unheard, and one tap turns sounds back on", async ({ page }) => {
    await page.goto("/settings/look-and-feel/sounds");
    await settle(page);
    await expect(page.getByText("Sounds are off.")).toHaveCount(0);
    await page.getByRole("switch", { name: "Sounds" }).click();
    await expect(page.getByRole("switch", { name: "Sounds" })).toHaveAttribute("aria-checked", "false");
    await expect(page.locator("#click-sound").getByText("Sounds are off.")).toBeVisible();
    await expect(page.locator("#error-sound").getByText("Sounds are off.")).toBeVisible();
    // Right under the Try it button too.
    await expect(page.locator(".try-it").getByText("Sounds are off.")).toBeVisible();

    // Try it does not pretend to sign in silently: it says why there is nothing to hear.
    await settleSound(page);
    await page.getByRole("button", { name: "Try it: Sign in" }).click();
    await expect(page.locator(".toast", { hasText: "Sounds are off. Turn them on to hear it." })).toBeVisible();
    await expect(page.locator(".toast", { hasText: "Signed in" })).toHaveCount(0);

    // A card tap you cannot hear does not change your pick.
    await settleSound(page);
    const bubble = page.getByRole("button", { name: /^Click sound 3: Bubble/ });
    await bubble.click();
    await expect(page.locator(".toast", { hasText: "Turn them on to hear it first." })).toBeVisible();
    await expect(bubble).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("button", { name: /^Click sound 6: Water drop/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".try-it__picks")).toContainText("Click 6: Water drop");

    // Turning sounds on answers with your click sound, once, so you hear they are back.
    await settleSound(page);
    await clearLog(page);
    await page.locator("#click-sound").getByRole("button", { name: "Turn sounds on" }).click();
    await expect(page.getByRole("switch", { name: "Sounds" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText("Sounds are off.")).toHaveCount(0);
    expect(await soundLog(page)).toMatchObject([{ kind: "tap", sound: 6, muted: false }]);
    expect(await soundLog(page)).toHaveLength(1);

    await settleSound(page);
    await clearLog(page);
    await bubble.click();
    await expect(bubble).toHaveAttribute("aria-pressed", "true");
    expect(await soundLog(page)).toMatchObject([{ kind: "tap", sound: 3, muted: false }]);
  });
});

test("Find a setting: Content Rewards, its campaigns and its money (§38.17)", async ({ page }) => {
  await page.goto("/settings");
  await settle(page);
  const box = page.getByLabel("Find a setting");
  await box.fill("content rewards");
  const hits = page.getByRole("listbox", { name: "Settings found" }).getByRole("option");
  await expect(hits.first()).toContainText("Content Rewards");
  await box.press("Enter");
  await expect(page).toHaveURL(/\/settings\/posting\/setup\/contentrewards$/);
  await expect(page.getByRole("heading", { name: "Content Rewards", level: 1 })).toBeVisible();
  await page.goto("/settings");
  await settle(page);
  await page.getByLabel("Find a setting").fill("whop");
  await expect(page.getByRole("listbox", { name: "Settings found" })).toContainText("Content Rewards");
});

test("Find a setting: Find campaigns opens the campaign finder (§41.1)", async ({ page }) => {
  await page.goto("/settings");
  await settle(page);
  const box = page.getByLabel("Find a setting");
  await box.fill("find campaigns");
  const hits = page.getByRole("listbox", { name: "Settings found" }).getByRole("option");
  await expect(hits.first()).toContainText("Find campaigns");
  await expect(hits.first()).toContainText("Campaigns on Content Rewards that pay what you want.");
  await box.press("Enter");
  await expect(page).toHaveURL(/\/campaigns\/find$/);
  await expect(page.getByRole("heading", { name: "Find campaigns", level: 1 })).toBeVisible();
  // Content Rewards news now names new campaigns too (§41.6 change 6).
  await page.goto("/settings");
  await settle(page);
  await page.getByLabel("Find a setting").fill("content rewards news");
  await expect(page.getByRole("listbox", { name: "Settings found" })).toContainText("You're in, send-now reminders, approvals, proof, money and new campaigns.");
});
