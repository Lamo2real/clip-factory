// The project a conversation is about (docs/CONTRACTS.md §45.27: an idea, a video, a character or a reference
// video): its page and its name, looked up once and remembered for the visit.
import { storiesApi } from "../api/client.ts";
import type { ProjectRef } from "../api/types.ts";
import { storiesHref } from "../routes.ts";

export const PROJECT_WORD: Record<ProjectRef["kind"], string> = { idea: "Idea", story: "Video", character: "Character", reference: "Reference video" };

export function projectHref(ref: ProjectRef): string {
  switch (ref.kind) {
    case "idea":
      return storiesHref({ name: "ideas" });
    case "story":
      return storiesHref({ name: "production_story", storyId: ref.id });
    case "character":
      return storiesHref({ name: "character", characterId: ref.id });
    case "reference":
      return storiesHref({ name: "reference", refId: ref.id });
  }
}

const names = new Map<string, string>();

export function forgetProjectNames(): void {
  names.clear();
}

export function rememberProjectName(ref: ProjectRef, name: string): void {
  names.set(`${ref.kind}:${ref.id}`, name);
}

export function knownProjectName(ref: ProjectRef): string | null {
  return names.get(`${ref.kind}:${ref.id}`) ?? null;
}

/** The project's name, or null when it cannot be found (deleted, or the page is not built yet). */
export async function projectName(ws: string, ref: ProjectRef): Promise<string | null> {
  const known = knownProjectName(ref);
  if (known) return known;
  const api = storiesApi();
  let name: string | null;
  try {
    if (ref.kind === "idea") name = (await api.listIdeas(ws, "all")).find((i) => i.ideaId === ref.id)?.title ?? null;
    else if (ref.kind === "story") name = (await api.getStory(ws, ref.id)).story.title;
    else if (ref.kind === "character") name = (await api.getCharacter(ws, ref.id)).name;
    else name = (await api.getReference(ws, ref.id)).reference.title;
  } catch {
    return null;
  }
  if (name) rememberProjectName(ref, name);
  return name;
}

export interface ProjectChoice {
  ref: ProjectRef;
  name: string;
  line: string;
}

/** Everything a chat can be about, per kind; a kind whose list does not load is simply empty (with `failed`). */
export async function projectChoices(ws: string, kind: ProjectRef["kind"]): Promise<{ items: ProjectChoice[]; failed: boolean }> {
  const api = storiesApi();
  try {
    let items: ProjectChoice[];
    if (kind === "idea") items = (await api.listIdeas(ws, "all")).map((i) => ({ ref: { kind, id: i.ideaId }, name: i.title, line: i.logline }));
    else if (kind === "story") items = (await api.listStories(ws, { status: "all", limit: 50 })).stories.map((s) => ({ ref: { kind, id: s.storyId }, name: s.title, line: "" }));
    else if (kind === "character") items = (await api.listCharacters(ws)).map((c) => ({ ref: { kind, id: c.characterId }, name: c.name, line: c.description }));
    else items = (await api.listReferences(ws)).filter((r) => r.status !== "uploading").map((r) => ({ ref: { kind, id: r.refId }, name: r.title, line: "" }));
    for (const it of items) rememberProjectName(it.ref, it.name);
    return { items, failed: false };
  } catch {
    return { items: [], failed: true };
  }
}
