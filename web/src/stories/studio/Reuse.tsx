// Use it again (docs/CONTRACTS.md §45.52): the button on a made video (the Production list's Made rows and the video's
// own page). One tap reads the video and its script, saves its whole setup as a new draft and opens that draft in
// Make a new video, where every part can be changed before it is made. The video it came from is never changed.
import { useState } from "react";
import { useToast } from "../../components/Toasts.tsx";
import { navigate } from "../../lib/router.ts";
import { storiesApi } from "../api/client.ts";
import type { Story } from "../api/types.ts";
import { storiesHref } from "../routes.ts";
import { MADE, REUSE_WORDS, reuseForm } from "./reuseForm.ts";
import { say } from "./words.ts";

/** Copies a made video's setup into a new draft and opens it. `busy` is the story being copied. */
export function useReuse(ws: string) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  async function reuse(storyId: string) {
    if (busy) return;
    setBusy(storyId);
    try {
      const [{ story, script }, characters] = await Promise.all([storiesApi().getStory(ws, storyId), storiesApi().listCharacters(ws)]);
      const draft = await storiesApi().createVideoDraft(ws, { form: reuseForm(story, script, characters) });
      toast.success(REUSE_WORDS.done);
      navigate(storiesHref({ name: "production_new", ideaId: null, draftId: draft.draftId }));
    } catch (e) {
      toast.error(say(e, REUSE_WORDS.failed), { group: "st-reuse" });
    } finally {
      setBusy(null);
    }
  }

  return { busy, reuse };
}

/** "Use it again", shown only on a video that was made to the end. */
export function ReuseButton({ story, busy, onReuse, className = "st-btn" }: { story: Pick<Story, "storyId" | "title" | "status">; busy: string | null; onReuse: (storyId: string) => void; className?: string }) {
  if (!MADE.has(story.status)) return null;
  const mine = busy === story.storyId;
  return (
    <button type="button" className={className} aria-label={`${REUSE_WORDS.button}: ${story.title}`} aria-disabled={busy !== null || undefined} onClick={() => onReuse(story.storyId)}>
      {mine ? REUSE_WORDS.busy : REUSE_WORDS.button}
    </button>
  );
}
