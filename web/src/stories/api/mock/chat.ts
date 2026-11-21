// Lamo Stories mock: the chat part (docs/CONTRACTS.md §45.16.8). SCAFFOLD (Phase 1): builder H implements it.
import type { StoriesApi } from "../types.ts";
import { notBuilt, type MockStore } from "./store.ts";

export const KEYS = ["listConversations", "createConversation", "getConversation", "patchConversation", "deleteConversation", "sendMessage", "chatAttachment", "stopMessage"] as const;

export function seed(_store: MockStore): void {}

export function api(_store: MockStore): Pick<StoriesApi, (typeof KEYS)[number]> {
  return notBuilt(KEYS);
}
