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
 * @returns {{action: "idle"|"paused"|"wait"|"resume"|"find"|"post", job?: object, reason?: string, until?: string}}
 */
export function nextAction({ on, queue, state, settings, device, now }) {
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

  // 4. Pace: never two posts close together. A clip the owner just uploaded by hand goes first with a smaller gap.
  const job = waiting[0];
  const gap = (job.source === "upload" ? settings.onDemandSpacingMinutes : settings.spacingMinutes) * MINUTE;
  const last = state.lastPressedAt ? Date.parse(state.lastPressedAt) : null;
  if (last !== null && now.getTime() - last < gap) {
    return { action: "wait", job, until: new Date(last + gap).toISOString() };
  }
  return { action: "post", job };
}
