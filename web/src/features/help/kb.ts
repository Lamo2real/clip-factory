// The corpus in the browser (docs/CONTRACTS.md §19.2): loaded the first time the panel opens (a separate chunk, not
// in the main bundle), filtered by device, and used for local answers when the server can't answer.
import { match } from "../../lib/router.ts";
import { compose } from "./compose.ts";
import { rank, type Ranked } from "./retrieve.ts";
import type { HelpAction, HelpAnswer, HelpContext, HelpCorpus, HelpTurn } from "./types.ts";

let loading: Promise<HelpCorpus> | null = null;

export function loadCorpus(): Promise<HelpCorpus> {
  loading ??= import("./help-corpus.json").then((m) => (m as { default: unknown }).default as HelpCorpus);
  // A failed chunk load (offline) may be tried again on the next question.
  loading.catch(() => (loading = null));
  return loading;
}

/** True when an action's path is a real page of the app (never "not found"). */
export function routeOk(to: string): boolean {
  if (!to.startsWith("/") || to.startsWith("//")) return false;
  try {
    const url = new URL(to, "https://app.invalid");
    if (url.origin !== "https://app.invalid") return false;
    return match(url.pathname, url.search).name !== "not_found";
  } catch {
    return false;
  }
}

/** Drops buttons that would lead nowhere, and keeps at most two. */
export function safeActions(actions: readonly HelpAction[]): HelpAction[] {
  return actions.filter((a) => typeof a.to === "string" && typeof a.label === "string" && routeOk(a.to)).slice(0, 2);
}

/** Ranks and composes against a loaded corpus: the same rules the API uses for its "kb" answers. */
export function answerFrom(corpus: HelpCorpus, question: string, history: readonly HelpTurn[], context: HelpContext): { answer: HelpAnswer; ranked: Ranked } {
  const ranked = rank(corpus.docs, question, history, context, corpus);
  const answer = compose(ranked);
  return { answer: { ...answer, actions: safeActions(answer.actions) }, ranked };
}

export async function answerLocally(question: string, history: readonly HelpTurn[], context: HelpContext): Promise<HelpAnswer> {
  return answerFrom(await loadCorpus(), question, history, context).answer;
}
