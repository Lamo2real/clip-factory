// Files and pictures for the notes on Home (docs/CONTRACTS.md §52): "Add files or images", the hint, and one chip per
// file. Each file goes up as soon as it is added; Make clips sends only the ones that are all up.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/index.ts";
import { putFile } from "../../api/upload.ts";
import type { JobAttachment } from "../../api/types.ts";
import { Icon, type IconName } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { Button, Progress } from "../../components/ui.tsx";
import {
  addFiles,
  ATTACH_HINT,
  ATTACHMENT_ACCEPT,
  canRead,
  CANT_READ,
  chipsFromDraft,
  isImageType,
  removeChip,
  restoreChip,
  setDone,
  setFailed,
  setProgress,
  setRetry,
  uploadErrorText,
  type Chip,
} from "../../lib/attachments.ts";
import { bytes } from "../../lib/format.ts";

/** How long Undo stays after a remove. */
export const REMOVE_UNDO_MS = 6000;

export interface Attachments {
  chips: Chip[];
  /** Thumbnails of the pictures (object URLs), by chip id. */
  thumbs: Record<string, string>;
  /** Adds files (from the picker, a paste or a drop); says the first refusal. Returns how many were added. */
  add(files: readonly File[]): number;
  remove(id: string): void;
  retry(id: string): void;
  /** The chips as they are right now (also between renders). */
  current(): Chip[];
  /** Waits until no file is still going up. */
  settle(): Promise<void>;
}

/** The notes' files: their uploads, thumbnails, remove with Undo and Try again. */
export function useAttachments(kept: readonly JobAttachment[] | undefined, onSay: (text: string) => void): Attachments {
  const toast = useToast();
  const chipsRef = useRef<Chip[]>([]);
  const [chips, setChips] = useState<Chip[]>(() => {
    chipsRef.current = chipsFromDraft(kept);
    return chipsRef.current;
  });
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const thumbsRef = useRef<Record<string, string>>({});
  const ctls = useRef(new Map<string, AbortController>());
  const flights = useRef(new Map<string, Promise<void>>());
  const alive = useRef(true);
  const say = useRef(onSay);
  say.current = onSay;

  const set = useCallback((f: (c: Chip[]) => Chip[]) => {
    if (!alive.current) return;
    chipsRef.current = f(chipsRef.current);
    setChips(chipsRef.current);
  }, []);

  const putThumbs = useCallback((next: Record<string, string>) => {
    thumbsRef.current = next;
    if (alive.current) setThumbs(next);
  }, []);

  const makeThumb = useCallback(
    (c: Chip) => {
      if (!c.file || !isImageType(c.type) || thumbsRef.current[c.id] || typeof URL.createObjectURL !== "function") return;
      try {
        putThumbs({ ...thumbsRef.current, [c.id]: URL.createObjectURL(c.file) });
      } catch {
        // No picture: the file icon shows instead.
      }
    },
    [putThumbs],
  );

  const dropThumb = useCallback(
    (id: string) => {
      const url = thumbsRef.current[id];
      if (!url) return;
      try {
        URL.revokeObjectURL(url);
      } catch {
        // Already gone.
      }
      const { [id]: _gone, ...rest } = thumbsRef.current;
      putThumbs(rest);
    },
    [putThumbs],
  );

  const stop = useCallback((id: string) => {
    ctls.current.get(id)?.abort();
    ctls.current.delete(id);
    flights.current.delete(id);
  }, []);

  const upload = useCallback(
    (c: Chip) => {
      const file = c.file;
      if (!file) return;
      stop(c.id);
      const ctl = new AbortController();
      ctls.current.set(c.id, ctl);
      const run = (async () => {
        try {
          const up = await api().createUpload({ filename: c.name, contentType: c.type, size: c.size, purpose: "attachment" });
          if (ctl.signal.aborted) return;
          await putFile(up, file, (p) => !ctl.signal.aborted && set((cs) => setProgress(cs, c.id, p)), ctl.signal);
          if (ctl.signal.aborted) return;
          set((cs) => setDone(cs, c.id, up.key));
        } catch (err) {
          if (ctl.signal.aborted || (err as DOMException)?.name === "AbortError") return;
          const text = uploadErrorText(err);
          set((cs) => setFailed(cs, c.id, text));
          say.current(`${c.name}: ${text}`);
        } finally {
          if (ctls.current.get(c.id) === ctl) {
            ctls.current.delete(c.id);
            flights.current.delete(c.id);
          }
        }
      })();
      flights.current.set(c.id, run);
    },
    [set, stop],
  );

  // Leaving Home stops the uploads and lets the pictures go.
  useEffect(() => {
    alive.current = true;
    const live = ctls.current;
    const going = flights.current;
    return () => {
      alive.current = false;
      for (const ctl of live.values()) ctl.abort();
      live.clear();
      going.clear();
      for (const url of Object.values(thumbsRef.current)) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // Already gone.
        }
      }
      thumbsRef.current = {};
    };
  }, []);

  const add = useCallback(
    (files: readonly File[]) => {
      const out = addFiles(chipsRef.current, files);
      if (out.refused) {
        toast.info(out.refused);
        say.current(out.refused);
      }
      if (!out.added.length) return 0;
      set(() => out.chips);
      for (const c of out.added) {
        makeThumb(c);
        upload(c);
      }
      say.current(out.added.length === 1 ? `Added ${out.added[0]!.name}.` : `Added ${out.added.length} files.`);
      return out.added.length;
    },
    [makeThumb, set, toast, upload],
  );

  const remove = useCallback(
    (id: string) => {
      const { chips: next, removed } = removeChip(chipsRef.current, id);
      if (!removed) return;
      // Forgotten at once: nothing is deleted on the server (the uploads/ clean-up takes it, §52 F2).
      stop(id);
      dropThumb(id);
      set(() => next);
      const name = removed.chip.name.length > 40 ? `${removed.chip.name.slice(0, 39)}…` : removed.chip.name;
      toast.undo(`Removed ${name}.`, {
        ms: REMOVE_UNDO_MS,
        onCommit: () => undefined,
        onUndo: () => {
          if (!alive.current) return;
          const back = restoreChip(chipsRef.current, removed);
          set(() => back.chips);
          if (!back.chips.some((c) => c.id === removed.chip.id)) return;
          makeThumb(removed.chip);
          if (back.restarted) upload(removed.chip);
        },
      });
    },
    [dropThumb, makeThumb, set, stop, toast, upload],
  );

  const retry = useCallback(
    (id: string) => {
      set((cs) => setRetry(cs, id));
      const c = chipsRef.current.find((x) => x.id === id);
      if (c?.state === "uploading") upload(c);
    },
    [set, upload],
  );

  const current = useCallback(() => chipsRef.current, []);
  const settle = useCallback(async () => {
    while (alive.current && flights.current.size) await Promise.allSettled([...flights.current.values()]);
  }, []);

  return { chips, thumbs, add, remove, retry, current, settle };
}

function iconFor(type: string): IconName {
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf") return "filePdf";
  if (type === "text/csv" || type.includes("spreadsheet")) return "fileTable";
  if (type === "application/json") return "fileCode";
  if (type.startsWith("text/") || type.includes("word") || type.includes("opendocument.text") || type === "application/rtf") return "fileText";
  return "file";
}

/** "Add files or images", the hint, and the chips under the notes. */
export function NotesAttach({ attach, hintId, locked, onLocked }: { attach: Attachments; hintId: string; locked: boolean; onLocked: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="notes-attach">
      <div className="notes-attach__row">
        <label
          className="notes-attach__add"
          onClick={(e) => {
            if (!locked) return;
            e.preventDefault();
            onLocked();
          }}
        >
          <input
            ref={input}
            type="file"
            multiple
            accept={ATTACHMENT_ACCEPT}
            className="sr-only"
            aria-describedby={hintId}
            disabled={locked}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              // Cleared, so the same file can be picked again after a remove.
              e.target.value = "";
              if (files.length) attach.add(files);
            }}
          />
          <Icon name="paperclip" size={18} />
          <span>Add files or images</span>
        </label>
        <p className="notes-attach__hint" id={hintId}>
          {ATTACH_HINT}
        </p>
      </div>
      {attach.chips.length ? (
        <ul className="attach-chips" aria-label="Added files">
          {attach.chips.map((c) => (
            <AttachChip key={c.id} chip={c} thumb={attach.thumbs[c.id]} onRemove={() => attach.remove(c.id)} onRetry={() => attach.retry(c.id)} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function AttachChip({ chip, thumb, onRemove, onRetry }: { chip: Chip; thumb?: string; onRemove: () => void; onRetry: () => void }) {
  const failed = chip.state === "failed";
  return (
    <li className={`attach-chip is-${chip.state}`} data-attach={chip.state}>
      <span className="attach-chip__pic" aria-hidden="true">
        {thumb ? <img src={thumb} alt="" /> : <Icon name={failed ? "alert" : iconFor(chip.type)} size={22} />}
      </span>
      <span className="attach-chip__text">
        <span className="attach-chip__name user-text">{chip.name}</span>
        {failed ? (
          <span className="attach-chip__line is-bad" role="alert">
            {chip.error ?? "Didn't upload."}
          </span>
        ) : chip.state === "uploading" ? (
          <Progress value={chip.progress} label={`Uploading ${chip.name}`} />
        ) : !canRead(chip.type) ? (
          <span className="attach-chip__line">
            {bytes(chip.size)} · {CANT_READ}
          </span>
        ) : (
          <span className="attach-chip__line">{bytes(chip.size)}</span>
        )}
      </span>
      {failed && chip.file ? (
        <Button size="sm" variant="ghost" icon="retry" act="retry" className="attach-chip__retry" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
      <button type="button" className="icon-btn attach-chip__remove" aria-label={`Remove ${chip.name}`} onClick={onRemove}>
        <Icon name="x" size={18} />
      </button>
    </li>
  );
}
