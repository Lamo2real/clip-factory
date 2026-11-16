import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import { putFile } from "../../api/upload.ts";
import type { ClipTarget, NewJobSource } from "../../api/types.ts";
import { useSession } from "../../app/session.tsx";
import { Icon } from "../../components/Icon.tsx";
import { PlatformMark } from "../../components/PlatformMark.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { ActGlyph, Button, Progress, Segmented, Stepper } from "../../components/ui.tsx";
import { bytes } from "../../lib/format.ts";
import { checkLink, extractLink, KIND_LABEL, PLATFORM_NAMES } from "../../lib/links.ts";
import { useAction } from "../../lib/motion.ts";
import { navigate } from "../../lib/router.ts";
import { useUnsaved } from "../../features/help/unsaved.ts";

const MAX_UPLOAD = 5 * 1024 ** 3;

type Mode = "link" | "upload";
type Count = "range" | "exact";

export function NewJobForm() {
  const id = useId();
  const { me, refresh } = useSession();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>("link");
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

  function pick(f: File | null) {
    setFile(f);
    setFileError(null);
    if (!f) return;
    // Played on the file arriving, not on the tap that opens the picker (§20.11 (a)).
    if (!f.type.startsWith("video/")) {
      setFileError("That is not a video. Tap the box and pick an MP4 or MOV file.");
      uploadAct.fail();
    } else if (f.size > MAX_UPLOAD) {
      setFileError(`That file is ${bytes(f.size)}. Videos can be up to 5 GB. Pick a shorter one.`);
      uploadAct.fail();
    } else uploadAct.play();
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
        const contentType = f.type || "video/mp4";
        const up = await api().createUpload({ filename: f.name, contentType, size: f.size });
        abort.current = new AbortController();
        setProgress(0);
        await putFile(up, f, setProgress, abort.current.signal);
        source = { type: "upload", key: up.key, filename: f.name };
      }
      if (!mounted.current) return;
      const job = await api().createJob({ source, clipTarget: target, ...(notes.trim() ? { notes: notes.trim() } : {}) });
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
    <form className="newjob" onSubmit={submit} noValidate aria-labelledby={`${id}-h`}>
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
          { value: "upload", label: "Upload a video", help: "upload-video" },
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
                  <span>MP4, MOV or WebM, up to 5 GB</span>
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
        <p className="newjob__hint">Nothing gets posted until you tap Keep.</p>
      </div>
    </form>
  );
}
