// Pure rules: which job to do now, if any. No I/O here, so every rule is unit-tested (test/plan.test.js).

const MINUTE = 60_000;

// After a press with no proof, the helper looks this long before asking "Did it post?"; the owner's Try again on a
// pressed post waits the same window (the server's tiktok_self.MAC_FIND_WINDOW; test/constants.test.js pins them).
export const FIND_FOR_MS = 30 * MINUTE;
// How often the helper beats a job it works on (§47, D2): the server calls a job stuck once its own beat is
// MAC_BEAT_STALE old, so a beat every minute stays well inside it (test/constants.test.js).
export const BEAT_EVERY_MS = MINUTE;

/**
 * Never twice (D2): why this job may not be posted or resumed now, or null when it may.
 * - "pressed": the server says Post was pressed for it (pressedAt). It is only ever looked for.
 * - "pressed_before": Post was pressed on an earlier try (pressedBefore), and the owner's Try again (againAt) did not
 *   come after the 30-minute find window, so the first post may still turn up on TikTok.
 */
export function neverTwice(job) {
  if (job.pressedAt) return "pressed";
  if (job.pressedBefore) {
    const again = job.againAt ? Date.parse(job.againAt) : NaN;
    if (!(again >= Date.parse(job.pressedBefore) + FIND_FOR_MS)) return "pressed_before";
  }
  return null;
}

/**
 * @param {object} args
 * @param {boolean} args.on            Clip Factory's switch (tiktokMac.on)
 * @param {Array<object>} args.queue   MacJob[] from GET /v1/tiktok/mac, in the server's order
 * @param {object} args.state          state.json
 * @param {object} args.settings       settings.json
 * @param {string} args.device         this Mac's device id
 * @param {Date} args.now
 * @param {{on: boolean, lastRunAt: string|null, nextRunAt: string|null}|null} [args.autopost] auto-posting's schedule
 * @returns {{action: "idle"|"paused"|"wait"|"resume"|"find"|"post", job?: object, reason?: string, until?: string,
 *   skipped?: Array<{clipId: string, why: "pressed"|"pressed_before"}>}} ``skipped``: jobs the never-twice rule held back
 */
export function nextAction(args) {
  const skipped = [];
  // A job the never-twice rule holds back is skipped (never claimed) and reported, so the tick logs never_twice.skip.
  const may = (job) => {
    const why = neverTwice(job);
    if (why && !skipped.some((s) => s.clipId === job.clipId)) skipped.push({ clipId: job.clipId, why });
    return !why;
  };
  const result = pick(args, may);
  return skipped.length ? { ...result, skipped } : result;
}

function pick({ on, queue, state, settings, device, now, autopost = null }, may) {
  if (!on) return { action: "idle", reason: "The switch in Clip Factory is off." };
  if (settings.paused) return { action: "paused", reason: "Paused on your Mac." };
  // Only these waiting jobs may be posted (never twice); the rest are skipped.
  const waiting = queue.filter((j) => j.state === "waiting" && may(j));

  // 0. His Upload and a run's own clips go before a backlog clip is resumed or looked for (review, 22 Nov): looking
  // for a pressed post only reads TikTok and can wait a few minutes; it never posts again either way.
  const backlogKind = (j) => j.source !== "upload" && j.source !== "auto";
  const holdBefore = settings.holdAutoBefore ? Date.parse(settings.holdAutoBefore) : null;
  const firstWaiting = waiting.find(
    (j) => j.source === "upload" || (j.source === "auto" && !(holdBefore && Date.parse(j.since || 0) < holdBefore))
  );
  const busyBacklog = queue.some((j) => j.state === "working" && backlogKind(j) && state.ledger[j.clipId]);
  if (firstWaiting && busyBacklog) {
    const last = state.lastPressedAt ? Date.parse(state.lastPressedAt) : null;
    const gap = ((firstWaiting.source === "upload" ? settings.onDemandSpacingMinutes : settings.autoSpacingMinutes) ?? 1) * MINUTE;
    if (last === null || now.getTime() - last >= gap) return { action: "post", job: firstWaiting };
  }

  // 1. Never twice: a job this Mac already pressed Post for is only ever looked for, never posted again. A job with
  // pressedAt is never posted or resumed, whatever its state (``may``), and one pressed on an earlier try
  // (pressedBefore) only after the owner's Try again came once the 30-minute find window was over.
  for (const job of queue) {
    const mine = state.ledger[job.clipId];
    const pressed = Boolean(job.pressedAt) || mine?.step === "pressing" || mine?.step === "finding";
    if (job.state === "working" && pressed && mine) return { action: "find", job };
  }
  // 2. A job this Mac claimed but had not pressed Post for (it stopped or crashed): do it again from the start.
  for (const job of queue) {
    const mine = state.ledger[job.clipId];
    if (job.state === "working" && !job.pressedAt && mine && mine.device === device && mine.step !== "pressing" && may(job)) {
      return { action: "resume", job };
    }
  }

  if (!waiting.length) return { action: "idle", reason: "Nothing waiting." };

  // 3. The owner's trial: stop after N posts until their views are checked.
  const limit = settings.trialLimit;
  if (limit !== null && limit !== undefined && state.posted.length >= limit) {
    return {
      action: "paused",
      reason: `Paused after the ${limit} trial posts. Clip Factory checks their views first.`,
    };
  }

  // 4. When (the owner, 22 Nov: "if auto posting is set to every 6 hours then it should also run the tiktok upload
  // every time thats run so its dependent on that automation" / "or if i hit upload on a video it should be invoked
  // as well"): a clip he uploaded goes at once, first; an auto-posting run's own clips go at once; and at most one
  // clip from the backlog ("Send these to my Mac") goes about 30 minutes after each run, until it is empty.
  const last = state.lastPressedAt ? Date.parse(state.lastPressedAt) : null;
  const since = (ms) => last === null || now.getTime() - last >= ms;
  const upload = waiting.find((j) => j.source === "upload");
  if (upload) {
    const gap = (settings.onDemandSpacingMinutes ?? 1) * MINUTE;
    return since(gap) ? { action: "post", job: upload } : { action: "wait", job: upload, until: new Date(last + gap).toISOString() };
  }
  // A hold on auto-posting clips made before a set time (22 Nov: a one-off Review run was stopped; any clip it made
  // waits until the coordinator confirms). Scheduled runs after that time post as usual.
  const holdUntil = settings.holdAutoBefore ? Date.parse(settings.holdAutoBefore) : null;
  const auto = waiting.find((j) => j.source === "auto" && !(holdUntil && Date.parse(j.since || 0) < holdUntil));
  if (auto) {
    const gap = (settings.autoSpacingMinutes ?? 1) * MINUTE;
    return since(gap) ? { action: "post", job: auto } : { action: "wait", job: auto, until: new Date(last + gap).toISOString() };
  }
  const backlog = waiting.find((j) => j.source !== "upload" && j.source !== "auto");
  if (!backlog) {
    const held = waiting.find((j) => j.source === "auto");
    return held ? { action: "wait", job: held, reason: "Held: an auto-posting clip from a stopped run." } : { action: "idle", reason: "Nothing waiting." };
  }
  if (settings.backfill) return backfillAction({ backlog, state, settings, now, autopost });
  // The time comes from backlogSlot, the same rule the ping reports as backlogAt (one rule, no drift).
  const slot = backlogSlot({ state, settings, autopost });
  const until = slot.at === null ? undefined : new Date(slot.at).toISOString();
  if (slot.why === "no_run") return { action: "wait", job: backlog, reason: "Waits for the next auto-posting run.", until };
  if (slot.why === "used") return { action: "wait", job: backlog, reason: "One per auto-posting run.", until };
  if (now.getTime() < slot.at) return { action: "wait", job: backlog, until };
  // Never right on top of another post.
  const gap = (settings.autoSpacingMinutes ?? 1) * MINUTE;
  return since(gap) ? { action: "post", job: backlog } : { action: "wait", job: backlog, until: new Date(last + gap).toISOString() };
}

/**
 * When the first backlog clip ("Send these to my Mac") is due, by the rule "When it posts": the backlog setting's
 * minutes (30) after the last auto-posting run when that run's slot is unused, else that long after the next run.
 * ``at`` is ms or null (no time known); ``why`` says which branch.
 */
function backlogSlot({ state, settings, autopost }) {
  const after = (settings.backlogAfterRunMinutes ?? 30) * MINUTE;
  const time = (t) => (t && Number.isFinite(Date.parse(t)) ? Date.parse(t) : null);
  const run = autopost && autopost.on ? time(autopost.lastRunAt) : null;
  const next = autopost ? time(autopost.nextRunAt) : null;
  const afterNext = next === null ? null : next + after;
  if (run === null) return { why: "no_run", at: afterNext };
  if (state.lastBacklogAt && Date.parse(state.lastBacklogAt) >= run) return { why: "used", at: afterNext };
  return { why: "run", at: run + after };
}

/**
 * The first backlog clip's time for the ping (D4), so the clip's row never guesses: an ISO time, or null during a
 * backfill (its own pace; the rows say "in line") or when auto-posting's schedule is unknown. It may be in the past:
 * then the clip goes at once (a minute after the last post at most).
 * @param {{settings: object, state: object, autopost: {on: boolean, lastRunAt: string|null, nextRunAt: string|null}|null}} args
 * @returns {string|null}
 */
export function backlogAt({ settings, state, autopost }) {
  if (settings.backfill || !autopost) return null;
  const { at } = backlogSlot({ state, settings, autopost });
  return at === null ? null : new Date(at).toISOString();
}

/**
 * The jobs the helper beats while it posts one (D2, §47): the current job with the last step the server took for it
 * (ledger sentStep; none before the first one), and every other job in this tick's queue that is this Mac's, working
 * and pressed (only looked for), with "finding". Each beat carries the job's attempt.
 * @returns {Array<{clipId: string, step: string, attempt?: number}>}
 */
export function beatTargets({ queue, state, device, current }) {
  const out = [];
  const sent = current ? state.ledger[current.clipId]?.sentStep : null;
  if (current && sent) out.push({ clipId: current.clipId, step: sent, attempt: current.attempt });
  for (const job of queue || []) {
    if (current && job.clipId === current.clipId) continue;
    if (job.state === "working" && job.pressedAt && state.ledger[job.clipId]?.device === device) {
      out.push({ clipId: job.clipId, step: "finding", attempt: job.attempt });
    }
  }
  return out;
}

/**
 * The ledger fields a claim writes. A fresh claim (a new attempt) forgets the last try's press, baseline and step;
 * the Studio ids from before an earlier press stay (``earlier``), so a Clips Funded post tried again after a press
 * can still find that first post (tiktok.js post).
 */
export function claimFields({ device, tries, fresh, earlier = null }) {
  return {
    device,
    step: "claimed",
    tries,
    ...(fresh ? { pressedAt: null, baseline: null, sentStep: null } : {}),
    ...(fresh && Array.isArray(earlier) && earlier.length ? { earlier } : {}),
  };
}

/** The Studio ids from before every press of this job so far (its ledger entry): what ``earlier`` keeps. */
export function earlierIds(entry) {
  const ids = [...(Array.isArray(entry?.earlier) ? entry.earlier : [])];
  if (entry?.pressedAt && Array.isArray(entry.baseline)) for (const id of entry.baseline) if (!ids.includes(id)) ids.push(id);
  return ids.slice(-500);
}

const trialHolds = (settings, state) =>
  settings.trialLimit !== null && settings.trialLimit !== undefined && (state.posted || []).length >= settings.trialLimit;

/**
 * The owner's taps in Clip Factory (D5): Start my Mac again (helper.resumeRequest) unpauses this Mac, and ends the
 * trial pause when that is what holds it; Let them go (helper.letGoRequest) lifts holdAutoBefore. ``patch`` goes to
 * settings.json; resumeDone / letGoDone go in the ping, which clears the request. Neither touches "needs you": only
 * the owner's answer on the stopped clip clears that, or the helper's logged-in (§47.11, loginHold below).
 * @returns {{patch: object, resumeDone?: string, letGoDone?: string}}
 */
export function applyRequests({ helper, settings, state }) {
  const patch = {};
  const out = { patch };
  if (helper?.resumeRequest?.at) {
    patch.paused = false;
    if (trialHolds(settings, state)) patch.trialLimit = null;
    out.resumeDone = helper.resumeRequest.at;
  }
  if (helper?.letGoRequest?.at) {
    patch.holdAutoBefore = null;
    out.letGoDone = helper.letGoRequest.at;
  }
  return out;
}

/**
 * What the ping adds to the check-in (D4, D5), each only when set: the first backlog clip's time, the hold on old
 * auto-posting clips, the backfill, and the owner's requests done.
 */
export function pingExtras({ settings, state, autopost, resumeDone, letGoDone }) {
  const at = backlogAt({ settings, state, autopost });
  const hold = settings.holdAutoBefore ? Date.parse(settings.holdAutoBefore) : NaN;
  return {
    ...(at ? { backlogAt: at } : {}),
    ...(Number.isFinite(hold) ? { holdBefore: new Date(hold).toISOString() } : {}),
    ...(settings.backfill ? { backfill: true } : {}),
    ...(resumeDone ? { resumeDone } : {}),
    ...(letGoDone ? { letGoDone } : {}),
  };
}

// §47.11: while a lane is held only for a TikTok login, the helper looks at most this often whether its Chrome is
// logged in to the right account again (a cheap headless look; nothing on screen).
export const LOGIN_CHECK_EVERY_MS = 5 * MINUTE;

/**
 * The lane's hold, when it is a TikTok login problem and nothing else (§47.11): ``{id}`` of the clip (Clip Factory,
 * ``needsYouClipId``) or Clips Funded job (``needsYouJobId``) it stopped on. Only a needs-you whose code is "login"
 * counts: a puzzle, a code, a limit, a warning, "three times", a pause or an older helper's hold (no code) is null,
 * and then the helper never looks.
 * @param {object|null} helper MacHelper / WsMacHelper from the lane's GET …/tiktok/mac
 * @param {"clips"|"ws"} kind
 * @returns {{id: string}|null}
 */
export function loginHold(helper, kind) {
  if (helper?.state !== "needs_you" || helper.needsYouCode !== "login") return null;
  const id = kind === "ws" ? helper.needsYouJobId : helper.needsYouClipId;
  return typeof id === "string" && id ? { id } : null;
}

/**
 * Did this Mac try the held clip or job (§47.11)? Every try writes the lane's ledger entry at its claim, before
 * anything can stop, so the Mac that stopped it always has one. A Mac without one (a second Mac, whose pings only
 * repeat the hold) never looks: the server's logged-in route would refuse it anyway (``needsYouDevice``).
 * @param {object} ledger the lane's ledger (state.ledger, state.ws[id].ledger)
 * @param {{id: string}|null} hold loginHold
 */
export function triedHere(ledger, hold) {
  return Boolean(hold && ledger && typeof ledger === "object" && Object.hasOwn(ledger, hold.id));
}

/** Is a look due? With no stamp, one 5 minutes old or more, or one in the future (the clock moved). */
export function loginCheckDue(lastAt, now) {
  const last = lastAt ? Date.parse(lastAt) : NaN;
  const t = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(last)) return true;
  return last > t || t - last >= LOGIN_CHECK_EVERY_MS;
}

const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Times (ms) within the last 24 hours. */
function lastDay(times, now) {
  return (times || []).map((t) => Date.parse(t)).filter((t) => Number.isFinite(t) && now - t < DAY && t <= now);
}

/**
 * The owner's one-time backfill (22 Nov: "i want all existing videos here to be uplaoded to tiktok ... just a one time
 * thing"): one backlog clip every 2 hours, oldest first, never within an hour of an auto-posting run or an Upload, at
 * most 7 backfill posts and 11 TikTok posts in all in any 24 hours (TikTok's guide: about 15 a day). It never holds
 * up a run's clip or his Upload (those are decided before this).
 */
export function backfillAction({ backlog, state, settings, now, autopost }) {
  const b = { everyMinutes: 120, quietMinutes: 60, maxPer24h: 7, totalMax24h: 11, ...settings.backfill };
  const t = now.getTime();
  const earliest = [];
  const backfills = lastDay(state.backfillPosts, t);
  const lastBackfill = Math.max(-Infinity, ...backfills, state.lastBacklogAt ? Date.parse(state.lastBacklogAt) : -Infinity);
  if (Number.isFinite(lastBackfill)) earliest.push(lastBackfill + b.everyMinutes * MINUTE);
  const quiet = b.quietMinutes * MINUTE;
  const lastRunPress = state.lastRunPressAt ? Date.parse(state.lastRunPressAt) : -Infinity;
  if (Number.isFinite(lastRunPress)) earliest.push(lastRunPress + quiet);
  const lastRun = autopost && autopost.lastRunAt ? Date.parse(autopost.lastRunAt) : -Infinity;
  if (Number.isFinite(lastRun)) earliest.push(lastRun + quiet);
  // The 24-hour caps: wait until the oldest post in the window is a day old.
  if (backfills.length >= b.maxPer24h) earliest.push(Math.min(...backfills) + DAY);
  const all = lastDay((state.posted || []).map((p) => p.at), t);
  if (all.length >= b.totalMax24h) earliest.push([...all].sort((x, y) => x - y)[all.length - b.totalMax24h] + DAY);
  // Auto-posting's schedule unknown (GET /v1/autopost failed): the paced backfill waits rather than risk the hour
  // before a run (review, 22 Nov). The burst (quiet of a minute or less) doesn't depend on it.
  if (!autopost && b.quietMinutes > 1) return { action: "wait", job: backlog, reason: "Backfill: auto-posting's schedule is unknown." };
  let when = Math.max(t, ...earliest);
  // Not within the quiet hour before the next run either: then it goes after that run's quiet hour.
  const next = autopost && autopost.on && autopost.nextRunAt ? Date.parse(autopost.nextRunAt) : null;
  if (next !== null && when > next - quiet && when < next + quiet) when = next + quiet;
  if (when <= t) return { action: "post", job: backlog };
  return { action: "wait", job: backlog, reason: "Backfill: one every 2 hours.", until: new Date(when).toISOString() };
}

// ---------------------------------------------------------------------------------------------------------------
// Clips Funded's lanes (§47.10, D1, D2): the same rules, each lane on its own, Clip Factory first.

/** A ws lane's settings: the shared pause, spacing and nothing of Clip Factory's trial, backfill or hold. */
export function wsSettings(settings) {
  return { ...settings, trialLimit: null, backfill: null, holdAutoBefore: null };
}

export const NOT_SET_UP = "Not logged in to TikTok on this Mac yet.";

/**
 * What a ws lane would do now: nextAction on its own view (its ledger, its last press), with the same never-twice,
 * find, resume and post rules. Its own needs-you pauses only this lane; settings.paused pauses every lane. A new
 * post waits while the lane's profile isn't logged in to the workspace's TikTok (``setUp`` false: the row says "Your
 * Mac isn't set up yet" until the owner's Log in on my Mac); a post already under way is still finished or looked for.
 * @param {{on: boolean, helper: object|null, queue: Array<object>, view: object, settings: object, device: string,
 *   now: Date, setUp?: boolean}} args
 */
export function wsAction({ on, helper, queue, view, settings, device, now, setUp = true }) {
  if (helper?.state === "needs_you") return { action: "paused", reason: helper.reason || "Your Mac needs you." };
  const action = nextAction({ on, queue, state: view, settings: wsSettings(settings), device, now, autopost: null });
  if (action.action === "post" && !setUp) return { ...action, action: "wait", reason: NOT_SET_UP };
  return action;
}

/**
 * A ws lane's check-in (POST /v1/workspaces/{ws}/tiktok/mac/ping): exactly these keys (the server refuses others).
 * ``resumeDone``: the owner's Start my Mac again (helper.resumeRequest) was carried out.
 * @returns {{state: "ok"|"needs_you"|"paused", reason?: string, version: string, device: string, setUp: boolean,
 *   handle?: string, loginDone?: string, resumeDone?: string}}
 */
export function wsPingBody({ action, needsYou, version, device, setUp, handle, loginDone, resumeDone }) {
  const state = needsYou ? "needs_you" : action?.action === "paused" ? "paused" : "ok";
  const reason = state !== "ok" && action?.reason ? String(action.reason).slice(0, 200) : null;
  return {
    state,
    ...(reason ? { reason } : {}),
    version,
    device,
    setUp: setUp === true,
    ...(handle && /^@[A-Za-z0-9._]{1,30}$/.test(handle) ? { handle } : {}),
    ...(loginDone ? { loginDone: String(loginDone).slice(0, 40) } : {}),
    ...(resumeDone ? { resumeDone: String(resumeDone).slice(0, 40) } : {}),
  };
}

const MAC_WORK = ["post", "resume", "find"];

/**
 * The one thing a tick does (D2): Clip Factory's post, resume or find first, exactly as in 1.1.0; else the first ws
 * lane (in workspace order) with a find, then a resume, then a post; else a ws lane's pending login request; else
 * tidying. ``lanes``: [{id, action, loginRequest}] in workspace order.
 * @returns {{lane: "clips"|string, what: "post"|"resume"|"find"|"login"|"tidy", index?: number}}
 */
export function pickWork({ clips, lanes = [] }) {
  if (MAC_WORK.includes(clips?.action)) return { lane: "clips", what: clips.action };
  for (const what of ["find", "resume", "post"]) {
    const index = lanes.findIndex((l) => l.action?.action === what);
    if (index >= 0) return { lane: lanes[index].id, what, index };
  }
  const index = lanes.findIndex((l) => l.loginRequest);
  if (index >= 0) return { lane: lanes[index].id, what: "login", index };
  return { lane: "clips", what: "tidy" };
}
