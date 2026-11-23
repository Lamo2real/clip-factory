// The per-job beat (§47, D2). Clip Factory calls a Mac post stuck once its own beat (macBeatAt) is MAC_BEAT_STALE
// old, and only then offers the owner It's on TikTok (and Try again after the find window). So while the helper works
// on a post it re-sends, every minute, the last step the server took for it: a re-sent step is the job's beat. Jobs
// this Mac pressed Post for and still looks for get the same beat with "finding". No beats while the helper is idle,
// waiting or paused: then the post really is stuck, and the row says so.
import { ApiError } from "./api.js";
import { BEAT_EVERY_MS, beatTargets } from "./plan.js";

const conflict = (e) => e instanceof ApiError && e.status === 409;
const words = (e) => String(e?.message || e);

/**
 * Starts beating for doPost's ``job``, from its claim until doPost returns (``stop``). Steps for the job go through
 * ``step`` so a step and a beat never overlap: a beat is skipped while a step (or the last beat) for that job is in
 * flight, and a step waits for a beat in flight. Beat errors are logged (beat.failed) and never stop the tick; a 409
 * on the current job's beat (Clip Factory took it back, or another try has it) makes the next ``ready``/``step``
 * throw it, so the next step goes no further (the "pressing" step stays the gate: no click without the server's yes).
 * @param {object} o
 * @param {{step: Function}} o.api      client() (only ``step`` is used)
 * @param {object} o.state              state.json (device; the ledger's sentStep is read at each beat)
 * @param {{clipId: string, attempt?: number}} o.job
 * @param {Array<object>} o.queue       this tick's queue (other pressed jobs of this Mac get "finding")
 * @param {(event: string, fields: object) => void} o.log
 * @param {(fields: object) => void} o.record  saves fields to the job's ledger entry, on disk (store.remember)
 * @param {number} [o.every]
 * @param {string} [o.current]  the job's own beat step (doFind: "finding"); default the last step the server took
 */
export function startBeats({ api, state, job, queue, log, record, every = BEAT_EVERY_MS, current = null }) {
  const flying = new Map(); // clipId -> a promise (never rejecting) of the step or beat in flight for that job
  let lost = null;
  const track = (clipId, call) => {
    const settled = call.then(
      () => {},
      () => {}
    );
    flying.set(clipId, settled);
    settled.then(() => {
      if (flying.get(clipId) === settled) flying.delete(clipId);
    });
    return call;
  };
  const beat = ({ clipId, step, attempt }) => {
    if (flying.has(clipId)) return;
    track(
      clipId,
      Promise.resolve()
        .then(() => api.step(clipId, state.device, step, attempt))
        .catch((e) => {
          log("beat.failed", { clipId, step, status: e?.status, error: words(e) });
          if (clipId === job.clipId && conflict(e)) lost = e;
        })
    );
  };
  let timer = setInterval(() => {
    const targets = beatTargets({ queue, state, device: state.device, current: job }).filter((t) => !current || t.clipId !== job.clipId);
    if (current) targets.unshift({ clipId: job.clipId, step: current, attempt: job.attempt });
    for (const target of targets) beat(target);
  }, every);
  timer.unref?.(); // never keeps the tick (and run.lock) alive on its own

  /** Waits for a beat in flight for the job; throws the 409 its beat got. */
  async function ready() {
    while (flying.has(job.clipId)) await flying.get(job.clipId);
    if (lost) throw lost;
  }

  return {
    ready,
    /** Sends a step for the job (never on top of its beat) and records it as the step the server took (sentStep). */
    async step(name) {
      await ready();
      await track(job.clipId, api.step(job.clipId, state.device, name, job.attempt));
      record({ sentStep: name });
    },
    /** No more beats; waits for those in flight. */
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await Promise.all([...flying.values()]);
    },
  };
}

/**
 * doFind's beats before it looks (D2): "finding", with each job's attempt, for the job it looks for and for every other
 * job of this Mac that is working and pressed (beatTargets): plan.js looks for one pressed job per tick, and the others
 * are still this Mac's to look for, so none of them reads "Not sure it posted" meanwhile. Returns false when Clip
 * Factory answered 409 on the job itself (it is no longer this try's), so it stops looking for it this tick. Other
 * errors, and every error on the other jobs, are only logged.
 */
export async function findBeat({ api, state, job, queue = [], log }) {
  const send = async ({ clipId, attempt }) => {
    try {
      await api.step(clipId, state.device, "finding", attempt);
      return true;
    } catch (e) {
      log("beat.failed", { clipId, step: "finding", status: e?.status, error: words(e) });
      return !conflict(e);
    }
  };
  const others = beatTargets({ queue, state, device: state.device, current: job }).filter((t) => t.clipId !== job.clipId);
  const [mine] = await Promise.all([send(job), ...others.map(send)]);
  return mine;
}
