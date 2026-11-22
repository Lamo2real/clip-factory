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
  const auto = waiting.find((j) => j.source === "auto");
  if (auto) {
    const gap = (settings.autoSpacingMinutes ?? 1) * MINUTE;
    return since(gap) ? { action: "post", job: auto } : { action: "wait", job: auto, until: new Date(last + gap).toISOString() };
  }
  const backlog = waiting.find((j) => j.source !== "upload" && j.source !== "auto");
  if (!backlog) return { action: "idle", reason: "Nothing waiting." };
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
