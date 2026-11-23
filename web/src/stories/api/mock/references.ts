// Lamo Stories mock: the references part (docs/CONTRACTS.md §45.16.8, §45.28). Reference videos in the shared store:
// a multipart upload with mock:// part addresses (the web pretends to send each part and gets an ETag back), and a
// pretend analysis by the video analysis agent that walks its three steps (Look at it, Listen, Write it up) in about
// 5 seconds and writes a ReferenceAnalysis. The model and effort follow the API's rules (§45.25: per-run override >
// the reference's own setting > the task > the agent > the default). Builder H owns it.
//
// GET …/references/{refId} answers the contract's { reference, analysis, job } (§45.34): the last stored analysis,
// whatever the status (as the API reads analysis.json), and the analysis job of currentJobId, else the latest one (null
// before the first analysis), so the page shows each step and the failure's own reason. Like Lamo Stories' agent, a
// failed re-run puts an analyzed video back to `analyzed` (the last analysis kept) and only the job says it failed.
// PATCH takes { title?, ai? } (ai: the video's own model and effort, "Keep with this video"), checked like the API.
//
// A reference video is deleted with deleteReferenceVideo (§45.34); deleteReference is a character's picture (the
// characters part).
//
// Like the API, a reference past uploading carries `url` (here a pretend link: mock mode plays nothing), except once
// its file was cleared to save space (§45.34 "Keeping and clearing files"): then `url` is left out, `bytes` is 0,
// `fileRemoved` is true and `studyKept` says whether its study stays (§45.35 D9), and Analyze answers 409 "The video was
// removed to save space. Its study stays." (only "The video was removed to save space." when it was never studied, as
// the API says). clearReferenceFile does that; clearByKeepSetting applies the workspace's
// keepReferences the way the API's storage cleanup does (index.ts runs it with POST …/storage/cleanup).
//
// The pretend study fits the uploaded video's own length (§45.36 E18), as the real agent reads it from the file: the
// web tells the mock the length it read on this device (mockVideoSeconds, a mock-only hook the HTTP client does not
// have), else the knob refUploadSeconds, else 42 seconds.
//
// A reference can also come from a pasted link (§45.40): createReferenceFromLink checks it with the same allowlist as
// the API (refLinks.ts) and the API's refusals (the 100 limit, the same link twice, three on their way at once), then a
// pretend `reference_fetch` job (one step, "Get the video") moves it from `fetching` to `ready` (24 MB, the video's
// length from refUploadSeconds or 42 seconds, the title left as it was), or to `fetch_failed` with the knob's
// sentence; fetchReferenceAgain is its Try again. GET answers `fetchJob` (the newest reference_fetch job, null for an
// upload) beside `job`, which is the analysis job only. `url` is only there once the file is here.
//
// Test knobs: refSeconds (how long an analysis takes, default 5), refFail (the next analysis fails with this sentence),
// refJobInGet (kept for older tests: the job is always in the answer now), refNoJob (the answer leaves `job` out, as
// the API did before §45.34, for the page's own fallback), refFileRemoved (refIds whose file was cleared),
// refFetchSeconds (how long getting a linked video takes, default 2), refFetchFail (the next fetch ends fetch_failed
// with this sentence).
import { ApiError } from "../../../api/errors.ts";
import type { AiSetting, ModelOverride, ProductionJob, ReferenceAnalysis, ReferenceVideo, StoriesApi, StoryStep } from "../types.ts";
import { refLink, REF_LINK_REFUSED, SITE_NAME } from "../refLinks.ts";
import { checkWs, lowerLevels, modelCall, MODELS, newId, resolve } from "./chat.ts";
import { delay, type MockStore } from "./store.ts";

export const KEYS = ["listReferences", "createReference", "completeReference", "analyzeReference", "createReferenceFromLink", "fetchReferenceAgain", "getReference", "patchReference", "deleteReferenceVideo"] as const;

/** The mock-only hook the upload uses to say how long the video it sent is (the HTTP client has none). */
export interface MockVideoSeconds {
  mockVideoSeconds?: (ws: string, refId: string, seconds: number) => void;
}

const PART = 100 * 1024 * 1024;
const MAX = 2 * 1024 * 1024 * 1024;
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const bad = (message: string, field?: string) => new ApiError(400, "bad_request", message, field);

/** The statuses that have a file to play (§45.40: never while uploading, fetching or after a fetch failed). */
const HAS_FILE: ReferenceVideo["status"][] = ["ready", "analyzing", "analyzed", "failed"];
/** The API's refusals for links (§45.40). */
export const LINK_SENTENCES = {
  full: "You have 100 reference videos already. Delete one first.",
  twice: "That video is in your list already.",
  three: "Three videos are on their way already. Wait for one to arrive.",
  fetching: "It is getting the video now.",
  here: "This video is here already.",
  notHere: "Wait until the video is here.",
  getFirst: "Get the video first. Tap Try again.",
} as const;

/** The analysis job's own steps (§45.28, §45.34: StoryStep.key look, listen, write). */
export const REF_STEPS: { key: string; label: string }[] = [
  { key: "look", label: "Look at it" },
  { key: "listen", label: "Listen" },
  { key: "write", label: "Write it up" },
];

interface RefState {
  owner: Map<string, string>;
  analyses: Map<string, ReferenceAnalysis>;
  uploads: Map<string, { uploadId: string; parts: number; size: number }>;
  runs: Map<string, { start: number; fail: string | null }>;
  /** References whose file was cleared to save space (their study stays). */
  cleared: Set<string>;
  /** The length of each uploaded video as the device read it (the agent reads it from the file). */
  seconds: Map<string, number>;
  /** Getting a linked video (§45.40): the reference_fetch job id, when it started and the sentence it fails with. */
  fetches: Map<string, { start: number; fail: string | null }>;
  /** Link references still named "{Site} video" by the mock, not by the owner (the API's titleFromLink). */
  titleFromLink: Set<string>;
}

const states = new WeakMap<MockStore, RefState>();
function state(store: MockStore): RefState {
  let s = states.get(store);
  if (!s) {
    s = { owner: new Map(), analyses: new Map(), uploads: new Map(), runs: new Map(), cleared: new Set(), seconds: new Map(), fetches: new Map(), titleFromLink: new Set() };
    states.set(store, s);
  }
  return s;
}

export const SEED_IDS = { analyzed: "01JSTRF0000000000000000001", ready: "01JSTRF0000000000000000002" };

/** The API's sentence for a reference whose file was cleared (§45.34). */
export const FILE_REMOVED = "The video was removed to save space. Its study stays.";
/** The same, for a video cleared before it was ever studied: no study stays (the API's REMOVED_NO_STUDY). */
export const REMOVED_NO_STUDY = "The video was removed to save space.";

function isCleared(store: MockStore, refId: string): boolean {
  const knob = store.knobs.refFileRemoved;
  return state(store).cleared.has(refId) || (Array.isArray(knob) && knob.includes(refId));
}

/** Clears a reference's file and keeps its study, as the keep setting `study_only` does (§45.34). */
export function clearReferenceFile(store: MockStore, refId: string): boolean {
  const ref = store.references.find((r) => r.refId === refId);
  if (!ref || !HAS_FILE.includes(ref.status) || ref.currentJobId || isCleared(store, refId)) return false;
  state(store).cleared.add(refId);
  // The file is gone, so it no longer counts in Settings › Storage (the API sums bytes 0 for it).
  ref.bytes = 0;
  ref.updatedAt = iso();
  return true;
}

/**
 * Applies the workspace's keepReferences now, as the API's storage cleanup does (§45.34, §45.35 D9): `study_only`
 * clears the file of every studied video (its study stays); `days_30` and `days_90` clear every video older than that,
 * studied or not (one never studied keeps no study). A video being uploaded or analyzed is left alone.
 */
export function clearByKeepSetting(store: MockStore, ws: string, keep: string | undefined, now = Date.now()): { files: number; bytes: number } {
  const removed = { files: 0, bytes: 0 };
  if (!keep || keep === "all") return removed;
  const days = keep === "days_30" ? 30 : keep === "days_90" ? 90 : null;
  const s = state(store);
  for (const ref of store.references) {
    if ((s.owner.get(ref.refId) ?? "stories") !== ws) continue;
    const old = days !== null && Date.parse(ref.createdAt) < now - days * 24 * 3600 * 1000;
    const studied = s.analyses.has(ref.refId);
    if (keep === "study_only" ? !studied : !old) continue;
    const bytes = ref.bytes;
    if (!clearReferenceFile(store, ref.refId)) continue;
    removed.files += 1;
    removed.bytes += bytes;
  }
  return removed;
}

/** A reference as the API answers it: a link to the file once it is here (uploaded or fetched), none after the file
 * was cleared; `link`, the cleaned link it came from (null for an upload). */
function pub(store: MockStore, ref: ReferenceVideo): ReferenceVideo {
  const out = structuredClone(ref);
  delete out.url;
  out.link = ref.link ?? null;
  const cleared = isCleared(store, ref.refId);
  if (HAS_FILE.includes(ref.status) && !cleared) out.url = `data:text/plain;charset=utf-8,${encodeURIComponent(`Pretend reference video "${ref.title}" (mock mode plays nothing).`)}`;
  // §45.35 D9: the mark the API reads (fileRemovedAt), and whether the study stays; a cleared file counts 0 bytes.
  out.fileRemoved = cleared;
  out.studyKept = cleared && state(store).analyses.has(ref.refId);
  if (cleared) out.bytes = 0;
  return out;
}

/** A believable analysis for a video of this length (the real one comes from the frames and the loudness). */
export function pretendAnalysis(title: string, durationSec: number): ReferenceAnalysis {
  const d = Math.max(6, durationSec);
  const cuts = [0, 0.08, 0.22, 0.4, 0.55, 0.72, 0.88, 1].map((f) => Math.round(f * d * 10) / 10);
  const what = [
    "A close-up of a worried face: something is about to go wrong.",
    "Wide shot: the whole problem at once, the character small in the frame.",
    "The first try. It fails in a funny way.",
    "A pause. The character looks straight at the camera.",
    "The second try, faster, with a new trick.",
    "It works, almost. One last wobble.",
    "The landing and a proud pose; the music lifts.",
  ];
  const shots = what.map((w, i) => ({
    start: cuts[i]!,
    end: cuts[i + 1]!,
    what: w,
    acting: ["Eyes go wide, shoulders up.", "Tiny steps, arms out for balance.", "A flail and a bounce.", "A slow blink: the joke lands.", "Determined squint, then a dash.", "Knees wobble, arms windmill.", "Chin up, a big grin."][i]!,
    sound: ["A rising whoosh.", "Quiet room tone.", "A boing and a thud.", "Silence for half a second.", "Quick footsteps.", "A squeak.", "A small fanfare."][i]!,
  }));
  return {
    summary: `"${title}" tells one small problem in ${shots.length} shots without a word: a worried start, two tries, and a proud finish. Every joke is in the faces and the timing.`,
    hook: { atSec: Math.min(1.5, d / 8), what: "The worried face fills the screen before we know why, so we wait to find out." },
    pacing: { cutsPer10s: Math.round(((shots.length - 1) / d) * 100) / 10, notes: "Fast at the start, one held pause before the second try, then quick cuts to the end." },
    shots,
    gags: ["The failed first try is bigger than the problem.", "The look to the camera after the fall.", "The second try copies something an animal did."],
    sound: "Loud at the start, almost silent before the second try, and the loudest moment is the landing. The music only comes in for the finish.",
    captions: "Two or three big words on screen at a time, near the top, never covering the face.",
    borrow: ["Open on the face, not the place.", "Hold a half-second pause before the turn.", "End on a pose the viewer can screenshot."],
    avoid: ["The characters, their names and their look.", "The exact jokes in the same order.", "Any of the footage or the music."],
  };
}

export function seed(store: MockStore): void {
  const s = state(store);
  const now = Date.now();
  const analyzed: ReferenceVideo = {
    refId: SEED_IDS.analyzed,
    title: "Penguin on the ice rink",
    status: "analyzed",
    durationSec: 38,
    bytes: 41_500_000,
    currentJobId: null,
    ai: { model: null, effort: null },
    analyzedWith: { model: "opus-5-5", effort: "high" },
    createdAt: iso(now - 26 * 3600_000),
    updatedAt: iso(now - 25 * 3600_000),
  };
  const ready: ReferenceVideo = {
    refId: SEED_IDS.ready,
    title: "Cat versus the robot vacuum",
    status: "ready",
    durationSec: null,
    bytes: 18_200_000,
    currentJobId: null,
    ai: { model: null, effort: null },
    analyzedWith: null,
    createdAt: iso(now - 5 * 3600_000),
    updatedAt: iso(now - 5 * 3600_000),
  };
  store.references.push(analyzed, ready);
  s.owner.set(analyzed.refId, "stories");
  s.owner.set(ready.refId, "stories");
  s.analyses.set(analyzed.refId, pretendAnalysis(analyzed.title, 38));
  store.knobs.refSeconds = store.knobs.refSeconds ?? 5;
}

function find(store: MockStore, ws: string, refId: string): ReferenceVideo {
  checkWs(store, ws);
  const r = store.references.find((x) => x.refId === refId);
  if (!r || (state(store).owner.get(refId) ?? "stories") !== ws) throw new ApiError(404, "not_found", "We could not find that reference video.");
  return r;
}

/** The newest job of a link reference's fetch (§45.40), or null (an upload has none). */
function fetchJobOf(store: MockStore, ref: ReferenceVideo): ProductionJob | null {
  const mine = store.jobs.filter((j) => j.jobType === "reference_fetch" && j.contentId === ref.refId);
  return mine.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.jobId.localeCompare(a.jobId))[0] ?? null;
}

/** The analysis job of currentJobId, else the reference's latest one (§45.34). */
function jobOf(store: MockStore, ref: ReferenceVideo): ProductionJob | null {
  const mine = store.jobs.filter((j) => j.jobType === "reference_analysis" && j.contentId === ref.refId);
  return mine.find((j) => j.jobId === ref.currentJobId) ?? mine.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

/** Moves every fetch of a linked video on (§45.40): `fetching` until refFetchSeconds have passed, then `ready` with its
 * file, or `fetch_failed` with the knob's sentence. */
function advanceFetches(store: MockStore, now: number): void {
  const s = state(store);
  const total = Number(store.knobs.refFetchSeconds ?? 2) * 1000;
  for (const [jobId, run] of s.fetches) {
    const job = store.jobs.find((j) => j.jobId === jobId);
    const ref = job ? store.references.find((r) => r.refId === job.contentId) : undefined;
    if (!job || !ref || (job.status !== "queued" && job.status !== "running") || ref.currentJobId !== jobId) {
      s.fetches.delete(jobId);
      continue;
    }
    const elapsed = now - run.start;
    const step = job.steps[0];
    job.status = "running";
    job.progress = Math.max(job.progress, Math.min(0.97, total > 0 ? elapsed / total : 0.97));
    job.updatedAt = iso(now);
    if (step && step.status === "pending") {
      step.status = "running";
      step.startedAt = iso(run.start);
    }
    if (elapsed < total) continue;
    if (run.fail) {
      job.status = "failed";
      job.error = run.fail;
      if (step) Object.assign(step, { status: "failed", message: run.fail, finishedAt: iso(now) });
      ref.status = "fetch_failed";
    } else {
      job.status = "ready";
      job.progress = 1;
      if (step) Object.assign(step, { status: "done", finishedAt: iso(now) });
      const knob = Number(store.knobs.refUploadSeconds);
      ref.status = "ready";
      ref.bytes = 24 * 1024 * 1024;
      ref.durationSec = Number.isFinite(knob) && knob > 0 ? knob : 42;
      s.titleFromLink.delete(ref.refId);
    }
    ref.currentJobId = null;
    ref.updatedAt = iso(now);
    s.fetches.delete(jobId);
  }
}

/** Moves every analysis on to where its time says it is (each read calls this). */
export function advance(store: MockStore, now = Date.now()): void {
  const s = state(store);
  advanceFetches(store, now);
  const total = Number(store.knobs.refSeconds ?? 5) * 1000;
  for (const [jobId, run] of s.runs) {
    const job = store.jobs.find((j) => j.jobId === jobId);
    const ref = job ? store.references.find((r) => r.refId === job.contentId) : undefined;
    if (!job || !ref || (job.status !== "queued" && job.status !== "running")) {
      s.runs.delete(jobId);
      continue;
    }
    const elapsed = now - run.start;
    const per = total / REF_STEPS.length;
    job.status = "running";
    job.progress = Math.max(job.progress, Math.min(0.97, elapsed / total));
    job.updatedAt = iso(now);
    job.steps.forEach((step, i) => {
      const startAt = i * per;
      if (elapsed >= startAt + per) {
        if (step.status !== "done") {
          step.status = "done";
          step.finishedAt = iso(run.start + startAt + per);
        }
      } else if (elapsed >= startAt && step.status !== "done") {
        step.status = "running";
        step.startedAt = step.startedAt ?? iso(run.start + startAt);
        if (i === 0) step.message = "2 pictures a second";
      }
    });
    if (run.fail && elapsed >= per) {
      // A failed analysis stops in its second step (Listen), however late it is read: the first is done, the rest
      // never ran, and the job carries the reason.
      job.status = "failed";
      job.error = run.fail;
      job.steps.forEach((st, i) => {
        if (i === 0) {
          st.status = "done";
          st.finishedAt = st.finishedAt ?? iso(run.start + per);
        } else if (i === 1) {
          st.status = "failed";
          st.startedAt = st.startedAt ?? iso(run.start + per);
          st.finishedAt = iso(now);
          delete st.message;
        } else {
          st.status = "pending";
          delete st.startedAt;
          delete st.finishedAt;
        }
      });
      ref.status = s.analyses.has(ref.refId) ? "analyzed" : "failed";
      ref.currentJobId = null;
      ref.updatedAt = iso(now);
      s.runs.delete(jobId);
      continue;
    }
    if (elapsed >= total) {
      job.status = "ready";
      job.progress = 1;
      for (const st of job.steps) {
        st.status = "done";
        delete st.message;
      }
      // The video's own length: as the device read it, else the knob, else a believable one (§45.36 E18).
      const knob = Number(store.knobs.refUploadSeconds);
      const sec = ref.durationSec ?? s.seconds.get(ref.refId) ?? (Number.isFinite(knob) && knob > 0 ? knob : 42);
      ref.durationSec = sec;
      ref.status = "analyzed";
      ref.currentJobId = null;
      const m = job.meta.models[0];
      ref.analyzedWith = m ? { model: m.model, effort: m.effort } : null;
      ref.updatedAt = iso(now);
      s.analyses.set(ref.refId, pretendAnalysis(ref.title, sec));
      s.runs.delete(jobId);
    }
  }
}

export function api(store: MockStore): Pick<StoriesApi, (typeof KEYS)[number]> {
  const s = state(store);
  /** A `reference_fetch` job for a link reference (§45.40): one step, "Get the video". */
  const startFetch = (ws: string, ref: ReferenceVideo, now: number): ProductionJob => {
    const job: ProductionJob = {
      jobId: newId(now),
      workspaceId: ws,
      contentType: "reference",
      contentId: ref.refId,
      jobType: "reference_fetch",
      status: "queued",
      steps: [{ key: "get", label: "Get the video", status: "pending" }],
      progress: 0,
      configuration: { run: ["get"], from: null, sceneIds: null, note: null },
      meta: { writerModel: null, engineVersion: null, seed: null, scriptVersion: null, targetSec: null, actualSec: null, safetyTopicId: null, providers: {}, models: [] },
      createdAt: iso(now),
      updatedAt: iso(now),
    };
    store.jobs.push(job);
    const fail = typeof store.knobs.refFetchFail === "string" ? store.knobs.refFetchFail : null;
    if (fail) store.knobs.refFetchFail = null;
    s.fetches.set(job.jobId, { start: now, fail });
    ref.currentJobId = job.jobId;
    ref.updatedAt = iso(now);
    return job;
  };
  const out = {
    async listReferences(ws: string) {
      await delay(120);
      checkWs(store, ws);
      advance(store);
      return store.references
        .filter((r) => (s.owner.get(r.refId) ?? "stories") === ws)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((r) => pub(store, r));
    },

    async createReference(ws: string, body: { filename: string; contentType: string; size: number; title: string }) {
      await delay(150);
      checkWs(store, ws);
      for (const k of Object.keys(body)) if (!["filename", "contentType", "size", "title"].includes(k)) throw bad("Something in that request was not right.", k);
      if (!["video/mp4", "video/quicktime"].includes(body.contentType)) throw bad("Pick an MP4 or MOV video.", "contentType");
      if (!(body.size > 0)) throw bad("That video is empty. Pick another one.", "size");
      if (body.size > MAX) throw new ApiError(413, "too_large", "That video is too big. Pick one under 2 GB.", "size");
      const title = String(body.title ?? "").trim();
      if (!title || title.length > 80) throw bad("Give the video a name of up to 80 letters.", "title");
      const now = iso();
      const ref: ReferenceVideo = { refId: newId(), title, status: "uploading", durationSec: null, bytes: body.size, currentJobId: null, ai: { model: null, effort: null }, analyzedWith: null, createdAt: now, updatedAt: now };
      store.references.push(ref);
      s.owner.set(ref.refId, ws);
      const count = Math.max(1, Math.ceil(body.size / PART));
      const uploadId = `mock-upload-${ref.refId}`;
      s.uploads.set(ref.refId, { uploadId, parts: count, size: body.size });
      return {
        reference: pub(store, ref),
        upload: { uploadId, parts: Array.from({ length: count }, (_, i) => ({ partNumber: i + 1, url: `mock://references/${ref.refId}/part/${i + 1}` })) },
      };
    },

    async completeReference(ws: string, refId: string, parts: { partNumber: number; etag: string }[]) {
      await delay(200);
      const ref = find(store, ws, refId);
      const up = s.uploads.get(refId);
      if (ref.status !== "uploading" || !up) throw new ApiError(409, "conflict", "That video has already been uploaded.");
      const numbers = new Set(parts.map((p) => p.partNumber));
      if (numbers.size !== up.parts || parts.some((p) => !p.etag || p.partNumber < 1 || p.partNumber > up.parts)) throw bad("Some of the video did not arrive. Upload it again.", "parts");
      ref.status = "ready";
      ref.updatedAt = iso();
      s.uploads.delete(refId);
      return pub(store, ref);
    },

    async analyzeReference(ws: string, refId: string, override?: ModelOverride) {
      await delay(160);
      const ref = find(store, ws, refId);
      advance(store);
      if (ref.status === "uploading") throw new ApiError(409, "conflict", "Wait until the video has finished uploading.");
      if (ref.status === "fetching") throw new ApiError(409, "conflict", LINK_SENTENCES.notHere);
      if (ref.status === "fetch_failed") throw new ApiError(409, "conflict", LINK_SENTENCES.getFirst);
      if (ref.status === "analyzing") throw new ApiError(409, "conflict", "It is being analyzed right now.");
      if (isCleared(store, refId)) throw new ApiError(409, "conflict", state(store).analyses.has(refId) ? FILE_REMOVED : REMOVED_NO_STUDY);
      if (override) for (const k of Object.keys(override)) if (!["model", "effort"].includes(k)) throw bad("Something in that request was not right.", "override");
      const low = lowerLevels(store, "reference_analysis", "video_analysis");
      if (low.agentOff) throw new ApiError(409, "conflict", low.agentOff);
      const eff = resolve({ request: override ?? null, project: ref.ai, task: low.task, agent: low.agent, ai: low.ai });
      if ("error" in eff) throw bad(eff.sentence, eff.error === "model" ? "override" : "effort");
      const now = Date.now();
      const job: ProductionJob = {
        jobId: newId(now),
        workspaceId: ws,
        contentType: "reference",
        contentId: refId,
        jobType: "reference_analysis",
        status: "queued",
        steps: REF_STEPS.map((st) => ({ key: st.key as StoryStep["key"], label: st.label, status: "pending" })),
        progress: 0,
        configuration: { run: REF_STEPS.map((st) => st.key as StoryStep["key"]), from: null, sceneIds: null, note: null },
        meta: {
          writerModel: null,
          engineVersion: null,
          seed: null,
          scriptVersion: null,
          targetSec: null,
          actualSec: null,
          safetyTopicId: null,
          providers: {},
          models: [{ step: "write", agentId: "video_analysis", task: "reference_analysis", model: eff.model, ...(modelCall(eff.model) ?? {}), effort: eff.effort, effortApplied: eff.effortApplied }],
        },
        createdAt: iso(now),
        updatedAt: iso(now),
      };
      store.jobs.push(job);
      const fail = typeof store.knobs.refFail === "string" ? store.knobs.refFail : null;
      if (fail) store.knobs.refFail = null;
      s.runs.set(job.jobId, { start: now, fail });
      ref.status = "analyzing";
      ref.currentJobId = job.jobId;
      ref.updatedAt = iso(now);
      return { reference: pub(store, ref), job: structuredClone(job) };
    },

    async createReferenceFromLink(ws: string, body: { url: string; title?: string }) {
      await delay(150);
      checkWs(store, ws);
      advance(store);
      for (const k of Object.keys(body ?? {})) if (!["url", "title"].includes(k)) throw bad("Something in that request was not right.", k);
      const raw = body?.url;
      if (typeof raw !== "string") throw bad(REF_LINK_REFUSED.empty, "url");
      const got = refLink(raw);
      if (!got.ok) throw bad(REF_LINK_REFUSED[got.why], "url");
      let title = `${SITE_NAME[got.site]} video`;
      if (body.title !== undefined) {
        title = String(body.title ?? "").trim().replace(/\s+/g, " ");
        if (!title) throw bad("Give the video a name.", "title");
        if (title.length > 80) throw bad("The name is too long (at most 80 characters).", "title");
      }
      const mine = store.references.filter((r) => (s.owner.get(r.refId) ?? "stories") === ws);
      if (mine.length >= 100) throw new ApiError(409, "conflict", LINK_SENTENCES.full);
      if (mine.some((r) => r.link === got.url)) throw new ApiError(409, "conflict", LINK_SENTENCES.twice);
      if (mine.filter((r) => r.status === "fetching").length >= 3) throw new ApiError(409, "conflict", LINK_SENTENCES.three);
      const now = Date.now();
      const ref: ReferenceVideo = { refId: newId(now), title, status: "fetching", durationSec: null, bytes: 0, link: got.url, currentJobId: null, ai: { model: null, effort: null }, analyzedWith: null, createdAt: iso(now), updatedAt: iso(now) };
      store.references.push(ref);
      s.owner.set(ref.refId, ws);
      if (body.title === undefined) s.titleFromLink.add(ref.refId);
      const job = startFetch(ws, ref, now);
      return { reference: pub(store, ref), job: structuredClone(job) };
    },

    async fetchReferenceAgain(ws: string, refId: string) {
      await delay(150);
      const ref = find(store, ws, refId);
      advance(store);
      if (ref.status === "fetching") throw new ApiError(409, "conflict", LINK_SENTENCES.fetching);
      if (ref.status !== "fetch_failed") throw new ApiError(409, "conflict", LINK_SENTENCES.here);
      const busy = store.references.filter((r) => (s.owner.get(r.refId) ?? "stories") === ws && r.status === "fetching").length;
      if (busy >= 3) throw new ApiError(409, "conflict", LINK_SENTENCES.three);
      const now = Date.now();
      ref.status = "fetching";
      const job = startFetch(ws, ref, now);
      return { reference: pub(store, ref), job: structuredClone(job) };
    },

    async getReference(ws: string, refId: string) {
      await delay(90);
      const ref = find(store, ws, refId);
      advance(store);
      const analysis = s.analyses.get(refId) ?? null;
      const job = jobOf(store, ref);
      const fetchJob = fetchJobOf(store, ref);
      const out = {
        reference: pub(store, ref),
        analysis: analysis ? structuredClone(analysis) : null,
        job: job ? structuredClone(job) : null,
        fetchJob: fetchJob ? structuredClone(fetchJob) : null,
      };
      if (store.knobs.refNoJob === true && store.knobs.refJobInGet !== true) {
        const { job: _left, ...older } = out;
        return older as typeof out;
      }
      return out;
    },

    async patchReference(ws: string, refId: string, patch: { title?: string; ai?: AiSetting }) {
      await delay(120);
      const ref = find(store, ws, refId);
      for (const k of Object.keys(patch ?? {})) if (!["title", "ai"].includes(k)) throw bad("Something in that request was not right.", k);
      if (patch.title === undefined && patch.ai === undefined) throw bad("Say what to change: the name or the model.", "title");
      let title = ref.title;
      if (patch.title !== undefined) {
        title = String(patch.title ?? "").trim();
        if (!title || title.length > 80) throw bad("Give the video a name of up to 80 letters.", "title");
      }
      let ai = ref.ai;
      if (patch.ai !== undefined) {
        if (!patch.ai || typeof patch.ai !== "object") throw bad("Pick a model and effort, or the usual.", "ai");
        ai = { model: patch.ai.model ?? null, effort: patch.ai.effort ?? null };
        // The same refusals as the API (§45.25): an unknown model, or an effort the model does not offer.
        if (ai.model !== null && !MODELS.some((m) => m.key === ai.model)) throw bad("We don't know that model. Pick one from the list.", "ai");
        const low = lowerLevels(store, "reference_analysis", "video_analysis");
        const r = resolve({ project: ai, task: low.task, agent: low.agent, ai: low.ai });
        if ("error" in r) throw bad(r.sentence, "ai");
      }
      if (patch.title !== undefined) s.titleFromLink.delete(refId); // the owner's own name: a fetch never changes it
      ref.title = title;
      ref.ai = ai;
      ref.updatedAt = iso();
      return pub(store, ref);
    },

    /** Mock only: the length the device read from the file it is uploading (the agent reads it from the file). */
    mockVideoSeconds(ws: string, refId: string, seconds: number): void {
      if (!Number.isFinite(seconds) || seconds <= 0) return;
      if ((s.owner.get(refId) ?? "stories") !== ws) return;
      s.seconds.set(refId, Math.round(seconds * 10) / 10);
    },

    async deleteReferenceVideo(ws: string, refId: string): Promise<void> {
      await delay(120);
      find(store, ws, refId);
      store.references = store.references.filter((r) => r.refId !== refId);
      const mine = (j: ProductionJob) => j.contentId === refId && (j.jobType === "reference_analysis" || j.jobType === "reference_fetch");
      for (const j of store.jobs)
        if (mine(j)) {
          s.runs.delete(j.jobId);
          s.fetches.delete(j.jobId);
        }
      store.jobs = store.jobs.filter((j) => !mine(j));
      s.analyses.delete(refId);
      s.uploads.delete(refId);
      s.owner.delete(refId);
      s.cleared.delete(refId);
      s.seconds.delete(refId);
      s.titleFromLink.delete(refId);
    },
  };
  return out as unknown as Pick<StoriesApi, (typeof KEYS)[number]>;
}
