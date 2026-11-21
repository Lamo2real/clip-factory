import type { StoriesPage } from "../routes.ts";

/** Every Lamo Stories screen gets the workspace it shows and its page (docs/CONTRACTS.md §45.16). */
export interface StoriesScreenProps {
  ws: string;
  page: StoriesPage;
}
