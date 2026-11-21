// Post it on TikTok yourself (docs/CONTRACTS.md §41). While TikTok has not approved Clip Factory, its API keeps every
// upload "Only me". This sheet hands the clip to TikTok instead: on a phone the share menu (pick TikTok), on a
// computer the file plus TikTok's own upload page; the caption is copied on the same tap. The owner posts it in
// TikTok for Everyone, then taps I posted it here, with the post's link when he has it, so its views are counted.
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import type { Clip, ClipFile, TikTokMarked } from "../../api/types.ts";
import { Icon } from "../../components/Icon.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { trapTab } from "../../components/Sheet.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { Button } from "../../components/ui.tsx";
import { burst } from "../../lib/confetti.ts";
import { currentOs } from "../../lib/device.ts";
import { useAction } from "../../lib/motion.ts";
import { canShareVideo, handOffFor, isPaid, looksLikeTikTokLink, steps, TIKTOK_UPLOAD_URL } from "../../lib/tiktokYourself.ts";
import { copyText, readClipboard, Rich } from "../settings/setup/bits.tsx";

type FileState = { state: "getting" } | { state: "ready"; file: ClipFile; video: File | null } | { state: "failed"; message: string };

/** Fetches the clip's file link and, where it will be shared, the video itself, so the tap can share it at once. */
function useClipFile(clipId: string, wantVideo: boolean, attempt: number, wanted = true): FileState {
  const [state, setState] = useState<FileState>({ state: "getting" });
  useEffect(() => {
    if (!wanted) return;
    let alive = true;
    setState({ state: "getting" });
    (async () => {
      const file = await api().clipFile(clipId);
      let video: File | null = null;
      if (wantVideo) {
        // no-store: a copy cached by the page's own <video> may lack the bucket's CORS answer.
        const res = await fetch(file.url, { cache: "no-store" });
        if (!res.ok) throw new Error(`video ${res.status}`);
        video = new File([await res.blob()], file.filename, {
          type: "video/mp4",
        });
      }
      if (alive) setState({ state: "ready", file, video });
    })().catch((e: unknown) => {
      if (alive)
        setState({
          state: "failed",
          message: e instanceof Error && e.message.startsWith("video") ? "The video did not load." : friendlyMessage(e),
        });
    });
    return () => {
      alive = false;
    };
  }, [clipId, wantVideo, attempt, wanted]);
  return state;
}

export function PostYourself({
  clip,
  onMarked,
  onClose,
  linkOnly = false,
  postedAt,
}: {
  clip: Clip;
  /** I posted it went through: the clip and its posts as they are now. */
  onMarked: (out: TikTokMarked) => void;
  onClose: () => void;
  /** Already posted by him without its link: only the link box, to start counting views. */
  linkOnly?: boolean;
  /** When he marked it (Add link): Find it looks for posts made since then. */
  postedAt?: string;
}) {
  const id = useId();
  const toast = useToast();
  const dialog = useRef<HTMLDivElement>(null);
  const [device] = useState(() => {
    const os = currentOs();
    const canShare = canShareVideo();
    // A Mac can also AirDrop the file to the iPhone through its share menu (Safari and the Mac app both have it).
    return { mode: handOffFor(os, canShare), airdrop: os === "mac" && canShare };
  });
  const { mode, airdrop } = device;
  // The post he makes is newer than this: the API looks for it on his TikTok from here (§41.2).
  const [openedAt] = useState(() => new Date(Date.now() - 60_000).toISOString());
  const [attempt, setAttempt] = useState(0);
  const file = useClipFile(clip.clipId, (mode === "share" || airdrop) && !linkOnly, attempt, !linkOnly);
  const [sent, setSent] = useState(false);
  const [copied, setCopied] = useState(false);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const send = useAction("send");
  const save = useAction("download");
  const done = useAction("check");
  const paste = useAction("paste");
  const caption = clip.captions.tiktok;

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  function keys(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCloseRef.current();
      return;
    }
    trapTab(e, dialog.current);
  }

  /** Copies the caption. Started first on the tap, before the share menu, which needs the same tap. */
  function copyCaption() {
    void copyText(caption).then((ok) => setCopied(ok));
  }

  /**
   * The share menu with the video file only (a caption next to it makes some apps drop the file). The caption is
   * copied first: copying does not use up the tap, sharing does. The menu's answer is not waited for: some iOS
   * versions never give one after Save Video.
   */
  function shareIt() {
    if (file.state !== "ready" || !file.video) return;
    copyCaption();
    setSent(true);
    navigator.share({ files: [file.video] }).catch((e: unknown) => {
      // Closing the share menu is not an error. Anything else: saving the file still works.
      if (e instanceof DOMException && e.name === "AbortError") return;
      send.fail({ sound: false });
      setProblem(mode === "share" ? "The share menu did not open. Tap Save the video below, then open TikTok and tap +." : "AirDrop did not open. Click Save the video instead.");
    });
  }

  function saveIt() {
    if (file.state !== "ready") return;
    copyCaption();
    // The Mac app opens other sites in the system browser, which saves the file (the link says "attachment").
    if ((window as { __CF_DESKTOP__?: unknown }).__CF_DESKTOP__ === true) {
      window.open(file.file.url, "_blank", "noopener,noreferrer");
      setSent(true);
      return;
    }
    const a = document.createElement("a");
    a.href = file.file.url;
    a.download = file.file.filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setSent(true);
  }

  function openTikTok() {
    copyCaption();
    window.open(TIKTOK_UPLOAD_URL, "_blank", "noopener,noreferrer");
    setSent(true);
  }

  async function pasteLink() {
    const text = await readClipboard();
    if (text) setLink(text.trim());
  }

  async function posted(e?: FormEvent, find = false) {
    e?.preventDefault();
    if (linkOnly && !find && !link.trim()) {
      done.fail();
      setProblem("Paste the TikTok link first. In TikTok, open your post, tap Share, then Copy link.");
      return;
    }
    if (link.trim() && !looksLikeTikTokLink(link)) {
      done.fail();
      setProblem("That is not a TikTok link. In TikTok, tap Share, then Copy link, and paste it here.");
      return;
    }
    setBusy(true);
    setProblem("");
    try {
      const typed = find ? undefined : link.trim() || undefined;
      const out = await api().markTikTokPosted(clip.clipId, typed, linkOnly ? (postedAt ?? openedAt) : openedAt);
      onMarked(out);
      const linked = !!out.posts.find((p) => p.platform === "tiktok")?.url;
      if (linkOnly) {
        if (linked) toast.success(typed ? "Link saved! Clip Factory will count its views." : "Found it on your TikTok! Clip Factory will count its views.");
        else toast.info(out.note ?? "Clip Factory could not find it yet. Paste its link instead.");
        if (!linked) return;
      } else {
        const box = dialog.current?.getBoundingClientRect();
        burst(box ? { x: box.left + box.width / 2, y: box.top + box.height / 3 } : undefined);
        // One toast, always with Undo: what happened, and what is still to do when Clip Factory has no link.
        const more = out.note ? ` ${out.note.replace(/^Saved\. /, "")}` : linked ? " Clip Factory will count its views." : "";
        toast.undo(`On TikTok for everyone!${more}`, { onUndo: () => void undo(), onCommit: () => undefined });
      }
      onClose();
    } catch (err) {
      done.fail({ sound: false });
      setProblem(friendlyMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    try {
      onMarked(await api().undoTikTokPosted(clip.clipId));
    } catch (err) {
      toast.error(friendlyMessage(err));
    }
  }

  const list = steps(mode, isPaid(clip));
  return createPortal(
    <div className="tt-sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tt-sheet ty-sheet glass" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1} ref={dialog} onKeyDown={keys}>
        <header className="tt-sheet__head">
          <h2 className="tt-sheet__title ty-sheet__title" id={`${id}-title`}>
            <PlatformMark platform="tiktok" size={26} />
            {linkOnly ? "Add the TikTok link" : "Post it on TikTok yourself"}
          </h2>
          <button type="button" className="tt-sheet__close" aria-label="Close" onClick={onClose}>
            <Icon name="x" size={20} />
          </button>
        </header>
        {linkOnly ? (
          <p className="ty-sheet__lede">In TikTok, open your post, tap Share, then Copy link. Paste it here, and Clip Factory counts its views.</p>
        ) : (
          <p className="ty-sheet__lede">
            Everyone can see it, because you post it in TikTok. Clip Factory&rsquo;s own TikTok upload stays Only me until TikTok approves the app.
          </p>
        )}

        {linkOnly ? null : (
          <>
            <div className="ty-sheet__top">
              <div className="tt-sheet__preview">
                {clip.videoUrl ? (
                  <video
                    className="tt-sheet__video"
                    src={clip.videoUrl}
                    poster={clip.coverUrl}
                    controls
                    playsInline
                    preload="none"
                    aria-label={`Clip: ${clip.hook}`}
                  />
                ) : clip.coverUrl ? (
                  <img className="tt-sheet__video" src={clip.coverUrl} alt={`Cover for: ${clip.hook}`} />
                ) : null}
              </div>
              <ol className="ty-steps">
                {list.map((s, i) => (
                  <li key={i}>
                    <Rich text={s} />
                  </li>
                ))}
              </ol>
            </div>

            <div className="field">
              <span className="field__label" id={`${id}-cap`}>
                Caption {copied ? <span className="ty-sheet__copied">· copied</span> : null}
              </span>
              <p className="ty-sheet__caption user-text" aria-labelledby={`${id}-cap`}>
                {caption}
              </p>
            </div>

            {file.state === "failed" ? (
              <div className="tt-sheet__stuck">
                <p className="callout callout--bad" role="alert">
                  <Icon name="alert" size={18} />
                  <span>{file.message} Tap Try again.</span>
                </p>
                <div className="tt-sheet__stuck-actions">
                  <Button icon="retry" act="retry" onClick={() => setAttempt((n) => n + 1)}>
                    Try again
                  </Button>
                </div>
              </div>
            ) : null}

            <div className="ty-sheet__send">
              {mode === "share" ? (
                <>
                  <Button
                    variant={sent ? "glass" : "primary"}
                    size="lg"
                    icon="download"
                    act={send}
                    block
                    loading={file.state === "getting"}
                    disabled={file.state !== "ready"}
                    onClick={shareIt}
                  >
                    {file.state === "getting" ? "Getting the video ready…" : "Save to my phone"}
                  </Button>
                  {problem && !sent ? (
                    <Button variant="glass" icon="download" act={save} block disabled={file.state !== "ready"} onClick={saveIt}>
                      Save the video
                    </Button>
                  ) : null}
                </>
              ) : (
                <>
                  <Button
                    variant={sent ? "glass" : "primary"}
                    size="lg"
                    icon="download"
                    act={save}
                    block
                    loading={file.state === "getting"}
                    disabled={file.state !== "ready"}
                    onClick={saveIt}
                  >
                    Save the video
                  </Button>
                  <Button variant="glass" size="lg" icon="external" block onClick={openTikTok}>
                    Open TikTok
                  </Button>
                  {airdrop ? (
                    <Button variant="ghost" icon="phone" act={send} block disabled={file.state !== "ready"} onClick={shareIt}>
                      Send to my iPhone (AirDrop)
                    </Button>
                  ) : null}
                </>
              )}
            </div>
          </>
        )}

        <form className="ty-sheet__done" onSubmit={(e) => void posted(e)}>
          <label className="field__label" htmlFor={`${id}-link`}>
            TikTok link <span className="muted">{linkOnly ? "(or let Clip Factory find it)" : "(optional: Clip Factory looks for the post on your TikTok)"}</span>
          </label>
          <div className="ty-sheet__link">
            <input
              id={`${id}-link`}
              className="input"
              inputMode="url"
              autoComplete="off"
              placeholder="In TikTok: Share › Copy link"
              value={link}
              onChange={(e) => setLink(e.target.value)}
            />
            <Button variant="glass" icon="paste" act={paste} onClick={() => void pasteLink()} aria-label="Paste the TikTok link">
              Paste
            </Button>
          </div>
          {problem ? (
            <p className="ty-sheet__problem" role="alert">
              {problem}
            </p>
          ) : null}
          <footer className="tt-sheet__actions">
            <Button variant="ghost" onClick={onClose}>
              Not now
            </Button>
            {linkOnly ? (
              <Button variant="glass" size="lg" icon="search" loading={busy && !link.trim()} onClick={() => void posted(undefined, true)}>
                Find it on my TikTok
              </Button>
            ) : null}
            <Button type="submit" variant={sent || linkOnly ? "primary" : "glass"} size="lg" icon="check" act={done} loading={busy && (!linkOnly || !!link.trim())}>
              {linkOnly ? "Save the link" : "I posted it"}
            </Button>
          </footer>
        </form>
      </div>
    </div>,
    document.body,
  );
}

/** The TikTok row's own button on a Library card or a clip page: opens the sheet. */
export function PostYourselfButton({
  clip,
  onMarked,
  size = "sm",
  linkOnly = false,
  postedAt,
}: {
  clip: Clip;
  onMarked: (out: TikTokMarked) => void;
  size?: "sm" | "md";
  /** "Add link": he posted it already; only the link is missing. */
  linkOnly?: boolean;
  /** When he marked it (Add link's Find it looks from there). */
  postedAt?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="post__retry">
      <Button
        size={size}
        variant="glass"
        icon={linkOnly ? "link" : "upload"}
        onClick={() => setOpen(true)}
        aria-label={linkOnly ? "Add the TikTok link" : "Post it on TikTok yourself"}
      >
        {linkOnly ? "Add link" : "Post it yourself"}
      </Button>
      {open ? <PostYourself clip={clip} onMarked={onMarked} onClose={() => setOpen(false)} linkOnly={linkOnly} postedAt={postedAt} /> : null}
    </span>
  );
}
