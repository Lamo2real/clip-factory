// TikTok Studio in the helper's Chrome: list the posts, upload one clip, confirm it went up.
//
// Rules (research: side-session notes tiktok-mac-automation-research.md §3):
// - Never guess. A login page, a puzzle, "Something went wrong", an unknown pop-up or a setting that did not stick
//   stops the try (Stop) before Post is pressed. No puzzle solving, no anti-detection tricks, no typed passwords.
// - Every setting is read back before Post. TikTok carries the last post's privacy over, so it is set every time.
// - Success is a new row in Studio › Posts with this caption, never just a redirect.
import { captionMatches, findExisting, findNewPost, normalize, postLink, videoId } from "./match.js";

export const STUDIO = "https://www.tiktok.com/tiktokstudio";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Stop extends Error {
  /** @param {string} reason plain words for the owner @param {{needsYou?: boolean}} [opts] */
  constructor(reason, { needsYou = false } = {}) {
    super(reason);
    this.reason = reason;
    this.needsYou = needsYou;
  }
}

export const REASONS = {
  login: "TikTok logged your Mac out. Log in to TikTok again on your Mac.",
  captcha: "TikTok wants a check (a puzzle or a code). Do it on your Mac, then tap Try again.",
  wrong: "TikTok said \"Something went wrong\". Try again later, or post it yourself.",
  restricted: "TikTok said this video may be restricted. Check it, then post it yourself.",
  popup: (text) => `TikTok showed something new: "${text}". Check it on your Mac, then tap Try again.`,
  noUpload: "TikTok's upload page looks different. Clip Factory will fix your Mac's helper; post it yourself for now.",
  uploadFailed: "TikTok couldn't take the video. Try again, or post it yourself.",
  slow: "TikTok took too long with the video. Try again later.",
  caption: "The caption didn't go in right on TikTok. Post it yourself for now.",
  privacy: (want) => `TikTok didn't keep "${want}" for who can watch. Post it yourself for now.`,
  toggle: (name) => `TikTok didn't keep ${name} the way it should be. Post it yourself for now.`,
  toggleOff: (name) => `TikTok has ${name} turned off for your account. Turn it on in TikTok's settings, then tap Try again.`,
  noPost: "TikTok's Post button didn't work. Post it yourself for now.",
};

const PRIVACY_WORDS = {
  PUBLIC_TO_EVERYONE: "Everyone",
  MUTUAL_FOLLOW_FRIENDS: "Friends",
  FOLLOWER_OF_CREATOR: "Followers",
  SELF_ONLY: "Only you",
};

export function privacyWord(privacy) {
  return PRIVACY_WORDS[privacy] || "Everyone";
}

// ---------------------------------------------------------------------------------------------------------------
// What is on the page

async function visibleText(page) {
  try {
    return await page.evaluate(() => document.body?.innerText || "");
  } catch {
    return "";
  }
}

/** A blocker that must stop the try: a login, a check, or TikTok's own error. */
export async function blocker(page) {
  const url = page.url();
  if (/\/login(\/|\?|$)/.test(url)) return new Stop(REASONS.login, { needsYou: true });
  const captcha = await page
    .locator('#captcha_container, [id*="captcha" i], [class*="captcha" i], iframe[src*="captcha" i]')
    .first()
    .isVisible()
    .catch(() => false);
  if (captcha) return new Stop(REASONS.captcha, { needsYou: true });
  const text = await visibleText(page);
  if (/verify to continue|drag the (slider|puzzle)|select \d+ objects|enter the code we sent/i.test(text)) {
    return new Stop(REASONS.captcha, { needsYou: true });
  }
  if (/log in to tiktok|log in to continue/i.test(text) && !/upload|posts/i.test(url)) {
    return new Stop(REASONS.login, { needsYou: true });
  }
  if (/something went wrong/i.test(text)) return new Stop(REASONS.wrong);
  if (/content may be restricted/i.test(text)) return new Stop(REASONS.restricted);
  return null;
}

async function check(page) {
  const stop = await blocker(page);
  if (stop) throw stop;
}

// Harmless pop-ups that are always safe to close: the cookie banner and the first-visit tours.
const HARMLESS = [/^decline optional cookies$/i, /^got it$/i, /^skip$/i, /^not now$/i, /^close$/i, /^dismiss$/i];

// TikTok's first-run questions, answered so nothing on his account changes (seen 22 Nov 2026 on the first upload).
// "Turn on automatic content checks?" → Cancel: his settings stay as they are (he can turn it on in Profile ›
// Settings). Anything else unknown still stops the try before Post.
export const KNOWN_DIALOGS = [{ text: /turn on automatic content checks\?/i, button: /^cancel$/i }];

async function dismissHarmless(page) {
  for (let round = 0; round < 3; round++) {
    let clicked = false;
    for (const known of KNOWN_DIALOGS) {
      const box = page.getByRole("dialog").filter({ hasText: known.text }).first();
      if (await box.isVisible().catch(() => false)) {
        const btn = box.getByRole("button", { name: known.button }).first();
        if (await btn.isVisible().catch(() => false)) {
          await btn.click({ timeout: 3000 }).catch(() => {});
          clicked = true;
          await sleep(600);
        }
      }
    }
    for (const name of HARMLESS) {
      const btn = page.getByRole("button", { name }).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ timeout: 3000 }).catch(() => {});
        clicked = true;
        await sleep(400);
      }
    }
    if (!clicked) return;
  }
}

async function openDialogText(page) {
  const dialogs = page.locator('[role="dialog"]:visible, [class*="modal" i]:visible');
  const n = await dialogs.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const text = ((await dialogs.nth(i).innerText().catch(() => "")) || "").trim();
    if (text) return text.replace(/\s+/g, " ").slice(0, 80);
  }
  return null;
}

export async function goto(page, path) {
  await page.goto(`${STUDIO}/${path}${path.includes("?") ? "&" : "?"}lang=en`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  await sleep(1500);
  await dismissHarmless(page);
  await check(page);
}

/** Is the helper's Chrome logged in to TikTok? (setup and status) */
export async function loggedIn(page) {
  const cookies = await page.context().cookies("https://www.tiktok.com");
  return cookies.some((c) => c.name === "sessionid" && c.value);
}

// ---------------------------------------------------------------------------------------------------------------
// Studio › Posts

/** The rows of Studio › Posts: each video's id, link and the text around it (its caption). */
export async function listPosts(page) {
  await goto(page, "content");
  await page.locator('a[href*="/video/"]').first().waitFor({ timeout: 30_000 }).catch(() => {});
  const rows = await page.$$eval('a[href*="/video/"]', (anchors) => {
    const out = [];
    for (const a of anchors) {
      const id = (/\/video\/(\d{6,})/.exec(a.href) || [])[1];
      if (!id) continue;
      // Climb to the smallest box around this video that has some text and no other video in it.
      let box = a;
      for (let i = 0; i < 8 && box.parentElement; i++) {
        const up = box.parentElement;
        const ids = new Set(
          [...up.querySelectorAll('a[href*="/video/"]')].map((x) => (/\/video\/(\d{6,})/.exec(x.href) || [])[1])
        );
        if (ids.size > 1) break;
        box = up;
      }
      out.push({ id, href: a.href, text: (box.innerText || "").slice(0, 2000) });
    }
    return out;
  });
  const seen = new Map();
  for (const r of rows) {
    const prev = seen.get(r.id);
    if (!prev || r.text.length > prev.text.length) seen.set(r.id, r);
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------------------------------------------
// Uploading

async function waitForUpload(page) {
  const started = Date.now();
  while (Date.now() - started < 12 * 60_000) {
    await check(page);
    const text = await visibleText(page);
    if (/couldn.t upload|upload failed|unsupported file|file (is )?too (large|big)/i.test(text)) {
      throw new Stop(REASONS.uploadFailed);
    }
    const post = postButton(page);
    const ready = (await post.isVisible().catch(() => false)) && (await post.isEnabled().catch(() => false));
    const uploading = /uploading|\d{1,3}\s?%/i.test(text) && !/uploaded/i.test(text);
    if (ready && !uploading) return;
    await sleep(2000);
  }
  throw new Stop(REASONS.slow);
}

function postButton(page) {
  return page.locator('[data-e2e="post_video_button"], button:has-text("Post"):not(:has-text("Posts"))').first();
}

async function setCaption(page, caption) {
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.waitFor({ timeout: 20_000 }).catch(() => {
    throw new Stop(REASONS.noUpload);
  });
  await editor.click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.press("Backspace");
  await sleep(300);
  await page.keyboard.type(caption, { delay: 12 });
  await sleep(600);
  // Close a hashtag or mention list by clicking the section's own heading.
  await page.getByText("Description", { exact: true }).first().click({ timeout: 2000 }).catch(() => {});
  await sleep(400);
  const typed = normalize(await editor.innerText().catch(() => ""));
  const want = normalize(caption);
  // Studio turns hashtags into tags, so compare without the # marks and spaces.
  const squash = (s) => s.replace(/[#\s]/g, "");
  if (!squash(typed).startsWith(squash(want).slice(0, 60))) throw new Stop(REASONS.caption);
}

async function sectionOf(page, heading) {
  const label = page.getByText(heading, { exact: true }).first();
  if (!(await label.isVisible().catch(() => false))) return null;
  // The heading's nearest box that also holds a control.
  return label.locator("xpath=ancestor::*[.//*[@role='combobox'] or .//select][1]");
}

async function setPrivacy(page, privacy) {
  const want = privacyWord(privacy);
  // Studio's heading was "Who can watch this video"; since late 2026 it is "Who can see this post".
  const section = (await sectionOf(page, "Who can see this post")) || (await sectionOf(page, "Who can watch this video"));
  if (!section) throw new Stop(REASONS.noUpload);
  const current = normalize(await section.innerText().catch(() => ""));
  if (!current.includes(normalize(want)) || current.includes("only you") || current.includes("friends")) {
    const control = section.locator("[role='combobox'], select").first();
    await control.click();
    await sleep(500);
    const option = page.getByRole("option", { name: want, exact: true }).first();
    if (await option.isVisible().catch(() => false)) await option.click();
    else await page.getByText(want, { exact: true }).last().click({ timeout: 5000 }).catch(() => {});
    await sleep(500);
  }
  const after = normalize(await section.innerText().catch(() => ""));
  if (!after.includes(normalize(want))) throw new Stop(REASONS.privacy(want));
  for (const other of ["Only you", "Friends", "Followers"]) {
    if (other !== want && after.includes(normalize(other)) && !after.includes(normalize(want))) {
      throw new Stop(REASONS.privacy(want));
    }
  }
}

/** The checkbox or switch whose own text (its nearest box with text) starts with ``name``; its id, or null. */
async function switchId(page, name) {
  return page.evaluate((want) => {
    const norm = (t) => (t || "").trim().split("\n")[0].trim().toLowerCase();
    for (const inp of document.querySelectorAll('input[type=checkbox], [role=switch], [role=checkbox]')) {
      let el = inp;
      for (let k = 0; k < 6 && el; k++, el = el.parentElement) {
        const t = norm(el.innerText);
        if (t) {
          if (t === want.toLowerCase()) {
            if (!inp.id) inp.id = `cf-switch-${Math.random().toString(36).slice(2)}`;
            return inp.id;
          }
          break;
        }
      }
    }
    return null;
  }, name);
}

async function setToggle(page, name, on) {
  let id = await switchId(page, name);
  if (!id) {
    const more = page.getByText("Show more", { exact: true }).first();
    if (await more.isVisible().catch(() => false)) {
      await more.click();
      await sleep(800);
    }
    id = await switchId(page, name);
  }
  if (!id) return false; // not on this page (the caller decides whether that is a stop)
  const box = page.locator(`[id="${id}"]`);
  if (await box.isDisabled().catch(() => false)) {
    if (on && !(await box.isChecked().catch(() => false))) throw new Stop(REASONS.toggleOff(name), { needsYou: true });
    return true;
  }
  const isOn = async () => box.isChecked().catch(async () => (await box.getAttribute("aria-checked")) === "true");
  if ((await isOn()) !== on) {
    await box.click({ force: true });
    await sleep(400);
  }
  if ((await isOn()) !== on) throw new Stop(REASONS.toggle(name));
  return true;
}

/** Comment, Duet and Stitch as the job says. Studio now has one "Reuse of content" switch for Duet and Stitch. */
async function setInteractions(page, job) {
  if (!(await setToggle(page, "Comment", job.comment !== false))) throw new Stop(REASONS.noUpload);
  const reuse = job.duet !== false || job.stitch !== false;
  if (!(await setToggle(page, "Reuse of content", reuse))) {
    // An older layout with separate switches.
    if (!(await setToggle(page, "Duet", job.duet !== false))) throw new Stop(REASONS.noUpload);
    if (!(await setToggle(page, "Stitch", job.stitch !== false))) throw new Stop(REASONS.noUpload);
  }
  // Never limit who can see it (the owner's most reach): Audience control (18+) stays off.
  await setToggle(page, "Audience control", false);
}

/**
 * Uploads one clip and presses Post. ``onStep(step)`` is called before each stage; it must have recorded "pressing"
 * (on disk and on the server) before it returns for that step, because pressing is the point of no return.
 * @returns {Promise<{link: string|null, sure: boolean}>} ``sure`` = TikTok said it posted or the new row was found.
 */
export async function post(page, job, file, onStep, { dryRun = false } = {}) {
  await onStep("opening");
  const before = await listPosts(page);
  const existing = findExisting(before, job.caption);
  if (existing) return { link: postLink(existing.href), sure: true, existing: true };
  const baseline = before.map((r) => r.id);

  await goto(page, "upload");
  const input = page.locator('input[type="file"]').first();
  await input.waitFor({ state: "attached", timeout: 30_000 }).catch(() => {
    throw new Stop(REASONS.noUpload);
  });
  await onStep("uploading");
  await input.setInputFiles(file);
  await sleep(3000);
  await waitForUpload(page);
  await dismissHarmless(page); // TikTok's first-run questions come up once the video is in

  await onStep("settings");
  await dismissHarmless(page);
  await setCaption(page, job.caption);
  await setPrivacy(page, job.privacy);
  await setInteractions(page, job);
  await check(page);
  const dialog = await openDialogText(page);
  if (dialog) throw new Stop(REASONS.popup(dialog));
  const button = postButton(page);
  if (!(await button.isEnabled().catch(() => false))) throw new Stop(REASONS.noPost);
  if (dryRun) {
    // A check run: everything up to Post, then nothing. Quitting Chrome afterwards throws the upload away.
    return { dryRun: true, link: null, sure: false, posts: before.length, baseline };
  }

  await onStep("pressing", { baseline }); // the point of no return: recorded before the click
  await button.click();

  // After the press: TikTok may ask once more while its checks run ("Continue to post?" › "Post now").
  let said = false;
  const started = Date.now();
  while (Date.now() - started < 90_000) {
    const now = page.getByRole("button", { name: /^post now$/i }).first();
    if (await now.isVisible().catch(() => false)) await now.click().catch(() => {});
    const text = await visibleText(page);
    if (/your video(s)? (has|have) been (uploaded|posted)|manage posts|video posted/i.test(text)) said = true;
    if (/\/tiktokstudio\/content/.test(page.url())) said = true;
    if (said) break;
    if (/something went wrong/i.test(text)) break;
    await sleep(1500);
  }

  await onStep("finding");
  for (let i = 0; i < 10; i++) {
    const rows = await listPosts(page).catch(() => []);
    const found = findNewPost(rows, job.caption, baseline);
    if (found) return { link: postLink(found.href), sure: true };
    await sleep(30_000);
  }
  return { link: null, sure: said };
}

/** After a crash once Post was pressed: look for the post, never post again. */
export async function find(page, job, sinceIds = []) {
  const rows = await listPosts(page);
  const found = sinceIds.length ? findNewPost(rows, job.caption, sinceIds) : findExisting(rows, job.caption);
  return found ? postLink(found.href) : null;
}

export { captionMatches, videoId };
