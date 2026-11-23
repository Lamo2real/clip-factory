import { expect, test, type Locator } from "@playwright/test";
import { AA, BONE, contrast, oklabL, type Rgb } from "../src/lib/background.ts";
import { animationsDone, settle, stillBackdrop } from "./helpers.ts";
import { decode, type Pixels } from "./pixels.ts";

// The update bar (docs/CONTRACTS.md §12.2), driven by the mock build's fake update (?update=1 / window.__cfFakeUpdate).

test("a new version shows the bar with what changed, and Reload runs to 100% and reloads", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?update=1");
  await settle(page);

  const bar = page.getByRole("region", { name: "New version" });
  await expect(bar).toBeVisible();
  await expect(bar.getByText("New version ready")).toBeVisible();
  await expect(bar.getByRole("list", { name: "What changed" }).getByRole("listitem")).toHaveText(["Settings", "Profile picture"]);

  // It sits above the phone tab bar, never on top of it (where it rests: it slides up from below the screen first).
  await animationsDone(page);
  const barBox = (await bar.boundingBox())!;
  const tabs = (await page.locator("nav.tabbar").boundingBox())!;
  expect(barBox.y + barBox.height).toBeLessThanOrEqual(tabs.y);

  // Watch the progress: record every value it shows until the page reloads.
  await page.evaluate(() => {
    const seen: number[] = [];
    (window as Window & { __seen?: number[] }).__seen = seen;
    sessionStorage.setItem("cf.testMarker", "before-reload");
    const tick = () => {
      const el = document.querySelector('[role="progressbar"][aria-label="Update progress"]');
      if (el) seen.push(Number(el.getAttribute("aria-valuenow")));
      sessionStorage.setItem("cf.testSeen", JSON.stringify(seen));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const started = Date.now();
  const reloaded = page.waitForEvent("load", { timeout: 12_000 });
  await bar.getByRole("button", { name: "Reload" }).click();
  await expect(page.getByRole("progressbar", { name: "Update progress" })).toBeVisible();
  await reloaded;
  expect(Date.now() - started).toBeLessThan(11_000);

  const seen = JSON.parse((await page.evaluate(() => sessionStorage.getItem("cf.testSeen"))) ?? "[]") as number[];
  expect(seen.length).toBeGreaterThan(5);
  expect(Math.max(...seen)).toBe(100);
  // Never goes backwards.
  for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
  // The fake flag is gone after the reload, so the bar does not come straight back.
  await settle(page);
  expect(page.url()).not.toContain("update=1");
  await expect(page.getByRole("region", { name: "New version" })).toBeHidden();
});

test("Later hides the bar until the next check", async ({ page }) => {
  await page.goto("/settings?update=1");
  await settle(page);
  const bar = page.getByRole("region", { name: "New version" });
  await expect(bar).toBeVisible();
  await bar.getByRole("button", { name: "Later" }).click();
  await expect(bar).toBeHidden();
  await page.evaluate(() => window.__cfCheckForUpdate?.());
  await expect(page.getByRole("region", { name: "New version" })).toBeVisible();
});

test("custom areas from window.__cfFakeUpdate, on desktop beside the sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    window.__cfFakeUpdate = ["Review", "Captions"];
  });
  await page.goto("/");
  await settle(page);
  const bar = page.getByRole("region", { name: "New version" });
  await expect(bar.getByRole("listitem")).toHaveText(["Review", "Captions"]);
  const sidebar = (await page.locator("nav.sidebar").boundingBox())!;
  const box = (await bar.boundingBox())!;
  expect(box.x).toBeGreaterThan(sidebar.x + sidebar.width);
});

test("the bar is centred: in the window without a sidebar, under the content beside it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?update=1");
  await settle(page);
  const bar = page.getByRole("region", { name: "New version" });
  await expect(bar).toBeVisible();
  // Beside the sidebar: centred in the space to its right.
  const side = (await page.locator("nav.sidebar").boundingBox())!;
  let box = (await bar.boundingBox())!;
  const contentMid = (side.x + side.width + 1440) / 2;
  expect(Math.abs(box.x + box.width / 2 - contentMid)).toBeLessThan(24);
  // Screens without the sidebar (like sign-in): centred in the window.
  await page.evaluate(() => document.querySelector("nav.sidebar")?.remove());
  await expect.poll(async () => {
    box = (await bar.boundingBox())!;
    return Math.abs(box.x + box.width / 2 - 720);
  }).toBeLessThan(2);
});

test("no bar when the server has the same version", async ({ page }) => {
  await page.goto("/");
  await settle(page);
  await page.evaluate(() => window.__cfCheckForUpdate?.());
  // The wait is the test: given time, no bar comes.
  await page.waitForTimeout(300);
  await expect(page.getByRole("region", { name: "New version" })).toBeHidden();
});

test("with reduced motion the bar simply fills, with no confetti", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?update=1");
  await settle(page);
  const reloaded = page.waitForEvent("load", { timeout: 12_000 });
  await page.getByRole("button", { name: "Reload" }).click();
  await expect(page.locator("canvas.confetti")).toHaveCount(0);
  await reloaded;
});

// Reload is a colourless liquid-glass lens (owner, 2026-11-23: "without color and only a liquid glassy style";
// ADR-87): bone words, no vermilion and no green on it, and it reads as the main choice beside Later by light alone,
// over its whole face (top, middle and bottom), in the app's own look, in Picture with a white photo and with a white
// thumbnail right under the bar. Later is the quiet choice but still a button: a step of light above the bar. Both keep
// their bone words at 4.5:1, and hover adds light. Measured from screenshot pixels in headless Chromium.
test.describe("Reload is a colourless glass lens", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "measured in headless Chromium");
  test.use({ reducedMotion: "reduce" });

  /** The vermilion family: the raw colour and the CTA's two stops. */
  const VERMILION = [/\b232[,\s]+57[,\s]+43\b/, /\b206[,\s]+48[,\s]+36\b/, /\b184[,\s]+38[,\s]+28\b/];
  /** A plain white picture: the hardest photo for bone words. */
  const WHITE_PICTURE = `data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16'><rect width='16' height='16' fill='#fff'/></svg>")}`;
  /** A step of light a person sees (OKLab L): Later over the bar. */
  const STEP = 0.03;
  /** Reload over Later at the height of its words (mid-height): plainly the main choice. */
  const LEAD = 0.08;

  const LOOKS: { name: string; look?: Record<string, unknown>; picture?: string; whiteUnder?: boolean }[] = [
    { name: "the app's own backdrop" },
    { name: "Picture with a white photo", look: { backgroundMode: "picture" }, picture: WHITE_PICTURE },
    { name: "a white thumbnail under the bar", whiteUnder: true },
  ];

  /** What a button paints (its fill, shadow and shine) and its words' colour, beside --ink worked out the same way. */
  const paint = (el: Locator) =>
    el.evaluate((node) => {
      const cs = getComputedStyle(node);
      const probe = document.createElement("span");
      probe.style.color = "var(--ink)";
      document.body.append(probe);
      const ink = getComputedStyle(probe).color;
      probe.remove();
      return {
        fill: [cs.backgroundImage, cs.backgroundColor, cs.boxShadow, getComputedStyle(node, "::before").backgroundImage].join(" "),
        color: cs.color,
        ink,
      };
    });

  type At = { x: number; y: number };
  /** Where a face is read, 4 x 4 px each: the top padding, the middle (where the words sit) and the bottom padding. */
  const faceSpots = (el: Locator) =>
    el.evaluate((node) => {
      const r = node.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2 - 2);
      return { top: { x, y: Math.round(r.top + 4) }, middle: { x, y: Math.round(r.top + r.height / 2 - 2) }, bottom: { x, y: Math.round(r.bottom - 9) } };
    });
  /** The bar itself in the gap between the two buttons, at their middle. */
  const gapSpot = async (later: Locator, reload: Locator): Promise<At> => {
    const l = (await later.boundingBox())!;
    const r = (await reload.boundingBox())!;
    const [left, right] = l.x + l.width <= r.x ? [l.x + l.width, r.x] : [r.x + r.width, l.x];
    return { x: Math.round((left + right) / 2 - 2), y: Math.round(l.y + l.height / 2 - 2) };
  };

  const patch = (p: Pixels, at: At): Rgb => {
    const sum = [0, 0, 0];
    for (let dy = 0; dy < 4; dy++)
      for (let dx = 0; dx < 4; dx++) {
        const i = ((at.y + dy) * p.width + at.x + dx) * 4;
        for (let k = 0; k < 3; k++) sum[k]! += p.data[i + k]!;
      }
    return sum.map((v) => v / 16) as unknown as Rgb;
  };

  for (const c of LOOKS)
    for (const width of [390, 1440])
      test(`${c.name}, at ${width} px: no colour, bone words at AA, a step of light over Later on its whole face, and hover adds light`, async ({ page }) => {
        await stillBackdrop(page);
        if (c.look) {
          await page.addInitScript(
            ({ look, picture }) => {
              if (sessionStorage.getItem("cf-update-look")) return;
              sessionStorage.setItem("cf-update-look", "1");
              const prefs = JSON.parse(localStorage.getItem("cf.prefs") ?? "{}") as Record<string, unknown>;
              localStorage.setItem("cf.prefs", JSON.stringify({ ...prefs, ...look }));
              sessionStorage.setItem("cf-mock-look", JSON.stringify(look));
              if (picture) localStorage.setItem("cf.background", picture);
            },
            { look: c.look, picture: c.picture ?? null },
          );
        }
        await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
        await page.goto("/?update=1");
        await settle(page);
        await animationsDone(page);
        const bar = page.getByRole("region", { name: "New version" });
        // Found by class, not name: the words are hidden below to read the glass under them.
        const reload = bar.locator(".update-bar__reload");
        const later = bar.locator(".update-bar__later");
        await expect(bar.getByRole("button", { name: "Reload" })).toHaveClass(/\bupdate-bar__reload\b/);
        await expect(bar.getByRole("button", { name: "Later" })).toHaveClass(/\bupdate-bar__later\b/);
        await expect(reload).toHaveClass(/\bbtn--glass\b/);
        await expect(reload).toHaveClass(/\bbtn--lens\b/);
        await expect(reload).not.toHaveClass(/btn--primary|btn--action/);
        await expect(later).toHaveClass(/\bbtn--ghost\b/);
        // Its motion stays: refresh plays on the glyph.
        await expect(reload).toHaveAttribute("data-act", "refresh");
        await expect(reload.locator(".act.act--refresh")).toHaveCount(1);

        const rest = await paint(reload);
        for (const red of VERMILION) expect(rest.fill, `Reload paints ${red}`).not.toMatch(red);
        // Colourless: every colour it paints is a grey (white light, the shadow below), never a tint.
        const tints = [...rest.fill.matchAll(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]).filter(([r, g, b]) => Math.max(r!, g!, b!) - Math.min(r!, g!, b!) > 24);
        expect(tints, rest.fill).toEqual([]);
        expect(rest.color).toBe(rest.ink);
        expect((await paint(later)).color).toBe(rest.ink);

        if (c.whiteUnder)
          await bar.evaluate((el) => {
            // A white thumbnail scrolled right under the bar (the same stacking context, one step below it).
            const white = document.createElement("div");
            white.style.cssText = "position: fixed; inset: auto 0 0 0; height: 60vh; background: #fff; z-index: 54; pointer-events: none;";
            el.parentElement!.insertBefore(white, el);
          });
        // As a person sees it (kept in the test's output folder for review), before the words are hidden to measure.
        const seen = (await bar.boundingBox())!;
        const view = { x: Math.max(0, Math.floor(seen.x) - 12), y: Math.max(0, Math.floor(seen.y) - 12), width: Math.ceil(seen.width) + 24, height: Math.ceil(seen.height) + 24 };
        await page.mouse.move(0, 0);
        await page.screenshot({ clip: view, path: test.info().outputPath(`update-bar-${width}.png`) });
        // The faces alone: the words, glyphs and their halo are hidden, so each patch is the glass the words sit on; and
        // the page under the bar is hidden too, so both buttons sit over the same backdrop (a panel edge behind one of
        // them, blurred 28 px, would tilt the comparison).
        await page.addStyleTag({
          content: ".update-bar__actions .btn > * { visibility: hidden !important; } .update-bar__actions .btn { text-shadow: none !important; } main.main { visibility: hidden !important; }",
        });
        await page.mouse.move(0, 0);
        await page.waitForTimeout(100);

        const lensAt = await faceSpots(reload);
        const laterAt = await faceSpots(later);
        const gapAt = await gapSpot(later, reload);
        // Only the bar is shot (a full 1440 px screen is slow to read back): each read is the colour of a 4 x 4 patch.
        const box = (await bar.boundingBox())!;
        const clip = { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.width), height: Math.ceil(box.height) };
        const shoot = async () => {
          const px = await decode(page, await page.screenshot({ clip }));
          return (at: At) => patch(px, { x: at.x - clip.x, y: at.y - clip.y });
        };
        const still = await shoot();
        const L = (at: At) => oklabL(still(at));
        const notes: string[] = [];
        for (const part of ["top", "middle", "bottom"] as const) {
          const dl = L(lensAt[part]) - L(laterAt[part]);
          notes.push(`Reload over Later at its ${part}: ${dl.toFixed(3)}`);
          // The words are at mid-height: there Reload reads LEAD over Later; above and below it is still a step.
          expect(dl, `Reload over Later at its ${part} (${c.name})`).toBeGreaterThanOrEqual(part === "middle" ? LEAD : STEP);
        }
        notes.push(`Later over the bar: ${(L(laterAt.middle) - L(gapAt)).toFixed(3)}`);
        expect(L(laterAt.middle) - L(gapAt), `Later over the bar (${c.name})`).toBeGreaterThanOrEqual(STEP);
        const lensFace = still(lensAt.middle);
        notes.push(`Reload's words ${contrast(BONE, lensFace).toFixed(2)}:1, Later's ${contrast(BONE, still(laterAt.middle)).toFixed(2)}:1`);
        expect(contrast(BONE, lensFace), `Reload's words (${c.name})`).toBeGreaterThanOrEqual(AA);
        expect(contrast(BONE, still(laterAt.middle)), `Later's words (${c.name})`).toBeGreaterThanOrEqual(AA);

        // Hover adds light, on the whole face, and the words keep AA.
        await reload.hover();
        await expect.poll(async () => oklabL((await shoot())(lensAt.middle)) - oklabL(lensFace)).toBeGreaterThanOrEqual(0.006);
        const lensHover = await shoot();
        expect(oklabL(lensHover(lensAt.top))).toBeGreaterThan(L(lensAt.top));
        expect(oklabL(lensHover(lensAt.bottom))).toBeGreaterThan(L(lensAt.bottom));
        notes.push(`Reload on hover: +${(oklabL(lensHover(lensAt.middle)) - oklabL(lensFace)).toFixed(3)}, words ${contrast(BONE, lensHover(lensAt.middle)).toFixed(2)}:1`);
        expect(contrast(BONE, lensHover(lensAt.middle)), `Reload's words on hover (${c.name})`).toBeGreaterThanOrEqual(AA);
        for (const red of VERMILION) expect((await paint(reload)).fill, `hovered Reload paints ${red}`).not.toMatch(red);
        await later.hover();
        await expect.poll(async () => oklabL((await shoot())(laterAt.middle)) - L(laterAt.middle)).toBeGreaterThan(0.003);
        const laterHover = await shoot();
        expect(oklabL(laterHover(laterAt.top))).toBeGreaterThan(L(laterAt.top));
        notes.push(`Later on hover: +${(oklabL(laterHover(laterAt.middle)) - L(laterAt.middle)).toFixed(3)}, words ${contrast(BONE, laterHover(laterAt.middle)).toFixed(2)}:1`);
        expect(contrast(BONE, laterHover(laterAt.middle)), `Later's words on hover (${c.name})`).toBeGreaterThanOrEqual(AA);
        await test.info().attach(`update-bar-${width}.txt`, { body: notes.join("\n") + "\n", contentType: "text/plain" });
        await page.mouse.move(0, 0);
        await page.locator("style").last().evaluate((el) => el.remove());
        await reload.hover();
        await page.screenshot({ clip: view, path: test.info().outputPath(`update-bar-${width}-hover.png`) });
      });
});
