// The click counts of docs/CONTRACTS.md §39.1 and §39.5: how many taps each way takes, the normal way's own controls
// (frozen: the campaign way never adds a step, field or warning to it), and one counting helper every click and key
// press that acts goes through, which fails as soon as the count is over. Plain data and a small class, so Vitest
// (web/test/twoWays.test.ts) reads the same numbers.
import type { Locator, Page } from "@playwright/test";

/** Home's Paste, Make clips, Go to Review, Use my settings, Upload to N. */
export const NORMAL_WAY_TAPS = 5;
/** The row chip, Paste (or a campaign video), Make campaign clips, Go to Review, Use my settings, Upload to 2. */
export const CAMPAIGN_WAY_TAPS = 6;
/** Make a FaZe Clips copy, then on the copy Use my settings and Upload to 2. */
export const COPY_TAPS = 3;
/** Paste, Add campaign, Connect Content Rewards (card), Yes, Connect Content Rewards (step 3), allow, Back to FaZe Clips. */
export const CONNECT_TAPS_DONE = 7;
/** From zero: the 9 Clip Factory taps up to "Back to FaZe Clips" and the pretend allow (1); "Open campaign" comes next. */
export const CONNECT_CF_TAPS_FROM_ZERO = 10;

/**
 * Home's form at `/` (the normal way), as origin/main drew it before campaigns: role and accessible name of every
 * labelled control. The link box's Paste turns into Clear once it holds text; Number of clips shows only for Exactly.
 */
export const NORMAL_HOME_CONTROLS = {
  empty: [
    "radio:Paste a link",
    "radio:Pick a video",
    "textbox:YouTube, Twitch or Kick link",
    "button:Paste",
    "radio:Pick for me (5–10)",
    "radio:Exactly",
    "textbox:Notes for Clip Factory you can skip this",
    "button:Make clips",
  ],
  /** With a link in the box: Clear instead of Paste. */
  withLink: [
    "radio:Paste a link",
    "radio:Pick a video",
    "textbox:YouTube, Twitch or Kick link",
    "button:Clear link",
    "radio:Pick for me (5–10)",
    "radio:Exactly",
    "textbox:Notes for Clip Factory you can skip this",
    "button:Make clips",
  ],
} as const;

/**
 * The Review card of a normal clip as origin/main drew it (no TikTok, YouTube and Instagram set up, the first card),
 * role and accessible name of each control in page order, times and counts written as {t} and {n}. A fitting
 * campaign adds exactly two optional controls (`NORMAL_REVIEW_EXTRA`), right under Checks before posting.
 */
export const NORMAL_REVIEW_CONTROLS: readonly string[] = [
  "link:From {t} to {t} in the source (opens in a new tab)",
  "summary:Checks before posting{n} of {n} passed",
  "button:YouTube",
  "button:Instagram",
  "link:Set up TikTok, Facebook and X to upload there too.",
  "button:Your settings are on",
  "summary:YouTube · title, description and settingsWho can see it: Everyone · Made for kids: No · Gaming",
  "textbox:Title",
  "textbox:Description",
  "radio:Everyone",
  "radio:Link only",
  "radio:Only me",
  "button:Category Gaming",
  "button:Made for kids",
  "button:Tell my subscribers",
  "summary:Instagram · caption and settingsReel · also in your feed",
  "textbox:Instagram caption",
  "button:Also show it in my feed",
  "button:Throw away",
  "button:Upload to 2",
  "link:See the job this clip came from",
];
export const NORMAL_REVIEW_EXTRA = ["button:Make a {campaign} copy", "button:Not now"] as const;

/** Every control inside `selector` that a tap can reach, as "role:name" (times and counts as {t} and {n}). */
export async function controlsIn(page: Page, selector: string): Promise<string[]> {
  const raw = await page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return [];
    const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
    const name = (el: Element) => {
      const aria = el.getAttribute("aria-label");
      if (aria) return aria;
      const by = el.getAttribute("aria-labelledby");
      if (by) return by.split(/\s+/).map((id) => text(document.getElementById(id))).join(" ").trim();
      if (el.id) {
        const l = document.querySelector(`label[for="${el.id}"]`);
        if (l) return text(l);
      }
      const lab = el.closest("label");
      if (lab && (el as HTMLInputElement).type === "radio") return text(lab);
      return text(el);
    };
    const role = (el: Element) => {
      const t = el.tagName.toLowerCase();
      if (t === "input") return (el as HTMLInputElement).type === "radio" ? "radio" : (el as HTMLInputElement).type === "file" ? "file" : "textbox";
      if (t === "textarea") return "textbox";
      if (t === "a") return "link";
      return t;
    };
    return [...root.querySelectorAll("a[href], button, input, textarea, select, summary")]
      .filter((el) => {
        // "Like clips that did well" (§14.6): its tiles are links out to other clips, never a step on the way to
        // Upload, and they come in when the search answers (library-audit.spec checks them).
        if (el.closest(".similar")) return false;
        if ((el as HTMLInputElement).type === "radio") return !!el.closest("label")?.getBoundingClientRect().width;
        const r = (el as HTMLElement).getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .map((el) => `${role(el)}:${name(el)}`);
  }, selector);
  return raw.map((c) => c.replace(/\d+:\d{2}(:\d{2})?/g, "{t}").replace(/\d+ of \d+ passed/g, "{n} of {n} passed"));
}

/** Counts every tap that acts; throws the moment it goes over `max`. */
export class Taps {
  count = 0;
  readonly log: string[] = [];
  constructor(readonly max: number) {}

  private take(what: string) {
    this.count++;
    this.log.push(what);
    if (this.count > this.max) throw new Error(`${this.count} taps, more than ${this.max}: ${this.log.join(" → ")}`);
  }

  /** One tap on a control. */
  async tap(target: Locator, what?: string): Promise<void> {
    this.take(what ?? (await target.first().innerText().catch(() => "?")).trim().split("\n")[0]!);
    await target.click();
  }

  /** One key press that acts (Command+V in the link box, Enter). */
  async press(target: Locator, key: string): Promise<void> {
    this.take(key);
    await target.press(key);
  }

  /** A tap that happens outside the app's page (the pretend Content Rewards allow page). */
  outside(what: string): void {
    this.take(what);
  }
}

export function tap(max: number): Taps {
  return new Taps(max);
}
