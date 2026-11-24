// §47.11: a TikTok login hold ends by itself. When a lane stopped only for a TikTok login problem (logged out, a login
// needed, the saved login refused: its stop carried code "login"), and the helper later sees that lane's Chrome
// profile logged in to exactly that lane's account, the hold ends and the stopped clip carries on, as if the owner
// had tapped Try again.
//
// Rules:
// - Only a login hold (plan.js loginHold): never a puzzle, a code, a limit, a warning, "three times", a pause, a
//   switch that is off or a Clip Factory sign-in.
// - Only the exact account: the strict check a post uses (whoami.js sameAccount: every handle the target, the pinned
//   uid where known, never another lane's handle or uid). Another account keeps the hold, and its words say so.
// - Never twice: the server re-waits only a stopped post that never pressed Post (a pressed one only has its hold
//   end), and nothing here touches the ledger's press, finding or baseline.
// - Nothing on screen: a headless look only (no frame, no pop-up, no window, no Apple Events). No cookie is cleared,
//   no saved login is typed, and loginTries / loginRefused stay as they are.
// - A tick's own look resumes one clip at most MAX_LOGIN_BACKS times in 24 hours (its ledger's loginBacks), so a
//   logout that keeps coming back can't loop; the owner's own setup is never capped.
import { REASONS, laneWords, refusedTarget } from "./tiktok.js";
import { at, sameAccount } from "./whoami.js";

export const MAX_LOGIN_BACKS = 2;
const DAY = 24 * 60 * 60_000;
/** What the server's logged-in route answers (the hold ended). */
export const BACK_OUTCOMES = Object.freeze(["resumed", "pressed", "cleared"]);

/**
 * The words a held lane's check-in carries after a look (only for ``wrong`` and ``logged_out``; null otherwise), in
 * the lane's own words.
 * @param {{kind: "clips"|"ws"}} lane
 * @param {string} outcome
 * @param {{seen?: string, target?: string, words?: string}} [found] ``words``: a refusal's own sentence
 */
export function heldWords(lane, outcome, { seen, target, words } = {}) {
  if (outcome === "wrong") return laneWords(lane.kind, words || REASONS.wrongAccount(seen || "another account", target || "your TikTok"));
  if (outcome === "logged_out") return laneWords(lane.kind, REASONS.login);
  return null;
}

const idsOf = (lane, id) => (lane.kind === "ws" ? { publishingJobId: id } : { clipId: id });

/** The resumes of this clip within the last 24 hours (its ledger's loginBacks), as ISO times. */
function recentBacks(lane, id, now) {
  const list = lane.state.ledger[id]?.loginBacks;
  return (Array.isArray(list) ? list : []).filter((t) => {
    const when = Date.parse(t);
    return Number.isFinite(when) && when <= now && now - when < DAY;
  });
}

/**
 * The server call that ends the hold (step 5 of loginBack): the clip's loggedIn route. With ``d.capped`` (a tick's
 * own look) the resume is counted in the ledger first, so a crash still counts. A 409 is ``refused`` and anything
 * else that fails (a 404 from an older server) is ``failed``: the hold stays either way.
 * @returns {Promise<{outcome: string}>}
 */
export async function sendBack(lane, hold, d) {
  const ids = idsOf(lane, hold.id);
  if (d.capped !== false) {
    const now = d.now();
    lane.remember(hold.id, { loginBacks: [...recentBacks(lane, hold.id, now), new Date(now).toISOString()] });
  }
  let outcome;
  let error;
  try {
    const answer = await d.call(hold.id);
    outcome = BACK_OUTCOMES.includes(answer?.outcome) ? answer.outcome : "failed";
  } catch (e) {
    outcome = e?.status === 409 ? "refused" : "failed";
    error = String(e?.message || e);
  }
  d.event("login_back", { ...ids, outcome, ...(error ? { error } : {}) });
  return { outcome };
}

/**
 * Is the held lane's Chrome logged in to exactly its account again? Then its hold ends (the server's logged-in
 * route). Everything this needs comes from ``d`` (run.js builds it; tests use fakes):
 *   look() → {state: "logged_out"} | {state: "in", seen} (a headless look of the lane's own profile),
 *   call(id) → the route's answer {helper, outcome}, now() → ms, event(kind, fields),
 *   target ("@name"), pinnedUid, others {handles, uids} (every other lane's accounts), capped (default true).
 * @param {object} lane run.js's lane (clipsLane / wsLane)
 * @param {{id: string}} hold plan.js loginHold
 * @returns {Promise<{outcome: "resumed"|"pressed"|"cleared"|"wrong"|"logged_out"|"unknown"|"no_account"|"refused"|
 *   "failed"|"too_many", words?: string}>} ``words`` only for wrong and logged_out
 */
export async function loginBack(lane, hold, d) {
  const ids = idsOf(lane, hold.id);
  const done = (outcome, extra = {}, words = null) => {
    d.event("login_back", { ...ids, outcome, ...extra });
    return words ? { outcome, words } : { outcome };
  };
  // 1. The cap, before any Chrome.
  if (d.capped !== false && recentBacks(lane, hold.id, d.now()).length >= MAX_LOGIN_BACKS) return done("too_many");
  // 2. The target: none (no Chrome, the words stay), or another lane's account (refused before any Chrome).
  const target = at(d.target);
  const others = d.others || { handles: [], uids: [] };
  const refused = refusedTarget({ kind: lane.kind, target, notHandles: others.handles });
  if (!target || refused?.unknown) return done("no_account");
  if (refused) {
    d.event("wrong_account", { ...ids, seen: target, target });
    return done("wrong", { seen: target }, heldWords(lane, "wrong", { words: refused.reason }));
  }
  // 3. The look (a Chrome that won't start reads as nobody: the hold stays, and the tick still checks in).
  let look;
  try {
    look = await d.look();
  } catch (e) {
    return done("unknown", { error: String(e?.message || e) });
  }
  if (look?.state === "logged_out") return done("logged_out", {}, heldWords(lane, "logged_out"));
  // 4. The account: the strict check a post uses.
  const res = sameAccount(look?.seen || {}, target, d.pinnedUid || null, { notUid: others.uids || [] });
  lane.onWho(res, target);
  // 5. Exactly the account: the hold ends.
  if (res.verdict === "same") return sendBack(lane, hold, d);
  // 6. Another account keeps the hold, and says so; nothing readable changes nothing.
  if (res.verdict === "wrong") {
    d.event("wrong_account", { ...ids, seen: res.seen, target });
    return done("wrong", { seen: res.seen }, heldWords(lane, "wrong", { seen: res.seen, target }));
  }
  return done("unknown");
}

// What cli.js setup prints after the owner's own login (§47.11), in the lane's words.
export const BACK_LINES = Object.freeze({
  resumed: "Your Mac carries on with the stopped clip now.",
  pressed: "Your Mac goes on. The clip it stopped on may already be on TikTok: check it in Clip Factory.",
  cleared: "Your Mac goes on.",
  logged_out: "TikTok isn't logged in yet.",
});
// Clips Funded's own (never "Clip Factory").
export const WS_BACK_LINES = Object.freeze({
  ...BACK_LINES,
  resumed: "Your Mac carries on with the stopped post now.",
  pressed: "Your Mac goes on. The post it stopped on may already be on TikTok: check it in Clips Funded.",
});

/** The one line setup prints for a hold it could end (null when there is nothing to say). */
export function backLine(lane, back, target) {
  if (back?.outcome === "wrong") return `${back.words} Log in as ${at(target) || "your TikTok"}.`;
  return (lane.kind === "ws" ? WS_BACK_LINES : BACK_LINES)[back?.outcome] || null;
}
