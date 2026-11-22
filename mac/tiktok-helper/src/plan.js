// Pure rules: which job to do now, if any. No I/O here, so every rule is unit-tested (test/plan.test.js).

const MINUTE = 60_000;

/**
 * @param {object} args
 * @param {boolean} args.on            Clip Factory's switch (tiktokMac.on)
 * @param {Array<object>} args.queue   MacJob[] from GET /v1/tiktok/mac, in the server's order
 * @param {object} args.state          state.json
 * @param {object} args.settings       settings.json
 * @param {string} args.device         this Mac's device id
 * @param {Date} args.now
 * @param {{on: boolean, lastRunAt: string|null, nextRunAt: string|null}|null} [args.autopost] auto-posting's schedule
 * @returns {{action: "idle"|"paused"|"wait"|"resume"|"find"|"post", job?: object, reason?: string, until?: string}}
 */
export function nextAction({ on, queue, state, settings, device, now, autopost = null }) {
  if (!on) return { action: "idle", reason: "The switch in Clip Factory is off." };
  if (settings.paused) return { action: "paused", reason: "Paused on your Mac." };

  // 0. His Upload and a run's own clips go before a backlog clip is resumed or looked for (review, 22 Nov): looking
  // for a pressed post only reads TikTok and can wait a few minutes; it never posts again either way.
  const backlogKind = (j) => j.source !== "upload" && j.source !== "auto";
  const holdBefore = settings.holdAutoBefore ? Date.parse(settings.holdAutoBefore) : null;
  const firstWaiting = queue.find(
    (j) => j.state === "waiting" && (j.source === "upload" || (j.source === "auto" && !(holdBefore && Date.parse(j.since || 0) < holdBefore)))
  );
  const busyBacklog = queue.some((j) => j.state === "working" && backlogKind(j) && state.ledger[j.clipId]);
  if (firstWaiting && busyBacklog) {
    const last = state.lastPressedAt ? Date.parse(state.lastPressedAt) : null;
    const gap = ((firstWaiting.source === "upload" ? settings.onDemandSpacingMinutes : settings.autoSpacingMinutes) ?? 1) * MINUTE;
    if (last === null || now.getTime() - last >= gap) return { action: "post", job: firstWaiting };
  }

  // 1. Never twice: a job this Mac already pressed Post for is only ever looked for, never posted again.
  for (const job of queue) {
    const mine = state.ledger[job.clipId];
    const pressed = Boolean(job.pressedAt) || mine?.step === "pressing" || mine?.step === "finding";
    if (job.state === "working" && pressed && mine) return { action: "find", job };
  }
  // 2. A job this Mac claimed but had not pressed Post for (it stopped or crashed): do it again from the start.
  for (const job of queue) {
    const mine = state.ledger[job.clipId];
    if (job.state === "working" && !job.pressedAt && mine && mine.device === device && mine.step !== "pressing") {
      return { action: "resume", job };
    }
  }

  const waiting = queue.filter((j) => j.state === "waiting");
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
  const run = autopost && autopost.on && autopost.lastRunAt ? Date.parse(autopost.lastRunAt) : null;
  const next = autopost && autopost.nextRunAt ? Date.parse(autopost.nextRunAt) : null;
  const after = (settings.backlogAfterRunMinutes ?? 30) * MINUTE;
  if (run === null) {
    return { action: "wait", job: backlog, reason: "Waits for the next auto-posting run.", until: next ? new Date(next + after).toISOString() : undefined };
  }
  const doneSince = state.lastBacklogAt ? Date.parse(state.lastBacklogAt) >= run : false;
  if (doneSince) {
    return { action: "wait", job: backlog, reason: "One per auto-posting run.", until: next ? new Date(next + after).toISOString() : undefined };
  }
  if (now.getTime() < run + after) return { action: "wait", job: backlog, until: new Date(run + after).toISOString() };
  // Never right on top of another post.
  const gap = (settings.autoSpacingMinutes ?? 1) * MINUTE;
  return since(gap) ? { action: "post", job: backlog } : { action: "wait", job: backlog, until: new Date(last + gap).toISOString() };
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
