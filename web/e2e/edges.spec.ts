import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openTodo, CLIPS, openClip, resolveRoute, ROUTES, settle } from "./helpers.ts";
import { decode, rowMeans } from "./pixels.ts";
import { WINDOW_EXTRA_ROUTES } from "./glass.ts";
import { visibleEdges } from "./edges.ts";

// No visible edges anywhere (owner, 2026-11-18; docs/DECISIONS.md ADR-45): no element on any screen draws a border,
// an outline, a ring or a hard line (a box-shadow layer with almost no blur), and no pseudo-element draws one for it.
// A pane shows by its blur, tint and shadow; a control by its fill. The only lines left are the allowed ones:
//   - the keyboard focus ring while :focus-visible (nothing is focused by keyboard here);
//   - the temporary "found" highlight (search) and Ask's spotlight ring, which trace a box on purpose;
//   - progress bars and rings, the switch track, spinners and the running step's pulse;
//   - the short action blinks (motion.css .act__item) and text underlines (text decoration, not a box edge).
// Run at a phone (390 × 844) and a desktop (1440 × 900) size, on every route plus a clip page, the Ask panel open and
// the setup list open. test/background.test.ts holds the stylesheets to the same rule without a browser.

const SIZES = [
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

test.use({ reducedMotion: "reduce" });

for (const size of SIZES) {
  test(`no visible edges on any screen, ${size.name} (${size.width}×${size.height})`, async ({ page }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: size.width, height: size.height });
    const paths: string[] = [];
    for (const r of ROUTES) paths.push(await resolveRoute(page, r));
    paths.push(...WINDOW_EXTRA_ROUTES);
    const failures: string[] = [];
    for (const path of paths) {
      await page.goto(path);
      if (!path.endsWith(".html")) await settle(page);
      for (const e of await visibleEdges(page)) failures.push(`${path}: ${e}`);
    }
    // A clip's page (opened from the Library), the Ask panel open, the setup list open.
    await openClip(page, CLIPS.all);
    for (const e of await visibleEdges(page)) failures.push(`a clip page: ${e}`);
    await page.goto("/");
    await settle(page);
    await page.getByRole("button", { name: "Ask Clip Factory" }).click();
    await page.locator(".help-panel").waitFor();
    await page.waitForTimeout(400);
    for (const e of await visibleEdges(page)) failures.push(`/ with Ask open: ${e}`);
    await page.goto("/library");
    await settle(page);
    await openTodo(page);
    await page.waitForTimeout(400);
    for (const e of await visibleEdges(page)) failures.push(`/library with the setup list open: ${e}`);
    expect(failures).toEqual([]);
  });
}

test("the scan does find an edge when one is drawn (so the checks above can fail)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings");
  await settle(page);
  expect(await visibleEdges(page)).toEqual([]);
  await page.addStyleTag({ content: ".glass { border-color: rgb(239 231 218 / 0.22) !important; } .glass { box-shadow: inset 0 1px 0 #efe7da !important; }" });
  const found = await visibleEdges(page);
  expect(found.some((f) => f.includes("border-top"))).toBe(true);
  expect(found.some((f) => f.includes("box-shadow"))).toBe(true);
});

// A band of glass can draw an edge with no border at all: where its blur and tint stop. The setup bar the page scrolls
// under must melt into the page, so across its bottom the change it makes to the picture ramps, never jumps between
// two pixel rows. Measured as the difference between the screen with the bar and without it (the page under it the
// same: a flat white page under the bar), row by row.
for (const path of ["/", "/review", "/settings"]) {
  test(`the scrolled setup bar has no hard bottom edge on a phone (${path})`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(path);
    await settle(page);
    await page.mouse.wheel(0, 400);
    await expect(page.locator(".setup-todo-bar")).toHaveClass(/is-scrolled/);
    await page.waitForTimeout(500);
    // A flat white page under the bar (the worst case, a white thumbnail), so the page's own words and cards cannot
    // make a step and the bar's tint shows at its strongest.
    await page.evaluate(() => {
      const d = document.createElement("div");
      Object.assign(d.style, { position: "fixed", inset: "0", zIndex: "1", background: "#fff" });
      document.body.append(d);
    });
    await page.waitForTimeout(300);
    const bar = (await page.locator(".setup-todo-bar").boundingBox())!;
    // Left of the pill: the pill is a pane of its own, so where it ends is its edge, not the bar's.
    const pill = (await page.locator(".setup-todo").boundingBox())!;
    const clip = { x: 0, y: Math.max(0, bar.y + bar.height - 30), width: Math.max(60, Math.floor(pill.x) - 24), height: 90 };
    const withBar = rowMeans(await decode(page, await page.screenshot({ clip })));
    await page.addStyleTag({ content: ".setup-todo-bar, .setup-todo-bar * { visibility: hidden !important; }" });
    await page.waitForTimeout(300);
    const without = rowMeans(await decode(page, await page.screenshot({ clip })));
    const effect = withBar.map((v, i) => v - without[i]!);
    let jump = 0;
    for (let i = 1; i < effect.length; i++) jump = Math.max(jump, Math.abs(effect[i]! - effect[i - 1]!));
    expect(jump, `largest step between two rows of the bar's effect: ${jump.toFixed(2)} (${effect.map((v) => v.toFixed(1)).join(" ")})`).toBeLessThan(6);
  });
}

// With no rings, a button has to show it is a button some other way: a fill of its own, an underline or an icon.
// (Buttons inside a pick-one group are the group's options: the track and the <Glide> pill show them.)
test("every button reads as one without a ring: a fill, an underline or an icon, phone size", async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const bare = async (where: string) =>
    (
      await page.evaluate(() => {
        const out: string[] = [];
        for (const el of Array.from(document.querySelectorAll<HTMLElement>("button, [role='button'], a.btn"))) {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height || (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))) continue;
          if (el.closest(".glide, [role='radiogroup'], [role='tablist'], .sr-only, .skip-link, svg")) continue;
          const s = getComputedStyle(el);
          const filled = (x: Element) => {
            const cs = getComputedStyle(x);
            const m = /rgba?\(([^)]*)\)/.exec(cs.backgroundColor);
            const a = m ? (m[1]!.split(/[\s,/]+/).filter(Boolean)[3] ?? "1") : "0";
            return Number(a) > 0.02 || cs.backgroundImage !== "none";
          };
          if (filled(el) || ["::before", "::after"].some((p) => getComputedStyle(el, p).content !== "none" && getComputedStyle(el, p).backgroundImage !== "none")) continue;
          if (s.textDecorationLine.includes("underline") || el.querySelector("svg, img, .icon")) continue;
          if (Array.from(el.querySelectorAll("*")).some((c) => getComputedStyle(c).textDecorationLine.includes("underline") || filled(c))) continue;
          out.push(`${el.tagName.toLowerCase()}.${String(el.className).trim().split(/\s+/).slice(0, 2).join(".")} "${(el.textContent ?? "").trim().slice(0, 40)}"`);
        }
        return out;
      })
    ).map((b) => `${where}: ${b}`);
  const failures: string[] = [];
  for (const r of ROUTES) {
    const path = await resolveRoute(page, r);
    await page.goto(path);
    await settle(page);
    failures.push(...(await bare(path)));
  }
  await page.goto("/");
  await settle(page);
  await page.getByRole("button", { name: "Ask Clip Factory" }).click();
  await page.locator(".help-panel").waitFor();
  await page.waitForTimeout(400);
  failures.push(...(await bare("/ with Ask open")));
  expect([...new Set(failures)]).toEqual([]);
});

// Opening Ask by a tap or a click puts the caret in its box: that is no keyboard focus, so no ring (a deeper well and a
// soft glow show it is in use). After Tab the ring is back.
test("the Ask box wears no ring when Ask is opened by a click, and the ring after Tab", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await settle(page);
  await page.getByRole("button", { name: "Ask Clip Factory" }).click();
  const box = page.locator(".help-panel__input");
  await expect(box).toBeFocused();
  const ring = () =>
    box.evaluate((el) => {
      const s = getComputedStyle(el);
      const border = parseFloat(s.borderTopWidth) > 0 && !/rgba\([^)]*,\s*0\)|transparent/.test(s.borderTopColor);
      const solid = s.boxShadow.split(/,(?![^(]*\))/).some((l) => /0px 0px 0px [1-9]/.test(l.trim()));
      return border || solid;
    });
  expect(await ring()).toBe(false);
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(box).toBeFocused();
  expect(await ring()).toBe(true);
});

// Ask as a full assistant (§27, review C14): the file tray and its tiles, an answer with its sources list, the
// markup editor and the search key card draw no edges either, at a phone and a desktop size.
const ASK_PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Page >> endobj\ntrailer << >>\n%%EOF\n").toString("base64");
for (const size of SIZES) {
  test(`no visible edges in Ask's tray, file tiles, sources, markup editor and search key card, ${size.name}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto("/");
    await settle(page);
    await page.getByRole("button", { name: "Ask Clip Factory" }).click();
    const panel = page.locator("#help-panel");
    await panel.waitFor();
    const png = readFileSync(join(import.meta.dirname, "fixtures", "shot.png")).toString("base64");
    await page.evaluate(
      ({ pdf, img }) => {
        const dt = new DataTransfer();
        const file = (b64: string, name: string, type: string) => {
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return new File([bytes], name, { type });
        };
        dt.items.add(file(pdf, "report.pdf", "application/pdf"));
        dt.items.add(file(img, "shot.png", "image/png"));
        const e = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
        if (!e.dataTransfer) Object.defineProperty(e, "dataTransfer", { value: dt });
        document.querySelector(".help-panel__log")!.dispatchEvent(e);
      },
      { pdf: ASK_PDF, img: png },
    );
    await expect(panel.locator(".help-pic__img")).toHaveCount(1, { timeout: 15_000 });
    await page.waitForTimeout(400);
    const failures: string[] = [];
    for (const e of await visibleEdges(page)) failures.push(`Ask tray: ${e}`);
    await panel.getByRole("button", { name: /Mark picture 1/ }).click();
    await page.locator(".mk__canvas").waitFor();
    await page.waitForTimeout(300);
    for (const e of await visibleEdges(page)) failures.push(`markup editor: ${e}`);
    await page.getByRole("button", { name: "Cancel" }).click();
    // A fresh chat for an answer with web sources.
    await page.goto("/");
    await settle(page);
    await page.getByRole("button", { name: "Ask Clip Factory" }).click();
    await panel.waitFor();
    await panel.getByLabel("Your question").fill("I made the Meta app, what now? #search");
    await panel.getByRole("button", { name: "Send" }).click();
    await expect(panel.locator(".ask-msg").last().getByRole("button", { name: "Copy answer" })).toBeVisible({ timeout: 20_000 });
    await expect(panel.locator(".ask-source__link").first()).toBeVisible();
    for (const e of await visibleEdges(page)) failures.push(`an answer with sources: ${e}`);
    await page.goto("/settings/app/ask");
    await settle(page);
    await page.getByRole("button", { name: "Take key away" }).click();
    await page.getByRole("link", { name: "Get a search key" }).waitFor();
    for (const e of await visibleEdges(page)) failures.push(`search key card: ${e}`);
    expect(failures).toEqual([]);
  });
}
