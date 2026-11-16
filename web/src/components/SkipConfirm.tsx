// "Skip TikTok?" (docs/CONTRACTS.md §17.13): the small glass question before a platform leaves the setup to-do list,
// used by the floating list and by Settings › Posting › Set up posting. Keep it is the safe answer: first, focused,
// the strong button; Escape and a tap outside also mean Keep it. Skip is the quiet choice, with no celebration.
import type { Platform } from "../api/types.ts";
import { skipQuestion } from "../lib/setupTodo.ts";
import { GUIDES } from "../setup/index.ts";
import { Sheet } from "./Sheet.tsx";
import { Button } from "./ui.tsx";

export function SkipConfirm({
  platform,
  connected = false,
  onKeep,
  onSkip,
}: {
  platform: Platform;
  /** The account is connected (a gate still needs the owner): the text then does not promise that nothing posts. */
  connected?: boolean;
  onKeep: () => void;
  onSkip: () => unknown;
}) {
  const question = skipQuestion(platform, connected);
  return (
    <Sheet
      title={question.title}
      onClose={onKeep}
      actions={
        <>
          <Button variant="primary" className="skip-confirm__keep" onClick={onKeep}>
            Keep it
          </Button>
          <Button variant="glass" className="skip-confirm__skip" onClick={onSkip}>
            Skip {GUIDES[platform].name}
          </Button>
        </>
      }
    >
      {question.text}
    </Sheet>
  );
}
