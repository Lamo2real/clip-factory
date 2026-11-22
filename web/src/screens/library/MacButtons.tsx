// The TikTok row's buttons for a Mac post (docs/CONTRACTS.md §47.4): Try again on a stopped one, and Post it yourself
// instead (Take it back from the Mac, then the §42 sheet, which the card or page opens so it outlives the row).
import { useState } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import type { Clip, Post, PostMac } from "../../api/types.ts";
import { useToast } from "../../components/Toasts.tsx";
import { Button } from "../../components/ui.tsx";
import { useAction } from "../../lib/motion.ts";
import { macTryAgainLabel } from "../../lib/tiktokMac.ts";
import { PostYourself } from "./PostYourself.tsx";

/** Try again on a stopped Mac post; after the Mac pressed Post it says it is not on TikTok (and sends that). */
export function MacTryAgain({ clip, mac, onKept }: { clip: Clip; mac: PostMac; onKept: (clip: Clip, posts: Post[]) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const act = useAction("retry");
  async function press() {
    setBusy(true);
    try {
      const out = await api().retryMac(clip.clipId, !!mac.pressedAt);
      onKept(out.clip, out.posts);
    } catch (e) {
      act.fail({ sound: false });
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="post__retry">
      <Button size="sm" variant="glass" icon="retry" act={act} loading={busy} onClick={() => void press()}>
        {macTryAgainLabel(mac)}
      </Button>
    </span>
  );
}

/**
 * Post it yourself instead: takes the clip back from the Mac (only while it waits or stopped), then `onTaken` opens
 * the Post it on TikTok yourself sheet. A refusal (the Mac started meanwhile) says why and changes nothing.
 */
export function PostYourselfInstead({
  clip,
  onTaken,
  size = "sm",
}: {
  clip: Clip;
  onTaken: (out: { clip: Clip; posts: Post[] }) => void;
  size?: "sm" | "md";
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function press() {
    setBusy(true);
    try {
      onTaken(await api().takeBackFromMac(clip.clipId));
    } catch (e) {
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="post__retry">
      <Button size={size} variant="glass" icon="upload" loading={busy} onClick={() => void press()} aria-label="Post it on TikTok yourself instead">
        Post it yourself instead
      </Button>
    </span>
  );
}

/**
 * I posted it, after the Mac pressed Post but could not confirm it (§47.3): it may be on TikTok, so the post is never
 * taken back. He opens the §42 link box (Find it looks from a minute before the press) and marks it as his.
 */
export function MacPostedIt({
  clip,
  mac,
  onMarked,
  size = "sm",
}: {
  clip: Clip;
  mac: PostMac;
  onMarked: (out: { clip: Clip; posts: Post[] }) => void;
  size?: "sm" | "md";
}) {
  const [open, setOpen] = useState(false);
  const since = mac.pressedAt ? new Date(Date.parse(mac.pressedAt) - 60_000).toISOString() : undefined;
  return (
    <span className="post__retry">
      <Button size={size} variant="glass" icon="check" onClick={() => setOpen(true)} aria-label="I posted it on TikTok">
        I posted it
      </Button>
      {open ? <PostYourself clip={clip} onMarked={onMarked} onClose={() => setOpen(false)} linkOnly postedAt={since} /> : null}
    </span>
  );
}
