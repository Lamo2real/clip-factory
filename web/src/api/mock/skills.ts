// The skills routes of docs/CONTRACTS.md §18 in memory, with the same rules as the API: every skill is always used,
// names come from titles and must be unique, built-ins are read-only, every save checks `version`.
import { ApiError } from "../errors.ts";
import type { Api, Skill, SkillDetail, SkillForm } from "../types.ts";
import { splitFrontmatter } from "../../lib/markdown.ts";
import { BODY_MAX_BYTES, checkForm, cleanForm, humanize, nameTaken, slug, uploadNameTaken } from "../../lib/skillName.ts";
import { ulid } from "./fixtures.ts";

/** A stored skill: the public fields plus its SKILL.md text and, for a zip, the other files in it. */
export type MockSkill = Skill & { content: string; files: string[] };

const OWNER = "mock-owner";
const MD_MAX_BYTES = 1024 ** 2;
const FORM_MAX_CHARS = 50_000;
export const NO_SWITCH = "Skills are always used now, so there is no switch.";
const BUILTIN_READ_ONLY = "Built-in skills are part of Clip Factory. You can read them, but not change or delete them.";
const STALE = "This skill was changed somewhere else. Load the newest one, then save again.";

const bad = (msg: string, field?: string) => new ApiError(400, "bad_request", msg, field);
const conflict = (msg: string, field?: string) => new ApiError(409, "conflict", msg, field);
const tooLarge = (msg: string) => new ApiError(413, "too_large", msg);
const bytes = (s: string) => new TextEncoder().encode(s).length;

/** The SKILL.md the API writes for a form (§18.2). `extra` keeps other frontmatter lines verbatim. */
export function buildSkillMd(name: string, description: string, title: string, instructions: string, extra = ""): string {
  const head = ["---", `name: ${name}`, `description: ${JSON.stringify(description)}`, ...(extra ? [extra] : []), "---", ""];
  const startsWithH1 = /^#\s/.test(instructions);
  return [...head, ...(startsWithH1 ? [] : [`# ${title}`, ""]), instructions, ""].join("\n");
}

/** The form back out of a SKILL.md, or why it cannot be changed here (§18.3). */
export function parseForm(skill: Skill, text: string): Pick<SkillDetail, "form" | "formBlocked"> {
  if (skill.builtin) return { form: null, formBlocked: "builtin" };
  const split = splitFrontmatter(text);
  let body = (split ? split.body : text).replace(/^\n+/, "");
  const first = /^# (.*)\n*/.exec(body);
  if (first && first[1]!.trim() === skill.title) body = body.slice(first[0].length);
  body = body.replace(/\n+$/, "");
  if (body.length > FORM_MAX_CHARS) return { form: null, formBlocked: "too_long" };
  return { form: { title: skill.title, description: split?.front.fields.description ?? skill.description, instructions: body } };
}

/** The frontmatter lines other than name and description, as they were (kept on a form save, §18.4). */
function extraFrontmatter(text: string): string {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return "";
  const end = lines.findIndex((l, i) => i > 0 && (l.trim() === "---" || l.trim() === "..."));
  if (end < 0) return "";
  const keep: string[] = [];
  let skipping = false;
  for (const line of lines.slice(1, end)) {
    const top = line && line[0] !== " " && line[0] !== "\t";
    if (top) skipping = /^(name|description)\s*:/.test(line);
    if (!skipping) keep.push(line);
  }
  return keep.join("\n").trim();
}

const toPublic = ({ content: _c, files: _f, ...s }: MockSkill): Skill => ({ ...s });

/** Built-ins by name, then the owner's by name (ties by id). */
export function sortSkills<T extends Skill>(skills: T[]): T[] {
  return [...skills].sort(
    (a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name) || a.skillId.localeCompare(b.skillId),
  );
}

type SkillApi = Pick<Api, "listSkills" | "getSkill" | "writeSkill" | "updateSkill" | "createSkillUpload" | "createSkill" | "deleteSkill">;

export interface MockSkillControls {
  /** Pretends the skill was changed on another screen: a new version with slightly different words. */
  bumpSkillVersion(skillId: string): number;
  /** The old on/off switch route: always the §18.1 400. */
  patchSkill(skillId: string, body?: unknown): Promise<never>;
}

export function skillsApi(
  store: { skills: MockSkill[] },
  delay: (min?: number, max?: number) => Promise<void>,
): { api: SkillApi; controls: MockSkillControls } {
  /** Uploads that were presigned but not saved yet: key → filename (and the skill it replaces). */
  const pending = new Map<string, { filename: string; skillId: string; replaces: boolean }>();

  const find = (skillId: string) => {
    const s = store.skills.find((x) => x.skillId === skillId);
    if (!s) throw new ApiError(404, "not_found", "That skill no longer exists.");
    return s;
  };
  const owned = (skillId: string) => {
    const s = find(skillId);
    if (s.builtin) throw conflict(BUILTIN_READ_ONLY);
    return s;
  };
  const taken = (except?: string) => store.skills.filter((s) => s.skillId !== except).map((s) => s.name);
  const isBuiltinName = (name: string) => store.skills.some((s) => s.builtin && s.name === name);

  function checkFormOrThrow(form: SkillForm, except?: string): SkillForm {
    if (bytes(JSON.stringify(form)) > BODY_MAX_BYTES) throw tooLarge("That skill is too long to save. Make it shorter.");
    const keys = Object.keys(form);
    if (keys.includes("enabled")) throw bad("Unknown field: enabled.");
    const problems = checkForm(form);
    const field = (["title", "description", "instructions"] as const).find((f) => problems[f]);
    if (field) throw bad(problems[field]!, field);
    const clean = cleanForm(form);
    if (taken(except).includes(slug(clean.title))) throw conflict(nameTaken(clean.title, isBuiltinName(slug(clean.title))), "title");
    return clean;
  }

  function fromUpload(filename: string, except?: string): { name: string; format: "md" | "zip" } {
    const format = filename.toLowerCase().endsWith(".zip") ? "zip" : "md";
    const base = filename.replace(/\.(md|zip)$/i, "");
    // The mock never sees the file, so the name comes from its file name ("SKILL.md" gets a short id).
    const name = slug(/^skill$/i.test(base) ? `skill-${ulid().slice(-4)}` : base);
    if (taken(except).includes(name)) throw conflict(uploadNameTaken(humanize(name), isBuiltinName(name)), "title");
    return { name, format };
  }

  const api: SkillApi = {
    async listSkills() {
      await delay();
      return sortSkills(store.skills).map(toPublic);
    },
    async getSkill(skillId) {
      await delay();
      const s = find(skillId);
      return { skill: toPublic(s), content: s.content, ...parseForm(s, s.content), files: s.format === "zip" ? [...s.files].sort() : [] };
    },
    async writeSkill(form) {
      await delay(200, 420);
      const clean = checkFormOrThrow(form);
      const name = slug(clean.title);
      const content = buildSkillMd(name, clean.description, clean.title, clean.instructions);
      if (bytes(content) > MD_MAX_BYTES) throw tooLarge("That skill is too long to save. Make it shorter.");
      const now = new Date().toISOString();
      const s: MockSkill = {
        skillId: ulid(),
        name,
        title: clean.title,
        description: clean.description,
        builtin: false,
        source: "written",
        format: "md",
        size: bytes(content),
        createdAt: now,
        updatedAt: now,
        version: 1,
        content,
        files: [],
      };
      store.skills.push(s);
      return toPublic(s);
    },
    async updateSkill(skillId, body) {
      await delay(200, 420);
      const s = owned(skillId);
      if (!Number.isInteger(body.version) || body.version < 1) throw bad("Send the version you last read.");
      if ("enabled" in body) throw bad("Unknown field: enabled.");
      let next: Partial<MockSkill>;
      if ("key" in body) {
        const up = pending.get(body.key);
        if (!up || up.skillId !== skillId || !up.replaces) throw bad("That upload does not belong to you.");
        const { name, format } = fromUpload(up.filename, skillId);
        next = {
          name,
          title: humanize(name),
          description: "Uploaded from this device.",
          format,
          source: "upload",
          size: format === "zip" ? 18_000 : 1024,
          content: `---\nname: ${name}\ndescription: Uploaded from this device.\n---\n\n# ${humanize(name)}\n\nThe words from your file.\n`,
          files: format === "zip" ? ["examples/hook.txt"] : [],
        };
        if (body.version !== s.version) throw conflict(STALE);
        pending.delete(body.key);
      } else {
        const clean = checkFormOrThrow(body, skillId);
        if (body.version !== s.version) throw conflict(STALE);
        const name = slug(clean.title);
        const content = buildSkillMd(name, clean.description, clean.title, clean.instructions, extraFrontmatter(s.content));
        next = { name, title: clean.title, description: clean.description, content, size: s.format === "zip" ? s.size : bytes(content) };
      }
      Object.assign(s, next, { version: s.version + 1, updatedAt: new Date().toISOString() });
      return toPublic(s);
    },
    async createSkillUpload(filename, skillId) {
      await delay();
      if (!/\.(md|zip)$/i.test(filename)) throw bad("Skills are a SKILL.md file or a .zip that contains one.");
      if (skillId) owned(skillId);
      const id = skillId ?? ulid();
      const file = filename.toLowerCase().endsWith(".zip") ? "skill.zip" : "SKILL.md";
      const key = `skills/${OWNER}/${id}/${ulid()}/${file}`;
      pending.set(key, { filename, skillId: id, replaces: !!skillId });
      return { skillId: id, key, uploadUrl: "mock://upload", headers: {} };
    },
    async createSkill({ skillId, key }) {
      await delay();
      const up = pending.get(key);
      if (!up || up.skillId !== skillId || up.replaces) throw bad("That upload does not belong to you.");
      const { name, format } = fromUpload(up.filename);
      pending.delete(key);
      const now = new Date().toISOString();
      const title = humanize(name);
      const s: MockSkill = {
        skillId,
        name,
        title,
        description: "Uploaded from this device.",
        builtin: false,
        source: "upload",
        format,
        size: format === "zip" ? 18_000 : 1024,
        createdAt: now,
        updatedAt: now,
        version: 1,
        content: `---\nname: ${name}\ndescription: Uploaded from this device.\n---\n\n# ${title}\n\nThe words from your file.\n`,
        files: format === "zip" ? ["examples/hook.txt"] : [],
      };
      store.skills.push(s);
      return toPublic(s);
    },
    async deleteSkill(skillId) {
      await delay();
      owned(skillId);
      store.skills = store.skills.filter((x) => x.skillId !== skillId);
    },
  };

  const controls: MockSkillControls = {
    bumpSkillVersion(skillId) {
      const s = owned(skillId);
      const form = parseForm(s, s.content).form;
      if (form) {
        const instructions = `${form.instructions}\n\nChanged on another screen.`;
        s.content = buildSkillMd(s.name, form.description, form.title, instructions, extraFrontmatter(s.content));
        if (s.format === "md") s.size = bytes(s.content);
      }
      s.version += 1;
      s.updatedAt = new Date().toISOString();
      return s.version;
    },
    async patchSkill() {
      await delay();
      throw bad(NO_SWITCH);
    },
  };
  return { api, controls };
}
