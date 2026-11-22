// Lamo Stories › References (docs/CONTRACTS.md §45.16.7, §45.28): reference videos the owner uploads so the video
// analysis agent can study their structure and timing; the list with the upload, and each video's own page.
import "../styles/chat.css";
import { RefList } from "../chat/references/RefList.tsx";
import { RefPage } from "../chat/references/RefPage.tsx";
import type { StoriesScreenProps } from "./types.ts";

export function ReferencesScreen({ ws, page }: StoriesScreenProps) {
  if (page.name === "reference") return <RefPage key={page.refId} ws={ws} refId={page.refId} />;
  return <RefList ws={ws} />;
}
