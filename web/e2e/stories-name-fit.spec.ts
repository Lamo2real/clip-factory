import { expect, test, type Page } from "@playwright/test";

// The app's final visible name, "Funded Clips" (the owner, 23 Nov), fits the redesign: its wordmark (the C mark and
// "Funded Clips" on one line), the rail, the phone top bar, the shell's fixed switch ("Clip Factory | Funded Clips") and
// the Live chip keep their words in their boxes on Dashboard, Setup, Production and Settings at 1440 x 900, 375 x 812
// and 320 x 640: nothing scrolls sideways, every text box stays inside its parent, the wordmark stays one line, nothing
// covers it, and the switch keeps exactly the box it had. The words are also swapped in here (page.evaluate), so the
// test holds on the redesign alone; with the rename merged they are already Funded Clips. Stories is on with
// cf.storiesPreview = 1.

const PAGES = ["/stories", "/stories/setup", "/stories/production", "/stories/settings"];
const SIZES = [
  [1440, 900],
  [375, 812],
  [320, 640],
] as const;
const NAME = "Funded Clips";

async function open(page: Page, path: string, [width, height]: readonly [number, number]) {
  await page.setViewportSize({ width, height });
  await page.goto(path);
  await page.locator(".stories-app[data-ws]").waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => !document.querySelector(".st-loading, .boot"), undefined, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
}

type Box = { x: number; y: number; w: number; h: number };

/** The shell's switch on screen: the pick bar in the dock on a computer, the round toggle in the phone top bar. */
async function switchBox(page: Page): Promise<Box | null> {
  return page.evaluate(() => {
    const shown = (e: Element | null) => (e && e.getBoundingClientRect().width > 0 ? e : null);
    const el = shown(document.querySelector(".ws-switch-host--dock .ws-switch")) ?? shown(document.querySelector(".ws-round--phone"));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x * 10) / 10, y: Math.round(r.y * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
  });
}

/** The wordmark's words: the innermost element that holds them (the rename's .ws-wordmark__main, inside its
 *  .ws-wordmark.st-brand__name grid; else this branch's .st-brand__name). Its own box is never counted as a line. */
const WORDS = ".st-brand__name:not(:has(.ws-wordmark__main)), .ws-wordmark__main";

/** Swap the visible name for the new one in the wordmark's words (WORDS, so the rename's one grid item is never
 *  replaced) and in the switch's Stories option. Test only: the source keeps its words (with the rename in, the same). */
async function swapName(page: Page) {
  await page.evaluate(([name, words]) => {
    const [first, second] = name.split(" ");
    for (const el of Array.from(document.querySelectorAll(words))) el.innerHTML = `${first} <em>${second}</em>`;
    for (const opt of Array.from(document.querySelectorAll(".ws-switch__opt"))) if (!/^Clip Factory$/.test(opt.textContent?.trim() ?? "")) opt.textContent = name;
    for (const el of Array.from(document.querySelectorAll(".st-brand[aria-label], .ws-round--phone[aria-label]"))) el.setAttribute("aria-label", el.getAttribute("aria-label")!.replace(/Lamo Stories|Clip Factory Stories|Clip Stories/, name));
  }, [NAME, WORDS] as const);
  await page.waitForTimeout(400);
}

/** Every problem with the new name on this page: what, and the measured numbers. */
async function problems(page: Page): Promise<{ list: string[]; found: string[] }> {
  return page.evaluate((words) => {
    const list: string[] = [];
    const found: string[] = [];
    const shown = (e: Element) => {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
    };
    const n = (v: number) => Math.round(v * 10) / 10;
    const check = (what: string, sel: string) => {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel)).filter(shown)) {
        found.push(what);
        if (el.scrollWidth > el.clientWidth + 1) list.push(`${what}: scrolls sideways (scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth})`);
        const r = el.getBoundingClientRect();
        if (r.left < -0.5 || r.right > innerWidth + 0.5) list.push(`${what}: off the window (${n(r.left)}..${n(r.right)} of ${innerWidth})`);
        const parent = el.parentElement;
        if (parent) {
          const p = parent.getBoundingClientRect();
          if (r.left < p.left - 0.5 || r.right > p.right + 0.5 || r.top < p.top - 0.5 || r.bottom > p.bottom + 0.5)
            list.push(`${what}: outside its parent (${n(r.left)},${n(r.top)} ${n(r.width)}x${n(r.height)} in ${n(p.left)},${n(p.top)} ${n(p.width)}x${n(p.height)})`);
        }
      }
    };
    // The wordmark's words: one line, inside the brand, nothing over them.
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(words)).filter(shown)) {
      found.push("wordmark");
      const range = document.createRange();
      range.selectNodeContents(el);
      const tops = new Set(Array.from(range.getClientRects()).filter((q) => q.width > 0).map((q) => Math.round(q.top)));
      if (tops.size > 1) list.push(`wordmark: ${tops.size} lines (tops ${[...tops].join(", ")})`);
      if (el.scrollWidth > el.clientWidth + 1) list.push(`wordmark: scrolls sideways (scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth})`);
      const r = range.getBoundingClientRect();
      const brand = el.closest(".st-brand, .ws-wordmark")?.getBoundingClientRect();
      if (brand && (r.left < brand.left - 0.5 || r.right > brand.right + 0.5)) list.push(`wordmark: its text ${n(r.left)}..${n(r.right)} leaves the brand ${n(brand.left)}..${n(brand.right)}`);
      const box = (el.closest(".st-rail, .st-top") ?? document.body).getBoundingClientRect();
      if (r.left < box.left - 0.5 || r.right > box.right + 0.5) list.push(`wordmark: its text ${n(r.left)}..${n(r.right)} leaves its bar ${n(box.left)}..${n(box.right)}`);
      // Covered: the topmost element at points along its text must be the text itself (or inside the brand).
      for (const f of [0.08, 0.5, 0.92]) {
        const x = r.left + r.width * f;
        const y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        if (hit && !el.closest(".st-brand, .ws-wordmark")!.contains(hit)) list.push(`wordmark: covered at ${n(x)},${n(y)} by ${hit.tagName}.${String(hit.className).slice(0, 40)}`);
      }
    }
    check("rail", ".st-rail");
    check("top bar", ".st-top");
    check("switch", ".ws-switch-host--dock .ws-switch");
    check("switch option", ".ws-switch-host--dock .ws-switch__opt");
    check("phone switch", ".ws-round--phone");
    check("Live chip", ".ws-dock__live .live-dot, .st-top .live-dot");
    // The switch's words: each option holds its whole name on one line.
    for (const opt of Array.from(document.querySelectorAll<HTMLElement>(".ws-switch-host--dock .ws-switch__opt")).filter(shown)) {
      const range = document.createRange();
      range.selectNodeContents(opt);
      const t = range.getBoundingClientRect();
      const o = opt.getBoundingClientRect();
      const tops = new Set(Array.from(range.getClientRects()).filter((q) => q.width > 0).map((q) => Math.round(q.top)));
      if (tops.size > 1) list.push(`switch "${opt.textContent}": ${tops.size} lines`);
      if (t.left < o.left - 0.5 || t.right > o.right + 0.5) list.push(`switch "${opt.textContent}": text ${n(t.width)} px wide in a ${n(o.width)} px option`);
    }
    // On a phone the top bar's brand and its switch and Live chip never overlap.
    const brand = Array.from(document.querySelectorAll(".st-top .st-brand")).find(shown)?.getBoundingClientRect();
    for (const sel of [".st-top .ws-round--phone", ".st-top .live-dot"]) {
      const other = Array.from(document.querySelectorAll(sel)).find(shown)?.getBoundingClientRect();
      if (brand && other && brand.right > other.left + 0.5 && brand.left < other.right - 0.5 && brand.bottom > other.top && brand.top < other.bottom)
        list.push(`top bar: the brand (${n(brand.left)}..${n(brand.right)}) overlaps ${sel} (${n(other.left)}..${n(other.right)})`);
    }
    return { list, found };
  }, WORDS);
}

test.describe(`the name "${NAME}" fits`, () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("cf.storiesPreview", "1");
      localStorage.setItem("cf.stories.prefs", JSON.stringify({ setupShown: ["e2e"], more: {} }));
    });
  });

  for (const size of SIZES)
    test(`the wordmark, the rail, the top bar, the switch and the Live chip at ${size[0]} x ${size[1]}`, async ({ page }) => {
      const all: string[] = [];
      for (const path of PAGES) {
        await open(page, path, size);
        const before = await switchBox(page);
        expect(before, `${path}: the switch is on screen`).not.toBeNull();
        await swapName(page);
        const after = await switchBox(page);
        if (JSON.stringify(after) !== JSON.stringify(before)) all.push(`${path}: the switch moved or changed size (${JSON.stringify(before)} → ${JSON.stringify(after)})`);
        const { list, found } = await problems(page);
        all.push(...list.map((p) => `${path}: ${p}`));
        // The parts this size shows are really there (a computer: the rail and the dock; a phone: the top bar).
        const want = size[0] >= 1024 ? ["wordmark", "rail", "switch", "switch option", "Live chip"] : ["wordmark", "top bar", "phone switch", "Live chip"];
        if (path !== "/stories/setup") for (const w of want) expect(found, `${path} at ${size[0]}: ${w}`).toContain(w);
        if (path === "/stories") {
          const names = await page.locator(WORDS).evaluateAll((els) => els.map((e) => e.textContent?.replace(/\s+/g, " ").trim()));
          expect(names.every((t) => t === NAME), names.join(" | ")).toBe(true);
        }
      }
      expect(all, all.join("\n")).toEqual([]);
    });
});
