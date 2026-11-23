// Lamo Stories mock: the skills part (docs/CONTRACTS.md §45.16.8, §45.26). Builder F2.
// Lamo Stories' own skills (never Clip Factory's): the three built-ins shipped in stories/skills/ (read-only, can be
// switched off), one the owner wrote in the app (with older versions to restore) and one uploaded .zip that is off.
// Every save is a new version (the last 10 kept); "which agents use it" is read from the agents' own skill lists.
// The built-ins' front matter and opening lines are copied here (a test keeps them the same as stories/skills/):
// the dev server and the tests refuse ?raw imports from outside web/.
import { ApiError } from "../../../api/errors.ts";
import type { AgentId, Skill, StoriesApi } from "../types.ts";
import { guardStories } from "./ai.ts";
import { delay, type MockStore } from "./store.ts";

export const KEYS = ["listSkills", "skillUpload", "createSkill", "getSkill", "putSkill", "deleteSkill", "restoreSkill"] as const;

const KEEP = 10;
const DAY_MS = 86_400_000;

interface Rev {
  revisionId: string;
  savedAt: string;
  size: number;
  title: string;
  description: string;
  content: string;
}

interface SkillState {
  revs: Record<string, Rev[]>;
  /** presigned upload keys handed out, with the file's name (the real API reads the file from S3) */
  uploads: Record<string, { skillId: string; filename: string }>;
}

const STATE = new WeakMap<MockStore, SkillState>();

function state(store: MockStore): SkillState {
  let s = STATE.get(store);
  if (!s) {
    s = { revs: {}, uploads: {} };
    STATE.set(store, s);
  }
  return s;
}

let counter = 0;
function newId(prefix: string): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36).toUpperCase()}${counter.toString(36).toUpperCase().padStart(4, "0")}`.slice(0, 26);
}

const iso = (ms: number) => new Date(ms).toISOString();
const size = (text: string) => new Blob([text]).size;

/** The title and the "when to use it" line from a SKILL.md's front matter. */
export function frontMatter(md: string): { name: string; description: string; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(md);
  if (!m) return { name: "", description: "", body: md };
  const field = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, "m").exec(m[1]!)?.[1]?.trim() ?? "";
  return { name: field("name"), description: field("description"), body: m[2]!.trim() };
}

function titleOf(name: string): string {
  const words = name.replace(/\.(md|zip)$/i, "").replace(/[-_]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "New skill";
}

/** The start of each built-in SKILL.md in stories/skills/ (its front matter and first lines; the API serves the whole file). */
export const BUILTIN_SKILLS: { skillId: string; md: string }[] = [
  {
    skillId: "nonverbal-storytelling",
    md: `---
name: nonverbal-storytelling
description: How Clip Factory Stories tells a whole story with no voice-over, only action, faces, sound and a few words on screen.
---

# Telling a story without words

- **One clear want.** In the first two seconds the viewer must see who the character is and what they want (a coffee,
  to get home, to stay on the road). Show it with a pose and a look, not text.
- **Faces carry the plot.** Change the expression at every turn of the story, using only the faces in that
  character's own list (for example calm → surprised → worried → relieved, when it has them). Hold each face long
  enough to read on a phone (at least half a second).
`,
  },
  {
    skillId: "driving-safety-teaching",
    md: `---
name: driving-safety-teaching
description: How Clip Factory Stories teaches driving safety honestly, only from the checked guidance list, without scaring or showing anything to copy.
---

# Teaching driving safety

- **Only checked advice.** Every instruction on screen comes from a shown step of the guidance topic you are given,
  in its order, and names its step id. If a step is hidden (sources disagree), do not show it; end with "Check your
  local road rules."
`,
  },
  {
    skillId: "vertical-short-hooks",
    md: `---
name: vertical-short-hooks
description: Hooks, pacing and endings that keep vertical short videos watched to the end on TikTok, Reels, Shorts and X.
---

# Hooks and pacing for vertical shorts

- **Hook in two seconds.** Start in the middle of the action or with the problem already happening (the car already
  sliding, the coffee already falling). No logos, no slow build-up.
- **Something changes every 2–4 seconds.** A new action, a new face, a camera move or a cut. A still frame longer than
  that loses viewers.
`,
  },
];

const BUILTIN_TITLES: Record<string, string> = {
  "nonverbal-storytelling": "Telling a story without words",
  "driving-safety-teaching": "Teaching driving safety honestly",
  "vertical-short-hooks": "Hooks for short vertical videos",
};

function bad(message: string, field?: string): ApiError {
  return new ApiError(400, "bad_request", message, field);
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function writtenMd(title: string, description: string, instructions: string): string {
  return `---\nname: ${title}\ndescription: ${description}\n---\n\n${instructions.trim()}\n`;
}

export function seed(store: MockStore): void {
  const s = state(store);
  const now = Date.now();
  s.revs = {};
  s.uploads = {};
  store.skills = [];
  for (const { skillId, md } of BUILTIN_SKILLS) {
    const fm = frontMatter(md);
    const rev: Rev = { revisionId: "builtin", savedAt: iso(now - 30 * DAY_MS), size: size(md), title: BUILTIN_TITLES[skillId] ?? titleOf(skillId), description: fm.description, content: md };
    s.revs[skillId] = [rev];
    store.skills.push({ skillId, title: rev.title, description: rev.description, builtin: true, source: "builtin", format: "md", enabled: true, agentIds: [], revisions: [{ revisionId: rev.revisionId, savedAt: rev.savedAt, size: rev.size }], version: 1, createdAt: rev.savedAt, updatedAt: rev.savedAt });
  }
  // One the owner wrote here, changed twice since.
  const slapId = "01JSLAPSTICKTIMING000000AA";
  const steps = [
    "Hold the moment before a fall for a beat. Then the fall. Then a little bounce.",
    "Hold the moment before a fall for a beat. Then the fall, fast. Then a little bounce and a dazed face.",
    "Hold the moment before a fall for half a second. Then the fall, fast, with a whoosh. Then a little bounce, a dazed face and one star circling the head. Never hurt anyone for real.",
  ];
  s.revs[slapId] = steps.map((text, i) => {
    const md = writtenMd("Slapstick timing", "When a scene needs a funny fall or a bump.", text);
    return { revisionId: `01JSLAPREV00000000000000${i}`, savedAt: iso(now - (12 - i * 5) * DAY_MS), size: size(md), title: "Slapstick timing", description: "When a scene needs a funny fall or a bump.", content: md };
  });
  const slapRevs = s.revs[slapId]!;
  store.skills.push({
    skillId: slapId,
    title: "Slapstick timing",
    description: "When a scene needs a funny fall or a bump.",
    builtin: false,
    source: "written",
    format: "md",
    enabled: true,
    agentIds: [],
    revisions: slapRevs.map((r) => ({ revisionId: r.revisionId, savedAt: r.savedAt, size: r.size })).reverse(),
    version: 3,
    createdAt: slapRevs[0]!.savedAt,
    updatedAt: slapRevs[slapRevs.length - 1]!.savedAt,
  });
  // One uploaded as a .zip, switched off for now.
  const brandId = "01JBRANDCOLOURS0000000000B";
  const brandRev: Rev = { revisionId: "01JBRANDREV000000000000000", savedAt: iso(now - 4 * DAY_MS), size: 48_213, title: "Lamo brand colours", description: "When a scene shows the Lamo logo or the end card.", content: writtenMd("Lamo brand colours", "When a scene shows the Lamo logo or the end card.", "Use sunshine yellow for the logo and the night blue for the end card. The logo files are in this skill's folder.") };
  s.revs[brandId] = [brandRev];
  store.skills.push({ skillId: brandId, title: brandRev.title, description: brandRev.description, builtin: false, source: "upload", format: "zip", enabled: false, agentIds: [], revisions: [{ revisionId: brandRev.revisionId, savedAt: brandRev.savedAt, size: brandRev.size }], version: 1, createdAt: brandRev.savedAt, updatedAt: brandRev.savedAt });
  // The creative director already uses the owner's slapstick skill (after the built-ins).
  const director = store.agents.find((a) => a.agentId === "creative_director");
  if (director && !director.skillIds.includes(slapId)) director.skillIds.push(slapId);
}

export function api(store: MockStore): Pick<StoriesApi, (typeof KEYS)[number]> {
  /** A skill as the API answers: which agents use it comes from the agents' own lists. */
  const shape = (sk: Skill): Skill => ({ ...clone(sk), agentIds: store.agents.filter((a) => a.skillIds.includes(sk.skillId)).map((a) => a.agentId as AgentId) });
  const find = (skillId: string): Skill => {
    const sk = store.skills.find((x) => x.skillId === skillId);
    if (!sk) throw new ApiError(404, "not_found", "We could not find that skill.");
    return sk;
  };
  const addRev = (sk: Skill, rev: Rev) => {
    const s = state(store);
    const list = [...(s.revs[sk.skillId] ?? []), rev].slice(-KEEP);
    s.revs[sk.skillId] = list;
    sk.revisions = list.map((r) => ({ revisionId: r.revisionId, savedAt: r.savedAt, size: r.size })).reverse();
    sk.title = rev.title;
    sk.description = rev.description;
    sk.version += 1;
    sk.updatedAt = rev.savedAt;
  };
  const checkWritten = (title: string, description: string, instructions: string) => {
    if (!title.trim()) throw bad("Give the skill a name.", "title");
    if (title.trim().length > 60) throw bad("Keep the name under 60 letters.", "title");
    if (!description.trim()) throw bad("Say when to use it, in one line.", "description");
    if (description.trim().length > 300) throw bad("Keep the line under 300 letters.", "description");
    if (!instructions.trim()) throw bad("Write what the agent should do.", "instructions");
    if (size(instructions) > 1_000_000) throw bad("That skill is too long. Keep it under 1 MB.", "instructions");
  };
  const fromUpload = (key: string, skillId: string): Rev => {
    const up = state(store).uploads[key];
    if (!up || up.skillId !== skillId) throw bad("That upload is not finished. Pick the file again.", "key");
    delete state(store).uploads[key];
    const title = titleOf(up.filename);
    const description = `Uploaded from ${up.filename}.`;
    const content = writtenMd(title, description, `The skill's instructions from ${up.filename}.`);
    return { revisionId: newId("01JREV"), savedAt: iso(Date.now()), size: up.filename.toLowerCase().endsWith(".zip") ? 120_000 : size(content), title, description, content };
  };

  return {
    async listSkills(ws) {
      await delay();
      guardStories(store, ws);
      return [...store.skills].sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.createdAt.localeCompare(b.createdAt)).map(shape);
    },

    async skillUpload(ws, body) {
      await delay();
      guardStories(store, ws);
      const name = body.filename.trim();
      if (!/\.(md|zip)$/i.test(name)) throw bad("That is not a skill. Pick a SKILL.md file or a .zip with one inside.", "filename");
      if (body.skillId) {
        const sk = find(body.skillId);
        if (sk.builtin) throw new ApiError(409, "conflict", "Built-in skills can't be changed. You can switch them off.");
      }
      const skillId = body.skillId ?? newId("01JSK");
      const key = `ws/mock-owner/${ws}/skills/${skillId}/${newId("01JREV")}/${name.toLowerCase().endsWith(".zip") ? "skill.zip" : "SKILL.md"}`;
      state(store).uploads[key] = { skillId, filename: name };
      return { skillId, key, uploadUrl: "mock://upload", headers: {} };
    },

    async createSkill(ws, body) {
      await delay();
      guardStories(store, ws);
      const now = iso(Date.now());
      let sk: Skill;
      let rev: Rev;
      if ("key" in body) {
        if (store.skills.some((x) => x.skillId === body.skillId)) throw new ApiError(409, "conflict", "That skill is already saved. Upload it as a new version instead.");
        rev = fromUpload(body.key, body.skillId);
        sk = { skillId: body.skillId, title: rev.title, description: rev.description, builtin: false, source: "upload", format: body.key.endsWith(".zip") ? "zip" : "md", enabled: true, agentIds: [], revisions: [], version: 0, createdAt: now, updatedAt: now };
      } else {
        checkWritten(body.title, body.description, body.instructions);
        const content = writtenMd(body.title.trim(), body.description.trim(), body.instructions);
        rev = { revisionId: newId("01JREV"), savedAt: now, size: size(content), title: body.title.trim(), description: body.description.trim(), content };
        sk = { skillId: newId("01JSK"), title: rev.title, description: rev.description, builtin: false, source: "written", format: "md", enabled: true, agentIds: [], revisions: [], version: 0, createdAt: now, updatedAt: now };
      }
      store.skills.push(sk);
      addRev(sk, rev);
      return shape(sk);
    },

    async getSkill(ws, skillId) {
      await delay();
      guardStories(store, ws);
      const sk = find(skillId);
      const revs = state(store).revs[skillId] ?? [];
      return { ...shape(sk), content: revs[revs.length - 1]?.content ?? "" };
    },

    async putSkill(ws, skillId, body) {
      await delay();
      guardStories(store, ws);
      const sk = find(skillId);
      if (body.version !== sk.version) throw new ApiError(409, "conflict", "That changed while you were looking. Reload the page, then try again.");
      const edits = body.title !== undefined || body.description !== undefined || body.instructions !== undefined || body.key !== undefined;
      if (sk.builtin && edits) throw new ApiError(409, "conflict", "Built-in skills can't be changed. You can switch them off.");
      if (body.key !== undefined) {
        const rev = fromUpload(body.key, skillId);
        sk.source = "upload";
        sk.format = body.key.endsWith(".zip") ? "zip" : "md";
        addRev(sk, rev);
      } else if (edits) {
        const last = (state(store).revs[skillId] ?? []).at(-1);
        const title = body.title ?? sk.title;
        const description = body.description ?? sk.description;
        const instructions = body.instructions ?? frontMatter(last?.content ?? "").body;
        checkWritten(title, description, instructions);
        const content = writtenMd(title.trim(), description.trim(), instructions);
        addRev(sk, { revisionId: newId("01JREV"), savedAt: iso(Date.now()), size: size(content), title: title.trim(), description: description.trim(), content });
        if (sk.source === "upload" && sk.format === "md") sk.source = "written";
      }
      if (body.enabled !== undefined) {
        sk.enabled = body.enabled;
        if (!edits) {
          sk.version += 1;
          sk.updatedAt = iso(Date.now());
        }
      }
      return shape(sk);
    },

    async deleteSkill(ws, skillId) {
      await delay();
      guardStories(store, ws);
      const sk = find(skillId);
      if (sk.builtin) throw new ApiError(409, "conflict", "Built-in skills can't be deleted. You can switch them off.");
      store.skills = store.skills.filter((x) => x.skillId !== skillId);
      for (const a of store.agents)
        if (a.skillIds.includes(skillId)) {
          a.skillIds = a.skillIds.filter((id) => id !== skillId);
          a.version += 1;
        }
      delete state(store).revs[skillId];
    },

    async restoreSkill(ws, skillId, revisionId) {
      await delay();
      guardStories(store, ws);
      const sk = find(skillId);
      if (sk.builtin) throw new ApiError(409, "conflict", "Built-in skills have one version.");
      const old = (state(store).revs[skillId] ?? []).find((r) => r.revisionId === revisionId);
      if (!old) throw new ApiError(404, "not_found", "That version is no longer kept.");
      addRev(sk, { ...old, revisionId: newId("01JREV"), savedAt: iso(Date.now()) });
      return shape(sk);
    },
  };
}
