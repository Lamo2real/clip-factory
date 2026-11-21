// Lamo Stories mock: the ai part (docs/CONTRACTS.md §45.16.8). SCAFFOLD (Phase 1): builder F2 implements it.
import type { StoriesApi } from "../types.ts";
import { notBuilt, type MockStore } from "./store.ts";

export const KEYS = ["getAi", "putAi", "checkModels", "setModelPrice", "usage", "getAgent", "patchAgent", "setProviderKey", "deleteProviderKey", "storage"] as const;

export function seed(_store: MockStore): void {}

export function api(_store: MockStore): Pick<StoriesApi, (typeof KEYS)[number]> {
  return notBuilt(KEYS);
}
