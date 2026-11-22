// The message list of one conversation as the page keeps it (docs/CONTRACTS.md §45.27): what is still being
// written, where the next poll starts, and how a poll's answer is folded in. Pure, so it is easy to test.
import type { Message } from "../api/types.ts";

export const LOCAL = "local-";

export function inFlight(m: Pick<Message, "status">): boolean {
  return m.status === "pending" || m.status === "streaming";
}

/**
 * The message id a poll asks "after": the last settled message before the first one still being written (so that
 * one and everything after it come back), or the last message when nothing is being written. Undefined: everything.
 */
export function afterId(messages: Message[]): string | undefined {
  const real = messages.filter((m) => !m.msgId.startsWith(LOCAL));
  const open = real.findIndex(inFlight);
  if (open === -1) return real[real.length - 1]?.msgId;
  return open === 0 ? undefined : real[open - 1]!.msgId;
}

/** Folds a poll's messages in: same id replaced, new ids added in their order; this device's unsent ones stay last. */
export function mergeMessages(prev: Message[], incoming: Message[]): Message[] {
  const local = prev.filter((m) => m.msgId.startsWith(LOCAL));
  const out = prev.filter((m) => !m.msgId.startsWith(LOCAL));
  const at = new Map(out.map((m, i) => [m.msgId, i]));
  for (const m of incoming) {
    const i = at.get(m.msgId);
    if (i === undefined) {
      at.set(m.msgId, out.length);
      out.push(m);
    } else out[i] = m;
  }
  return [...out, ...local];
}

/** The user message just before an assistant message (what "Try again" sends again). */
export function askedBefore(messages: Message[], assistantId: string): Message | null {
  const i = messages.findIndex((m) => m.msgId === assistantId);
  for (let j = i - 1; j >= 0; j--) if (messages[j]!.role === "user") return messages[j]!;
  return null;
}

/** A title for a new chat from its first message ("Give me three funny ideas about…"). */
export function titleFrom(text: string): string {
  const words = text.replace(/\s+/g, " ").trim();
  if (words.length <= 40) return words;
  const cut = words.slice(0, 40);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : 40)}…`;
}
