import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { visibleEdges } from "./edges.ts";
import { animationsDone, findOverflow, settle } from "./helpers.ts";

// Pictures in Ask (docs/CONTRACTS.md §26) in the mock build: attach, paste and drop; the 4-picture limit; take away;
// sending pictures with no words; the follow-up carrying `seen`; the viewer; the notices; pictures off; Start over;
// reduced motion; and the no-edges, no-side-scroll and 44 px rules. Runs in Chromium and in WebKit (Desktop Safari,
// and iPhone 15 for the phone size), headless. The mock checks pictures like the API and records what it saw.

const FIX = join(import.meta.dirname, "fixtures");
const PHOTO = join(FIX, "photo-gps.jpg");
const SHOT = join(FIX, "shot.png");
const GIF = join(FIX, "anim.gif");
const NOTE = join(FIX, "note.txt");

const SIZES = [
  { name: "phone", width: 390, height: 844, phone: true },
  { name: "desktop", width: 1440, height: 900, phone: false },
] as const;

const panel = (page: Page) => page.getByRole("dialog", { name: "Ask Clip Factory" });
const picButton = (page: Page) => panel(page).getByRole("button", { name: "Add a picture" });
const fileInput = (page: Page) => panel(page).locator('.help-panel__field input[type="file"]');
const tiles = (page: Page) => panel(page).locator(".help-pic:not(.is-leaving)");
const note = (page: Page) => panel(page).locator(".help-note");

interface Seen {
  count: number;
  pictures: { bytes: number; width: number; height: number; hasExif: boolean }[];
}

async function open(page: Page) {
  await page.goto("/");
  await settle(page);
  await page.getByRole("button", { name: "Ask Clip Factory" }).click();
  await expect(panel(page)).toBeVisible();
  await expect(picButton(page)).toBeVisible();
}

async function attach(page: Page, ...files: string[]) {
  await fileInput(page).setInputFiles(files);
  await expect(panel(page).locator(".help-pic.is-busy")).toHaveCount(0, { timeout: 15_000 });
}

/** A File in the page from a fixture's bytes. */
function fileArg(path: string, type: string) {
  return { b64: readFileSync(path).toString("base64"), name: path.split("/").pop()!, type };
}

async function paste(page: Page, path: string, type: string) {
  await page.evaluate(({ b64, name, type: t }) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type: t }));
    const target = document.querySelector<HTMLTextAreaElement>(".help-panel__input")!;
    const e = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
    // Some engines drop clipboardData from the constructor: put it on the event.
    if (!e.clipboardData) Object.defineProperty(e, "clipboardData", { value: dt });
    target.dispatchEvent(e);
  }, fileArg(path, type));
}

async function drag(page: Page, type: "dragenter" | "dragover" | "dragleave" | "drop", path?: string) {
  await page.evaluate(
    ({ kind, file }) => {
      const dt = new DataTransfer();
      if (file) {
        const bin = atob(file.b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        dt.items.add(new File([bytes], file.name, { type: file.type }));
      }
      const e = new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: dt });
      if (!e.dataTransfer) Object.defineProperty(e, "dataTransfer", { value: dt });
      // An empty DataTransfer has no "Files" type: say it carries files, as a real drag from the desktop does.
      if (!Array.from(e.dataTransfer!.types).includes("Files")) Object.defineProperty(e.dataTransfer, "types", { value: ["Files"] });
      document.querySelector(".help-panel__log")!.dispatchEvent(e);
    },
    { kind: type, file: path ? fileArg(path, "image/png") : null },
  );
}

async function send(page: Page, text = "") {
  const box = panel(page).getByLabel("Your question");
  if (text) await box.fill(text);
  await panel(page).getByRole("button", { name: "Send" }).click();
  await expect(panel(page).locator(".help-thinking")).toHaveCount(0, { timeout: 15_000 });
}

const mockSeen = (page: Page) => page.evaluate(() => (window as unknown as { __cfMockHelp?: { seen?: Seen[] } }).__cfMockHelp?.seen ?? []);
const mockHistory = (page: Page) => page.evaluate(() => (window as unknown as { __cfMockHelp?: { history?: unknown[][] } }).__cfMockHelp?.history ?? []);

for (const size of SIZES) {
  test.describe(`Ask pictures at ${size.width}x${size.height}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });
    // The iPhone project runs the phone size only; the desktop projects run both.
    test.skip(({ isMobile }) => isMobile && !size.phone, "iPhone runs the phone size");

    test("attach, paste and drop each add a picture; the drop layer comes and goes", async ({ page }) => {
      await open(page);
      await attach(page, SHOT);
      await expect(tiles(page)).toHaveCount(1);
      await expect(panel(page).getByRole("status").filter({ hasText: "Picture added. 1 of 4." })).toHaveCount(1);
      await expect(panel(page).getByLabel("Your question")).toHaveAttribute("placeholder", "Ask about your picture");
      await paste(page, SHOT, "image/png");
      await expect(tiles(page)).toHaveCount(2, { timeout: 15_000 });
      // Pasting words still pastes words.
      await panel(page).getByLabel("Your question").fill("");
      await drag(page, "dragenter");
      await expect(panel(page).locator(".help-drop")).toBeVisible();
      await expect(panel(page).locator(".help-drop")).toHaveText("Drop your picture here");
      await drag(page, "dragover");
      await drag(page, "drop", SHOT);
      await expect(panel(page).locator(".help-drop")).toHaveCount(0);
      await expect(tiles(page)).toHaveCount(3, { timeout: 15_000 });
      await drag(page, "dragenter");
      await drag(page, "dragleave");
      await expect(panel(page).locator(".help-drop")).toHaveCount(0);
    });

    test("five pictures: four tiles and a note; a text file is not a picture", async ({ page }) => {
      await open(page);
      await attach(page, SHOT, SHOT, SHOT, SHOT, SHOT);
      await expect(tiles(page)).toHaveCount(4);
      await expect(note(page)).toHaveText("You can add 4 pictures. Take one away first.");
      await panel(page).getByRole("button", { name: "Take away picture 1" }).click();
      await expect(tiles(page)).toHaveCount(3);
      await attach(page, NOTE);
      await expect(note(page)).toHaveText("That's not a picture. Try a screenshot.");
      await expect(tiles(page)).toHaveCount(3);
    });

    test("take away leaves 3 and moves the focus on", async ({ page }) => {
      await open(page);
      await attach(page, SHOT, SHOT, SHOT, SHOT);
      await panel(page).getByRole("button", { name: "Take away picture 2" }).click();
      await expect(tiles(page)).toHaveCount(3);
      await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Take away picture 2");
      for (let i = 0; i < 3; i++) await panel(page).getByRole("button", { name: "Take away picture 1" }).click();
      await expect(tiles(page)).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Add a picture");
    });

    test("send with no words: small clean JPEGs reach the API, the bubble shows them, the follow-up carries seen", async ({ page }) => {
      await open(page);
      await attach(page, PHOTO, SHOT, GIF, PHOTO);
      await expect(tiles(page)).toHaveCount(4);
      await expect(panel(page).getByRole("button", { name: "Send" })).toBeEnabled();
      await send(page);
      await expect(tiles(page)).toHaveCount(0);
      const bubble = panel(page).locator(".help-msg--me").last();
      await expect(bubble.getByRole("button", { name: /Open picture \d bigger/ })).toHaveCount(4);
      const seen = await mockSeen(page);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.count).toBe(4);
      for (const p of seen[0]!.pictures) {
        expect(p.bytes).toBeLessThanOrEqual(600_000);
        expect(Math.max(p.width, p.height)).toBeLessThanOrEqual(1568);
        expect(p.hasExif).toBe(false);
      }
      // The 4000 x 3000 photo came down to 1568 x 1176.
      expect(seen[0]!.pictures[0]).toMatchObject({ width: 1568, height: 1176 });
      await send(page, "and where is it?");
      expect(await mockSeen(page)).toHaveLength(1);
      const history = await mockHistory(page);
      expect(history.at(-1)?.[0]).toMatchObject({ role: "user", text: "", seen: "I can see the Home page." });
    });

    test("the viewer opens bigger, steps with the arrows and closes with Escape", async ({ page }) => {
      await open(page);
      await attach(page, SHOT, PHOTO);
      await send(page, "what is this");
      const first = panel(page).getByRole("button", { name: "Open picture 1 bigger" });
      await first.click();
      const viewer = page.getByRole("dialog", { name: "Your picture 1 of 2" });
      await expect(viewer).toBeVisible();
      await expect(viewer.getByRole("img", { name: "Your picture 1 of 2" })).toBeVisible();
      await page.keyboard.press("ArrowRight");
      await expect(page.getByRole("dialog", { name: "Your picture 2 of 2" })).toBeVisible();
      await page.keyboard.press("ArrowLeft");
      await expect(page.getByRole("dialog", { name: "Your picture 1 of 2" })).toBeVisible();
      await page.getByRole("button", { name: "Next picture" }).click();
      await expect(page.getByRole("dialog", { name: "Your picture 2 of 2" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator(".help-viewer")).toHaveCount(0);
      // Escape closed the viewer only, and the focus is back on the tile.
      await expect(panel(page)).toBeVisible();
      await expect(first).toBeFocused();
    });

    test("a picture that was not read says so", async ({ page }) => {
      await open(page);
      await attach(page, SHOT);
      await send(page, "#unread what is this");
      await expect(panel(page).locator(".help-msg--notice").last()).toContainText("I couldn't look at your picture this time.");
      await attach(page, SHOT);
      await send(page, "#piclimit what is this");
      await expect(panel(page).locator(".help-msg--notice").last()).toContainText("You sent lots of pictures today.");
    });

    test("a note floats: the field and the tray do not move when it comes and goes", async ({ page }) => {
      await open(page);
      await attach(page, SHOT, SHOT, SHOT, SHOT);
      await animationsDone(page);
      const field = panel(page).locator(".help-panel__field");
      const before = (await field.boundingBox())!.y;
      await picButton(page).click();
      await expect(note(page)).toHaveText("You can add 4 pictures. Take one away first.");
      expect((await field.boundingBox())!.y).toBe(before);
      await expect(note(page)).toHaveCount(0, { timeout: 8_000 });
      expect((await field.boundingBox())!.y).toBe(before);
    });

    test("the take-away button's focus glow is not cut off", async ({ page }) => {
      await open(page);
      await attach(page, SHOT);
      await panel(page).getByRole("button", { name: "Take away picture 1" }).focus();
      const room = await page.evaluate(() => {
        const tray = document.querySelector(".help-pics")!.getBoundingClientRect();
        const btn = document.querySelector(".help-pic__remove")!.getBoundingClientRect();
        return btn.top - tray.top;
      });
      // The global focus glow reaches 5.5 px past the button.
      expect(room).toBeGreaterThanOrEqual(5.5);
    });

    test("a question that could not go gives its pictures and words back", async ({ page }) => {
      await open(page);
      await attach(page, SHOT, PHOTO);
      await send(page, "#503 where is keep");
      await expect(tiles(page)).toHaveCount(2);
      await expect(panel(page).getByLabel("Your question")).toHaveValue("#503 where is keep");
    });

    test("Tab stays inside the picture view", async ({ page }) => {
      await open(page);
      await attach(page, SHOT, PHOTO);
      await send(page, "what is this");
      await panel(page).getByRole("button", { name: "Open picture 1 bigger" }).click();
      await expect(page.locator(".help-viewer")).toBeVisible();
      const seen: string[] = [];
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press("Tab");
        seen.push(await page.evaluate(() => (document.activeElement?.closest(".help-viewer") ? document.activeElement.getAttribute("aria-label") ?? "?" : "OUT")));
      }
      expect(seen).not.toContain("OUT");
      expect(new Set(seen).size).toBe(3);
      await page.keyboard.press("Shift+Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest(".help-viewer"))).toBe(true);
    });

    test("pictures off: no picture button, and a pasted picture gets a note", async ({ page }) => {
      await open(page);
      await page.evaluate(() => {
        (window as unknown as { __cfMockHelp: { pictures: boolean } }).__cfMockHelp.pictures = false;
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await expect(picButton(page)).toHaveCount(0);
      await paste(page, SHOT, "image/png");
      await expect(note(page)).toHaveText("Pictures are off right now. Ask me in words.");
      await expect(tiles(page)).toHaveCount(0);
    });

    test("Start over empties the tray and the chat", async ({ page }) => {
      await open(page);
      await attach(page, SHOT);
      await send(page, "what is this");
      await attach(page, SHOT, SHOT);
      await expect(tiles(page)).toHaveCount(2);
      await panel(page).getByRole("button", { name: "Start over" }).click();
      await expect(tiles(page)).toHaveCount(0);
      await expect(panel(page).locator(".help-msg--me")).toHaveCount(0);
    });

    test("no edges, no side scroll, and every picture control is 44 px or more", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await open(page);
      await attach(page, SHOT, PHOTO, SHOT, PHOTO);
      await send(page, "what is this");
      await attach(page, SHOT, SHOT, SHOT);
      await animationsDone(page);
      const edges = (await visibleEdges(page)).filter((e) => /help-(pic|pics|sent|note|drop|viewer|panel__pic)/.test(e));
      expect(edges, edges.join("\n")).toEqual([]);
      const o = await findOverflow(page);
      expect(o.page, "page scrolls sideways").toBeLessThanOrEqual(o.viewport);
      const small = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>(".help-panel__pic, .help-pic__remove, .help-sent__tile"))
          .map((el) => ({ label: el.getAttribute("aria-label"), ...el.getBoundingClientRect().toJSON() }))
          .filter((r) => r.width < 44 || r.height < 44),
      );
      expect(small).toEqual([]);
      // The viewer too.
      await panel(page).getByRole("button", { name: "Open picture 1 bigger" }).click();
      await animationsDone(page);
      const viewerEdges = (await visibleEdges(page)).filter((e) => /help-viewer/.test(e));
      expect(viewerEdges, viewerEdges.join("\n")).toEqual([]);
      const viewerSmall = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>(".help-viewer button"))
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width < 44 || r.height < 44).length,
      );
      expect(viewerSmall).toBe(0);
      const v = await findOverflow(page);
      expect(v.page).toBeLessThanOrEqual(v.viewport);
    });

    test("reduced motion: pictures only fade", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await open(page);
      await attach(page, SHOT);
      const names = await page.evaluate(() => getComputedStyle(document.querySelector(".help-pic")!).animationName);
      expect(names).toBe("help-fade-in");
      await animationsDone(page);
    });
  });
}

// Before and after pictures for the owner (only when ASKPICS_SHOTS names a folder).
const SHOTS = process.env.ASKPICS_SHOTS;
for (const size of SIZES) {
  test(`screenshots for the owner, ${size.name}`, async ({ page }, info) => {
    test.skip(!SHOTS || info.project.name !== "chromium", "only when asked, in Chromium");
    test.setTimeout(120_000);
    await page.setViewportSize({ width: size.width, height: size.height });
    const shot = async (name: string) => {
      await animationsDone(page);
      await page.screenshot({ path: join(SHOTS!, `after-${size.name}-${name}.png`) });
    };
    await open(page);
    await shot("1-empty-composer");
    await attach(page, SHOT, PHOTO);
    await shot("2-picture-added");
    await send(page, "what is this");
    await shot("3-sent-with-picture");
    await panel(page).getByRole("button", { name: "Open picture 1 bigger" }).click();
    await shot("4-lightbox");
    await page.keyboard.press("Escape");
    await attach(page, SHOT, SHOT, SHOT, SHOT, SHOT);
    await shot("5-error-too-many");
  });
}
