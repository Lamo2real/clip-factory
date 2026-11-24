// Where a chat button or a reference video hands over to Production › New (docs/CONTRACTS.md §45.16.5, §45.27,
// §45.28, §45.34): the address carries what to fill in, so a reload keeps it and nothing is made until the owner taps
// Make the video there. Production › New reads `idea`, `ref` (up to 3 reference videos), `cast` (up to 3 characters)
// and `sec` (15–90) (StoriesPage.production_new: ideaId, refIds, castIds, durationSec) and starts with them picked;
// `art` (night_drive or classic, §45.45) starts it on that drawing style, "Just for this video".
// `title`, `logline` and `category` (a short concept) are not read there: the chat saves a short concept as an idea
// first, so its words and cast arrive through `idea`.
import type { IdeaCategory } from "../api/types.ts";
import type { ArtStyle } from "../engine/types.ts";
import { STORIES_ROOT } from "../routes.ts";

export interface ProductionPrefill {
  ideaId?: string | null;
  referenceIds?: string[];
  characterIds?: string[];
  durationSec?: number;
  /** the drawing style the director offered (§45.45) */
  art?: ArtStyle;
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
  if (p.art === "night_drive" || p.art === "classic") q.set("art", p.art);
  if (p.brief && !p.ideaId) {
    q.set("title", p.brief.title.slice(0, 80));
    q.set("logline", p.brief.logline.slice(0, 280));
    if (CATEGORIES.includes(p.brief.category)) q.set("category", p.brief.category);
  }
  const qs = q.toString();
  return `${STORIES_ROOT}/production/new${qs ? `?${qs}` : ""}`;
}
