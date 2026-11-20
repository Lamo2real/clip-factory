import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import { putFile } from "../../api/upload.ts";
import type { ClipTarget, NewJobSource } from "../../api/types.ts";
import { useSession } from "../../app/session.tsx";
import { Icon } from "../../components/Icon.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { ActGlyph, Button, Progress, Segmented, Stepper } from "../../components/ui.tsx";
import { classifyDrop, dragKind, dragMayHoldText, isVideoFile, videoType, type Dropped, type DragKind } from "../../lib/drops.ts";
import { bytes } from "../../lib/format.ts";
import { checkLink, extractLink, KIND_LABEL, PLATFORM_NAMES } from "../../lib/links.ts";
import { useAction } from "../../lib/motion.ts";
import { navigate } from "../../lib/router.ts";
import { useUnsaved } from "../../features/help/unsaved.ts";
import { canMacFetch, macBridge } from "../../lib/macFetch.ts";

const MAX_UPLOAD = 5 * 1024 ** 3;

type Mode = "link" | "upload";
/** The highlight over the card while something is dragged over it (§12.5); "busy" while an upload or a start runs. */
type Over = Exclude<DragKind, null> | "busy" | null;
type Count = "range" | "exact";

/** Use a video file on a failed link job (docs/CONTRACTS.md §29.7) opens Home at `/?file=1&from={jobId}`: the form
 * starts on Pick a video, with that job's clip count and notes. */
export function fileStart(search: string): { file: boolean; from: string | null } {
  const q = new URLSearchParams(search);
  const from = q.get("from");
  return { file: q.get("file") === "1", from: from && /^[A-Za-z0-9_-]{1,64}$/.test(from) ? from : null };
}

export function NewJobForm() {
  const id = useId();
  const { me, refresh } = useSession();
  const toast = useToast();
  const [start] = useState(() => fileStart(location.search));
  const [mode, setMode] = useState<Mode>(start.file ? "upload" : "link");
  const [link, setLink] = useState("");
  const [touched, setTouched] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [count, setCount] = useState<Count>("range");
  const [exact, setExact] = useState(6);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const [nudge, setNudge] = useState(false);
  const mounted = useRef(true);
  // A video or a link dragged over the card (§12.5): one soft highlight for the whole card, counted so moving over
  // the fields inside it never makes it flicker.
  // No idle timer: a drag held still sends no dragover in WebKit, and hiding then would put the counter out of step.
  const [over, setOver] = useState<Over>(null);
  const dragDepth = useRef(0);
  const form = useRef<HTMLFormElement>(null);
  // One status line that is always there, so a screen reader hears what a drop did even when it switched the bar.
  const [said, setSaid] = useState("");
  const sayTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Action motion (§20.11 (a)): Make clips' scissors fly; Paste drops in; Clear spins away; the dropzone's arrow rises.
  const send = useAction("send");
  const pasteAct = useAction("paste");
  const clearAct = useAction("clear");
  const uploadAct = useAction("upload");
  // A pasted link that is not sent yet, or an upload in progress: Ask Clip Factory asks before leaving (§19.8).
  useUnsaved(() => (mode === "link" && link.trim().length > 0 && !busy) || progress !== null);

  // Leaving Home stops a running upload: it has no progress or Cancel anywhere else, and must not pull the owner
  // back to a job page later from whatever screen they moved on to.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, []);

  // From a failed job: the same clip count and notes, so only the file is new.
  useEffect(() => {
    if (!start.from) return;
    let live = true;
    api()
      .getJob(start.from)
      .then(({ job }) => {
        if (!live) return;
        const t = job.clipTarget;
        if (t && t.min === t.max && t.min >= 1 && t.min <= 10) {
          setCount("exact");
          setExact(t.min);
        }
        if (job.notes) setNotes((n) => n || job.notes!);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [start.from]);

  // A drop anywhere, the drag ending, the drag going into another part of the page, or leaving the window (Escape
  // fires a dragleave too) clears the highlight, even when the card itself never heard about it.
  useEffect(() => {
    const done = () => endDrag();
    const entered = (e: globalThis.DragEvent) => {
      if (!form.current?.contains(e.target as Node)) endDrag();
    };
    const left = (e: globalThis.DragEvent) => {
      const outside = e.clientX <= 0 || e.clientY <= 0 || e.clientX >= innerWidth || e.clientY >= innerHeight;
      if (!e.relatedTarget && outside) endDrag();
    };
    window.addEventListener("drop", done);
    window.addEventListener("dragend", done);
    window.addEventListener("dragenter", entered);
    window.addEventListener("dragleave", left);
    return () => {
      window.removeEventListener("drop", done);
      window.removeEventListener("dragend", done);
      window.removeEventListener("dragenter", entered);
      window.removeEventListener("dragleave", left);
      clearTimeout(sayTimer.current);
    };
  }, []);

  const check = useMemo(() => checkLink(link), [link]);
  const min = me?.settings.clipMin ?? 5;
  const max = me?.settings.clipMax ?? 10;
  const target: ClipTarget = count === "range" ? { min, max } : { min: exact, max: exact };
  const ready = mode === "link" ? check.state === "ok" : !!file && !fileError;
  const showLinkError = check.state === "error" && (touched || link.length > 8);

  function takeLink(text: string) {
    setLink(extractLink(text));
    setNudge(false);
  }

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        pasteAct.fail({ sound: false });
        toast.info("Nothing is copied yet. Copy a link from YouTube, Twitch or Kick first.");
        return;
      }
      takeLink(text);
      setTouched(true);
    } catch {
      pasteAct.fail({ sound: false });
      linkInput.current?.focus();
      toast.info("Press and hold in the box, then choose Paste.");
    }
  }

  /** Picks a file (from the picker or a drop) and says what is wrong with it, if anything. */
  function pick(f: File | null, how: "tap" | "drop" = "tap"): string | null {
    setFile(f);
    setFileError(null);
    if (!f) return null;
    let error: string | null = null;
    // Played on the file arriving, not on the tap that opens the picker (§20.11 (a)).
    if (!isVideoFile(f)) {
      error = how === "drop" ? "That is not a video. Drop an MP4, MOV or WebM video." : "That is not a video. Tap the box and pick an MP4 or MOV file.";
    } else if (f.size > MAX_UPLOAD) {
      error = `That file is ${bytes(f.size)}. Videos can be up to 5 GB. Pick a shorter one.`;
    }
    setFileError(error);
    if (error) uploadAct.fail();
    else uploadAct.play();
    return error;
  }

  /** Says one line in the always-there status (cleared first, so the same words are heard again). */
  function say(text: string) {
    setSaid("");
    clearTimeout(sayTimer.current);
    sayTimer.current = setTimeout(() => setSaid(text), 60);
  }

  function endDrag() {
    dragDepth.current = 0;
    setOver(null);
  }

  /**
   * What the card does with this drag where the pointer is now: the highlight to show, or null to let it through
   * (text, or a link, dragged into Notes types there; plain text into the link box too). undefined: not ours at all.
   */
  function overFor(e: DragEvent<HTMLElement>): Over | undefined {
    const kind = dragKind(e.dataTransfer);
    if (!kind && !dragMayHoldText(e.dataTransfer)) return undefined;
    const t = e.target as HTMLElement | null;
    if (!kind && t?.closest?.("input, textarea")) return null;
    if (kind === "link" && t?.closest?.("textarea")) return null;
    if (progress !== null || busy) return "busy";
    return kind ?? "link";
  }

  function dragEnter(e: DragEvent<HTMLFormElement>) {
    const o = overFor(e);
    if (o === undefined) return;
    dragDepth.current++;
    setOver(o);
    if (o) e.preventDefault();
  }

  function dragOver(e: DragEvent<HTMLFormElement>) {
    const o = overFor(e);
    if (o === undefined) return;
    // The window lost track (it cleared on a leave it took for the last one): the pointer is on the card again.
    if (dragDepth.current === 0) dragDepth.current = 1;
    if (o !== over) setOver(o);
    if (!o) return;
    // Without this the drop would be refused (the window guard) or the file opened instead of picked. While an upload
    // runs the card says so and refuses the drop, still without the file replacing the app.
    e.preventDefault();
    e.dataTransfer.dropEffect = o === "busy" ? "none" : "copy";
  }

  function dragLeave(e: DragEvent<HTMLFormElement>) {
    if (overFor(e) === undefined) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) endDrag();
  }

  function drop(e: DragEvent<HTMLFormElement>) {
    const o = overFor(e);
    endDrag();
    if (!o) return;
    e.preventDefault();
    if (o === "busy") {
      toast.info(
        progress !== null ? "The upload is still running. Cancel it first, then drop again." : "Clip Factory is starting your job. Drop it again in a moment.",
      );
      return;
    }
    const dropped = classifyDrop(e.dataTransfer);
    if (dropped.kind !== "none") takeDrop(dropped);
  }

  /** A dropped video is picked like the file picker's; a dropped link is pasted like Paste's. Both switch the bar. */
  function takeDrop(d: Exclude<Dropped, { kind: "none" }>) {
    setNudge(false);
    if (d.kind === "link") {
      setMode("link");
      takeLink(d.url);
      setTouched(true);
      pasteAct.play();
      const c = checkLink(extractLink(d.url));
      say(c.state === "ok" ? `Link added. ${PLATFORM_NAMES[c.platform]} ${KIND_LABEL[c.kind]} found.` : c.state === "error" ? `Link added. ${c.message}` : "Link added.");
      return;
    }
    setMode("upload");
    const error = pick(d.file, "drop");
    if (d.kind === "video" && d.others > 0) toast.info(`One video per job. Clip Factory took ${d.file.name}.`);
    say(error ?? `Video picked: ${d.file.name}. Then choose Make clips.`);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!ready || busy) return;
    setBusy(true);
    try {
      let source: NewJobSource;
      if (mode === "link" && check.state === "ok") {
        source = { type: "link", url: check.url };
      } else {
        const f = file!;
        const contentType = videoType(f);
        const up = await api().createUpload({ filename: f.name, contentType, size: f.size });
        abort.current = new AbortController();
        setProgress(0);
        await putFile(up, f, setProgress, abort.current.signal);
        source = { type: "upload", key: up.key, filename: f.name };
      }
      if (!mounted.current) return;
      // In the desktop app a YouTube link is fetched by this computer from the start (§35.1): no cloud block to hit.
      const macFirst = source.type === "link" && check.state === "ok" && check.platform === "youtube" && canMacFetch();
      const job = await api().createJob({
        source,
        clipTarget: target,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(macFirst ? { macFetch: true } : {}),
        // From a link job (Use a video file): this file replaces it, so its wait for the Mac ends (§35.8).
        ...(source.type === "upload" && start.from ? { replaces: start.from } : {}),
      });
      // This computer stops getting that job's video now and removes its copy (the job's stop says so too, a moment later).
      if (source.type === "upload" && start.from) void macBridge()?.cancel(start.from).catch(() => undefined);
      toast.success("Started! Your clips show up in Review when they are ready.");
      void refresh().catch(() => undefined);
      if (mounted.current && location.pathname === "/") navigate(`/jobs/${job.jobId}`);
    } catch (err) {
      if ((err as DOMException)?.name === "AbortError")
        toast.info(mounted.current ? "Upload canceled." : "Upload stopped because you left Home. Start it again from Home.");
      else {
        // The error toast already plays the deny sound (§20.5).
        send.fail({ sound: false });
        toast.error(friendlyMessage(err));
      }
    } finally {
      setBusy(false);
      setProgress(null);
      abort.current = null;
    }
  }

  const platform = check.state === "ok" ? check.platform : check.state === "error" ? check.platform : undefined;

  return (
    <form
      ref={form}
      className={`newjob${over ? " is-drop" : ""}`}
      onSubmit={submit}
      noValidate
      aria-labelledby={`${id}-h`}
      onDragEnter={dragEnter}
      onDragOver={dragOver}
      onDragLeave={dragLeave}
      onDrop={drop}
    >
      <h2 className="sr-only" id={`${id}-h`}>
        Make new clips
      </h2>
      <Segmented<Mode>
        label="Source"
        value={mode}
        onChange={(m) => {
          // The progress bar and Cancel live in the upload view, so it stays put while a file is going up.
          if (progress !== null) toast.info("The upload is still running. Tap Cancel upload first to switch.");
          else setMode(m);
        }}
        options={[
          { value: "link", label: "Paste a link" },
          { value: "upload", label: "Pick a video", help: "upload-video" },
        ]}
      />

      {mode === "link" ? (
        <div className="field">
          <label className="field__label" htmlFor={`${id}-link`}>
            YouTube, Twitch or Kick link
          </label>
          <div className={`linkbox${check.state === "ok" ? " is-ok" : ""}${showLinkError ? " is-bad" : ""}`} data-help-dodge="">
            <span className={`linkbox__mark${platform ? ` is-${platform}` : ""}`} aria-hidden="true">
              {platform ? <PlatformMark platform={platform} size={22} /> : <Icon name="link" />}
            </span>
            <input
              id={`${id}-link`}
              ref={linkInput}
              className="linkbox__input"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://www.youtube.com/watch?v=…"
              value={link}
              onChange={(e) => takeLink(e.target.value)}
              onBlur={() => setTouched(true)}
              aria-invalid={showLinkError || undefined}
              aria-describedby={`${id}-status`}
            />
            {link ? (
              <button
                type="button"
                className="icon-btn linkbox__clear"
                aria-label="Clear link"
                data-act="clear"
                onClick={() => {
                  setLink("");
                  clearAct.play();
                }}
              >
                <ActGlyph act={clearAct}>
                  <Icon name="x" size={18} />
                </ActGlyph>
              </button>
            ) : (
              <button
                type="button"
                className="linkbox__paste"
                data-help="paste-link"
                data-act="paste"
                onClick={() => {
                  void pasteFromClipboard();
                  pasteAct.play();
                }}
              >
                <ActGlyph act={pasteAct}>
                  <Icon name="paste" size={18} />
                </ActGlyph>
                <span>Paste</span>
              </button>
            )}
          </div>
          <p className={`field__status${showLinkError ? " is-bad" : check.state === "ok" ? " is-ok" : ""}`} id={`${id}-status`} aria-live="polite">
            {check.state === "ok" ? (
              <>
                <Icon name="checkCircle" size={18} />
                <span>
                  {PLATFORM_NAMES[check.platform]} {KIND_LABEL[check.kind]} found.
                  {check.kind === "live" ? " Clip Factory clips the latest broadcast." : ""}
                </span>
              </>
            ) : showLinkError ? (
              <>
                <Icon name="alert" size={18} />
                <span>{check.message}</span>
              </>
            ) : nudge ? (
              <>
                <Icon name="info" size={18} />
                <span>First, add a link. Tap Paste.</span>
              </>
            ) : (
              <span>Copy a link from YouTube, Twitch or Kick, then tap Paste.</span>
            )}
          </p>
        </div>
      ) : (
        <div className="field">
          <span className="field__label" id={`${id}-fl`}>
            Video file
          </span>
          <label className={`dropzone${file ? " has-file" : ""}${fileError ? " is-bad" : ""}`}>
            <input
              type="file"
              accept="video/*"
              className="sr-only"
              aria-labelledby={`${id}-fl`}
              aria-describedby={`${id}-fs`}
              onChange={(e) => pick(e.target.files?.[0] ?? null)}
            />
            <ActGlyph act={uploadAct}>
              <Icon name={file ? "file" : "upload"} size={26} />
            </ActGlyph>
            <span className="dropzone__text">
              {file ? (
                <>
                  <strong className="user-text">{file.name}</strong>
                  <span>{bytes(file.size)} · tap to pick a different one</span>
                </>
              ) : (
                <>
                  <strong>Tap to choose a video</strong>
                  <span>
                    <span className="dropzone__or-drop">Or drop it here. </span>MP4, MOV or WebM, up to 5 GB
                  </span>
                </>
              )}
            </span>
          </label>
          <p className={`field__status${fileError ? " is-bad" : ""}`} id={`${id}-fs`} aria-live="polite">
            {fileError ? (
              <>
                <Icon name="alert" size={18} />
                <span>{fileError}</span>
              </>
            ) : progress !== null ? (
              <span>Uploading… {Math.round(progress * 100)}%</span>
            ) : (
              <span>{nudge ? "First, choose a video. Tap the box above." : "Only you can see your videos."}</span>
            )}
          </p>
          {progress !== null ? (
            <div className="upload-progress">
              <Progress value={progress} label="Upload progress" />
              <Button size="sm" variant="ghost" icon="x" act="clear" onClick={() => abort.current?.abort()}>
                Cancel upload
              </Button>
            </div>
          ) : null}
        </div>
      )}

      <fieldset className="field field--inline">
        <legend className="field__label">How many clips</legend>
        <div className="count-row">
          <Segmented<Count>
            label="How many clips"
            value={count}
            onChange={setCount}
            options={[
              { value: "range", label: `Pick for me (${min}–${max})` },
              { value: "exact", label: "Exactly" },
            ]}
          />
          {count === "exact" ? <Stepper label="Number of clips" value={exact} min={1} max={10} onChange={setExact} /> : null}
        </div>
      </fieldset>

      <div className="field">
        <label className="field__label" htmlFor={`${id}-notes`}>
          Notes for Clip Factory <span className="field__optional">you can skip this</span>
        </label>
        <textarea
          id={`${id}-notes`}
          className="input textarea"
          rows={2}
          maxLength={1000}
          placeholder="Campaign tags like #gta6, names to mention, moments to skip"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      <div className="newjob__actions">
        <Button
          type="submit"
          variant="primary"
          size="lg"
          icon="scissors"
          act={send}
          data-help="make-clips"
          disabled={!ready}
          loading={busy}
          onClickCapture={() => {
            if (!ready && !busy) {
              setNudge(true);
              setTouched(true);
            }
          }}
        >
          Make clips
        </Button>
        <p className="newjob__hint">Nothing gets posted until you tap Upload.</p>
      </div>

      <p className="sr-only" role="status">
        {said}
      </p>
      {over ? (
        // Pointer-only: the file box stays a labelled file input and the link box a labelled text box for keyboards.
        <div className={`newjob__drop${over === "busy" ? " is-busy" : ""}`} aria-hidden="true">
          <div className="newjob__drop-say">
            <Icon name={over === "busy" ? "clock" : over === "link" ? "link" : "upload"} size={30} />
            <p>
              {over === "busy"
                ? progress !== null
                  ? "Upload still running"
                  : "Starting your job…"
                : over === "file"
                  ? "Drop your video here"
                  : over === "link"
                    ? "Drop your link here"
                    : "Drop it here"}
            </p>
          </div>
        </div>
      ) : null}
    </form>
  );
}
