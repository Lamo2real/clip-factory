// The box for TikTok's verification file (docs/CONTRACTS.md §17.4): drop or pick the tiktok….txt TikTok gives you,
// Clip Factory puts it on its website, and the files online are listed (each can be removed, with Undo).
import { useRef, useState, type DragEvent } from "react";
import { api } from "../../../api/index.ts";
import { friendlyMessage } from "../../../api/errors.ts";
import type { PlatformSetup } from "../../../api/types.ts";
import { Icon } from "../../../components/Icon.tsx";
import { useToast } from "../../../components/Toasts.tsx";
import { ActGlyph, Button } from "../../../components/ui.tsx";
import { useAction } from "../../../lib/motion.ts";
import { usePickAction } from "../parts.tsx";

const NAME = /^tiktok[A-Za-z0-9_-]{4,64}\.txt$/;

/**
 * TikTok's own name for a picked file, or null. A browser that downloads it twice saves "tiktokAbC (1).txt", and a
 * renamed copy may read "TikTokAbC.TXT": the " (1)" goes and "tiktok" and ".txt" are made lowercase (the code in the
 * middle is kept as it is, since TikTok checks it letter for letter).
 */
export function tiktokFileName(picked: string): string | null {
  const m = /^tiktok([A-Za-z0-9_-]{4,64}) ?(?:\(\d{1,3}\))?\.txt$/i.exec(picked.trim());
  if (!m) return null;
  const name = `tiktok${m[1]}.txt`;
  return NAME.test(name) ? name : null;
}

/** Why a picked file is not TikTok's, and what to do instead. */
export function fileProblem(picked: string, size: number): string | null {
  if (!tiktokFileName(picked))
    return /^tiktok.*\.txt$/i.test(picked.trim())
      ? "This file's name was changed. Download it again from TikTok and pick it without renaming it."
      : "That is not TikTok's file. Pick the tiktok….txt file TikTok gave you.";
  if (size > 4096) return "That file is too big to be TikTok's. Download it again from TikTok.";
  return null;
}

export function VerificationUpload({
  setup,
  onChange,
  reload,
}: {
  setup: PlatformSetup;
  onChange: (setup: PlatformSetup) => void;
  reload: () => Promise<void>;
}) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [hidden, setHidden] = useState<string[]>([]);
  const files = (setup.files ?? []).filter((f) => !hidden.includes(f));
  const pick = usePickAction("upload");
  // One bin for the file removed last: its row goes while the Undo is up and comes back rewinding (§20.7).
  const removeAct = useAction("delete");
  const [removed, setRemoved] = useState<string | null>(null);

  async function send(f: File) {
    pick.play();
    const problem = fileProblem(f.name, f.size);
    const name = tiktokFileName(f.name);
    if (problem || !name) {
      pick.fail({ sound: false });
      return toast.error(problem ?? "That is not TikTok's file.");
    }
    setBusy(true);
    try {
      // Put online under TikTok's own name, whatever the browser called the copy.
      onChange(await api().uploadVerificationFile(name, await f.text()));
      toast.success("File is online. Now press Verify on TikTok.");
    } catch (e) {
      pick.fail({ sound: false });
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function remove(name: string) {
    setHidden((h) => [...h, name]);
    setRemoved(name);
    removeAct.play();
    toast.undo("File removed.", {
      onUndo: () => {
        setHidden((h) => h.filter((x) => x !== name));
        setRemoved(name);
        removeAct.rewind();
      },
      onCommit: () => {
        api()
          .deleteVerificationFile(name)
          .then(() => reload())
          .catch((e) => toast.error(friendlyMessage(e)))
          .finally(() => setHidden((h) => h.filter((x) => x !== name)));
      },
    });
  }

  function drop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files[0];
    if (f) void send(f);
  }

  return (
    <div className="upload-box">
      <div
        className={`upload-box__zone${over ? " is-over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
      >
        <Icon name="upload" size={26} />
        <p className="upload-box__text">Drop TikTok&apos;s file here, or</p>
        <input
          ref={input}
          type="file"
          accept=".txt,text/plain"
          className="sr-only"
          tabIndex={-1}
          aria-label="TikTok's verification file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void send(f);
            e.target.value = "";
          }}
        />
        <Button size="sm" icon="upload" act={pick} playOnClick={false} loading={busy} onClick={() => input.current?.click()}>
          Pick the file
        </Button>
      </div>
      {files.length ? (
        <ul className="upload-box__files" aria-label="Files online">
          {files.map((f) => (
            <li key={f} className="upload-box__file">
              <Icon name="checkCircle" size={18} />
              <code className="upload-box__name">{f}</code>
              <span className="upload-box__online">Online</span>
              <button type="button" className="upload-box__remove" aria-label={`Remove ${f}`} data-act="delete" onClick={() => remove(f)}>
                <ActGlyph act={f === removed ? removeAct : { kind: "delete", shot: 0, phase: "idle" }}>
                  <Icon name="x" size={18} />
                </ActGlyph>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
