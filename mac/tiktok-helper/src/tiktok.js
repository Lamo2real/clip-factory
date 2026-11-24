// TikTok Studio in the helper's Chrome: list the posts, upload one clip, confirm it went up.
//
// Rules (research: side-session notes tiktok-mac-automation-research.md §3):
// - Never guess. A login page, a puzzle, "Something went wrong", an unknown pop-up or a setting that did not stick
//   stops the try (Stop) before Post is pressed. No puzzle solving, no anti-detection tricks, no typed passwords.
// - Every setting is read back before Post. TikTok carries the last post's privacy over, so it is set every time.
// - Success is a new row in Studio › Posts with this caption, never just a redirect.
// - 1.2.0 (§47.10, D3, D4): before Studio › Posts is read, right before Post and before every look for a link, the
//   signed-in account must be the lane's target (whoami.js). A Clips Funded post also turns on TikTok's
//   "AI-generated content" label and keeps "Disclose post content" off, or it doesn't post.
// - 1.3.0 (§47.9): Clip Factory's posts get TikTok's commercial content disclosure from the job (``brandContent``:
//   Branded content, the "Paid partnership" label every campaign clip needs; ``brandOrganic``: Your brand), read back
//   before Post like privacy. A job without a label keeps "Disclose post content" off (read back too).
import { loginOutcome } from "./login.js";
import { captionMatches, findExisting, findNewPost, normalize, postLink, videoId } from "./match.js";
import { accountInfo, at, bare, mergeSeen, sameAccount, sessionHash, whoAmI } from "./whoami.js";

export const STUDIO = "https://www.tiktok.com/tiktokstudio";
export const HOME_URL = "https://www.tiktok.com/?lang=en";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Stop extends Error {
  /**
   * @param {string} reason plain words for the owner
   * @param {{needsYou?: boolean, wrongAccount?: boolean, seen?: string, unknown?: boolean, blank?: boolean}} [opts]
   *   ``wrongAccount``: TikTok is logged in as another account (``seen``); ``unknown``: the account couldn't be read
   *   (``blank``: nothing at all was readable, as when TikTok ended the session but its cookie stayed)
   */
  constructor(reason, { needsYou = false, wrongAccount = false, seen, unknown = false, blank = false } = {}) {
    super(reason);
    this.reason = reason;
    this.needsYou = needsYou;
    if (wrongAccount) this.wrongAccount = true;
    if (seen) this.seen = seen;
    if (unknown) this.unknown = true;
    if (blank) this.blank = true;
  }
}

export const REASONS = {
  login: "TikTok logged your Mac out. Log in to TikTok again on your Mac.",
  captcha: "TikTok wants a check (a puzzle or a code). Do it on your Mac, then tap Try again.",
  wrong: "TikTok said \"Something went wrong\". Tap Try again in a few minutes.",
  restricted: "TikTok said this video may be restricted. Check the clip, then tap Try again.",
  popup: (text) => `TikTok showed something new: "${text}". Check it on your Mac, then tap Try again.`,
  noUpload: "TikTok's upload page looks different. Clip Factory will fix your Mac's helper; then tap Try again.",
  uploadFailed: "TikTok couldn't take the video. Tap Try again.",
  slow: "TikTok took too long with the video. Try again later.",
  caption: "The caption didn't go in right on TikTok. Tap Try again.",
  privacy: (want) => `TikTok didn't keep "${want}" for who can watch. Tap Try again.`,
  toggle: (name) => `TikTok didn't keep ${name} the way it should be. Tap Try again.`,
  toggleOff: (name) => `TikTok has ${name} turned off for your account. Turn it on in TikTok's settings, then tap Try again.`,
  noPost: "TikTok's Post button didn't work. Tap Try again.",
  noLoginPage: "TikTok's login page looks different. Log in on your Mac.",
  limit: "TikTok says it's posting too much right now. The rest wait; Clip Factory tells you.",
  // 1.2.0, both lanes (§47.10.5).
  wrongAccount: (seen, target) => `Your Mac is logged in to TikTok as ${seen}, not ${target}. Nothing was posted.`,
  whoUnknown: "Your Mac couldn't see which TikTok it's logged in to. Nothing was posted. Tap Try again.",
  linkElsewhere: (seen, target) => `The post showed up on ${seen}, not ${target}. Look on your TikTok.`,
  // Clip Factory's lane: its TikTok in Settings is a Clips Funded account (rule 1: never cross accounts).
  otherWorkspaceClips: "That TikTok account is your other workspace's. Nothing was posted. Connect TikTok again in Settings › Posting.",
  // Clips Funded only.
  otherWorkspace: "That TikTok account is your other workspace's. Nothing was posted. Connect TikTok again in Social accounts.",
  aiLabel: "Your Mac couldn't turn on TikTok's AI label, so it didn't post. Tap Try again.",
  // 1.3.0, Clip Factory's lane: the disclosure didn't come out as the job says (on, off, or the wrong label).
  label: "Your Mac couldn't set TikTok's Branded content label the way this clip needs, so it didn't post. Tap Try again.",
  videoGone: "The video is gone. Make it again, then tap Try again.",
};

/**
 * A Clips Funded lane's words: the same as Clip Factory's, except where those name the app or the Keychain login
 * (§47.10.5). Never "Clip Factory" here.
 */
export const WS_REASONS = Object.freeze({
  ...REASONS,
  login: "TikTok logged your Mac out. Tap Log in on my Mac.",
  // Nothing readable three times (TikTok may have ended the session on its side): a new login fixes it.
  nobody: "Your Mac couldn't see which TikTok it's logged in to. Nothing was posted. Tap Log in on my Mac.",
  noUpload: "TikTok's upload page looks different. Your Mac's helper needs a fix. Then tap Try again.",
  limit: "TikTok says it's posting too much right now. The rest wait.",
});

/** A stop reason in the lane's words: Clip Factory's texts that name the app or the login become the lane's. */
export function laneWords(kind, reason) {
  if (kind !== "ws") return reason;
  for (const key of ["login", "noUpload", "limit", "noLoginPage"]) {
    if (reason === REASONS[key]) return key === "noLoginPage" ? WS_REASONS.login : WS_REASONS[key];
  }
  return reason;
}

/** Is this stop reason one the owner fixes with Log in on my Mac? (the card's button, §47.10.6) */
export function loginReason(reason) {
  return reason === WS_REASONS.login || reason === WS_REASONS.nobody || /^Your Mac is logged in to TikTok as /.test(String(reason || ""));
}

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
  if (/posting too (fast|often|frequently|much)|too many (posts|uploads|videos|requests)|(daily|upload|posting) limit|limit (reached|exceeded)|reached (the|your) limit|slow down/i.test(text)) {
    return new Stop(REASONS.limit, { needsYou: true });
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

/** Opens Studio › Posts and waits for its rows (none at all on a new account). */
async function openPosts(page) {
  await goto(page, "content");
  await page.locator('a[href*="/video/"]').first().waitFor({ timeout: 30_000 }).catch(() => {});
}

/** The rows of Studio › Posts: each video's id, link and the text around it (its caption). */
export async function listPosts(page) {
  await openPosts(page);
  return readPosts(page);
}

async function readPosts(page) {
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
// Which account (D3)

/**
 * Who the open page says is logged in. When the Studio page shows no handle (a new account without posts, and the
 * passport answer unreadable), www.tiktok.com is read too; ``moved`` says the page left Studio.
 */
export async function identify(page) {
  let seen = await whoAmI(page);
  let moved = false;
  if (!seen.handles.length) {
    moved = true;
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await sleep(1500);
    // The feed's video links are other people's: only the account's own data counts there (sources 1 and 3).
    seen = mergeSeen(seen, await whoAmI(page, { links: false }));
  }
  return { seen, moved };
}

/** The accounts this post must never go to (another lane's: rule 1), as lists: ``notHandles``/``notUids`` and the
 * single ``notHandle``/``notUid`` the check run still passes. */
export function never(opts = {}) {
  const list = (many, one) => [...(Array.isArray(many) ? many : []), ...(one ? [one] : [])].filter(Boolean).map(String);
  return { handles: list(opts.notHandles, opts.notHandle), uids: list(opts.notUids, opts.notUid) };
}

/**
 * Before anything is read: the stop for a target that may never be posted to here (none, or another lane's account:
 * a Clips Funded job never to Clip Factory's, a Clip Factory clip never to Clips Funded's), or null.
 */
export function refusedTarget(opts = {}) {
  const target = at(opts.target);
  if (!target) return new Stop(REASONS.whoUnknown, { unknown: true });
  if (never(opts).handles.some((h) => bare(h) === bare(target))) {
    return new Stop(opts.kind === "ws" ? REASONS.otherWorkspace : REASONS.otherWorkspaceClips, { needsYou: true, wrongAccount: true, seen: target });
  }
  return null;
}

/**
 * Refuses unless the logged-in account is ``opts.target`` (and its pinned uid, and never another lane's handle or
 * uid). Wrong: a needs-you stop (nothing was posted); unreadable: a plain stop. ``opts.onWho(result)`` records what
 * was read.
 * @returns {Promise<{moved: boolean}>}
 */
async function checkAccount(page, opts) {
  const target = at(opts.target);
  const refused = refusedTarget(opts);
  if (refused) {
    if (refused.wrongAccount) opts.onWho?.({ verdict: "wrong", seen: target });
    throw refused;
  }
  const not = never(opts);
  const { seen, moved } = await identify(page);
  const res = sameAccount(seen, target, opts.uid || null, { notUid: not.uids });
  opts.onWho?.(res);
  if (res.verdict === "wrong") throw new Stop(REASONS.wrongAccount(res.seen, target), { needsYou: true, wrongAccount: true, seen: res.seen });
  // Nobody readable and no TikTok session at all: logged out (the lane's login flow, as 1.1.0 had it at upload).
  if (res.verdict !== "same" && !(await loggedIn(page).catch(() => true))) throw new Stop(REASONS.login, { needsYou: true });
  const blank = !(seen.handles || []).length && !(seen.uids || []).length;
  if (res.verdict !== "same") throw new Stop(REASONS.whoUnknown, { unknown: true, blank });
  return { moved };
}

/**
 * Right before Post (no navigation): source 1, when readable, still says the target (and its uid); and the TikTok
 * session is the one of the first check, unless source 1 itself confirms the target.
 */
async function recheckAccount(page, opts, session) {
  const target = at(opts.target);
  const now = await sessionHash(page);
  const info = await accountInfo(page);
  const nameOff = Boolean(info.handle) && bare(info.handle) !== bare(target);
  const uidOff = Boolean(info.uid) && ((opts.uid && info.uid !== String(opts.uid)) || never(opts).uids.includes(String(info.uid)));
  const confirmed = Boolean(info.handle) && !nameOff && !uidOff;
  if (nameOff || uidOff || (now !== session && !confirmed)) {
    const seen = nameOff ? at(info.handle) : "another account";
    opts.onWho?.({ verdict: "wrong", seen });
    throw new Stop(REASONS.wrongAccount(seen, target), { needsYou: true, wrongAccount: true, seen });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Uploading

/**
 * Puts the video in TikTok's upload box. Chrome runs on this Mac, so it is given the file's path and reads the file
 * itself (CDP DOM.setFileInputFiles): instant at any size. Playwright's setInputFiles over a CDP connection sends
 * the whole file through the connection instead, which timed out at 30 s for a 38 MB clip (22 Nov); it stays as the
 * fallback with a longer limit.
 */
async function giveFile(page, file) {
  try {
    const session = await page.context().newCDPSession(page);
    const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
    const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector: 'input[type="file"]' });
    if (!nodeId) throw new Error("no file input");
    await session.send("DOM.setFileInputFiles", { files: [file], nodeId });
    await session.detach().catch(() => {});
    return;
  } catch {
    // fall back below
  }
  await page.locator('input[type="file"]').first().setInputFiles(file, { timeout: 240_000 });
}

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

/** Types the caption, line by line; a hashtag or mention list that opens is closed before each new line. */
async function typeCaption(page, editor, caption, delay) {
  await editor.click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.press("Backspace");
  await sleep(300);
  const lines = String(caption).split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      // Enter with a suggestion list open would pick a suggestion instead of starting a line: close it first.
      await page.keyboard.press("Escape").catch(() => {});
      await sleep(150);
      await page.keyboard.press("Enter");
    }
    await page.keyboard.type(lines[i], { delay });
    await sleep(250);
  }
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(400);
  // Close a hashtag or mention list by clicking the section's own heading.
  await page.getByText("Description", { exact: true }).first().click({ timeout: 2000 }).catch(() => {});
  await sleep(400);
}

async function setCaption(page, caption) {
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.waitFor({ timeout: 20_000 }).catch(() => {
    throw new Stop(REASONS.noUpload);
  });
  const want = normalize(caption);
  // Studio turns hashtags into tags, so compare without the # marks and spaces.
  const squash = (s) => s.replace(/[#\s]/g, "");
  let typed = "";
  // Twice, the second time slower: a suggestion list that opened at the wrong moment can spoil one try (22 Nov).
  for (const delay of [12, 40]) {
    await typeCaption(page, editor, caption, delay);
    typed = normalize(await editor.innerText().catch(() => ""));
    if (squash(typed).startsWith(squash(want).slice(0, 60))) return;
  }
  const stop = new Stop(REASONS.caption);
  stop.detail = { typed, want }; // what TikTok's box held vs the clip's caption (both normalized), for the log
  throw stop;
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
    // An option's name may say more under its word: Studio's Friends reads "Friends Followers you follow back"
    // (probe, 24 Nov), so the option is the one whose name starts with the word.
    const word = want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const option = page.getByRole("option", { name: new RegExp(`^${word}(\\s|$)`, "i") }).first();
    if (await option.isVisible().catch(() => false)) await option.click();
    else await page.getByText(want, { exact: true }).last().click({ timeout: 5000 }).catch(() => {});
    await sleep(500);
  }
  await checkPrivacy(page, privacy, section);
}

/** Who can see it still says the job's choice (after setPrivacy, and again right before Post: the label may move it). */
async function checkPrivacy(page, privacy, given = null) {
  const want = privacyWord(privacy);
  const section = given || (await sectionOf(page, "Who can see this post")) || (await sectionOf(page, "Who can watch this video"));
  if (!section) throw new Stop(REASONS.noUpload);
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

/** The switch named one of ``names`` (Show more opened first when it is not in view), or null. */
async function findSwitch(page, names) {
  for (const name of names) {
    const id = await switchId(page, name);
    if (id) return page.locator(`[id="${id}"]`);
  }
  const more = page.getByText("Show more", { exact: true }).first();
  if (await more.isVisible().catch(() => false)) {
    await more.click();
    await sleep(800);
  }
  for (const name of names) {
    const id = await switchId(page, name);
    if (id) return page.locator(`[id="${id}"]`);
  }
  return null;
}

const switchOn = async (box) => box.isChecked().catch(async () => (await box.getAttribute("aria-checked").catch(() => null)) === "true");

export const AI_LABEL_NAMES = ["AI-generated content", "AI-generated"];
// A dialog TikTok may show when the AI label is turned on; only these buttons are pressed in it, and only here.
const AI_DIALOG = /AI-generated/i;
const AI_DIALOG_BUTTON = /^(turn on|confirm|ok|got it)$/i;

async function confirmAiDialog(page) {
  const box = page.getByRole("dialog").filter({ hasText: AI_DIALOG }).first();
  if (!(await box.isVisible().catch(() => false))) return;
  const btn = box.getByRole("button", { name: AI_DIALOG_BUTTON }).first();
  if (await btn.isVisible().catch(() => false)) {
    await btn.click({ timeout: 3000 }).catch(() => {});
    await sleep(600);
  }
}

/** D4: TikTok's "AI-generated content" label on, read back; else no post. A label TikTok set itself (on, locked) is fine. */
async function setAiLabel(page) {
  const box = await findSwitch(page, AI_LABEL_NAMES);
  if (!box) throw new Stop(REASONS.aiLabel);
  if (await box.isDisabled().catch(() => false)) {
    if (await switchOn(box)) return;
    throw new Stop(REASONS.aiLabel);
  }
  if (!(await switchOn(box))) {
    await box.click({ force: true });
    await sleep(600);
    await confirmAiDialog(page);
  }
  if (!(await switchOn(box))) throw new Stop(REASONS.aiLabel);
}

async function aiLabelOn(page) {
  const box = await findSwitch(page, AI_LABEL_NAMES);
  return Boolean(box) && (await switchOn(box));
}

/** D4: never a branded post. "Disclose post content" stays off (read back); a page without it is fine. */
async function keepDiscloseOff(page) {
  const name = "Disclose post content";
  const box = await findSwitch(page, [name]);
  if (!box) return;
  if ((await switchOn(box)) && !(await box.isDisabled().catch(() => false))) {
    await box.click({ force: true });
    await sleep(400);
  }
  if (await switchOn(box)) throw new Stop(REASONS.toggle(name));
}

// ---------------------------------------------------------------------------------------------------------------
// TikTok's commercial content disclosure (1.3.0, §47.9)
//
// TikTok Studio, read with the probe on 24 Nov 2026 (headless, nothing posted): under "Show more", the switch
// "Disclose post content" ("Let others know this post promotes a brand, product or service."). On, it shows two
// checkboxes: "Your brand" (the "Promotional content" label) and "Branded content" (the "Paid partnership" label, with
// "By posting, you agree to our Branded Content Policy and Music Usage Confirmation."). With Branded content ticked
// Who can see it greys out Only you ("Private"); with Only you picked, Branded content is greyed out. On with nothing
// ticked, Post still works, so the helper never leaves it like that.

// How long one click waits for Studio to show the change before it is tried another way (and then read back).
const LABEL_WAIT_MS = 3000;

export const DISCLOSE = "Disclose post content";
export const YOUR_BRAND = "Your brand";
export const BRANDED = "Branded content";

/** What the job asks TikTok's disclosure to say: on for any label, and which ones. */
export function labelOf(job) {
  const organic = job?.brandOrganic === true;
  const branded = job?.brandContent === true;
  return { disclose: organic || branded, organic, branded };
}

/** One control to the right state: read, click when it differs (never a greyed-out one), read again. */
async function turn(box, on) {
  if ((await box.on()) === on) return;
  if (await box.disabled()) throw new Stop(REASONS.label);
  await box.click();
  if ((await box.on()) !== on) throw new Stop(REASONS.label);
}

/**
 * Sets the disclosure on ``form`` (Studio's controls, ``studioForm``: ``openMore()`` and ``box(name)`` →
 * ``{on(), disabled(), click()}`` or null) and reads it back. With a label: the switch on, then Your brand and
 * Branded content each as the job says. Without one: the switch off (TikTok may carry the last post's over); a page
 * without the switch is fine then. Throws ``Stop(REASONS.label)`` when it can't be made so.
 */
export async function applyLabel(form, job) {
  const want = labelOf(job);
  await form.openMore();
  const sw = await form.box(DISCLOSE);
  if (!sw) {
    if (want.disclose) throw new Stop(REASONS.label);
    return;
  }
  await turn(sw, want.disclose);
  if (want.disclose) {
    for (const [name, on] of [
      [YOUR_BRAND, want.organic],
      [BRANDED, want.branded],
    ]) {
      const box = await form.box(name);
      if (!box) {
        if (on) throw new Stop(REASONS.label);
        continue;
      }
      await turn(box, on);
    }
  }
  await checkLabel(form, job);
}

/** What the disclosure says now (the probe's proof): the switch and both boxes. */
export async function readLabel(form) {
  const read = async (name) => {
    const box = await form.box(name);
    return box ? Boolean(await box.on()) : null;
  };
  return { disclose: await read(DISCLOSE), organic: await read(YOUR_BRAND), branded: await read(BRANDED) };
}

/** Read back only (after applyLabel, and again right before Post): every part is as the job says. */
export async function checkLabel(form, job) {
  const want = labelOf(job);
  const now = await readLabel(form);
  if (Boolean(now.disclose) !== want.disclose) throw new Stop(REASONS.label);
  if (!want.disclose) return;
  if (Boolean(now.organic) !== want.organic || Boolean(now.branded) !== want.branded) throw new Stop(REASONS.label);
}

/**
 * Studio's controls for applyLabel, by their own text (switchId). Studio draws a checkbox anew when it changes (a new
 * element with a new id, probe of 24 Nov), so every read and click finds it again by its text. Clicks go through CDP
 * only (no OS input).
 */
export function studioForm(page) {
  const state = (name) =>
    page.evaluate((want) => {
      const norm = (t) => (t || "").trim().split("\n")[0].trim().toLowerCase();
      for (const inp of document.querySelectorAll("input[type=checkbox], [role=switch], [role=checkbox]")) {
        let el = inp;
        for (let k = 0; k < 6 && el; k++, el = el.parentElement) {
          const t = norm(el.innerText);
          if (t) {
            if (t === want.toLowerCase()) {
              return {
                on: inp.checked === true || inp.getAttribute("aria-checked") === "true",
                disabled: inp.disabled === true || Boolean(inp.closest('[aria-disabled="true"], [data-disabled="true"]')),
              };
            }
            break;
          }
        }
      }
      return null;
    }, name);
  return {
    openMore: async () => {
      const more = page.getByText("Show more", { exact: true }).first();
      if (await more.isVisible().catch(() => false)) {
        await more.click();
        await sleep(800);
      }
    },
    box: async (name) => {
      if (!(await state(name))) return null;
      const on = async () => Boolean((await state(name))?.on);
      return {
        on,
        disabled: async () => (await state(name))?.disabled !== false,
        click: async () => {
          const before = await on();
          // Studio takes a moment to show the tick (over 600 ms for Branded content, probe of 24 Nov): wait for it.
          const moved = async () => {
            for (let waited = 0; waited < LABEL_WAIT_MS; waited += 250) {
              if ((await on()) !== before) return true;
              await sleep(250);
            }
            return false;
          };
          const id = await switchId(page, name);
          if (id) await page.locator(`[id="${id}"]`).click({ force: true, timeout: 5000 }).catch(() => {});
          if (await moved()) return;
          // A slow page may still show the first click: never click again before a last look (a second click would
          // undo a late first one).
          await sleep(LABEL_WAIT_MS);
          if ((await on()) !== before) return;
          // Studio's switch input is hidden under its own track: click the track (or the checkbox's label) instead.
          const again = await switchId(page, name);
          if (again) await page.evaluate((i) => document.getElementById(i)?.closest(".Switch__content, label, [role=switch]")?.click(), again);
          await moved();
          await sleep(1000); // let a late change land before turn() reads it back
        },
      };
    },
  };
}

/**
 * Comment, Duet and Stitch as the job says. Studio now has one "Reuse of content" switch for Duet and Stitch.
 * A Clips Funded lane (``kind`` "ws", whatever the job says) then turns on the AI label and keeps Disclose post
 * content off; Clip Factory's lane never touches the AI label and sets Disclose post content from the job (1.3.0).
 */
async function setInteractions(page, job, kind = "clips") {
  if (!(await setToggle(page, "Comment", job.comment !== false))) throw new Stop(REASONS.noUpload);
  const reuse = job.duet !== false || job.stitch !== false;
  if (!(await setToggle(page, "Reuse of content", reuse))) {
    // An older layout with separate switches.
    if (!(await setToggle(page, "Duet", job.duet !== false))) throw new Stop(REASONS.noUpload);
    if (!(await setToggle(page, "Stitch", job.stitch !== false))) throw new Stop(REASONS.noUpload);
  }
  // Never limit who can see it (the owner's most reach): Audience control (18+) stays off.
  await setToggle(page, "Audience control", false);
  if (kind === "ws") {
    await setAiLabel(page);
    await keepDiscloseOff(page);
  } else {
    // 1.3.0: TikTok's disclosure as the job says (a campaign clip: Branded content), then Who can see it again (a
    // label must never leave it on something else).
    await applyLabel(studioForm(page), job);
    await checkPrivacy(page, job.privacy);
  }
}

/**
 * Uploads one clip and presses Post. ``onStep(step)`` is called before each stage; it must have recorded "pressing"
 * (on disk and on the server) before it returns for that step, because pressing is the point of no return.
 * ``opts``: ``target`` (the account it may post to, "@name"), ``uid`` (its pinned uid), ``notHandles`` / ``notUids``
 * (every other lane's accounts; ``notHandle`` / ``notUid`` for one), ``kind`` ("clips" | "ws"), ``earlier`` (a Clips
 * Funded post tried again after a press: the Studio ids from before that press), ``onWho(result)``, ``dryRun``.
 * @returns {Promise<{link: string|null, sure: boolean}>} ``sure`` = TikTok said it posted or the new row was found.
 */
export async function post(page, job, file, onStep, opts = {}) {
  const { dryRun = false, kind = "clips" } = opts;
  await onStep("opening");
  // D3: the account first, before Studio › Posts is read.
  await openPosts(page);
  const { moved } = await checkAccount(page, opts);
  const session = await sessionHash(page);
  const before = moved ? await listPosts(page) : await readPosts(page);
  if (kind !== "ws") {
    // A Clips Funded lane never matches older posts by caption (an older story's post could look like this one);
    // it relies on the server's never-twice rule and the baseline saved at pressing.
    const existing = findExisting(before, job.caption);
    if (existing) return { link: postLink(existing.href), sure: true, existing: true };
  } else if (Array.isArray(opts.earlier) && opts.earlier.length) {
    // The owner's Try again after a press ("Post it again? Only if it's not on your TikTok"): a row with this
    // caption that is new since that first press is that first post, so it is on TikTok already and nothing is
    // posted again. The Only me copy and older stories were there before the first press, so they never count.
    const earlier = new Set(opts.earlier);
    const first = findExisting(before.filter((r) => !earlier.has(r.id)), job.caption);
    if (first) return { link: postLink(first.href), sure: true, existing: true };
  }
  const baseline = before.map((r) => r.id);

  await goto(page, "upload");
  const input = page.locator('input[type="file"]').first();
  await input.waitFor({ state: "attached", timeout: 30_000 }).catch(() => {
    throw new Stop(REASONS.noUpload);
  });
  await onStep("uploading");
  await giveFile(page, file);
  await sleep(3000);
  await waitForUpload(page);
  await dismissHarmless(page); // TikTok's first-run questions come up once the video is in

  await onStep("settings");
  await dismissHarmless(page);
  await setCaption(page, job.caption);
  await setPrivacy(page, job.privacy);
  await setInteractions(page, job, kind);
  await check(page);
  const dialog = await openDialogText(page);
  if (dialog) throw new Stop(REASONS.popup(dialog));
  const button = postButton(page);
  if (!(await button.isEnabled().catch(() => false))) throw new Stop(REASONS.noPost);
  // Right before Post: the AI label is still on (Clips Funded), Clip Factory's disclosure and who can see it are still
  // as the job says, and it is still the same account.
  if (kind === "ws" && !(await aiLabelOn(page))) throw new Stop(REASONS.aiLabel);
  await recheckAccount(page, opts, session);
  if (kind !== "ws") {
    // The last look, after the account check: nothing slow comes between it and Post now.
    await checkLabel(studioForm(page), job);
    await checkPrivacy(page, job.privacy);
  }
  if (dryRun) {
    // A check run: everything up to Post, then nothing. Quitting Chrome afterwards throws the upload away. It says
    // what TikTok's disclosure reads now (Clip Factory's lane) and whether Studio shows "Paid partnership".
    const label = kind !== "ws" ? await readLabel(studioForm(page)) : undefined;
    if (label) label.paidPartnership = await page.getByText("Paid partnership", { exact: true }).first().isVisible().catch(() => false);
    return { dryRun: true, link: null, sure: false, posts: before.length, baseline, ...(label ? { label } : {}) };
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

/**
 * After a crash once Post was pressed: look for the post, never post again. The account is checked first (D3). A
 * Clips Funded lane always uses the baseline saved at pressing (an empty one too), never an older caption match.
 */
export async function find(page, job, sinceIds = [], opts = {}) {
  await openPosts(page);
  const { moved } = await checkAccount(page, opts);
  const rows = moved ? await listPosts(page) : await readPosts(page);
  const found =
    sinceIds.length || opts.kind === "ws" ? findNewPost(rows, job.caption, sinceIds) : findExisting(rows, job.caption);
  return found ? postLink(found.href) : null;
}

export const LOGIN_URL = "https://www.tiktok.com/login/phone-or-email/email?lang=en";

/**
 * Logs in with the saved login (login.js). ``onTry`` is called right before the password is sent (it counts the
 * try). Returns loginOutcome's answer: "ok", "needs_you" (a code, a puzzle or a new-device check), "refused" or
 * "waiting" (no answer in a minute). The page stays as it is, so a code page can be handed to the owner.
 */
export async function passwordLogin(page, login, { onTry }) {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await sleep(1500);
  await dismissHarmless(page);
  if (await loggedIn(page)) return "ok";
  const user = page.locator('input[name="username"], input[placeholder*="email or username" i], input[type="email"]').first();
  const pass = page.locator('input[type="password"]').first();
  try {
    await user.waitFor({ state: "visible", timeout: 20_000 });
    await pass.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    throw new Stop(REASONS.noLoginPage, { needsYou: true });
  }
  const button = page.locator('button[data-e2e="login-button"], button[type="submit"]').first();
  const before = await visibleText(page);
  await onTry();
  await user.fill(login.username);
  await pass.fill(login.password);
  await button.click();
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    await sleep(2000);
    const outcome = loginOutcome({ loggedIn: await loggedIn(page), text: await visibleText(page), before, url: page.url() });
    if (outcome !== "waiting") return outcome;
  }
  return "waiting";
}

export { captionMatches, videoId };
