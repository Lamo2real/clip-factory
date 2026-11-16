// The skill rules the web needs before it asks the server (docs/CONTRACTS.md §18.2). They mirror the API's
// `skills.slug` and `skills.humanize` and its form limits, so the form can say "you already have that one" and
// "that is too long" while the owner types. The API stays the judge.
import type { SkillForm } from "../api/types.ts";

export const NAME_MAX = 64;
export const TITLE_MAX = 60;
export const DESCRIPTION_MIN = 3;
export const DESCRIPTION_MAX = 1024;
export const INSTRUCTIONS_MAX = 50_000;
/** Bigger bodies are refused with 413 (§18.2). */
export const BODY_MAX_BYTES = 256 * 1024;
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** "Funny Moments FIRST!!" → "funny-moments-first"; "Ça va" → "ca-va"; "🎮🎮" → "my-skill". */
export function slug(title: string): string {
  let s = title
    .normalize("NFKD")
    .replace(/\p{Mn}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length > NAME_MAX) {
    const at = s.slice(0, NAME_MAX + 1).lastIndexOf("-");
    s = (at > 0 ? s.slice(0, at) : s.slice(0, NAME_MAX)).replace(/-+$/g, "");
  }
  return s || "my-skill";
}

/** "funny-moments-first" → "Funny moments first". */
export function humanize(name: string): string {
  const words = name.replace(/-/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : words;
}

/** Trims, turns `\r\n` into `\n` and drops control characters other than new lines and tabs (as the API does). */
export function cleanText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim();
}

/** The form as the API will store it: cleaned, and the description on one line. */
export function cleanForm(form: SkillForm): SkillForm {
  return {
    title: cleanText(form.title),
    description: cleanText(form.description).replace(/\s*\n\s*/g, " "),
    instructions: cleanText(form.instructions),
  };
}

export type SkillField = keyof SkillForm;
export type FormProblems = Partial<Record<SkillField, string>>;

/** A plain sentence per field that cannot be saved yet, in kid words. Empty when the form is fine. */
export function checkForm(form: SkillForm, takenNames: readonly string[] = [], builtinNames: readonly string[] = []): FormProblems {
  const f = cleanForm(form);
  const out: FormProblems = {};
  if (!f.title) out.title = "Give your skill a name.";
  else if (f.title.length > TITLE_MAX) out.title = `Make the name shorter: at most ${TITLE_MAX} letters.`;
  else if (!/[\p{L}\p{N}]/u.test(f.title)) out.title = "Use at least one letter or number in the name.";
  else if (takenNames.includes(slug(f.title))) out.title = nameTaken(f.title, builtinNames.includes(slug(f.title)));
  if (f.description.length < DESCRIPTION_MIN) out.description = "Say when Clip Factory should use it, in a few words.";
  else if (f.description.length > DESCRIPTION_MAX) out.description = `Make this shorter: at most ${DESCRIPTION_MAX} letters.`;
  if (!f.instructions) out.instructions = "Say what the skill should do.";
  else if (f.instructions.length > INSTRUCTIONS_MAX)
    out.instructions = `Make this shorter: at most ${INSTRUCTIONS_MAX.toLocaleString("en")} letters.`;
  return out;
}

/** The words for a name that is already used (§18.2). A built-in's name is Clip Factory's, not the owner's. */
export function nameTaken(title: string, builtin = false): string {
  return builtin
    ? `Clip Factory already has a skill called ${title}. Pick another name.`
    : `You already have a skill called ${title}. Pick another name.`;
}

/**
 * The words for an uploaded file whose name is already used. An upload has no name box to change, so it says what to
 * do instead: open that skill and replace its file, or rename the skill inside the file.
 */
export function uploadNameTaken(title: string, builtin = false): string {
  return builtin
    ? `Clip Factory already has a skill called ${title}. Change the name inside your file, then upload it again.`
    : `You already have a skill called ${title}. To change it, open it and tap Replace the whole file.`;
}
