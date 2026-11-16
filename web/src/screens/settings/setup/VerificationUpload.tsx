// The box for TikTok's verification file (docs/CONTRACTS.md §17.4): drop or pick the tiktok….txt TikTok gives you,
// Clip Factory puts it on its website, and the files online are listed (each can be removed, with Undo).
import { useRef, useState, type DragEvent } from "react";
import { api } from "../../../api/index.ts";
import { friendlyMessage } from "../../../api/errors.ts";
import type { PlatformSetup } from "../../../api/types.ts";
import { Icon } from "../../../components/Icon.tsx";
import { useToast } from "../../../components/Toasts.tsx";
import { Button } from "../../../components/ui.tsx";

const NAME = /^tiktok[A-Za-z0-9_-]{4,64}\.txt$/;

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

  async function send(f: File) {
    if (!NAME.test(f.name)) return toast.error("That is not TikTok's file. Its name starts with tiktok and ends with .txt.");
    if (f.size > 4096) return toast.error("That file is too big to be TikTok's. Download it again from TikTok.");
    setBusy(true);
    try {
      onChange(await api().uploadVerificationFile(f.name, await f.text()));
      toast.success("File is online. Now press Verify on TikTok.");
    } catch (e) {
      toast.error(friendlyMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function remove(name: string) {
    setHidden((h) => [...h, name]);
    toast.undo("File removed.", {
      onUndo: () => setHidden((h) => h.filter((x) => x !== name)),
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
        <Button size="sm" icon="upload" loading={busy} onClick={() => input.current?.click()}>
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
              <button type="button" className="upload-box__remove" aria-label={`Remove ${f}`} onClick={() => remove(f)}>
                <Icon name="x" size={18} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
