// Where a chat button or a reference video hands over to Production › New (docs/CONTRACTS.md §45.16.5, §45.27,
// §45.28): the address carries what to fill in, so a reload keeps it and nothing is made until the owner taps Make
// the video there. `idea` is the router's own word (StoriesPage.production_new.ideaId) and the one Production › New
// reads today. `ref` (up to 3 reference videos), `cast` (up to 3 characters), `sec` (15–90) and `title`, `logline`,
// `category` (a short concept) are proposed in the builder's contract notes and are not read there yet: the chat
// saves a short concept as an idea first, so its words and cast arrive through `idea`.
import type { IdeaCategory } from "../api/types.ts";
import { STORIES_ROOT } from "../routes.ts";

export interface ProductionPrefill {
  ideaId?: string | null;
  referenceIds?: string[];
  characterIds?: string[];
  durationSec?: number;
  brief?: { title: string; logline: string; category: IdeaCategory };
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const CATEGORIES: IdeaCategory[] = ["driving_safety", "everyday_skills", "comedy", "explainer"];

export function productionNewHref(p: ProductionPrefill): string {
  const q = new URLSearchParams();
  if (p.ideaId && ID.test(p.ideaId)) q.set("idea", p.ideaId);
  for (const id of (p.referenceIds ?? []).filter((x) => ID.test(x)).slice(0, 3)) q.append("ref", id);
  for (const id of (p.characterIds ?? []).filter((x) => ID.test(x)).slice(0, 3)) q.append("cast", id);
  if (typeof p.durationSec === "number" && Number.isInteger(p.durationSec) && p.durationSec >= 15 && p.durationSec <= 90) q.set("sec", String(p.durationSec));
  if (p.brief && !p.ideaId) {
    q.set("title", p.brief.title.slice(0, 80));
    q.set("logline", p.brief.logline.slice(0, 280));
    if (CATEGORIES.includes(p.brief.category)) q.set("category", p.brief.category);
  }
  const qs = q.toString();
  return `${STORIES_ROOT}/production/new${qs ? `?${qs}` : ""}`;
}
