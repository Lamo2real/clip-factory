import { expect, test, type Page } from "@playwright/test";
import { blocks, CONTROLS, DODGE_HOLD_MS, DODGE_SETTLE_MS, type Box } from "../src/features/help/dodge.ts";
import { SPOT_ARRIVE_CAP_MS } from "../src/features/help/spotlight.ts";
import { animationsDone, findOverflow, launcherSettled, settle } from "./helpers.ts";

// These cover Ask's §19/§26 path (plain answers, pictures inline): the mock's assistant (§28) is turned off here.
// e2e/ask-assistant.spec.ts and e2e/ask-markup.spec.ts cover the assistant.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("cf-mock-assistant", "off");
    } catch {
      /* no storage: the assistant stays on */
    }
  });
});

/** The launcher's box when it is shown (not stepped aside), else null. */
async function shownLauncher(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".help-launcher");
    if (!el || el.classList.contains("is-hidden") || getComputedStyle(el).opacity === "0") return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  });
}

/**
 * Links, buttons, fields and anything focusable on the page that the shown launcher makes hard to tap: it covers more
 * than 30 % of one, or leaves no part of it 44 px (or its own size, if smaller) each way free beside it (§19.8).
 */
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
      if (w <= 0 || h <= 0) continue;
      const needW = Math.min(44, r.width);
      const needH = Math.min(44, r.height);
      const free = [
        [l.left - r.left, r.height],
        [r.right - l.right, r.height],
        [r.width, l.top - r.top],
        [r.width, r.bottom - l.bottom],
      ].some(([fw, fh]) => fw! >= needW && fh! >= needH);
      if ((w * h) / (r.width * r.height) > 0.3 || !free) out.push(`${c.tagName.toLowerCase()}.${String(c.className).split(" ")[0]} "${(c.getAttribute("aria-label") || c.textContent || "").trim().slice(0, 30)}" ${Math.round(w)}x${Math.round(h)}`);
    }
    return out;
  });
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
      await page.locator('[data-help~="upload"]').first().waitFor();
      await launcherSettled(page);
      const keep = (await page.locator('[data-help~="upload"]').first().boundingBox())!;
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
      await expect(page.locator('[data-help-spotlit][data-help~="upload"]')).toBeVisible();
      // The ring stays lit for its full time once Keep has scrolled in, however long the scroll takes on this machine.
      await expect.poll(() => spotlitIsReachable(page), { timeout: SPOT_ARRIVE_CAP_MS }).toBe("ok");
      // Open it again: the question and its steps are still there (memory only).
      // The panel may still step away by itself while the page scrolls Keep in: close it if it is there, then wait for
      // the one end state (no panel) either way.
      if (await panel(page).count()) await panel(page).getByRole("button", { name: "Close" }).click({ timeout: 3000 }).catch(() => undefined);
      await expect(panel(page)).toHaveCount(0);
      await page.mouse.wheel(0, -5);
      // Where a control is under its spot and no clear spot is a small nudge away, the launcher fades out until the
      // owner scrolls to a free spot (§19.8). Whether this exact spot is free depends on what is above it on the page
      // (the setup list's strip, cards still loading in), so scroll on a little, like the owner would, until it shows,
      // then tap it.
      await launcherSettled(page);
      await expect(async () => {
        if ((await launcher(page).getAttribute("data-dodge")) === "blocked") {
          await page.mouse.wheel(0, 40);
          await launcherSettled(page);
        }
        await launcher(page).click({ timeout: 1500 });
        await expect(panel(page)).toBeVisible({ timeout: 1000 });
      }).toPass({ timeout: 30_000 });
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
      // Its spot (it may be faded out there over a control, a little smaller): the layout box.
      const spot = (el: HTMLElement) => ({ x: el.offsetLeft, y: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight });
      const b = await btn.evaluate(spot);
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
      const plain = await launcher(page).evaluate(spot);
      if (size.phone) {
        const tabs = (await page.locator("nav.tabbar").boundingBox())!;
        expect(plain.y + plain.height).toBeLessThanOrEqual(tabs.y);
      } else {
        // Its home spot is 24 px off the bottom (it may nudge up a little from there, or fade out, over a control).
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
      else await expect.poll(() => spotlitIsReachable(page), { timeout: SPOT_ARRIVE_CAP_MS }).toBe("ok");
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
      await expect(answer).toContainText("Upload");
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
        // Given back once the sheet has gone: wait for that, not for the click to return.
        await expect.poll(() => page.locator(".shell").getAttribute("inert")).toBeNull();
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
      // The fade class lives only for its 300 ms, so on a busy runner a check after the click can miss it. Record
      // every class the plane gets (and any trail) from the click on, then check what happened: it faded, it never
      // flew, and no trail was ever drawn.
      await send.evaluate((el) => {
        const w = window as unknown as { __fly: { classes: string[]; trail: boolean } };
        w.__fly = { classes: [], trail: false };
        new MutationObserver(() => {
          const fly = el.querySelector(".fly");
          if (fly) w.__fly.classes.push(fly.className);
          if (el.querySelector(".fly__trail")) w.__fly.trail = true;
        }).observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
      });
      await send.click();
      const fly = () => page.evaluate(() => (window as unknown as { __fly: { classes: string[]; trail: boolean } }).__fly);
      await expect.poll(async () => (await fly()).classes.join(" ")).toMatch(/is-fading/);
      expect((await fly()).classes.join(" ")).not.toMatch(/is-flying/);
      expect((await fly()).trail).toBe(false);
      await expect(send.locator(".fly__trail")).toHaveCount(0);
      const names = await send.evaluate((el) => el.getAnimations({ subtree: true }).map((a) => (a as CSSAnimation).animationName ?? ""));
      expect(names.every((n) => n === "fly-fade" || n === ""), names.join(", ")).toBe(true);
      await expect(panel(page).locator(".help-msg--bot")).toHaveCount(1);
      // Nothing keeps moving: no entrance, no bouncing dots, no shimmer (1 ms leftovers of a tap settle at once).
      await expect
        .poll(() => page.evaluate(() => document.querySelector(".help-panel")!.getAnimations({ subtree: true }).length), { timeout: 3000 })
        .toBe(0);
    });

    test("the launcher never moves, and changes only once the page is still, however it scrolls", async ({ page }) => {
      await page.goto("/");
      await settle(page);
      await launcherSettled(page);
      expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeGreaterThan(400);
      // Read inside the page, frame by frame: where the launcher is drawn, and when its fade state flips, against
      // when the page last scrolled. A long smooth scroll down, one back up, then small wheel nudges both ways
      // (like a resting thumb, or momentum ending in a bounce).
      const r = await page.evaluate(async () => {
        const el = document.querySelector<HTMLElement>(".help-launcher")!;
        const home = el.getBoundingClientRect();
        let lastScroll = -Infinity;
        let moved = 0;
        let sideways = 0;
        const flips: { since: number; at: number }[] = [];
        let hidden = el.classList.contains("is-hidden");
        const onScroll = () => (lastScroll = performance.now());
        window.addEventListener("scroll", onScroll, { passive: true });
        // A flip is timed when the class changes (the observer runs in the same task), not at the next frame: a
        // scroll event landing in that frame after the change would otherwise look like it came first.
        const watch = new MutationObserver(() => {
          const now = el.classList.contains("is-hidden");
          if (now !== hidden) {
            hidden = now;
            flips.push({ since: performance.now() - lastScroll, at: performance.now() });
          }
        });
        watch.observe(el, { attributes: true, attributeFilter: ["class"] });
        let run = true;
        const tick = () => {
          const b = el.getBoundingClientRect();
          // The fade shrinks it a little around its centre; its centre never moves.
          sideways = Math.max(sideways, Math.abs(b.left + b.width / 2 - (home.left + home.width / 2)));
          moved = Math.max(moved, Math.abs(b.top + b.height / 2 - (home.top + home.height / 2)));
          if (run) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        const until = (cond: () => boolean) =>
          new Promise<void>((res) => {
            const t0 = performance.now();
            const check = () => (cond() || performance.now() - t0 > 4000 ? res() : requestAnimationFrame(check));
            check();
          });
        window.scrollTo({ top: 400, behavior: "smooth" });
        await until(() => Math.abs(window.scrollY - 400) < 1);
        window.scrollTo({ top: 100, behavior: "smooth" });
        await until(() => Math.abs(window.scrollY - 100) < 1);
        for (let i = 0; i < 24; i++) {
          window.scrollBy(0, i % 2 ? -10 : 12);
          await new Promise((res) => setTimeout(res, 40));
        }
        await new Promise((res) => setTimeout(res, 1600));
        run = false;
        watch.disconnect();
        window.removeEventListener("scroll", onScroll);
        return { moved, sideways, flips };
      });
      expect(r.sideways, "the launcher moved sideways").toBeLessThan(1);
      expect(r.moved, "the launcher moved up or down").toBeLessThan(1);
      // Every change began only once the page had been still for the settle time (timer slack), each held a while.
      for (const f of r.flips) expect(f.since).toBeGreaterThanOrEqual(DODGE_SETTLE_MS - 20);
      for (let i = 1; i < r.flips.length; i++) expect(r.flips[i]!.at - r.flips[i - 1]!.at).toBeGreaterThanOrEqual(DODGE_HOLD_MS - 50);
    });

    test("over a small control it fades out where it stands once scrolling settles, and back in when the spot is clear", async ({ page }) => {
      await page.goto("/");
      await settle(page);
      await launcherSettled(page);
      // Its home spot: the layout box.
      const home = await launcher(page).evaluate((el: HTMLElement) => ({ x: el.offsetLeft, y: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight }));
      await page.evaluate((spot) => {
        const b = document.createElement("button");
        b.id = "under-ask";
        b.textContent = "Save";
        // A small button in the page (it scrolls with it), 300 px further down than the spot for now.
        b.style.cssText = `position:absolute;z-index:1;left:${spot.x - 10}px;width:${spot.width + 20}px;height:44px;top:${window.scrollY + spot.y + 6 + 300}px`;
        document.body.appendChild(b);
        // Room to scroll that far on any page.
        document.body.style.minHeight = `${document.documentElement.scrollHeight + 600}px`;
        window.scrollBy({ top: 300, behavior: "instant" });
      }, home);
      await launcherSettled(page);
      await expect(launcher(page)).toHaveClass(/is-hidden/);
      await expect(launcher(page)).toHaveAttribute("data-dodge", "blocked");
      // Faded where it stands: same spot, and a tap there reaches the control.
      const faded = (await launcher(page).boundingBox())!;
      expect(Math.abs(faded.x + faded.width / 2 - (home.x + home.width / 2))).toBeLessThan(1);
      expect(Math.abs(faded.y + faded.height / 2 - (home.y + home.height / 2))).toBeLessThan(1);
      expect(await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.id, [home.x + home.width / 2, home.y + home.height / 2 + 6])).toBe("under-ask");
      // Scrolled on so the spot is clear: it fades back in at the same spot.
      await page.evaluate(() => document.getElementById("under-ask")!.remove());
      await page.evaluate(() => window.scrollBy({ top: -300, behavior: "instant" }));
      await launcherSettled(page);
      await expect(launcher(page)).not.toHaveClass(/is-hidden/);
      expect(await coveredControls(page)).toEqual([]);
    });

    test("after its panel closes from a tap it still keeps clear of a control under its spot", async ({ page }) => {
      await open(page);
      await panel(page).getByRole("button", { name: /close/i }).first().click();
      await expect(panel(page)).toHaveCount(0);
      const home = await launcher(page).evaluate((el: HTMLElement) => ({ x: el.offsetLeft, y: el.offsetTop, width: el.offsetWidth }));
      await page.evaluate((spot) => {
        const b = document.createElement("button");
        b.id = "under-ask";
        b.textContent = "Save";
        b.style.cssText = `position:absolute;z-index:1;left:${spot.x - 10}px;width:${spot.width + 20}px;height:44px;top:${window.scrollY + spot.y + 6 + 200}px`;
        document.body.appendChild(b);
        document.body.style.minHeight = `${document.documentElement.scrollHeight + 600}px`;
        window.scrollBy({ top: 200, behavior: "instant" });
      }, home);
      await launcherSettled(page);
      await expect(launcher(page)).toHaveClass(/is-hidden/);
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

// The launcher never rests on a real control once the page settles, at any width, at the top of each page and after
// scrolling through it (it nudges up a little or fades out in place), with the update bar too, and with other fonts.
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
      // It walks every route; at wide sizes a GPU-less runner draws the see-through glass slowly (1.3 min on CI).
      test.setTimeout(300_000);
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

// The launcher has one home spot (§19.8): at every scroll position of every page it is at that spot, shown or faded
// out there; never nudged, slid sideways, sent to the middle or hidden by a scroll.
for (const size of [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 1024, height: 768 },
]) {
  test.describe(`Ask Clip Factory launcher home spot at ${size.width} px`, () => {
    test.use({ viewport: size });
    test("is always at its home spot", async ({ page }) => {
      const fails: string[] = [];
      for (const route of ["/", "/settings/posting/setup/instagram", "/settings/look-and-feel/sounds", "/get-app"]) {
        await page.goto(route);
        await settle(page);
        const max = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
        for (const y of [0, Math.round(max / 2), max]) {
          await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), y);
          await launcherSettled(page);
          const s = await page.evaluate(() => {
            const el = document.querySelector<HTMLElement>(".help-launcher")!;
            const b = el.getBoundingClientRect();
            return {
              translate: getComputedStyle(el).translate,
              up: Math.round(el.offsetTop + el.offsetHeight / 2 - (b.top + b.height / 2)),
              side: Math.round(el.offsetLeft + el.offsetWidth / 2 - (b.left + b.width / 2)),
            };
          });
          if (s.translate !== "none") fails.push(`${route} at ${y}: moved (${s.translate})`);
          if (s.up !== 0) fails.push(`${route} at ${y}: ${s.up} px up from home`);
          if (s.side !== 0) fails.push(`${route} at ${y}: ${s.side} px sideways`);
        }
      }
      expect(fails, fails.join("\n")).toEqual([]);
    });
  });
}

/**
 * What is under the launcher's resting spot right now: its box, and the controls in its column (what shows of each,
 * counted like dodge.ts `controlBoxes`: a marked block by its parts, a control holding controls through them).
 */
async function underLauncher(page: Page): Promise<{ base: Box; controls: Box[] }> {
  return page.evaluate((selector) => {
    const el = document.querySelector<HTMLElement>(".help-launcher")!;
    const base = { top: el.offsetTop, bottom: el.offsetTop + el.offsetHeight, left: el.offsetLeft, right: el.offsetLeft + el.offsetWidth };
    const chrome = ".help-launcher, .help-panel, .help-ring, .update-bar, .tabbar, .sidebar, .setup-todo-bar, .setup-todo-scrim";
    const out: Box[] = [];
    const seen = new Set<Element>();
    const add = (c: Element) => {
      if (seen.has(c) || c.closest(chrome) || c.closest("[inert], [hidden]")) return;
      seen.add(c);
      const s = getComputedStyle(c);
      if (s.visibility === "hidden" || s.pointerEvents === "none") return;
      const r = c.getBoundingClientRect();
      const box = { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      for (let a = c.parentElement; a && a !== document.body; a = a.parentElement) {
        const cs = getComputedStyle(a);
        const ar = a.getBoundingClientRect();
        if (cs.overflowX !== "visible") [box.left, box.right] = [Math.max(box.left, ar.left), Math.min(box.right, ar.right)];
        if (cs.overflowY !== "visible") [box.top, box.bottom] = [Math.max(box.top, ar.top), Math.min(box.bottom, ar.bottom)];
        if (cs.position === "fixed") break;
      }
      if (box.right - box.left >= 1 && box.bottom - box.top >= 1 && box.right > base.left && box.left < base.right) out.push(box);
    };
    for (const block of document.querySelectorAll("[data-help-dodge]")) {
      if (block.matches(selector) || !block.children.length) add(block);
      else for (const part of block.children) add(part);
    }
    for (const c of document.querySelectorAll(selector)) if (!c.querySelector(selector)) add(c);
    return { base, controls: out };
  }, CONTROLS);
}

// The launcher is there when the owner wants it (§19.8): shown and tappable at the top of the main pages on a phone,
// and faded out at no more than a fifth of the places a page can be scrolled to and left. The Library is the one
// exception: its cards and their post rows end in 48 px open buttons right in the launcher's column, and covering one
// would make it hard to tap. How often that is depends on the cards (and a font's line height), so there it is held
// to the rule itself, at every place: faded out only where it would make a control hard to tap, shown everywhere else.
test.describe("Ask Clip Factory launcher is mostly there on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  for (const route of ["/", "/jobs", "/settings", "/settings/look-and-feel", "/settings/look-and-feel/sounds", "/library", "/review"]) {
    test(`on ${route}`, async ({ page }) => {
      // The mock's clips and posts are dated from now, so from 22:00 to about 04:00 their labels ("4 days ago") make the
      // Library 15 px longer and the launcher fades at one spot more (14 of 39 against 13 allowed). Noon keeps the page
      // the same at any hour; the clock still runs, so the fades keep their real timing.
      const noon = new Date();
      noon.setHours(12, 0, 0, 0);
      await page.clock.install({ time: noon });
      await page.clock.resume();
      await page.goto(route);
      await settle(page);
      await launcherSettled(page);
      if (["/", "/jobs", "/settings", "/settings/look-and-feel"].includes(route)) {
        await expect(launcher(page)).not.toHaveClass(/is-hidden/);
        await launcher(page).click();
        await expect(panel(page)).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(panel(page)).toHaveCount(0);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      }
      const max = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
      let hidden = 0;
      let spots = 0;
      const wrong: string[] = [];
      for (let y = 0; y <= max; y += 150) {
        await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), y);
        await launcherSettled(page);
        spots++;
        const out = await launcher(page).evaluate((el) => el.classList.contains("is-hidden"));
        if (out) hidden++;
        if (route === "/library") {
          const { base, controls } = await underLauncher(page);
          const must = blocks(base, controls);
          if (out !== must) wrong.push(`at ${y}: ${out ? "faded out with nothing hard to tap under it" : "shown over a control it makes hard to tap"}`);
        }
      }
      if (route === "/library") expect(wrong, `faded out at ${hidden} of ${spots} spots\n${wrong.join("\n")}`).toEqual([]);
      else expect(hidden, `faded out at ${hidden} of ${spots} spots`).toBeLessThanOrEqual(Math.max(1, Math.floor(spots * 0.2)));
    });
  }

  test("does not blink while the owner scrolls in short steps at reading pace", async ({ page }) => {
    await page.goto("/settings/look-and-feel/sounds");
    await settle(page);
    await launcherSettled(page);
    const flips = await page.evaluate(async () => {
      const el = document.querySelector<HTMLElement>(".help-launcher")!;
      let hidden = el.classList.contains("is-hidden");
      const at: number[] = [];
      let run = true;
      const tick = () => {
        const now = el.classList.contains("is-hidden");
        if (now !== hidden) {
          hidden = now;
          at.push(performance.now());
        }
        if (run) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      const max = document.documentElement.scrollHeight - innerHeight;
      for (let y = 0; y <= max; y += 140) {
        window.scrollTo({ top: y, behavior: "instant" });
        await new Promise((res) => setTimeout(res, 300));
      }
      for (let y = max; y >= 0; y -= 140) {
        window.scrollTo({ top: y, behavior: "instant" });
        await new Promise((res) => setTimeout(res, 300));
      }
      await new Promise((res) => setTimeout(res, 1500));
      run = false;
      return at;
    });
    // Never a fade in and out (or out and in) within a second.
    for (let i = 1; i < flips.length; i++) expect(flips[i]! - flips[i - 1]!).toBeGreaterThanOrEqual(DODGE_HOLD_MS - 50);
  });
});
