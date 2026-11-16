import { describe, expect, it } from "vitest";
import { checkForm, cleanForm, humanize, NAME_RE, slug, uploadNameTaken } from "../src/lib/skillName.ts";

describe("skill names (mirror of the API's slug and humanize, §18.2)", () => {
  it.each([
    ["Funny Moments FIRST!!", "funny-moments-first"],
    ["Ça va", "ca-va"],
    ["🎮🎮", "my-skill"],
    ["", "my-skill"],
    ["  GTA RP hooks  ", "gta-rp-hooks"],
    ["Crème brûlée", "creme-brulee"],
    ["a--b__c", "a-b-c"],
  ])("slug(%j) = %j", (title, name) => {
    expect(slug(title)).toBe(name);
    expect(NAME_RE.test(slug(title))).toBe(true);
  });

  it("cuts long names at a dash, never over 64", () => {
    const title = "word ".repeat(16); // 80 characters
    const name = slug(title);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.endsWith("-")).toBe(false);
    expect(name).toBe(Array(13).fill("word").join("-"));
    expect(slug("x".repeat(80))).toBe("x".repeat(64));
  });

  it("humanize turns a name back into words", () => {
    expect(humanize("funny-moments-first")).toBe("Funny moments first");
    expect(humanize("brand-voice")).toBe("Brand voice");
    expect(humanize("")).toBe("");
  });
});

describe("the three questions' limits", () => {
  const ok = { title: "Funny", description: "Every time.", instructions: "Laugh." };

  it("passes a good form", () => {
    expect(checkForm(ok)).toEqual({});
  });

  it("names each problem under its question", () => {
    expect(checkForm({ ...ok, title: "" }).title).toMatch(/name/);
    expect(checkForm({ ...ok, title: "x".repeat(61) }).title).toMatch(/shorter/);
    expect(checkForm({ ...ok, title: "x".repeat(60) }).title).toBeUndefined();
    expect(checkForm({ ...ok, title: "!!!" }).title).toMatch(/letter or number/);
    expect(checkForm({ ...ok, description: "ab" }).description).toBeDefined();
    expect(checkForm({ ...ok, description: "x".repeat(1025) }).description).toMatch(/shorter/);
    expect(checkForm({ ...ok, instructions: " " }).instructions).toBeDefined();
    expect(checkForm({ ...ok, instructions: "x".repeat(50_001) }).instructions).toMatch(/shorter/);
  });

  it("says when the name is already used", () => {
    expect(checkForm({ ...ok, title: "Brand Voice!" }, ["brand-voice"]).title).toBe(
      "You already have a skill called Brand Voice!. Pick another name.",
    );
    // A built-in's name is Clip Factory's, not "yours".
    expect(checkForm({ ...ok, title: "Short form video playbook" }, ["short-form-video-playbook"], ["short-form-video-playbook"]).title).toBe(
      "Clip Factory already has a skill called Short form video playbook. Pick another name.",
    );
  });

  it("says what to do when an uploaded file's name is taken (there is no name box to change)", () => {
    expect(uploadNameTaken("Brand voice")).toBe("You already have a skill called Brand voice. To change it, open it and tap Replace the whole file.");
    expect(uploadNameTaken("Short form video playbook", true)).toMatch(/^Clip Factory already has a skill called Short form video playbook\. Change the name inside your file/);
    expect(uploadNameTaken("x")).not.toMatch(/Pick another name/);
  });

  it("cleans like the API: trims, CRLF, control characters, one-line description", () => {
    expect(cleanForm({ title: " a\u0007b ", description: "one\r\ntwo", instructions: "x\r\ny\t" })).toEqual({
      title: "ab",
      description: "one two",
      instructions: "x\ny",
    });
  });
});
