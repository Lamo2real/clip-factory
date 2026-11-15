// The whole HTTP API in memory, with fake latency, so the UI runs with no backend (npm run dev:mock, Playwright).
import { ApiError, networkError } from "../errors.ts";
import type { Api, Job, Post, Settings, Skill } from "../types.ts";
import { MOMENTS, PLATFORMS, STEP_KEYS, coverArt, seed, stepsAt, thumbArt, ulid, type Store } from "./fixtures.ts";

const STEP_MS = 3500;
const clone = <T>(v: T): T => structuredClone(v);

/** Browser automation (Playwright) freezes job progress so screens and screenshots stay stable. */
const frozen = () => typeof navigator !== "undefined" && navigator.webdriver === true;

function delay(min = 160, max = 420): Promise<void> {
  const ms = frozen() ? 30 : min + Math.random() * (max - min);
  return new Promise((r) => setTimeout(r, ms));
}

const notFound = (what: string) => new ApiError(404, "not_found", `That ${what} no longer exists.`);
const conflict = (msg: string) => new ApiError(409, "conflict", msg);
const bad = (msg: string) => new ApiError(400, "bad_request", msg);
const ALREADY_DECIDED = "This clip has already been confirmed or declined.";

/**
 * Knobs for tests (Playwright reaches them as window.__cfMockFaults). `keepStopsAfterSave` makes the next N Keeps
 * save the clip and then fail like a dropped connection, before posting starts. `resumeAfterMs` is how old a
 * stuck Keep must be before Keep again finishes it (the API waits 60 seconds).
 */
export interface MockFaults {
  keepStopsAfterSave: number;
  resumeAfterMs: number;
}

export function mockApi(store: Store = seed(), faults: MockFaults = { keepStopsAfterSave: 0, resumeAfterMs: 60_000 }): Api {
  if (typeof window !== "undefined") (window as unknown as { __cfMockFaults?: MockFaults }).__cfMockFaults = faults;
  // When each kept clip's posting was last started (the API's publishClaimAt).
  const claimedAt = new Map<string, number>();

  // When each running job's current step began, to move it along over time.
  const clock = new Map<string, { at: number; done: number }>();
  for (const j of store.jobs) {
    if (j.status === "running") clock.set(j.jobId, { at: Date.now(), done: j.steps.findIndex((s) => s.status === "running") });
  }

  function finish(job: Job) {
    const count = job.clipTarget.min + Math.floor(Math.random() * (job.clipTarget.max - job.clipTarget.min + 1));
    const tags = job.notes?.match(/#\w+/g)?.join(" ") ?? "#clips";
    for (let i = 0; i < count; i++) {
      const m = MOMENTS[(i + job.jobId.charCodeAt(25)) % MOMENTS.length]!;
      const layout = i % 3 === 0 ? "blur_fill" : "facecam_top";
      store.clips.push({
        clipId: ulid(),
        jobId: job.jobId,
        rank: i + 1,
        status: "review",
        momentType: m.type,
        hook: m.hook,
        summary: m.summary,
        durationSec: 20 + i * 3,
        sourceStart: 300 + i * 600,
        sourceEnd: 320 + i * 603,
        sourceUrlAt: job.source.url,
        layout,
        coverUrl: coverArt(i + 2, m.hook, layout),
        captions: {
          youtubeTitle: `${m.hook} ${tags}`,
          youtubeDescription: m.summary,
          instagram: `${m.hook}\n${tags}`,
          facebook: m.hook,
          tiktok: `${m.hook} ${tags}`,
          x: `${m.hook} ${tags}`,
        },
        checklist: { items: [{ key: "hook_3s", label: "Hook lands in the first 3 seconds", pass: true }], fixes: [] },
        score: m.score,
        createdAt: new Date().toISOString(),
      });
    }
    job.status = "ready";
    job.clipCount = count;
    job.progress = 1;
    job.steps = stepsAt(STEP_KEYS.length, "ready");
  }

  function tick() {
    if (frozen()) return;
    const now = Date.now();
    for (const job of store.jobs) {
      if (job.status === "queued" && now - Date.parse(job.createdAt) > 4000) {
        job.status = "running";
        clock.set(job.jobId, { at: now, done: 0 });
      }
      const c = clock.get(job.jobId);
      if (job.status !== "running" || !c) continue;
      const done = Math.min(STEP_KEYS.length, c.done + Math.floor((now - c.at) / STEP_MS));
      if (done >= STEP_KEYS.length) {
        finish(job);
        clock.delete(job.jobId);
      } else {
        const within = ((now - c.at) % STEP_MS) / STEP_MS;
        job.steps = stepsAt(done, "running", done === 5 ? "Cutting the clips" : undefined);
        job.progress = Math.min(0.99, (done + within) / STEP_KEYS.length);
      }
      job.updatedAt = new Date().toISOString();
    }
  }

  const job = (jobId: string) => {
    const j = store.jobs.find((x) => x.jobId === jobId);
    if (!j) throw notFound("job");
    return j;
  };
  const clip = (clipId: string) => {
    const c = store.clips.find((x) => x.clipId === clipId);
    if (!c) throw notFound("clip");
    return c;
  };
  const skill = (skillId: string) => {
    const s = store.skills.find((x) => x.skillId === skillId);
    if (!s) throw notFound("skill");
    return s;
  };
  const publicSkill = ({ content: _content, ...s }: Skill & { content: string }): Skill => s;
  const pendingSkills = new Map<string, string>();

  return {
    async health() {
      await delay();
      return { ok: true, version: "mock" };
    },
    async me() {
      await delay();
      tick();
      return {
        user: { id: "mock-owner", email: "owner@example.com" },
        settings: clone(store.settings),
        counts: {
          review: store.clips.filter((c) => c.status === "review").length,
          running: store.jobs.filter((j) => j.status === "running" || j.status === "queued").length,
          posted: store.clips.filter((c) => c.status === "posted").length,
        },
      };
    },
    async createUpload({ filename, contentType, size }) {
      await delay();
      if (!contentType.startsWith("video/")) throw bad("Pick a video file, like an MP4 or MOV.");
      if (size > 5 * 1024 ** 3) throw new ApiError(413, "too_large", "Videos can be up to 5 GB.");
      const uploadId = ulid();
      return {
        uploadId,
        key: `uploads/mock-owner/${uploadId}/${filename}`,
        uploadUrl: "mock://upload",
        headers: { "Content-Type": contentType },
      };
    },
    async createJob(body) {
      await delay();
      const now = new Date().toISOString();
      const isLink = body.source.type === "link";
      const url = isLink ? (body.source as { url: string }).url : undefined;
      const platform = !isLink ? "upload" : /twitch\.tv/.test(url!) ? "twitch" : /kick\.com/.test(url!) ? "kick" : "youtube";
      const filename = body.source.type === "upload" ? body.source.filename : undefined;
      const j: Job = {
        jobId: ulid(),
        status: "queued",
        source: {
          type: body.source.type,
          platform,
          url,
          key: body.source.type === "upload" ? body.source.key : undefined,
          filename,
          title: filename ?? "Reading the link…",
          thumbnailUrl: thumbArt(store.jobs.length, platform === "upload" ? "Upload" : platform),
        },
        clipTarget: body.clipTarget,
        steps: stepsAt(0, "queued"),
        progress: 0,
        clipCount: 0,
        notes: body.notes,
        createdAt: now,
        updatedAt: now,
      };
      store.jobs.unshift(j);
      return clone(j);
    },
    async listJobs({ limit = 20, cursor } = {}) {
      await delay();
      tick();
      const sorted = [...store.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const start = cursor ? Number(cursor) : 0;
      const page = sorted.slice(start, start + limit);
      const next = start + limit < sorted.length ? String(start + limit) : null;
      return { jobs: clone(page), nextCursor: next };
    },
    async getJob(jobId) {
      await delay();
      tick();
      const j = job(jobId);
      const clips = store.clips.filter((c) => c.jobId === jobId).sort((a, b) => a.rank - b.rank);
      return { job: clone(j), clips: clone(clips) };
    },
    async cancelJob(jobId) {
      await delay();
      const j = job(jobId);
      if (j.status !== "queued" && j.status !== "running") throw conflict("Only a job that is still working can be canceled.");
      j.status = "canceled";
      j.steps = j.steps.map((s) => (s.status === "running" ? { ...s, status: "pending", message: undefined } : s));
      clock.delete(jobId);
      j.updatedAt = new Date().toISOString();
      return clone(j);
    },
    async retryJob(jobId) {
      await delay();
      const j = job(jobId);
      if (j.status !== "failed" && j.status !== "canceled") throw conflict("Only a failed or canceled job can be retried.");
      j.status = "queued";
      j.error = undefined;
      j.steps = stepsAt(0, "queued");
      j.progress = 0;
      j.createdAt = new Date().toISOString();
      j.updatedAt = j.createdAt;
      return clone(j);
    },
    async listClips({ status = "review", jobId } = {}) {
      await delay();
      tick();
      return clone(
        store.clips
          .filter((c) => status === "all" || c.status === status)
          .filter((c) => !jobId || c.jobId === jobId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.rank - b.rank),
      );
    },
    async getClip(clipId) {
      await delay();
      return clone(clip(clipId));
    },
    async updateClip(clipId, captions) {
      await delay(120, 260);
      const c = clip(clipId);
      if (c.status !== "review") throw conflict("Captions can only be changed while the clip waits for review.");
      c.captions = { ...c.captions, ...captions };
      return clone(c);
    },
    async confirmClip(clipId, captions) {
      await delay();
      const c = clip(clipId);
      const startPosting = () => {
        const have = new Set(store.posts.filter((p) => p.clipId === clipId).map((p) => p.platform));
        const created: Post[] = store.settings.platforms
          .filter((platform) => !have.has(platform))
          .map((platform) => ({ postId: ulid(), clipId, platform, status: "pending_integration" }));
        store.posts.push(...created);
        return { clip: clone(c), posts: clone(store.posts.filter((p) => p.clipId === clipId)) };
      };
      // Keep again on a kept clip whose posting never started: finished once the last try is old enough.
      if (c.status === "confirmed" && !store.posts.some((p) => p.clipId === clipId)) {
        const last = claimedAt.get(clipId) ?? Date.parse(c.decidedAt ?? "");
        if (Number.isNaN(last) || Date.now() - last < faults.resumeAfterMs) throw conflict(ALREADY_DECIDED);
        claimedAt.set(clipId, Date.now());
        return startPosting();
      }
      if (c.status !== "review") throw conflict(ALREADY_DECIDED);
      if (captions) c.captions = { ...c.captions, ...captions };
      c.status = "confirmed";
      c.decidedAt = new Date().toISOString();
      claimedAt.set(clipId, Date.now());
      if (faults.keepStopsAfterSave > 0) {
        faults.keepStopsAfterSave--;
        throw networkError();
      }
      return startPosting();
    },
    async declineClip(clipId) {
      await delay();
      const c = clip(clipId);
      if (c.status !== "review") throw conflict(ALREADY_DECIDED);
      c.status = "declined";
      c.decidedAt = new Date().toISOString();
      c.coverUrl = undefined;
      c.videoUrl = undefined;
      return clone(c);
    },
    async listSkills() {
      await delay();
      return store.skills.map(publicSkill);
    },
    async createSkillUpload(filename) {
      await delay();
      if (!/\.(md|zip)$/i.test(filename)) throw bad("Skills are a SKILL.md file or a .zip that contains one.");
      const skillId = ulid();
      pendingSkills.set(skillId, filename);
      return { skillId, key: `skills/mock-owner/${skillId}/${filename}`, uploadUrl: "mock://upload", headers: {} };
    },
    async createSkill({ skillId }) {
      await delay();
      const filename = pendingSkills.get(skillId);
      if (!filename) throw bad("Upload the file first, then add the skill.");
      pendingSkills.delete(skillId);
      const name = filename.replace(/\.(md|zip)$/i, "").replace(/[^a-z0-9-]+/gi, "-").toLowerCase() || "new-skill";
      const s: Skill & { content: string } = {
        skillId,
        name: name === "skill" ? `skill-${skillId.slice(-4).toLowerCase()}` : name,
        description: "Uploaded from this device. The agent reads it on the next job.",
        enabled: true,
        builtin: false,
        format: filename.toLowerCase().endsWith(".zip") ? "zip" : "md",
        size: 1024,
        createdAt: new Date().toISOString(),
        content: `---\nname: ${name}\ndescription: Uploaded skill.\n---\n\n# ${name}\n`,
      };
      store.skills.push(s);
      return publicSkill(s);
    },
    async setSkillEnabled(skillId, enabled) {
      await delay(100, 220);
      const s = skill(skillId);
      s.enabled = enabled;
      return publicSkill(s);
    },
    async deleteSkill(skillId) {
      await delay();
      const s = skill(skillId);
      if (s.builtin) throw bad("Built-in skills can be turned off, not deleted.");
      store.skills = store.skills.filter((x) => x.skillId !== skillId);
    },
    async skillContent(skillId) {
      await delay();
      return skill(skillId).content;
    },
    async getSettings() {
      await delay();
      return clone(store.settings);
    },
    async putSettings(patch) {
      await delay(100, 240);
      const next: Settings = { ...store.settings, ...patch, hasYoutubeCookies: store.settings.hasYoutubeCookies };
      if (next.clipMin < 1 || next.clipMin > 10) throw bad("The smallest number of clips must be between 1 and 10.");
      if (next.clipMax < next.clipMin || next.clipMax > 10) throw bad("The largest number of clips must be between the smallest and 10.");
      if (next.maxSourceHours < 1 || next.maxSourceHours > 12) throw bad("Source length must be between 1 and 12 hours.");
      if (!next.platforms.every((p) => PLATFORMS.includes(p))) throw bad("Unknown platform.");
      store.settings = next;
      return clone(next);
    },
    async createCookiesUpload(_filename) {
      await delay();
      // The mock marks cookies present once the upload URL is issued; the real API checks the object.
      store.settings.hasYoutubeCookies = true;
      return { key: "private/mock-owner/youtube-cookies.txt", uploadUrl: "mock://upload", headers: { "Content-Type": "text/plain" } };
    },
    async deleteCookies() {
      await delay();
      store.settings.hasYoutubeCookies = false;
    },
    async listAccounts() {
      await delay();
      return clone(store.accounts);
    },
    async connectAccount() {
      await delay();
      throw new ApiError(501, "not_implemented", "Connecting accounts arrives in the next phase.");
    },
    async listPosts(clipId) {
      await delay();
      return clone(store.posts.filter((p) => !clipId || p.clipId === clipId));
    },
    async insights() {
      await delay();
      return { learnings: clone(store.learnings), posts: clone(store.posts.filter((p) => p.metrics)) };
    },
  };
}

