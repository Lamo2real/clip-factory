// A deterministic stand-in for the help model (docs/CONTRACTS.md §19.8, mock mode only): it adds a friendly first
// sentence, keeps the steps and the first button, and takes 300 ms. Unknown and refused answers pass through.
import type { HelpAnswer } from "../../features/help/types.ts";

export const FAKE_MODEL_MS = 300;

const OPENERS = ["Sure thing!", "Happy to help!", "Good question!"];

export function fakeModel(answer: HelpAnswer, question: string): HelpAnswer {
  if (!answer.known) return answer;
  const opener = OPENERS[question.length % OPENERS.length]!;
  return { ...answer, text: `${opener} ${answer.text}`, actions: answer.actions.slice(0, 1) };
}
