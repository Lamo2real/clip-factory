// Which TikTok account the helper's Chrome is logged in to (§47.10, D3). Before every post, and before every look
// for a post's link, the helper reads the signed-in handle and refuses unless it is the lane's target: @lamo.clips
// for Clip Factory, the job's account for Clips Funded. Each source below is a pure parser (test/whoami.test.js);
// whoAmI reads them all from the page that is open. Nothing here ever reads, keeps or prints a cookie's value: the
// session check keeps only a hash of it, in memory.
import crypto from "node:crypto";

const NAME = /^[A-Za-z0-9._]{1,30}$/;

/** A handle without "@", in lower case ("" when it is not a TikTok handle). */
export function bare(handle) {
  const name = String(handle ?? "").trim().replace(/^@/, "");
  return NAME.test(name) ? name.toLowerCase() : "";
}

/** "@name" as TikTok writes it (its own case), or null when it is not a TikTok handle. */
export function at(handle) {
  const name = String(handle ?? "").trim().replace(/^@/, "");
  return NAME.test(name) ? `@${name}` : null;
}

const uidOf = (value) => (/^\d{5,25}$/.test(String(value ?? "")) ? String(value) : undefined);

/** Source 1: ``/passport/web/account/info/`` → ``data.username``, ``data.user_id_str``. */
export function fromAccountInfo(body) {
  const data = body && typeof body === "object" ? body.data : null;
  if (!data || typeof data !== "object") return {};
  const handle = at(data.username);
  const uid = uidOf(data.user_id_str);
  return { ...(handle ? { handle } : {}), ...(uid ? { uid } : {}) };
}

/** Source 2: the ``/@name/video/<id>`` links of Studio › Posts rows (the account's own posts). */
export function fromHrefs(hrefs) {
  const out = [];
  for (const href of hrefs || []) {
    const m = /\/@([A-Za-z0-9._]{1,30})\/video\/\d{6,}/.exec(String(href || ""));
    const handle = m ? at(m[1]) : null;
    if (handle && !out.some((h) => bare(h) === bare(handle))) out.push(handle);
  }
  return out;
}

/** Source 3: ``__UNIVERSAL_DATA_FOR_REHYDRATION__`` on www.tiktok.com › ``webapp.app-context.user``. */
export function fromRehydration(text) {
  let data;
  try {
    data = typeof text === "string" ? JSON.parse(text) : text;
  } catch {
    return {};
  }
  if (!data || typeof data !== "object") return {};
  const scope = data.__DEFAULT_SCOPE__ && typeof data.__DEFAULT_SCOPE__ === "object" ? data.__DEFAULT_SCOPE__ : data;
  const user = scope?.["webapp.app-context"]?.user;
  if (!user || typeof user !== "object") return {};
  const handle = at(user.uniqueId);
  const uid = uidOf(user.uid);
  return { ...(handle ? { handle } : {}), ...(uid ? { uid } : {}) };
}

/** The handle in a post's link (``https://www.tiktok.com/@name/video/<id>``), or null. */
export function linkHandle(link) {
  const m = /^https:\/\/(?:www\.)?tiktok\.com\/@([A-Za-z0-9._]{2,30})\/video\/\d{8,25}/.exec(String(link || ""));
  return m ? `@${m[1]}` : null;
}

/** Everything one read found: every handle, every uid (two different uids is itself a mismatch). */
export function seenFrom({ info = {}, hrefs = [], rehydration = {} } = {}) {
  const handles = [];
  const add = (h) => {
    if (h && !handles.some((x) => bare(x) === bare(h))) handles.push(h);
  };
  add(info.handle);
  for (const h of fromHrefs(hrefs)) add(h);
  add(rehydration.handle);
  const uids = [...new Set([info.uid, rehydration.uid].filter(Boolean))];
  return { handles, uids, ...(uids.length === 1 ? { uid: uids[0] } : {}) };
}

/** Two reads together (the Studio page, then www.tiktok.com when the first found no handle). */
export function mergeSeen(a, b) {
  const handles = [...(a?.handles || [])];
  for (const h of b?.handles || []) if (!handles.some((x) => bare(x) === bare(h))) handles.push(h);
  const uids = [...new Set([...(a?.uids || []), ...(b?.uids || [])])];
  return { handles, uids, ...(uids.length === 1 ? { uid: uids[0] } : {}) };
}

/**
 * Is the signed-in account the target? ``same`` only when every readable handle equals the target (case and "@"
 * aside) and every readable uid equals the pinned one; ``wrong`` as soon as one doesn't, or when a uid is the one
 * that must never post here (``notUid``: Clip Factory's, for a Clips Funded lane); ``unknown`` when nothing is
 * readable (then nothing is posted either).
 * @param {{handles?: string[], uids?: string[], uid?: string}} seen
 * @param {string} target "@name"
 * @param {string|null} [pinnedUid]
 * @param {{notUid?: string|null}} [opts]
 * @returns {{verdict: "same"|"wrong"|"unknown", seen?: string, uid?: string}}
 */
export function sameAccount(seen, target, pinnedUid = null, { notUid = null } = {}) {
  const want = bare(target);
  if (!want) return { verdict: "unknown" };
  const names = (seen?.handles || []).map(bare).filter(Boolean);
  const uids = [...new Set([...(seen?.uids || []), ...(seen?.uid ? [seen.uid] : [])].map(String))];
  const shown = (name) => (name ? `@${name}` : "another account");
  const other = names.find((n) => n !== want);
  if (other) return { verdict: "wrong", seen: shown(other) };
  if (uids.length > 1) return { verdict: "wrong", seen: shown(names[0]) };
  if (notUid && uids.includes(String(notUid))) return { verdict: "wrong", seen: shown(names[0]) };
  if (pinnedUid && uids.length && uids[0] !== String(pinnedUid)) return { verdict: "wrong", seen: shown(names[0]) };
  if (names.length) return { verdict: "same", seen: shown(want), ...(uids[0] ? { uid: uids[0] } : {}) };
  if (pinnedUid && uids[0] === String(pinnedUid)) return { verdict: "same", seen: shown(want), uid: uids[0] };
  return { verdict: "unknown" };
}

/** Source 1 only (the right-before-Post check: no navigation). */
export async function accountInfo(page) {
  try {
    const body = await page.evaluate(async () => {
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(), 8000);
      try {
        const res = await fetch("/passport/web/account/info/?aid=1988", { credentials: "include", signal: stop.signal });
        return res.ok ? await res.json() : null;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    });
    return fromAccountInfo(body);
  } catch {
    return {};
  }
}

/**
 * Every source the open page has. ``links: false`` skips source 2: off Studio › Posts (www.tiktok.com's feed) the
 * video links are other people's, never the account's own.
 */
export async function whoAmI(page, { links = true } = {}) {
  const info = await accountInfo(page);
  const hrefs = links ? await page.$$eval('a[href*="/video/"]', (as) => as.map((a) => a.href)).catch(() => []) : [];
  const raw = await page
    .evaluate(() => document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__")?.textContent || null)
    .catch(() => null);
  return seenFrom({ info, hrefs, rehydration: raw ? fromRehydration(raw) : {} });
}

/** A hash of the TikTok session cookie (kept in memory only), so the check right before Post sees a switch. */
export async function sessionHash(page) {
  const cookies = await page.context().cookies("https://www.tiktok.com").catch(() => []);
  const session = cookies.find((c) => c.name === "sessionid" && c.value);
  return session ? crypto.createHash("sha256").update(session.value).digest("hex") : null;
}
