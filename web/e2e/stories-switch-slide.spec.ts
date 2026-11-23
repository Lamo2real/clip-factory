import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { asMacWindow } from "./desktopWindow.ts";
import { settle, stillBackdrop } from "./helpers.ts";

// The workspace switch's highlight slides smoothly both ways, every time (the owner, 22 Nov: "make sure to make the
// click animation between the two buttons smooth"; docs/CONTRACTS.md §20.13, §45.38). The switch is the shell's, so it
// stays mounted across the change of app; the slide starts on the tap's own frame, runs its whole 450 ms to the end
// (never cancelled by a remount), and the page changes only once it has landed, so no new page is laid out during it.
// Checked in Chromium (WebView2 on Windows) and WebKit (the Mac app): the slide's Web Animation from start to finish,
// the frames the page drew meanwhile (a requestAnimationFrame recorder), and in Chromium the main thread's own tasks
// (a DevTools trace). A strip of six frames of each slide is saved as pictures (CF_SLIDE_SHOTS, else under
// test-results/switch-slide). The living backdrop is held still for the frame counts (as the other motion checks do):
// without a GPU the test browsers repaint its nine blurred, drifting blobs on every frame, which says nothing about
// the slide. Now that the whole app slides over it, it is drawn flat for them too (flatBackdrop): a browser drawing in
// software applies those nine 56 px blurs again on every frame anything moves above them (three to five frames of 50
// to 100 ms in each slide, still or moving, glass or none), which is the test machine's drawing, not the slide (the
// real backdrop drifts on every frame anyway, on a GPU). And on a Mac, Chromium draws on the Mac's own GPU (Metal), as
// the app's windows do: headless Chromium otherwise composites in software (SwiftShader) there too, and its frames
// measured the CPU, not the app (on the GPU the slide, its drifting backdrop included, keeps every frame at 60 Hz). A frame counts as dropped only when it comes later than twice this machine's own frame at rest (and its
// worst gap at rest, and 25 ms); one such late frame in a slide is let pass, as one hiccup of a busy test machine (the
// CI runners have no GPU and run six shards at once) is not the slide's own. The hard checks never bend: the slide
// runs its whole 450 ms on transform only, to its end, never cancelled, and the page changes only after it.
//
// And the whole app slides with it, like a sliding window (the owner, 23 Nov: "id like the transission between clip
// factory and clips funded to be like a sliding window"; stories/pane.tsx AppPanes): going to Clips Funded, Clip
// Factory's pane (with its own backdrop) slides out to the left while Clips Funded's slides in from the right, and back
// the other way. Both panes' slides start with the highlight's, run their whole length on transform alone, to their end; both panes are on screen only while they slide; nothing is laid out again meanwhile;
// each page sits where it is scrolled to (the one going out where the window was, the one coming in at its kept
// place, with no jump when it lands); the dock does not move; the page changes once they have landed, with focus on
// the new page. Calm motion (the device's, or the app's own) never slides them.
//
// And the whole switch moves slow in, slow out (the owner, 23 Nov: "make sure the switch between clip factory and
// clips funded uses slow in slow out effect when switching between them"; tokens.css --ease-in-out,
// cubic-bezier(0.65, 0, 0.35, 1)): both panes' slides and the switch's lens (its highlight) run on that one curve, for
// the same 450 ms, in both directions, so they read as one move. Every other glide keeps its own ease-out.
//
// The switch's two choices are found by what they open (data-ws-type), never by the second app's name.

const SHOTS = process.env.CF_SLIDE_SHOTS ?? join(import.meta.dirname, "..", "test-results", "switch-slide");
/** The panes' slide (app/shell.ts APP_SLIDE_ID and APP_SLIDE_MS): the switch's lens slides for as long. */
const APP_SLIDE = "app-slide";
const APP_SLIDE_MS = 450;
/** The slow-in slow-out curve the whole switch moves on (tokens.css --ease-in-out). */
const SLOW_IN_OUT = [0.65, 0, 0.35, 1];
/** A cubic-bezier's four numbers, however it is written ("cubic-bezier(.65,0,.35,1)" or "cubic-bezier(0.65, 0, 0.35, 1)"). */
const curve = (easing: string) => (easing.match(/-?\d*\.?\d+/g) ?? []).map(Number);

interface Recorded {
  /** The slide's animation: its id, duration, when it was first seen (ms after the tap) and how it ended. */
  slides: {
    id: string;
    duration: number;
    /** The curve its Web Animation runs on (its effect's easing). */
    easing: string;
    seenAt: number;
    end?: "finished" | "cancelled";
    property: string;
  }[];
  /** Frame times (performance.now) from the tap until the page changed. */
  frames: number[];
  tapAt: number;
  /** When the tap's click came (ms after the pointer went down): the switch acts on the click. */
  clickAt: number | null;
  /** When the address changed (ms after the tap). */
  changedAt: number | null;
  /** The bar's element is the one from before the tap (the switch was never remounted). */
  sameBar: boolean;
  longTasks: { start: number; duration: number }[];
}

/**
 * For the frame counts: the living backdrop held still (stillBackdrop) and drawn flat, its lights without their blur
 * (see the top of this file: a software renderer blurs them again on every frame the panes move over them).
 */
async function flatBackdrop(page: Page) {
  await stillBackdrop(page);
  await page.addInitScript(() => {
    const add = () => {
      const style = document.createElement("style");
      style.dataset.e2e = "flat-backdrop";
      style.textContent = ".backdrop *, .backdrop::before, .backdrop::after { filter: none !important; will-change: auto !important; animation: none !important; }";
      document.head.append(style);
    };
    if (document.head) add();
    else document.addEventListener("DOMContentLoaded", add, { once: true });
  });
}

test.use({
  launchOptions: [
    async ({ browserName, launchOptions }, use) => {
      const gpu = browserName === "chromium" && process.platform === "darwin";
      await use(gpu ? { ...launchOptions, args: [...(launchOptions.args ?? []), "--use-angle=metal", "--ignore-gpu-blocklist"] } : launchOptions);
    },
    { scope: "worker" },
  ],
});

async function on(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("cf.storiesPreview", "1");
    localStorage.setItem(
      "cf.stories.prefs",
      JSON.stringify({
        setupShown: ["stories"],
        more: { "motion.reduce": false },
      }),
    );
  });
}

/** The app as the owner has it a few seconds after opening: Lamo Stories' code fetched while idle, fonts in. */
async function warm(page: Page) {
  await settle(page);
  await page.waitForFunction(() => performance.getEntriesByType("resource").some((e) => /\/assets\/StoriesApp-[^/]+\.js$/.test(e.name)), undefined, {
    timeout: 10_000,
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
}

async function storiesReady(page: Page) {
  await page.locator(".stories-app[data-ws]").waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => !document.querySelector(".st-loading, .boot"), undefined, { timeout: 15_000 });
  await page.waitForTimeout(600);
}

/** Starts the in-page recorders: the glide's animations, every frame, long tasks (where the browser reports them). */
async function record(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __slide: Recorded };
    const bar = document.querySelector<HTMLElement>(".ws-dock .ws-switch")!;
    const glide = bar.querySelector<HTMLElement>(":scope > .glide")!;
    const from = location.pathname;
    const r: Recorded = {
      slides: [],
      frames: [],
      tapAt: 0,
      clickAt: null,
      changedAt: null,
      sameBar: false,
      longTasks: [],
    };
    w.__slide = r;
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) r.longTasks.push({ start: e.startTime, duration: e.duration });
      }).observe({ type: "longtask", buffered: false });
    } catch {
      // WebKit has no long-task entries: its frames say it.
    }
    document.addEventListener(
      "pointerdown",
      () => {
        r.tapAt = performance.now();
        console.timeStamp("cf-tap");
      },
      { capture: true, once: true },
    );
    document.addEventListener(
      "click",
      () => {
        r.clickAt = performance.now() - r.tapAt;
      },
      { capture: true, once: true },
    );
    const seen = new Set<Animation>();
    const look = () => {
      for (const a of glide.getAnimations()) {
        if (seen.has(a)) continue;
        seen.add(a);
        const kf = (a.effect as KeyframeEffect | null)?.getKeyframes?.() ?? [];
        const rec: Recorded["slides"][number] = {
          id: a.id,
          duration: Number(a.effect?.getTiming().duration ?? 0),
          easing: String(a.effect?.getTiming().easing ?? ""),
          seenAt: performance.now() - r.tapAt,
          property: Object.keys(kf[0] ?? {})
            .filter((k) => !["offset", "easing", "composite", "computedOffset"].includes(k))
            .join(","),
        };
        r.slides.push(rec);
        a.finished.then(
          () => {
            rec.end = "finished";
            console.timeStamp("cf-slide-end");
          },
          () => (rec.end = "cancelled"),
        );
      }
    };
    new MutationObserver(look).observe(bar, {
      subtree: true,
      attributes: true,
    });
    const tick = (t: number) => {
      if (r.tapAt) r.frames.push(t);
      look();
      if (location.pathname !== from && r.changedAt === null) {
        r.changedAt = performance.now() - r.tapAt;
        r.sameBar = document.querySelector(".ws-dock .ws-switch") === bar;
      }
      if (!r.tapAt || performance.now() - r.tapAt < 2500) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Chromium's own trace of the main thread (its tasks), between the tap and the slide's end. */
async function trace(page: Page, run: () => Promise<void>): Promise<{ longest: number; tasks: number }> {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const events: {
    name: string;
    ts: number;
    dur?: number;
    tid: number;
    pid: number;
    cat: string;
    args?: { data?: { message?: string } };
  }[] = [];
  cdp.on("Tracing.dataCollected", (e) => void events.push(...(e.value as unknown as typeof events)));
  const done = new Promise<void>((resolve) => cdp.once("Tracing.tracingComplete", () => resolve()));
  await cdp.send("Tracing.start", {
    categories: "devtools.timeline,disabled-by-default-devtools.timeline",
    transferMode: "ReportEvents",
  });
  await run();
  await cdp.send("Tracing.end");
  await done;
  await cdp.detach();
  const mark = (m: string) => events.find((e) => e.name === "TimeStamp" && e.args?.data?.message === m);
  const tap = mark("cf-tap");
  const end = mark("cf-slide-end");
  if (!tap || !end) return { longest: -1, tasks: 0 };
  // The page's main thread (where the tap's mark was written), between the tap and the end of the slide.
  const tasks = events.filter(
    (e) => e.name === "RunTask" && e.pid === tap.pid && e.tid === tap.tid && e.ts >= tap.ts && e.ts <= end.ts && typeof e.dur === "number",
  );
  return {
    longest: Math.max(0, ...tasks.map((t) => t.dur! / 1000)),
    tasks: tasks.length,
  };
}

/** This machine's own frames at rest on this page (half a second with nothing happening): the usual gap and the worst. */
async function restFrame(page: Page): Promise<{ median: number; worst: number }> {
  return page.evaluate(
    () =>
      new Promise<{ median: number; worst: number }>((done) => {
        const ts: number[] = [];
        const tick = (now: number) => {
          ts.push(now);
          if (now - ts[0]! < 500) requestAnimationFrame(tick);
          else {
            const gaps = ts
              .slice(1)
              .map((t, i) => t - ts[i]!)
              .sort((a, b) => a - b);
            done({
              median: gaps[Math.floor(gaps.length / 2)] ?? 16.7,
              worst: gaps.at(-1) ?? 16.7,
            });
          }
        };
        requestAnimationFrame(tick);
      }),
  );
}

/**
 * The frames between the slide's start and its end: how many were drawn, the longest gap, and how many came late:
 * past twice this machine's usual frame at rest, past its worst gap at rest with half a frame more, and past 25 ms
 * (a 60 Hz frame and a half), whichever is the most.
 */
function frames(r: Recorded, rest: { median: number; worst: number }) {
  const slide = r.slides.find((s) => s.id === "glide-slide")!;
  const start = r.tapAt + slide.seenAt;
  const within = r.frames.filter((t) => t >= start - 1 && t <= start + slide.duration + 17);
  const gaps = within.slice(1).map((t, i) => t - within[i]!);
  const late = Math.max(25, 2 * rest.median, rest.worst + rest.median / 2);
  return {
    count: within.length,
    longest: Math.max(0, ...gaps),
    late,
    dropped: gaps.filter((g) => g > late).length,
  };
}

// WebKit here means the Mac app's engine, so its run counts on macOS (as nav-smooth.spec.ts): Playwright's WebKit on
// the Linux CI runners is the GTK/WPE port, which never started the glide's Web Animation there.
test.skip(({ browserName }) => browserName === "webkit" && process.platform !== "darwin", "WebKit's slide is measured on macOS (the Mac app's engine)");

/** Which app each choice of the switch opens (its data-ws-type): the tests find them by it, never by a name. */
const APP = { "Clips Funded": "stories", "Clip Factory": "clips" } as const;
type To = keyof typeof APP;
const choice = (page: Page, to: To) => page.locator(`.ws-dock .ws-switch__opt[data-ws-type="${APP[to]}"]`);

async function tapChoice(page: Page, to: To) {
  const opt = choice(page, to);
  const box = (await opt.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // The pointer came to it: Lamo Stories' code is asked for now (it is here already: the idle fetch brought it).
  await page.waitForTimeout(250);
  await page.mouse.down();
  await page.mouse.up();
}

for (const [label, glass] of [
  ["the browser look", false],
  ["the see-through Mac window", true],
] as const)
  test(`the highlight slides both ways to its end, on the tap's own frame, with no long task and no dropped frame (${label})`, async ({
    page,
    browserName,
  }) => {
    if (glass) await asMacWindow(page);
    await flatBackdrop(page);
    await on(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/library");
    await warm(page);
    const chromium = browserName === "chromium";
    // The slide's timing (dropped frames, frames drawn, the main thread's long tasks) counts where it says something
    // about the slide: on a Mac. The Linux CI runners have 4 cores and no GPU, so Chromium draws this glass page in
    // software at 75 to 200 ms a frame, and a tap's first frame waits behind one (LayerTreeHost::WaitForCommitCompletion):
    // long tasks of 142 to 210 ms and starved frames there (runs 45112115668 and 45134524791) that measure the runner,
    // not the app. The same test failed 2 of 3 runs on the older head 1477c325 under a 4x CPU throttle; no Clips Funded
    // code ran during the slide. Everywhere the slide still has to start on the tap's own frame, run its whole 450 ms
    // on transform only, slow in and slow out, to its end, keep the same switch and change the page only after it.
    const timing = process.platform === "darwin";
    const mainThread = timing;
    for (const [to, url] of [
      ["Clips Funded", /\/stories$/],
      ["Clip Factory", /\/library$/],
    ] as const) {
      const rest = await restFrame(page);
      await record(page);
      const tasks = chromium
        ? await trace(page, () => tapChoice(page, to).then(() => page.waitForURL(url)))
        : (await tapChoice(page, to), await page.waitForURL(url), null);
      if (to === "Clips Funded") await storiesReady(page);
      else await settle(page);
      const r = await page.evaluate(() => (window as unknown as { __slide: Recorded }).__slide);
      const slides = r.slides.filter((s) => s.id === "glide-slide");
      // One slide, a real one (450 ms, as long as the panes', on transform only), run to its end: never cut short by a
      // remount. It runs slow in, slow out: its Web Animation's own curve is the app's --ease-in-out.
      expect(slides, `${to}: one slide`).toHaveLength(1);
      expect(slides[0]!.duration, `${to}: its length (the panes' own)`).toBe(APP_SLIDE_MS);
      expect(curve(slides[0]!.easing), `${to}: slow in, slow out (${slides[0]!.easing})`).toEqual(SLOW_IN_OUT);
      expect(slides[0]!.property, `${to}: transform only`).toBe("transform");
      expect(slides[0]!.end, `${to}: run to its end`).toBe("finished");
      // It began on the tap's own frame: there before the page drew its next frame after the tap's click (the time
      // from the pointer going down to the click is the test machine's own, so it is not counted).
      expect(r.clickAt, `${to}: the tap's click`).not.toBeNull();
      expect(slides[0]!.seenAt - r.clickAt!, `${to}: started at once (on the click's own frame)`).toBeLessThan(Math.max(17, rest.median));
      // The switch stayed mounted, and the page changed only once the slide had landed.
      expect(r.sameBar, `${to}: the same switch before and after`).toBe(true);
      expect(r.changedAt, `${to}: the page changed after the slide`).toBeGreaterThanOrEqual(slides[0]!.seenAt + APP_SLIDE_MS - 20);
      const f = frames(r, rest);
      test.info().annotations.push({
        type: `${browserName} ${label} → ${to}`,
        description: JSON.stringify({
          slideMs: slides[0]!.duration,
          startedAfterClickMs: +(slides[0]!.seenAt - (r.clickAt ?? 0)).toFixed(2),
          framesDrawn: f.count,
          restFrameMs: +rest.median.toFixed(2),
          restWorstMs: +rest.worst.toFixed(2),
          lateAfterMs: +f.late.toFixed(2),
          longestGapMs: +f.longest.toFixed(2),
          droppedFrames: f.dropped,
          longTasksDuringSlide: r.longTasks.filter((t) => t.start >= r.tapAt && t.start <= r.tapAt + slides[0]!.seenAt + APP_SLIDE_MS).length,
          mainThreadLongestTaskMs: tasks ? +tasks.longest.toFixed(2) : "n/a (WebKit)",
          mainThreadTasks: tasks?.tasks ?? "n/a",
        }),
      });
      if (timing)
        expect(
          f.dropped,
          `${to}: dropped frames (longest gap ${f.longest.toFixed(1)} ms, late past ${f.late.toFixed(1)} ms; at rest ${rest.median.toFixed(1)} ms, worst ${rest.worst.toFixed(1)} ms)`,
        ).toBeLessThanOrEqual(1);
      // And it drew frames all the way: at least half the frames this machine draws at rest in its 450 ms.
      if (timing) expect(f.count, `${to}: frames drawn during the slide`).toBeGreaterThanOrEqual(Math.floor(APP_SLIDE_MS / rest.median / 2));
      if (mainThread)
        expect(
          r.longTasks.filter((t) => t.start >= r.tapAt && t.start <= r.tapAt + slides[0]!.seenAt + APP_SLIDE_MS && t.duration > 50),
          `${to}: long tasks during the slide`,
        ).toEqual([]);
      if (tasks && mainThread) {
        expect(tasks.longest, `${to}: the trace found the slide`).toBeGreaterThanOrEqual(0);
        expect(tasks.longest, `${to}: the longest main-thread task during the slide`).toBeLessThanOrEqual(50);
      }
      // The highlight is on the app now on screen.
      await expect(page.locator(".ws-dock .ws-switch__opt.is-on")).toHaveAttribute("data-ws-type", APP[to]);
    }
  });

/** The six frames side by side, in one picture (drawn in the page's own canvas). */
async function strip(page: Page, frames: Buffer[]): Promise<Buffer> {
  const b64 = await page.evaluate(
    async (pngs) => {
      const imgs = await Promise.all(pngs.map(async (p) => createImageBitmap(await (await fetch(`data:image/png;base64,${p}`)).blob())));
      const gap = 8;
      const w = imgs.reduce((n, i) => n + i.width, 0) + gap * (imgs.length - 1);
      const h = Math.max(...imgs.map((i) => i.height));
      const c = new OffscreenCanvas(w, h);
      const x = c.getContext("2d")!;
      x.fillStyle = "#111";
      x.fillRect(0, 0, w, h);
      let at = 0;
      for (const i of imgs) {
        x.drawImage(i, at, 0);
        at += i.width + gap;
      }
      const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
      let out = "";
      for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(out);
    },
    frames.map((f) => f.toString("base64")),
  );
  return Buffer.from(b64, "base64");
}

test.describe("the slide in pictures", () => {
  test.use({ deviceScaleFactor: 2 });
  for (const [label, glass] of [
    ["clip-factory-glass", true],
    ["browser", false],
  ] as const)
    test(`a strip of six frames of the slide, both ways (${label})`, async ({ page, browserName }) => {
      test.skip(browserName !== "chromium", "the pictures come from one browser");
      mkdirSync(SHOTS, { recursive: true });
      if (glass) await asMacWindow(page);
      await on(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/library");
      await warm(page);
      // The slide is held at six moments (the page changes only once it ends, which this test lets it do last).
      for (const [to, from, url] of [
        ["Clips Funded", "clip-factory", /\/stories$/],
        ["Clip Factory", "clips-funded", /\/library$/],
      ] as const) {
        await choice(page, to).click();
        // Everything that moves in the bar at once, held together: the highlight's slide and its words' colour change,
        // and the whole app's slide behind it.
        await page.evaluate((ids) => {
          for (const a of document.querySelector(".ws-dock .ws-switch")!.getAnimations({ subtree: true })) a.pause();
          for (const a of document.getAnimations()) if (ids.includes(a.id)) a.pause();
        }, [APP_SLIDE]);
        expect(await page.evaluate(() => document.querySelector(".ws-dock .glide")!.getAnimations().map((a) => a.id))).toEqual(["glide-slide"]);
        const clip = (await page.locator(".ws-dock .ws-switch").boundingBox())!;
        const area = {
          x: Math.max(0, clip.x - 14),
          y: Math.max(0, clip.y - 14),
          width: clip.width + 28,
          height: clip.height + 70,
        };
        const shots: Buffer[] = [];
        for (const [i, t] of [0, 90, 180, 270, 360, 450].entries()) {
          // The highlight at t, and the whole app at the same moment of its own slide (both 450 ms, in six steps).
          await page.evaluate(
            ([ms, ids]) => {
              for (const a of document.querySelector(".ws-dock .ws-switch")!.getAnimations({ subtree: true })) {
                a.pause();
                a.currentTime = Math.min(ms, Number(a.effect?.getTiming().duration ?? ms) - 0.1);
              }
              for (const a of document.getAnimations())
                if (ids.includes(a.id)) {
                  a.pause();
                  a.currentTime = Math.min(ms, Number(a.effect?.getTiming().duration ?? ms) - 0.1);
                }
            },
            [t, [APP_SLIDE] as string[]] as const,
          );
          const name = `${label}-${from}-to-${to.toLowerCase().replaceAll(" ", "-")}-${i + 1}-${t}ms`;
          shots.push(await page.screenshot({ path: join(SHOTS, `${name}.png`), clip: area }));
          // The sliding window itself: the whole window at that moment.
          await page.screenshot({ path: join(SHOTS, `${name}-window.png`), scale: "css" });
        }
        writeFileSync(join(SHOTS, `${label}-${from}-to-${to.toLowerCase().replaceAll(" ", "-")}-strip.png`), await strip(page, shots));
        // Let it land: the page changes now.
        await page.evaluate((ids) => {
          for (const a of document.querySelector(".ws-dock .ws-switch")!.getAnimations({ subtree: true })) a.finish();
          for (const a of document.getAnimations()) if (ids.includes(a.id)) a.finish();
        }, [APP_SLIDE]);
        await page.waitForURL(url);
        if (to === "Clips Funded") await page.locator(".stories-app[data-ws]").waitFor();
        await page.waitForTimeout(1500);
      }
    });
});

// ---------- The whole app slides like a sliding window ----------

interface PaneAnim {
  /** What it moves: a pane ("clips", "stories") or Clip Factory's own backdrop ("backdrop"). */
  what: string;
  id: string;
  duration: number;
  easing: string;
  property: string;
  /** Its translateX at the start and at the end, in % of the window. */
  from: number | null;
  to: number | null;
  /** When it was first seen (ms after the pointer went down). */
  seenAt: number;
  end?: "finished" | "cancelled";
}

interface PaneFrame {
  /** ms after the pointer went down. */
  t: number;
  path: string;
  /** Each pane's display (none, contents, block). */
  shown: Record<"clips" | "stories", string>;
  sliding: boolean;
  /** The dock's switch and Live chip row, as drawn. */
  dock: string;
  /** Each pane's page, as laid out (offsets, transforms left out). */
  layout: string;
  /** The top of the page going out and of the one coming in, as drawn. */
  outTop: number | null;
  inTop: number | null;
}

interface PaneRun {
  from: "clips" | "stories";
  tapAt: number;
  clickAt: number | null;
  glideAt: number | null;
  /** The switch's lens (its highlight's slide): its length and its curve. */
  glide: { duration: number; easing: string } | null;
  changedAt: number | null;
  anims: PaneAnim[];
  frames: PaneFrame[];
  /** The top of the page on screen just before the tap. */
  topBefore: number | null;
  /** How many times anything took data-app-slide (a pane, or the backdrop). */
  slideMarks: number;
}

/** Starts the in-page recorder of the panes' slide: their Web Animations, and every frame from the tap on. */
async function recordPanes(page: Page) {
  await page.evaluate((id) => {
    const w = window as unknown as { __panes: PaneRun };
    const from = location.pathname.startsWith("/stories") ? "stories" : "clips";
    const to = from === "clips" ? "stories" : "clips";
    const pane = (app: string) => document.querySelector<HTMLElement>(`[data-app-pane="${app}"]`);
    const mainOf = (app: string) => pane(app)?.querySelector("main") ?? null;
    const r: PaneRun = {
      from,
      tapAt: 0,
      clickAt: null,
      glideAt: null,
      glide: null,
      changedAt: null,
      anims: [],
      frames: [],
      topBefore: mainOf(from)?.getBoundingClientRect().top ?? null,
      slideMarks: 0,
    };
    w.__panes = r;
    const startPath = location.pathname;
    document.addEventListener("pointerdown", () => (r.tapAt = performance.now()), { capture: true, once: true });
    document.addEventListener("click", () => (r.clickAt = performance.now() - r.tapAt), { capture: true, once: true });
    const seen = new Set<Animation>();
    const shift = (kf: Keyframe | undefined) => {
      const m = /translateX\((-?[\d.]+)%\)/.exec(String(kf?.transform ?? ""));
      return m ? Number(m[1]) + 0 : null;
    };
    const look = () => {
      if (!r.tapAt) return;
      // Timed before asking: getAnimations() brings the page's styles up to date first, which is this recorder's own
      // work (the app leaves it to the next frame).
      const at = performance.now() - r.tapAt;
      const lens = r.glideAt === null ? document.querySelector(".ws-dock .glide")?.getAnimations().find((a) => a.id === "glide-slide") : undefined;
      if (lens) {
        r.glideAt = at;
        r.glide = { duration: Number(lens.effect?.getTiming().duration ?? 0), easing: String(lens.effect?.getTiming().easing ?? "") };
      }
      for (const a of document.getAnimations()) {
        if (a.id !== id || seen.has(a)) continue;
        seen.add(a);
        const effect = a.effect as KeyframeEffect | null;
        const target = effect?.target as HTMLElement | null;
        const kf = effect?.getKeyframes?.() ?? [];
        const rec: PaneAnim = {
          what: target?.dataset.appPane ?? (target?.classList.contains("backdrop") ? "backdrop" : (target?.className ?? "?")),
          id: a.id,
          duration: Number(effect?.getTiming().duration ?? 0),
          easing: String(effect?.getTiming().easing ?? ""),
          property: Object.keys(kf[0] ?? {})
            .filter((k) => !["offset", "easing", "composite", "computedOffset"].includes(k))
            .join(","),
          from: shift(kf[0]),
          to: shift(kf.at(-1)),
          seenAt: at,
        };
        r.anims.push(rec);
        a.finished.then(
          () => (rec.end = "finished"),
          () => (rec.end = "cancelled"),
        );
      }
    };
    new MutationObserver((list) => {
      for (const m of list) if ((m.target as Element).hasAttribute("data-app-slide") && m.oldValue === null) r.slideMarks++;
      look();
    }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["data-app-slide", "class"], attributeOldValue: true });
    const box = (el: Element | null | undefined) => {
      const b = el?.getBoundingClientRect();
      return b ? [b.x, b.y, b.width, b.height].map((n) => n.toFixed(1)).join(",") : "none";
    };
    const tick = () => {
      if (r.tapAt) {
        look();
        const lay = (["clips", "stories"] as const)
          .map((app) => {
            const c = pane(app)?.firstElementChild as HTMLElement | null | undefined;
            return c ? [c.offsetLeft, c.offsetTop, c.offsetWidth, c.offsetHeight].join(",") : "-";
          })
          .join("|");
        r.frames.push({
          t: performance.now() - r.tapAt,
          path: location.pathname,
          shown: { clips: pane("clips") ? getComputedStyle(pane("clips")!).display : "none", stories: pane("stories") ? getComputedStyle(pane("stories")!).display : "none" },
          sliding: !!document.querySelector("[data-app-pane][data-app-slide]"),
          dock: `${box(document.querySelector(".ws-dock .ws-switch-host"))} ${box(document.querySelector(".ws-dock .ws-dock__live"))}`,
          layout: lay,
          outTop: mainOf(from)?.getBoundingClientRect().top ?? null,
          inTop: mainOf(to)?.getBoundingClientRect().top ?? null,
        });
      }
      if (location.pathname !== startPath && r.changedAt === null) r.changedAt = performance.now() - r.tapAt;
      if (!r.tapAt || performance.now() - r.tapAt < 2200) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, APP_SLIDE);
}

const readPanes = (page: Page) => page.evaluate(() => (window as unknown as { __panes: PaneRun }).__panes);

/** The page settles after a switch: no slide mark left, and the recorder's 2.2 s of frames are in. */
async function landedPanes(page: Page): Promise<PaneRun> {
  await page.waitForFunction(() => {
    const r = (window as unknown as { __panes?: PaneRun }).__panes;
    return !!r && r.tapAt > 0 && performance.now() - r.tapAt > 2300;
  });
  return readPanes(page);
}

test("the whole app slides like a sliding window, both ways: transform only, to its end, with the highlight, the dock still, each page where it was", async ({ page, browserName }) => {
  await flatBackdrop(page);
  await on(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/library");
  await warm(page);
  // The app's slow-in slow-out curve: it starts gently, speeds up in the middle and settles gently.
  const ease = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--ease-in-out").trim());
  expect(curve(ease), `the app's own slow in, slow out (${ease})`).toEqual(SLOW_IN_OUT);
  // Clip Factory's Library scrolled down a little: that is where its page slides out from, and back in to.
  const y = await page.evaluate(() => {
    const to = Math.min(320, document.documentElement.scrollHeight - innerHeight);
    window.scrollTo({ top: to, behavior: "instant" as ScrollBehavior });
    return Math.round(window.scrollY);
  });
  await page.waitForTimeout(300);

  for (const [to, url] of [
    ["Clips Funded", /\/stories$/],
    ["Clip Factory", /\/library$/],
  ] as const) {
    const rest = await restFrame(page);
    await recordPanes(page);
    await tapChoice(page, to);
    await page.waitForURL(url);
    const r = await landedPanes(page);
    const going = to === "Clips Funded" ? "stories" : "clips";
    const label = `${browserName} → ${to}`;

    // Three slides, one Web Animation each, the app's own: Clip Factory's pane, its backdrop with it, and Clips Funded's.
    expect(
      r.anims.map((a) => a.what).sort(),
      `${label}: what slides`,
    ).toEqual(["backdrop", "clips", "stories"]);
    for (const a of r.anims) {
      expect(a.duration, `${label}: ${a.what}'s length`).toBeGreaterThanOrEqual(420);
      expect(a.duration, `${label}: ${a.what}'s length`).toBeLessThanOrEqual(480);
      expect(a.duration, `${label}: ${a.what}'s length`).toBe(APP_SLIDE_MS);
      expect(a.property, `${label}: ${a.what} moves on transform only`).toBe("transform");
      expect(curve(a.easing), `${label}: ${a.what} slow in, slow out (${a.easing})`).toEqual(SLOW_IN_OUT);
      expect(a.end, `${label}: ${a.what} ran to its end`).toBe("finished");
    }
    // Clip Factory on the left, Clips Funded on the right: to Clips Funded everything moves left, back it moves right.
    const by = (what: string) => r.anims.find((a) => a.what === what)!;
    const way = going === "stories" ? -100 : 100;
    const clipsWay = going === "stories" ? [0, way] : [-way, 0];
    const storiesWay = going === "stories" ? [-way, 0] : [0, way];
    expect([by("clips").from, by("clips").to], `${label}: Clip Factory's pane`).toEqual(clipsWay);
    expect([by("backdrop").from, by("backdrop").to], `${label}: Clip Factory's backdrop, with its pane`).toEqual(clipsWay);
    expect([by("stories").from, by("stories").to], `${label}: Clips Funded's pane`).toEqual(storiesWay);

    // It starts on the tap, with the highlight's own slide (the same frame), and the page changes once it landed.
    expect(r.clickAt, `${label}: the tap's click`).not.toBeNull();
    expect(r.glideAt, `${label}: the highlight slid`).not.toBeNull();
    // The switch's lens moves with them as one: the same curve, for the same length.
    expect(r.glide!.duration, `${label}: the lens as long as the panes`).toBe(APP_SLIDE_MS);
    expect(curve(r.glide!.easing), `${label}: the lens slow in, slow out (${r.glide!.easing})`).toEqual(SLOW_IN_OUT);
    // On the tap means in the tap's own task: no frame was drawn between the click and the panes' slide, nor between
    // the highlight's slide and theirs (how long that task takes is the test machine's own, so it is only held under
    // a long task).
    const start = Math.min(...r.anims.map((a) => a.seenAt));
    const framesBetween = (a: number, b: number) => r.frames.filter((f) => f.t > Math.min(a, b) && f.t < Math.max(a, b)).length;
    expect(framesBetween(r.clickAt!, start), `${label}: started on the tap (no frame drawn before it)`).toBe(0);
    expect(framesBetween(r.glideAt!, start), `${label}: with the highlight (on the same frame)`).toBe(0);
    expect(start - r.clickAt!, `${label}: started on the tap (no long task before it)`).toBeLessThan(50);
    expect(r.changedAt, `${label}: the page changed once the panes landed`).toBeGreaterThanOrEqual(start + APP_SLIDE_MS - 20);

    // Both panes are on screen only while they slide; before and after, only the app on screen is.
    const during = r.frames.filter((f) => f.sliding);
    const after = r.frames.filter((f) => !f.sliding && f.t > (r.changedAt ?? Infinity));
    expect(during.length, `${label}: frames drawn while it slid`).toBeGreaterThan(2);
    for (const f of during) expect([f.shown.clips, f.shown.stories], `${label}: both panes on screen at ${f.t.toFixed(0)} ms`).toEqual(["block", "block"]);
    expect(after.length, `${label}: frames after it landed`).toBeGreaterThan(2);
    for (const f of after) {
      expect(f.shown[going], `${label}: the app now on screen at ${f.t.toFixed(0)} ms`).toBe("contents");
      expect(f.shown[going === "clips" ? "stories" : "clips"], `${label}: the other app hidden at ${f.t.toFixed(0)} ms`).toBe("none");
    }
    // Nothing is laid out again while they move (only their transforms change): every page box the same from the
    // second frame on (the first frame puts the page coming in at its place).
    expect(new Set(during.slice(1).map((f) => f.layout)).size, `${label}: no layout while it slid (${[...new Set(during.map((f) => f.layout))].join(" / ")})`).toBe(1);
    // The dock (the switch and the Live chip) never moves.
    expect(new Set(r.frames.map((f) => f.dock)).size, `${label}: the dock stayed put (${[...new Set(r.frames.map((f) => f.dock))].join(" / ")})`).toBe(1);
    // Each page where it is scrolled to: the one going out exactly where it was, the one coming in where it then lands.
    expect(during[0]!.outTop, `${label}: the page going out stays where it was`).toBeCloseTo(r.topBefore!, 0);
    expect(after[0]!.inTop, `${label}: the page coming in lands where it slid in`).toBeCloseTo(during.at(-1)!.inTop!, 0);
    // At rest again: no slide mark, no will-change, the page's own height, the window at the page's own place.
    const restNow = await page.evaluate(() => ({
      marks: document.querySelectorAll("[data-app-slide]").length,
      willChange: Array.from(document.querySelectorAll<HTMLElement>("[data-app-pane]")).map((p) => getComputedStyle(p).willChange),
      minHeight: document.documentElement.style.minHeight,
      left: document.getAnimations().filter((a) => a.id === "app-slide").length,
      scrollY: Math.round(window.scrollY),
      focus: document.activeElement === document.querySelector("[data-app-pane]:not([hidden]) main"),
    }));
    expect(restNow.marks, `${label}: no slide mark left`).toBe(0);
    expect(restNow.willChange, `${label}: will-change only while it slid`).toEqual(restNow.willChange.map(() => "auto"));
    expect(restNow.minHeight, `${label}: the page's own height`).toBe("");
    expect(restNow.left, `${label}: no slide left over`).toBe(0);
    if (going === "clips") {
      // Back in Clip Factory: its Library where the owner left it, and focus on its page (its heading comes first).
      expect(restNow.scrollY, `${label}: Clip Factory's scroll kept`).toBe(y);
      expect(restNow.focus, `${label}: focus on the page`).toBe(true);
    } else expect(restNow.scrollY, `${label}: Clips Funded's first visit opens at its top`).toBe(0);
    test.info().annotations.push({
      type: `${label}: the panes' slide`,
      description: JSON.stringify({
        startedAfterClickMs: +(start - r.clickAt!).toFixed(2),
        withHighlightMs: +(start - r.glideAt!).toFixed(2),
        framesWhileSliding: during.length,
        longestGapMs: +Math.max(0, ...during.slice(1).map((f, i) => f.t - during[i]!.t)).toFixed(2),
        restFrameMs: +rest.median.toFixed(2),
        changedAtMs: +(r.changedAt ?? 0).toFixed(1),
      }),
    });
    if (going === "stories") await storiesReady(page);
    else await settle(page);
  }
});

for (const [label, how] of [
  ["the device asks for less motion", "device"],
  ["each app's own Calm motion", "own"],
] as const)
  test(`calm motion never slides the panes: the switch is at once, both ways (${label})`, async ({ page }) => {
    await stillBackdrop(page);
    await on(page);
    if (how === "device") await page.emulateMedia({ reducedMotion: "reduce" });
    // Clips Funded's own switch (its Settings card writes it on the device).
    else await page.addInitScript(() => localStorage.setItem("cf.stories.prefs", JSON.stringify({ setupShown: ["stories"], more: { "motion.reduce": true } })));
    await page.setViewportSize({ width: 1440, height: 900 });
    if (how === "own") {
      // Clip Factory's own, from its Settings (the account's setting: the server's answer wins over the device's copy).
      await page.goto("/settings/look-and-feel/motion");
      await settle(page);
      await page.getByRole("switch", { name: "Reduce motion" }).click();
      await expect(page.locator("html")).toHaveClass(/(^|\s)reduce-motion(\s|$)/);
      await page.locator('.sidebar a[href="/library"]').click();
      await page.waitForURL(/\/library$/);
    } else await page.goto("/library");
    await warm(page);
    for (const [to, url] of [
      ["Clips Funded", /\/stories$/],
      ["Clip Factory", /\/library$/],
    ] as const) {
      await recordPanes(page);
      await tapChoice(page, to);
      await page.waitForURL(url);
      const r = await landedPanes(page);
      expect(r.anims, `${how} → ${to}: nothing slid`).toEqual([]);
      expect(r.slideMarks, `${how} → ${to}: no pane ever left its place`).toBe(0);
      expect(r.frames.filter((f) => f.shown.clips !== "none" && f.shown.stories !== "none"), `${how} → ${to}: never both on screen`).toEqual([]);
      expect(r.changedAt, `${how} → ${to}: the page changed at once`).toBeLessThan(300);
      if (to === "Clips Funded") await storiesReady(page);
      else await settle(page);
    }
  });
