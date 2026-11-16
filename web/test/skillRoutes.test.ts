import { describe, expect, it } from "vitest";
import { match, section, skillPath } from "../src/lib/router.ts";
import { titleFor } from "../src/app/App.tsx";

const ID = "01JZ8S00000000000000000001";

describe("skill pages under Settings › Clip making › Skills (§18.7)", () => {
  it("parses the three sub-routes", () => {
    expect(match("/settings/clip-making/skills/new")).toEqual({ name: "skill", mode: "new", skillId: null });
    expect(match(`/settings/clip-making/skills/${ID}`)).toEqual({ name: "skill", mode: "read", skillId: ID });
    expect(match(`/settings/clip-making/skills/${ID}/edit`)).toEqual({ name: "skill", mode: "edit", skillId: ID });
    expect(match("/settings/clip-making/skills/builtin-short-form-video-playbook")).toEqual({
      name: "skill",
      mode: "read",
      skillId: "builtin-short-form-video-playbook",
    });
    expect(match("/settings/clip-making/skills/")).toEqual({ name: "settings", tree: "clip-making", branch: "skills" });
  });

  it("an address that cannot be a skill becomes the friendly not-found page", () => {
    for (const bad of [
      "/settings/clip-making/skills/nope",
      "/settings/clip-making/skills/01jz8s00000000000000000001",
      "/settings/clip-making/skills/01JZ8S0000000000000000000I",
      `/settings/clip-making/skills/${ID}/delete`,
      `/settings/clip-making/skills/${ID}/edit/more`,
      "/settings/clip-making/skills/new/edit",
      "/settings/clip-making/skills/builtin-",
      "/settings/clip-making/skills/%E0%A4%A",
    ])
      expect(match(bad)).toEqual({ name: "skill", mode: "read", skillId: null });
  });

  it("belongs to Settings and names the tab", () => {
    const r = match(`/settings/clip-making/skills/${ID}/edit`);
    expect(section(r)).toBe("settings");
    expect(titleFor(r)).toBe("Change a skill · Settings");
    expect(titleFor(match("/settings/clip-making/skills/new"))).toBe("Write a skill · Settings");
  });

  it("builds the addresses", () => {
    expect(skillPath(null)).toBe("/settings/clip-making/skills/new");
    expect(skillPath(ID)).toBe(`/settings/clip-making/skills/${ID}`);
    expect(skillPath(ID, "edit")).toBe(`/settings/clip-making/skills/${ID}/edit`);
  });
});
