import { expect, test, type Page } from "@playwright/test";
import { animationsDone, findOverflow, settle } from "./helpers.ts";

/** The launcher's box when it is shown (not stepped aside), else null. */
async function shownLauncher(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".help-launcher");
    if (!el || el.classList.contains("is-hidden") || getComputedStyle(el).opacity === "0") return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  });
}

/** Buttons, inputs and text areas on the page that share area with the launcher. */
async function coveredControls(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".help-launcher");
    if (!el || el.classList.contains("is-hidden")) return [];
    const l = el.getBoundingClientRect();
    const out: string[] = [];
    for (const c of Array.from(document.querySelectorAll<HTMLElement>("button, input, textarea, select, [role=switch]"))) {
      if (c === el || c.closest(".help-launcher, .help-panel, .update-bar, .tabbar, .toasts")) continue;
      const s = getComputedStyle(c);
      if (s.visibility === "hidden" || s.display === "none" || (c instanceof HTMLInputElement && c.type === "hidden")) continue;
      const r = c.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const w = Math.min(r.right, l.right) - Math.max(r.left, l.left);
      const h = Math.min(r.bottom, l.bottom) - Math.max(r.top, l.top);
      if (w > 0 && h > 0) out.push(`${c.tagName.toLowerCase()}.${String(c.className).split(" ")[0]} "${(c.getAttribute("aria-label") || c.textContent || "").trim().slice(0, 30)}" ${Math.round(w)}x${Math.round(h)}`);
    }
    return out;
  });
}

/** True when the top element at the centre of the spotlit target is the target (or inside it). */
async function spotlitIsReachable(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("[data-help-spotlit]");
    if (!el) return "nothing spotlit";
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top && (el === top || el.contains(top)) ? "ok" : `covered by ${top?.className ?? "nothing"}`;
  });
}

// Ask Clip Factory (docs/CONTRACTS.md §19.8, §19.11) in the mock build: the fake model, the shared corpus and the
// magic words #429, #503 and #off. Phone 375x812 and desktop 1440x900.

const SIZES = [
  { name: "phone", width: 375, height: 812, phone: true },
  { name: "desktop", width: 1440, height: 900, phone: false },
] as const;

const launcher = (page: Page) => page.getByRole("button", { name: "Ask Clip Factory" });
const panel = (page: Page) => page.getByRole("dialog", { name: "Ask Clip Factory" });

async function open(page: Page, path = "/") {
  await page.goto(path);
  await settle(page);
  await launcher(page).click();
  await expect(panel(page)).toBeVisible();
}

async function ask(page: Page, question: string) {
  const box = panel(page).getByLabel("Your question");
  await box.fill(question);
  await box.press("Enter");
}

async function noOverflow(page: Page, label: string) {
  const r = await findOverflow(page);
  const fails = r.items.map((o) => `${label}: ${o.selector} "${o.text}" ${o.scrollWidth} > ${o.clientWidth}`);
  if (r.page > r.viewport) fails.push(`${label}: page scrolls sideways (${r.page} > ${r.viewport})`);
  expect(fails, fails.join("\n")).toEqual([]);
}

for (const size of SIZES) {
  test.describe(`Ask Clip Factory at ${size.width}x${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test("the launcher never sits on Keep on Review, even before any scroll", async ({ page }) => {
      await page.goto("/review");
      await settle(page);
      await page.locator('[data-help~="keep"]').first().waitFor();
      await page.waitForTimeout(400);
      const keep = (await page.locator('[data-help~="keep"]').first().boundingBox())!;
      const b = await shownLauncher(page);
      if (b) {
        const apart = b.right <= keep.x || b.left >= keep.x + keep.width || b.bottom <= keep.y || b.top >= keep.y + keep.height;
        expect(apart, `launcher ${JSON.stringify(b)} on Keep ${JSON.stringify(keep)}`).toBe(true);
      }
      expect(await coveredControls(page)).toEqual([]);
    });

    test("an answer button shows the control it lights up, and the chat is still there after", async ({ page }) => {
      await open(page);
      await ask(page, "What does Keep do?");
      const answer = panel(page).locator(".help-msg--bot").last();
      await expect(answer.locator(".help-steps li")).toHaveCount(3);
      await answer.getByRole("button", { name: "Open Review" }).click();
      await expect(page).toHaveURL(/\/review$/);
      await expect(page.locator('[data-help-spotlit][data-help~="keep"]')).toBeVisible();
      await expect.poll(() => spotlitIsReachable(page), { timeout: 3000 }).toBe("ok");
      // Open it again: the question and its steps are still there (memory only).
      if (await panel(page).count()) await panel(page).getByRole("button", { name: "Close" }).click();
      await page.mouse.wheel(0, -5);
      await expect(launcher(page)).not.toHaveClass(/is-hidden/, { timeout: 2000 });
      await launcher(page).click();
      await expect(panel(page).locator(".help-msg--me")).toHaveText(["What does Keep do?"]);
      await expect(panel(page).locator(".help-steps li")).toHaveCount(3);
      await panel(page).getByRole("button", { name: "Start over" }).click();
      await expect(panel(page).getByText("Hi! What do you want to do?")).toBeVisible();
    });

    test("the launcher is named, sits clear of the tab bar and the update bar", async ({ page }) => {
      await page.goto("/?update=1");
      await settle(page);
      const btn = launcher(page);
      await expect(btn).toBeVisible();
      await expect(btn).not.toHaveClass(/btn--primary/);
      await page.waitForTimeout(700); // the update bar slides in
      const b = (await btn.boundingBox())!;
      const barNow = (await page.getByRole("region", { name: "New version" }).boundingBox())!;
      expect(barNow.height).toBeGreaterThan(0);
      expect(b.y + b.height).toBeLessThanOrEqual(barNow.y - (size.phone ? 9 : 11));
      expect(b.x + b.width).toBeLessThanOrEqual(size.width - 15);
      if (size.phone) {
        const tabs = (await page.locator("nav.tabbar").boundingBox())!;
        expect(b.y + b.height).toBeLessThanOrEqual(tabs.y);
        expect(b.width).toBe(56);
        await expect(btn.locator(".help-launcher__word")).toBeHidden();
      } else {
        await expect(btn).toContainText("Ask");
      }

      // Without the update bar it still never covers the tab bar.
      await page.goto("/");
      await settle(page);
      const plain = (await launcher(page).boundingBox())!;
      if (size.phone) {
        const tabs = (await page.locator("nav.tabbar").boundingBox())!;
        expect(plain.y + plain.height).toBeLessThanOrEqual(tabs.y);
      } else {
        expect(size.height - (plain.y + plain.height)).toBeCloseTo(24, 0);
      }
    });

    test("opens with three suggestions and takes you to the click sound", async ({ page }) => {
      await open(page);
      await expect(panel(page).getByText("Hi! What do you want to do?")).toBeVisible();
      await expect(panel(page).locator(".help-chip")).toHaveCount(3);
      await expect(panel(page).getByLabel("Your question")).toBeFocused();
      await noOverflow(page, "panel (empty)");

      await ask(page, "Where do I change my click sound?");
      const answer = panel(page).locator(".help-msg--bot").last();
      await expect(answer.locator(".help-steps li")).toHaveCount(3);
      const go = answer.getByRole("button", { name: "Open Sounds" });
      await expect(go).toHaveClass(/btn--primary/);
      await noOverflow(page, "panel (answer)");

      await go.click();
      await expect(page).toHaveURL(/\/settings\/look-and-feel\/sounds#click-sound$/);
      await expect(page.locator("#click-sound[data-help-spotlit]")).toBeVisible();
      await expect(page.locator(".help-ring")).toBeVisible();
      if (size.phone) await expect(panel(page)).toBeHidden();
      // On wide screens the panel stays open unless it would cover what lit up.
      else await expect.poll(() => spotlitIsReachable(page), { timeout: 2000 }).toBe("ok");
    });

    test("the Ask box spans the panel and sends with a paper plane", async ({ page }) => {
      await open(page);
      const p = panel(page);
      const box = p.getByLabel("Your question");
      const send = p.getByRole("button", { name: "Send", exact: true });
      await expect(box).toHaveAttribute("enterkeyhint", "send");
      await animationsDone(page);
      // Edge to edge: the field takes the panel's width less the form's small padding.
      const pb = (await p.boundingBox())!;
      const fb = (await box.boundingBox())!;
      expect(fb.width, "field width").toBeGreaterThanOrEqual(pb.width - 24);
      expect(fb.x - pb.x).toBeLessThanOrEqual(12);
      // The plane: no words, a 44 px target, inside the right end of the field, off while the field is empty.
      expect(((await send.textContent()) ?? "").trim()).toBe("");
      await expect(send.locator("svg.paper-plane")).toHaveCount(1);
      const sb = (await send.boundingBox())!;
      expect(Math.round(sb.width)).toBe(44);
      expect(Math.round(sb.height)).toBe(44);
      expect(sb.x).toBeGreaterThan(fb.x + fb.width / 2);
      expect(sb.x + sb.width).toBeLessThanOrEqual(fb.x + fb.width);
      expect(sb.y).toBeGreaterThanOrEqual(fb.y);
      expect(sb.y + sb.height).toBeLessThanOrEqual(fb.y + fb.height);
      await expect(send).toHaveAttribute("aria-disabled", "true");
      // Nothing (the tab bar on phones, the launcher on desktop) sits on the plane.
      const onTop = await send.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!top && el.contains(top);
      });
      expect(onTop).toBe(true);
      if (size.phone) expect(sb.y + sb.height).toBeLessThanOrEqual(size.height);

      // Shift+Enter adds a line; the field grows up to four lines, then scrolls.
      await box.fill("one");
      const oneLine = (await box.boundingBox())!.height;
      await box.press("Shift+Enter");
      await box.pressSequentially("two");
      await expect(box).toHaveValue("one\ntwo");
      await expect(p.locator(".help-msg--me")).toHaveCount(0);
      expect((await box.boundingBox())!.height).toBeGreaterThan(oneLine);
      await box.fill("1\n2\n3\n4\n5\n6\n7");
      const tall = (await box.boundingBox())!.height;
      await box.fill("1\n2\n3\n4");
      expect((await box.boundingBox())!.height).toBeCloseTo(tall, 0);
      expect(tall).toBeLessThan(oneLine * 3);
      await noOverflow(page, "Ask box (four lines)");

      // Tap the plane: it flies, and the question shows straight away (it does not wait for the flight).
      await box.fill("What does Keep do?");
      await expect(send).not.toHaveAttribute("aria-disabled", "true");
      await send.click();
      await expect(send.locator(".fly")).toHaveClass(/is-flying/);
      await expect(send.locator(".fly__trail")).toHaveCount(1);
      await expect(p.locator(".help-msg--me")).toHaveText(["What does Keep do?"]);
      await expect(box).toHaveValue("");
      await expect(send.locator(".fly")).not.toHaveClass(/is-flying/, { timeout: 2000 });
      await expect(p.locator(".help-msg--bot").last().locator(".help-steps li")).toHaveCount(3);
      // The tap played the click sound.
      const log = await page.evaluate(() => (window.__cfSoundLog ?? []).map((e) => e.kind));
      expect(log).toContain("tap");
    });

    test("fills the best clip's views from the owner's own data", async ({ page }) => {
      await open(page, "/library");
      await ask(page, "How many views did my best clip get this week?");
      const answer = panel(page).locator(".help-msg--bot").last();
      await expect(answer).toContainText(/Your best clip this week, ".+", has [\d.]+[KM]? views\.|No clips this week yet\./);
      await expect(answer.locator(".help-shimmer")).toHaveCount(0);
      await expect(answer.getByRole("button", { name: "See this week" })).toBeVisible();
    });

    test("refuses secrets and says when it does not know", async ({ page }) => {
      await open(page);
      await ask(page, "what is my password");
      await expect(panel(page).locator(".help-msg--bot").last()).toContainText("I can't help with that. I only know how to use Clip Factory.");
      await ask(page, "what's the weather");
      const unknown = panel(page).locator(".help-msg--bot").last();
      await expect(unknown).toContainText("I don't know that one yet.");
      await expect(unknown.locator(".help-chip")).toHaveCount(3);
      // On Home, Go Home would do nothing: the chips are the next step.
      await expect(unknown.getByRole("button", { name: "Go Home" })).toHaveCount(0);
    });

    test("#429 shows a calm countdown and Ask stays off", async ({ page }) => {
      await open(page);
      await ask(page, "#429 what does keep do");
      await expect(panel(page).getByText(/Let's take a short break\. You can ask again in \d seconds\./)).toBeVisible();
      await panel(page).getByLabel("Your question").fill("What does Keep do?");
      await expect(panel(page).locator(".help-panel__ask")).toHaveAttribute("aria-disabled", "true");
      await noOverflow(page, "panel (429)");
    });

    test("#503 answers from the local notes with a help code to copy", async ({ page }) => {
      await open(page);
      await ask(page, "#503 What does Keep do?");
      const answer = panel(page).locator(".help-msg--bot").last();
      await expect(answer).toContainText("Keep");
      await expect(answer.getByRole("button", { name: "Open Review" })).toBeVisible();
      await expect(answer.getByRole("button", { name: "Something went wrong? Copy the help code" })).toBeVisible();
    });

    test("#off says so, then the launcher is gone", async ({ page }) => {
      await open(page);
      await ask(page, "#off");
      await expect(panel(page).getByText("Ask Clip Factory is turned off right now.")).toBeVisible();
      await expect(launcher(page)).toHaveCount(0);
      await expect(panel(page)).toHaveCount(0, { timeout: 6000 });
    });

    test("Tab stays where it can be seen", async ({ page }) => {
      await open(page);
      await expect(panel(page)).toHaveAttribute("aria-modal", size.phone ? "true" : "false");
      await panel(page).getByLabel("Your question").fill("What does Keep do?");
      await panel(page).locator(".help-panel__ask").focus();
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press("Tab");
        const where = await page.evaluate(() => {
          const a = document.activeElement;
          return a?.closest(".help-panel") ? "panel" : (a?.tagName ?? "none");
        });
        if (size.phone) expect(where, `Tab ${i + 1}`).toBe("panel");
      }
      if (size.phone) {
        // The page and the launcher behind the sheet are inert.
        expect(await page.locator(".shell").getAttribute("inert")).toBe("");
        await panel(page).getByRole("button", { name: "Close" }).click();
        expect(await page.locator(".shell").getAttribute("inert")).toBeNull();
      }
    });

    test("Escape closes the panel and gives the focus back to the launcher", async ({ page }) => {
      await open(page);
      await page.keyboard.press("Escape");
      await expect(panel(page)).toHaveCount(0);
      await expect(launcher(page)).toBeFocused();
    });

    test("with reduced motion nothing in the panel animates", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await open(page);
      // The plane only fades: no flight, no trail.
      const box = panel(page).getByLabel("Your question");
      await box.fill("What does Keep do?");
      const send = panel(page).getByRole("button", { name: "Send", exact: true });
      await send.click();
      await expect(send.locator(".fly")).toHaveClass(/is-fading/);
      await expect(send.locator(".fly__trail")).toHaveCount(0);
      const names = await send.evaluate((el) => el.getAnimations({ subtree: true }).map((a) => (a as CSSAnimation).animationName ?? ""));
      expect(names.every((n) => n === "fly-fade" || n === ""), names.join(", ")).toBe(true);
      await expect(panel(page).locator(".help-msg--bot")).toHaveCount(1);
      // Nothing keeps moving: no entrance, no bouncing dots, no shimmer (1 ms leftovers of a tap settle at once).
      await expect
        .poll(() => page.evaluate(() => document.querySelector(".help-panel")!.getAnimations({ subtree: true }).length), { timeout: 3000 })
        .toBe(0);
    });

    test("the launcher steps aside while scrolling down and comes back on scroll up", async ({ page }) => {
      await page.goto("/");
      await settle(page);
      const hidden = async (y: number) =>
        page.evaluate(async (top) => {
          window.scrollTo({ top, behavior: "instant" });
          await new Promise((r) => setTimeout(r, 120));
          return document.querySelector(".help-launcher")!.classList.contains("is-hidden");
        }, y);
      expect(await hidden(400)).toBe(true);
      expect(await hidden(100)).toBe(false);
      // And it comes back by itself once scrolling stops.
      expect(await hidden(500)).toBe(true);
      await expect(launcher(page)).not.toHaveClass(/is-hidden/, { timeout: 2000 });
    });
  });
}

// The posting and skills guides take you to the real pages (§17, §18) and light up a control that is there.
test.describe("Ask Clip Factory guides for posting setup and skills", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  for (const c of [
    // The mock model keeps one button; #503 answers from the local notes, which keep both.
    { q: "#503 connect youtube", button: "Set up YouTube", url: /\/settings\/posting\/setup\/youtube$/, lit: /setup-(connect|progress)/ },
    { q: "connect tiktok", button: "Open Set up posting", url: /\/settings\/posting\/setup$/, lit: /setup-tiktok/ },
    { q: "write a skill", button: "Write a skill", url: /\/settings\/clip-making\/skills\/new$/, lit: /skill-form/ },
    { q: "delete a skill", button: "Open Skills", url: /\/settings\/clip-making\/skills#your-skills$/, lit: /your-skills/ },
  ]) {
    test(`"${c.q}" opens ${c.button} and lights it up`, async ({ page }) => {
      await open(page);
      await ask(page, c.q);
      await panel(page).locator(".help-msg--bot").last().getByRole("button", { name: c.button }).click();
      await expect(page).toHaveURL(c.url);
      await expect(page.locator("[data-help-spotlit]")).toHaveAttribute("data-help", c.lit);
    });
  }
});

// The circle on phones never sits on a real control once it settles: it lifts over the marked ones or steps aside.
const PHONES = [320, 375, 390, 430] as const;
const PHONE_ROUTES = ["/", "/jobs", "/review", "/library", "/library?view=week", "/settings/clip-making/skills", "/settings/look-and-feel/sounds", "/get-app"];
for (const width of PHONES) {
  test.describe(`Ask Clip Factory launcher on a ${width} px phone`, () => {
    test.use({ viewport: { width, height: 812 } });
    for (const update of [false, true]) {
      test(`covers no control on any page${update ? " with the update bar" : ""}`, async ({ page }) => {
        const fails: string[] = [];
        for (const route of PHONE_ROUTES) {
          const sep = route.includes("?") ? "&" : "?";
          await page.goto(update ? `${route}${sep}update=1` : route);
          await settle(page);
          await page.waitForTimeout(update ? 800 : 300);
          for (const c of await coveredControls(page)) fails.push(`${route}: ${c}`);
        }
        expect(fails, fails.join("\n")).toEqual([]);
      });
    }
  });
}
