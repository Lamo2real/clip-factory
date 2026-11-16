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

/** Links, buttons, fields and anything focusable on the page that share area with the shown launcher. */
async function coveredControls(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".help-launcher");
    if (!el || el.classList.contains("is-hidden")) return [];
    const l = el.getBoundingClientRect();
    const sel =
      'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="switch"], [role="tab"], [tabindex]:not([tabindex="-1"])';
    const out: string[] = [];
    for (const c of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      // Fixed chrome the launcher is placed clear of by CSS, and cards that are links: their own controls count.
      if (c === el || c.closest(".help-launcher, .help-panel, .update-bar, .tabbar, .sidebar") || c.querySelector(sel)) continue;
      const s = getComputedStyle(c);
      if (s.visibility === "hidden" || s.display === "none") continue;
      const r = c.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const w = Math.min(r.right, l.right) - Math.max(r.left, l.left);
      const h = Math.min(r.bottom, l.bottom) - Math.max(r.top, l.top);
      if (w > 0 && h > 0) out.push(`${c.tagName.toLowerCase()}.${String(c.className).split(" ")[0]} "${(c.getAttribute("aria-label") || c.textContent || "").trim().slice(0, 30)}" ${Math.round(w)}x${Math.round(h)}`);
    }
    return out;
  });
}

/**
 * Waits until the launcher has settled: not stepped aside for a scroll and not moving, for three frames in a row
 * (its measure runs on the frame after a change and its move starts on the next). Frames and events, not time.
 */
async function launcherSettled(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let calm = 0;
        const tick = () => {
          const el = document.querySelector<HTMLElement>(".help-launcher");
          const still = !el || (el.dataset.dodge !== "scroll" && el.getAnimations().every((a) => a.playState !== "running"));
          calm = still ? calm + 1 : 0;
          if (calm >= 3) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

/**
 * Makes the page fall back to other fonts (no bundled Inter or Tinos, different widths), like a machine whose fonts
 * differ, so the layout shifts a little: the launcher has to find its spot from the page, not from known pixels.
 */
async function fallbackFonts(page: Page) {
  await page.route(/\.woff2?(\?.*)?$/, (r) => r.abort());
  await page.addInitScript(() => {
    const add = () => {
      const s = document.createElement("style");
      s.textContent = ":root{--font-ui: Verdana, 'DejaVu Sans', sans-serif !important; --font-display: Georgia, 'DejaVu Serif', serif !important}";
      document.head.appendChild(s);
    };
    if (document.head) add();
    else document.addEventListener("DOMContentLoaded", add);
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
      await launcherSettled(page);
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
      // The panel may still step away by itself while the page scrolls Keep in: close it if it is there, then wait for
      // the one end state (no panel) either way.
      if (await panel(page).count()) await panel(page).getByRole("button", { name: "Close" }).click({ timeout: 3000 }).catch(() => undefined);
      await expect(panel(page)).toHaveCount(0);
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
      await expect(page.getByRole("region", { name: "New version" })).toBeVisible();
      await animationsDone(page); // the update bar slides in
      await launcherSettled(page);
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
      await launcherSettled(page);
      const plain = (await launcher(page).boundingBox())!;
      if (size.phone) {
        const tabs = (await page.locator("nav.tabbar").boundingBox())!;
        expect(plain.y + plain.height).toBeLessThanOrEqual(tabs.y);
      } else {
        // Its resting spot is 24 px off the bottom (it may lift from there to stay off a control on the page).
        const rest = await launcher(page).evaluate((el: HTMLElement) => innerHeight - (el.offsetTop + el.offsetHeight));
        expect(rest).toBeCloseTo(24, 0);
        expect(size.height - (plain.y + plain.height)).toBeGreaterThanOrEqual(24 - 0.5);
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
      // Waits on events, not time: each scroll here flips the launcher, so wait for its class to change (a 3 s cap
      // only turns a hang into a clear failure). Smooth scrolling, like a finger or a wheel.
      const scrollAndRead = async (y: number) =>
        page.evaluate(async (top) => {
          const el = document.querySelector(".help-launcher")!;
          const was = el.classList.contains("is-hidden");
          await new Promise<void>((resolve) => {
            const seen = new MutationObserver(() => {
              if (el.classList.contains("is-hidden") === was) return;
              seen.disconnect();
              resolve();
            });
            seen.observe(el, { attributes: true, attributeFilter: ["class"] });
            setTimeout(() => (seen.disconnect(), resolve()), 3000);
            window.scrollTo({ top, behavior: "smooth" });
          });
          return el.classList.contains("is-hidden");
        }, y);
      expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeGreaterThan(400);
      expect(await scrollAndRead(400)).toBe(true);
      await page.evaluate(() => window.scrollTo({ top: 400, behavior: "instant" })); // let a smooth scroll finish
      expect(await scrollAndRead(100)).toBe(false);
      // And it comes back by itself once scrolling stops.
      expect(await scrollAndRead(500)).toBe(true);
      await expect(launcher(page)).not.toHaveClass(/is-hidden/, { timeout: 5000 });
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

// The launcher never sits on a real control once it settles, at any width, at the top of each page and after
// scrolling through it (it lifts to a free spot or steps aside), with the update bar too, and with other fonts.
const WIDTHS = [320, 375, 390, 430, 768, 1024, 1440, 1920] as const;
const ROUTES = [
  "/",
  "/jobs",
  "/review",
  "/library",
  "/library?view=week",
  "/settings",
  "/settings/clip-making/skills",
  "/settings/clip-making/skills/new",
  "/settings/look-and-feel/sounds",
  "/get-app",
];
const VARIANTS = [
  ...WIDTHS.map((width) => ({ width, update: false, fonts: false })),
  ...WIDTHS.map((width) => ({ width, update: true, fonts: false })),
  ...([320, 430, 1024, 1440] as const).map((width) => ({ width, update: true, fonts: true })),
];
for (const v of VARIANTS) {
  test.describe(`Ask Clip Factory launcher at ${v.width} px`, () => {
    test.use({ viewport: { width: v.width, height: v.width < 768 ? 812 : 900 } });
    test(`covers no control on any page${v.update ? " with the update bar" : ""}${v.fonts ? " and other fonts" : ""}`, async ({ page }) => {
      if (v.fonts) await fallbackFonts(page);
      const fails: string[] = [];
      for (const route of ROUTES) {
        const sep = route.includes("?") ? "&" : "?";
        await page.goto(v.update ? `${route}${sep}update=1` : route);
        await settle(page);
        if (v.update) await expect(page.getByRole("region", { name: "New version" })).toBeVisible();
        await launcherSettled(page);
        for (const c of await coveredControls(page)) fails.push(`${route} at the top: ${c}`);
        // Scroll down through the page and back up a little (the launcher shows again), then check where it stops.
        const max = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
        for (const y of [Math.round(max / 3), Math.round((2 * max) / 3), max]) {
          if (y < 60) continue;
          await page.evaluate(async (top) => {
            const scrolled = () => new Promise((r) => window.addEventListener("scroll", r, { once: true }));
            const down = scrolled();
            window.scrollTo({ top, behavior: "instant" });
            await down;
            const up = scrolled();
            window.scrollTo({ top: top - 40, behavior: "instant" });
            await up;
          }, y);
          await launcherSettled(page);
          for (const c of await coveredControls(page)) fails.push(`${route} at ${y}: ${c}`);
        }
      }
      expect(fails, fails.join("\n")).toEqual([]);
    });
  });
}
