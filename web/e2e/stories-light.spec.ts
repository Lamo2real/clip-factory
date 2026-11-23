import { expect, test, type Page } from "@playwright/test";
import { asMacWindow } from "./desktopWindow.ts";

// The logic of light in Clip Factory Stories (the owner, 22 Nov: "the top layer is always brighter than the bottom,
// growing gradually in between"; styles/GLASS-CONTRACT.md, Elevation): on real pages, one surface per level is
// read from the page as the browser computed it (every background layer, top and bottom) and laid over the same
// backdrop pixel (the espresso, the stage's own colour, and black): each level is brighter than the one under it,
// at its top and at its bottom; every surface is lighter at the top than at the bottom; and every surface has a bright
// top rim, brighter on higher levels. A card inside a card is laid over its card, as the browser paints it. Over a
// picture or the desktop also over white and mid grey: from the page panel
// upward each level at least 0.015 brighter over white (the owner's rule). In every look: Colours › Ember, a picture,
// See-through Clear and Frosted in the desktop app, and solid glass (reduced transparency). test/storiesLight.test.ts
// proves the same from the style
// sheets alone, without a browser.

type Rgb = [number, number, number];
type Layer = { top: [number, number, number, number]; bottom: [number, number, number, number] };
type Surface = { level: number; what: string; layers: Layer[]; parent: Layer[] | null; rim: number | null };

const ESPRESSO: Rgb = [28, 19, 14];
const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];
const GREY: Rgb = [128, 128, 128];

const LOOKS: { name: string; more: Record<string, string>; picture?: boolean; desktop?: boolean }[] = [
  { name: "Colours › Ember", more: {} },
  { name: "a picture", more: { "look.mode": "picture" }, picture: true },
  { name: "See-through, Clear", more: { "look.mode": "see-through", "look.strength": "clear" }, desktop: true },
  { name: "See-through, Frosted", more: { "look.mode": "see-through", "look.strength": "frosted" }, desktop: true },
  { name: "solid glass (reduced transparency)", more: { "look.glass": "solid" } },
];

async function open(page: Page, path: string, look: (typeof LOOKS)[number], width: number) {
  await page.setViewportSize({ width, height: width < 768 ? 812 : 900 });
  await page.goto(path);
  await page.locator(".stories-app[data-ws]").waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => !document.querySelector(".st-loading, .boot"), undefined, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  if (look.desktop) expect(await page.locator(".stories-app").getAttribute("data-look")).toBe("window");
  if (look.picture) expect(await page.locator(".stories-app").getAttribute("data-look")).toBe("picture");
}

/** One surface per level on this page, as the browser computed it. */
async function surfaces(page: Page): Promise<Surface[]> {
  return page.evaluate(() => {
    const COLOUR = /rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\s*\)/g;
    const shown = (e: Element) => {
      const r = e.getBoundingClientRect();
      return r.width > 8 && r.height > 8 && r.bottom > 0 && r.top < innerHeight && getComputedStyle(e).visibility !== "hidden";
    };
    // The layers of a background, the bottom one last: a colour, or a linear gradient's first (top) and last stop.
    const layersOf = (el: Element) => {
      const cs = getComputedStyle(el);
      const out: { top: number[]; bottom: number[] }[] = [];
      const parts: string[] = [];
      let depth = 0;
      let cur = "";
      for (const ch of cs.backgroundImage) {
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        if (ch === "," && depth === 0) {
          parts.push(cur.trim());
          cur = "";
        } else cur += ch;
      }
      if (cur.trim()) parts.push(cur.trim());
      for (const p of parts) {
        if (!p.startsWith("linear-gradient(")) continue;
        const cols = [...p.matchAll(COLOUR)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])]);
        if (cols.length) out.push({ top: cols[0]!, bottom: cols[cols.length - 1]! });
      }
      const bg = [...cs.backgroundColor.matchAll(COLOUR)][0];
      if (bg) {
        const c = [Number(bg[1]), Number(bg[2]), Number(bg[3]), bg[4] === undefined ? 1 : Number(bg[4])];
        out.push({ top: c, bottom: c });
      }
      return out;
    };
    // The bright top rim: a light inset shadow straight down, thin (x 0, y 1-4 px, blur at most 4 px, spread ≤ 0), its
    // alpha.
    const rimOf = (el: Element) => {
      const sh = getComputedStyle(el).boxShadow;
      for (const m of sh.matchAll(/rgba?\(([^)]*)\)\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px(?:\s+(-?[\d.]+)px)?\s+inset/g)) {
        const [r, g, b, a = "1"] = m[1]!.split(",").map((s) => s.trim());
        const [x, y, blur, spread = "0"] = [m[2], m[3], m[4], m[5]].map((v) => v ?? "0");
        if (Number(x) === 0 && Number(y) > 0 && Number(y) <= 4 && Number(blur) <= 4 && Number(spread) <= 0 && Number(r) > 200 && Number(g) > 200 && Number(b) > 200) return Number(a);
      }
      return null;
    };
    const pick = (sel: string) => Array.from(document.querySelectorAll(sel)).find(shown) ?? null;
    const out: { level: number; what: string; layers: unknown; parent: unknown; rim: number | null }[] = [];
    const add = (level: number, what: string, sel: string, parentSel?: string) => {
      const el = pick(sel);
      if (!el) return;
      const parent = parentSel ? el.closest(parentSel) : null;
      out.push({ level, what, layers: layersOf(el), parent: parent ? layersOf(parent) : null, rim: rimOf(el) });
    };
    const PLAIN = ":not(.st-glass--hero):not(.st-glass--bar):not(.st-glass--float):not(.st-glass--control):not(.st-glass--tinted):not(.st-rail):not(.st-empty)";
    add(1, "the rail", ".st-rail");
    if (document.querySelector('.stories-app:is([data-look="window"], [data-look="picture"])')) add(1, "a plate", ".st-plate");
    add(2, "a card", `.st-glass${PLAIN}`);
    add(3, "a hero", ".st-glass--hero:not(.st-glass--float):not(.is-liquid)");
    add(3, "the tab bar", ".st-tabbar");
    add(3, "a tinted tile", ".st-glass--tinted:not(.is-liquid)");
    add(
      4,
      "a control on a card",
      `.st-glass${PLAIN} :is(.st-btn:not(.st-btn--main):not(.st-btn--quiet):not(.st-btn--coral):not(.st-btn--cream), .st-pill:not(.is-on), .st-round-btn:not(.st-round-btn--cream):not(.st-round-btn--accent):not(.is-on), .st-glass--control)`,
      `.st-glass${PLAIN}`,
    );
    add(5, "a sheet", ".st-glass--float");
    // A card inside a card (glass.css .st-glass .st-glass, one level up): no screen draws one yet, so one is put inside
    // a plain card of the page for the measure (as a screen would nest it), read with its card as its parent (it is
    // painted over its card, never over the bare backdrop), and taken away again.
    const card = Array.from(document.querySelectorAll(`.st-glass${PLAIN}`)).find((e) => shown(e) && !e.parentElement?.closest(".st-glass"));
    if (card) {
      const nested = document.createElement("div");
      nested.className = "st-glass";
      nested.style.cssText = "height: 48px; margin: 8px";
      card.append(nested);
      out.push({ level: 3, what: "a card inside a card", layers: layersOf(nested), parent: layersOf(card), rim: rimOf(nested) });
      nested.remove();
    }
    return out as Surface[];
  });
}

const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
/** The layers (the bottom one last) over `under`, at the top or the bottom of the surface. */
function over(layers: Layer[], under: Rgb, at: "top" | "bottom"): Rgb {
  let c: Rgb = [...under];
  for (const l of [...layers].reverse()) {
    const [r, g, b, a] = l[at];
    c = [r * a + c[0] * (1 - a), g * a + c[1] * (1 - a), b * a + c[2] * (1 - a)];
  }
  return c;
}
/** What this surface shows over `under`: a control over the card it sits on. */
const seen = (s: Surface, under: Rgb, at: "top" | "bottom") => over(s.layers, s.parent ? over(s.parent, under, at) : under, at);

test.describe("the logic of light: each level is brighter than the one under it", () => {
  for (const look of LOOKS)
    test(look.name, async ({ page }) => {
      if (look.desktop) await asMacWindow(page);
      await page.addInitScript(
        ({ more, picture }) => {
          localStorage.setItem("cf.storiesPreview", "1");
          localStorage.setItem("cf.stories.prefs", JSON.stringify({ setupShown: ["e2e"], more }));
          if (picture) {
            const c = document.createElement("canvas");
            c.width = 64;
            c.height = 40;
            const x = c.getContext("2d")!;
            const g = x.createLinearGradient(0, 0, 64, 40);
            g.addColorStop(0, "#f4d9b0");
            g.addColorStop(0.5, "#5a7fa8");
            g.addColorStop(1, "#ffffff");
            x.fillStyle = g;
            x.fillRect(0, 0, 64, 40);
            localStorage.setItem("cf.stories.picture", c.toDataURL("image/png"));
          }
        },
        { more: look.more, picture: !!look.picture },
      );
      const found: Surface[] = [];
      for (const [path, width] of [
        ["/stories", 1440],
        ["/stories/settings", 1440],
        ["/stories/library", 1440],
        ["/stories", 375],
      ] as const) {
        await open(page, path, look, width);
        found.push(...(await surfaces(page)).map((s) => ({ ...s, what: `${s.what} (${path} at ${width})` })));
        if (width < 768) {
          await page.locator('.st-tabbar__item[aria-label="More pages"]').click();
          await page.locator(".st-more__sheet").waitFor();
          await page.waitForTimeout(500);
          found.push(...(await surfaces(page)).filter((s) => s.level === 5).map((s) => ({ ...s, what: `${s.what} (the More sheet at ${width})` })));
        }
      }
      // Every level is there: 1 to 5 (0 is the backdrop itself).
      const levels = [...new Set(found.map((s) => s.level))].sort();
      expect(levels, found.map((s) => s.what).join(", ")).toEqual([1, 2, 3, 4, 5]);

      const problems: string[] = [];
      for (const under of [ESPRESSO, BLACK])
        for (const at of ["top", "bottom"] as const) {
          for (const s of found) {
            // (a tinted tile's tone is colour as well as light: a control is a step above the tile it sits on, and the
            // control measured here sits on a plain card)
            const below = s.level === 1 ? [{ what: "the backdrop", l: lum(under) }] : found.filter((o) => o.level === s.level - 1 && !(s.level === 4 && o.what.startsWith("a tinted"))).map((o) => ({ what: o.what, l: lum(seen(o, under, at)) }));
            const here = lum(seen(s, under, at));
            for (const b of below) if (!(here > b.l)) problems.push(`over ${under.join(" ")}, at the ${at}: ${s.what} (level ${s.level}, ${here.toFixed(4)}) is not brighter than ${b.what} (${b.l.toFixed(4)})`);
          }
        }
      // Over a light backdrop (a picture or the desktop can be white or mid grey: the owner's rule, Clip Factory's own)
      // the page-to-panel step may go darker where AA needs the veil, but from the panel upward every level is at least
      // 0.015 brighter in relative luminance than the one under it over white (brighter over mid grey), and a control
      // a step up from the card it sits on.
      if (look.picture || look.desktop)
        for (const [name, under, step] of [
          ["white", WHITE, 0.015],
          ["mid grey", GREY, 1e-4],
        ] as const)
          for (const at of ["top", "bottom"] as const)
            for (const s of found) {
              const here = lum(seen(s, under, at));
              const below =
                s.level === 4
                  ? [{ what: "the card it sits on", l: lum(over(s.parent!, under, at)) }]
                  : s.level === 5
                    ? found.filter((o) => o.level === 3 && !o.what.startsWith("a tinted")).map((o) => ({ what: o.what, l: lum(seen(o, under, at)) }))
                    : s.level >= 2
                      ? found.filter((o) => o.level === s.level - 1).map((o) => ({ what: o.what, l: lum(seen(o, under, at)) }))
                      : [];
              for (const b of below) if (!(here >= b.l + step)) problems.push(`over ${name}, at the ${at}: ${s.what} (level ${s.level}, ${here.toFixed(4)}) is not ${step} above ${b.what} (${b.l.toFixed(4)})`);
            }
      for (const s of found) {
        // lighter at the top than at the bottom (its own light), over the espresso
        const top = lum(seen(s, ESPRESSO, "top"));
        const bottom = lum(seen(s, ESPRESSO, "bottom"));
        if (!(top > bottom)) problems.push(`${s.what}: not lighter at the top (${top.toFixed(4)} ≤ ${bottom.toFixed(4)})`);
        if (s.rim === null) problems.push(`${s.what}: no bright top rim`);
      }
      // the rim is brighter on higher levels
      for (const s of found)
        for (const o of found)
          if (o.level === s.level - 1 && s.rim !== null && o.rim !== null && !(s.rim > o.rim)) problems.push(`${s.what}'s rim (${s.rim}) is not brighter than ${o.what}'s (${o.rim})`);
      expect(problems, problems.join("\n")).toEqual([]);
    });
});
