import { describe, expect, it } from "vitest";
import { seed, SKILL_IDS } from "../src/api/mock/fixtures.ts";
import { buildSkillMd, NO_SWITCH, parseForm, skillsApi } from "../src/api/mock/skills.ts";
import { splitFrontmatter } from "../src/lib/markdown.ts";

const fresh = () => {
  const store = seed();
  return { store, ...skillsApi(store, async () => undefined) };
};
const form = { title: "Funny Moments FIRST!!", description: "Every time it picks moments.", instructions: "Laugh first." };

describe("mock skills follow the §18 rules", () => {
  it("lists built-ins first, then the owner's by name, with no on/off field", async () => {
    const { api } = fresh();
    const list = await api.listSkills();
    expect(list.map((s) => s.name)).toEqual(["short-form-video-playbook", "brand-voice", "gta-rp-hooks", "safety-test"]);
    for (const s of list) expect(s).not.toHaveProperty("enabled");
  });

  it("writes a skill: slug name, built SKILL.md, version 1, source written", async () => {
    const { api } = fresh();
    const skill = await api.writeSkill(form);
    expect(skill).toMatchObject({ name: "funny-moments-first", title: "Funny Moments FIRST!!", version: 1, source: "written", format: "md" });
    const detail = await api.getSkill(skill.skillId);
    expect(splitFrontmatter(detail.content)?.front.fields).toEqual({ name: "funny-moments-first", description: form.description });
    expect(detail.form).toEqual(form);
  });

  it("refuses a name that is used (built-in or owner), naming the title field", async () => {
    const { api } = fresh();
    await expect(api.writeSkill({ ...form, title: "Brand voice" })).rejects.toMatchObject({ status: 409, field: "title" });
    await expect(api.writeSkill({ ...form, title: "Short form video playbook" })).rejects.toMatchObject({ status: 409 });
    await expect(api.writeSkill({ ...form, title: "" })).rejects.toMatchObject({ status: 400, field: "title" });
    await expect(api.writeSkill({ ...form, instructions: "x".repeat(300_000) })).rejects.toMatchObject({ status: 413 });
  });

  it("built-ins are read-only, with no form", async () => {
    const { api } = fresh();
    const id = "builtin-short-form-video-playbook";
    expect((await api.getSkill(id)).formBlocked).toBe("builtin");
    await expect(api.updateSkill(id, { version: 1, ...form })).rejects.toMatchObject({ status: 409 });
    await expect(api.deleteSkill(id)).rejects.toMatchObject({ status: 409 });
    await expect(api.createSkillUpload("x.md", id)).rejects.toMatchObject({ status: 409 });
  });

  it("an edit checks the version; another screen's change gives 409", async () => {
    const { api, controls } = fresh();
    const before = await api.getSkill(SKILL_IDS.written);
    controls.bumpSkillVersion(SKILL_IDS.written);
    await expect(api.updateSkill(SKILL_IDS.written, { version: before.skill.version, ...before.form! })).rejects.toMatchObject({
      status: 409,
      code: "conflict",
    });
    const now = await api.getSkill(SKILL_IDS.written);
    expect(now.form!.instructions).toContain("Changed on another screen.");
    const saved = await api.updateSkill(SKILL_IDS.written, { version: now.skill.version, ...before.form!, title: "GTA RP hooks" });
    expect(saved.version).toBe(now.skill.version + 1);
  });

  it("renaming to itself is fine; a zip keeps its other files and frontmatter", async () => {
    const { api } = fresh();
    const zip = await api.getSkill(SKILL_IDS.zip);
    expect(zip.files).toEqual(["banned-words.txt", "examples/sign-off.txt"]);
    const saved = await api.updateSkill(SKILL_IDS.zip, { version: zip.skill.version, ...zip.form!, instructions: "New words." });
    const after = await api.getSkill(saved.skillId);
    expect(after.files).toEqual(zip.files);
    expect(after.content).toContain("license: Own words");
    expect(after.form!.instructions).toBe("New words.");
  });

  it("replaces the whole file only with this skill's own upload", async () => {
    const { api } = fresh();
    const other = await api.createSkillUpload("other.md");
    await expect(api.updateSkill(SKILL_IDS.written, { version: 2, key: other.key })).rejects.toMatchObject({ status: 400 });
    const up = await api.createSkillUpload("new-words.zip", SKILL_IDS.written);
    expect(up.key).toMatch(new RegExp(`^skills/mock-owner/${SKILL_IDS.written}/[0-9A-Z]{26}/skill\\.zip$`));
    const saved = await api.updateSkill(SKILL_IDS.written, { version: 2, key: up.key });
    expect(saved).toMatchObject({ format: "zip", name: "new-words", title: "New words", source: "upload", version: 3 });
  });

  it("the old switch route answers the plain 400", async () => {
    const { controls } = fresh();
    await expect(controls.patchSkill(SKILL_IDS.written, { enabled: false })).rejects.toMatchObject({ status: 400, message: NO_SWITCH });
  });

  it("form ↔ SKILL.md round-trips, and a body over 50,000 characters cannot be edited here", () => {
    const s = { skillId: "X", title: "My title", builtin: false } as Parameters<typeof parseForm>[0];
    const md = buildSkillMd("my-title", "When.", "My title", "Do it.");
    expect(md).toBe('---\nname: my-title\ndescription: "When."\n---\n\n# My title\n\nDo it.\n');
    expect(parseForm(s, md).form).toEqual({ title: "My title", description: "When.", instructions: "Do it." });
    expect(buildSkillMd("a", "b", "T", "# Own heading\n\nx")).not.toContain("# T\n");
    expect(parseForm(s, buildSkillMd("a", "b", "T", "y".repeat(50_001)))).toEqual({ form: null, formBlocked: "too_long" });
  });

  it("deletes owner skills", async () => {
    const { api } = fresh();
    await api.deleteSkill(SKILL_IDS.tricky);
    await expect(api.getSkill(SKILL_IDS.tricky)).rejects.toMatchObject({ status: 404 });
  });
});
