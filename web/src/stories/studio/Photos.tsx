// A vehicle's photos for "Design with AI" (docs/CONTRACTS.md §45.42, §45.47): one strip per side, "Outside" (front,
// side, back, up to 6) and "Inside" (seats and dashboard, up to 4), 8 in all. Photos come by drag and drop, by paste
// (Cmd/Ctrl+V: on the strip, or anywhere on the page for the strip the owner last used) or by "Add photos". Each goes
// the same way as today's "Add a picture": the same type and size rules (References.fileProblem: PNG, JPEG or WebP, at
// most 10 MB), designUpload, then straight to storage with a presigned PUT (ws/{u}/{w}/design/), at most 3 at once,
// with a thumbnail from the file itself. Each photo keeps its side. A photo that did not send says "Tap to try again".
// Drops go through the shared drop hook (lib/useFileDrop.ts, §45.40.1), which hands every dropped file to the same
// add() as "Add photos" and a paste, so a drop, a paste and the picker say the same about each file.
import "../styles/sd-cars.css";
import { useEffect, useId, useRef, useState, type ClipboardEvent as ReactClipboardEvent } from "react";
import { putFile } from "../../api/upload.ts";
import { filesFrom } from "../../features/help/pictures.ts";
import { OWN_DROP_SELECTOR, useFileDrop } from "../../lib/useFileDrop.ts";
import { storiesApi } from "../api/client.ts";
import type { PhotoSide } from "../api/types.ts";
import { Notice, ProgressBar } from "./kit.tsx";
import { fileProblem } from "./References.tsx";

export interface Photo {
  key: string;
  assetId: string | null;
  url: string;
  state: "sending" | "ready" | "failed";
  file: File;
  /** which strip it is in (§45.47); left out = "outside" */
  side?: PhotoSide;
}

/** At most this many photos send at once. */
const AT_ONCE = 3;

/** The photos still on their way, by key (the asset id once sent, null when it did not): a panel closed while one
 * sends keeps it sending, and the panel opened again shows how it ended instead of sending it again. */
const inflight = new Map<string, Promise<string | null>>();

let seq = 0;

/** The photos' own sentence for a file that cannot be one (the same rules as References.fileProblem). */
function photoProblem(f: File): string | null {
  const bad = fileProblem(f);
  if (!bad) return null;
  return /too big/i.test(bad) ? "That photo is too big. Pick one under 10 MB." : "Pick a PNG, JPEG or WebP picture.";
}

/** The pictures a paste holds (a copied photo or a screenshot), or none. */
function pasted(data: DataTransfer | null): File[] {
  return filesFrom(data).filter((f) => f.type.startsWith("image/") || !f.type);
}

export function Photos({
  ws,
  max,
  photos,
  onChange,
  label,
  hint,
  side,
  tooMany: tooManyLine,
  noun = "photo",
  catchPaste = false,
}: {
  ws: string;
  max: number;
  photos: Photo[];
  onChange: (next: Photo[]) => void;
  label: string;
  hint: string;
  /** the strip's side: each new photo keeps it */
  side?: PhotoSide;
  /** what a full strip says (default "Up to {max} photos. Remove one first.") */
  tooMany?: string;
  /** how a photo is named to screen readers ("photo", "inside photo") */
  noun?: string;
  /** a paste anywhere on the page (not in another drop place) comes here */
  catchPaste?: boolean;
}) {
  const id = useId();
  /** The newest list: set on each render and on each change made here, so uploads that end together keep each other's news. */
  const list = useRef(photos);
  list.current = photos;
  const [problem, setProblem] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const running = useRef(0);
  const queue = useRef<string[]>([]);
  const live = useRef(true);
  const change = useRef(onChange);
  change.current = onChange;
  const full = photos.length >= max;
  const tooMany = tooManyLine ?? `Up to ${max} photos. Remove one first.`;
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);

  const commit = (next: Photo[]) => {
    list.current = next;
    change.current(next);
  };
  const patch = (key: string, p: Partial<Photo>) => commit(list.current.map((x) => (x.key === key ? { ...x, ...p } : x)));
  const here = (key: string) => list.current.some((p) => p.key === key);

  const settle = (key: string, assetId: string | null) => {
    if (!live.current || !here(key)) return;
    if (assetId) return patch(key, { assetId, state: "ready" });
    patch(key, { state: "failed" });
    setProblem("That photo didn't send. Tap it to try again.");
  };

  useEffect(() => {
    live.current = true;
    // Opened again: a photo that was still sending shows how it ends; one that never started (it was waiting its turn
    // when the panel closed) is "Tap to try again".
    for (const p of list.current) {
      if (p.state !== "sending") continue;
      const on = inflight.get(p.key);
      if (on) void on.then((assetId) => settle(p.key, assetId));
      else patch(p.key, { state: "failed" });
    }
    return () => {
      live.current = false;
      queue.current = [];
    };
    // Only on mount and unmount (patch and settle read the newest list through refs).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function send(photo: Photo) {
    const on = (async () => {
      try {
        const target = await storiesApi().designUpload(ws, { filename: photo.file.name, contentType: photo.file.type, size: photo.file.size });
        await putFile({ key: target.assetId, uploadUrl: target.uploadUrl, headers: target.headers }, photo.file, (n) => {
          if (live.current) setProgress((m) => ({ ...m, [photo.key]: n }));
        });
        return target.assetId;
      } catch {
        return null;
      }
    })();
    inflight.set(photo.key, on);
    const assetId = await on;
    inflight.delete(photo.key);
    settle(photo.key, assetId);
  }

  function pump() {
    while (live.current && running.current < AT_ONCE && queue.current.length) {
      const photo = list.current.find((p) => p.key === queue.current[0]);
      queue.current.shift();
      if (!photo) continue;
      running.current += 1;
      void send(photo).finally(() => {
        running.current -= 1;
        pump();
      });
    }
  }

  function add(files: File[]) {
    setProblem(null);
    const next = [...list.current];
    let bad: string | null = null;
    for (const f of files) {
      const why = photoProblem(f);
      if (why) {
        bad = why;
        continue;
      }
      if (next.length >= max) {
        bad = tooMany;
        continue;
      }
      seq += 1;
      const key = `photo-${seq}`;
      next.push({ key, assetId: null, url: typeof URL.createObjectURL === "function" ? URL.createObjectURL(f) : "", state: "sending", file: f, ...(side ? { side } : {}) });
      queue.current.push(key);
    }
    if (next.length !== list.current.length) commit(next);
    if (bad) setProblem(bad);
    pump();
  }

  function retry(key: string) {
    setProblem(null);
    patch(key, { state: "sending" });
    setProgress((m) => ({ ...m, [key]: 0 }));
    queue.current.push(key);
    pump();
  }

  function remove(key: string) {
    setProblem(null);
    const gone = list.current.find((p) => p.key === key);
    if (gone?.url.startsWith("blob:")) URL.revokeObjectURL(gone.url);
    queue.current = queue.current.filter((k) => k !== key);
    commit(list.current.filter((p) => p.key !== key));
  }

  // Every dropped file goes to add(), which takes the pictures that fit and says why any other cannot be a photo (the
  // picker's own rules and words), so the drop zone checks nothing itself and never cuts a drop short.
  const drop = useFileDrop({ scope: "element", checkFile: () => null, maxFiles: Number.POSITIVE_INFINITY, onFiles: add });
  const shown = problem ?? drop.refused;

  // A paste (Cmd/Ctrl+V) goes to add() too: on the strip itself, or (catchPaste) anywhere else on the page that is not
  // another drop place. React's own handler (on the strip) runs first and marks the paste as taken.
  const adder = useRef(add);
  adder.current = add;
  const onPaste = (e: ReactClipboardEvent) => {
    const files = pasted(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    adder.current(files);
  };
  useEffect(() => {
    if (!catchPaste) return;
    const take = (e: ClipboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.target instanceof Element && e.target.closest(OWN_DROP_SELECTOR)) return;
      const files = pasted(e.clipboardData);
      if (!files.length) return;
      e.preventDefault();
      adder.current(files);
    };
    document.addEventListener("paste", take);
    return () => document.removeEventListener("paste", take);
  }, [catchPaste]);

  return (
    <div className="st-s-field st-s-photos">
      <span className="st-s-field__label" id={`${id}-l`}>
        {label}
      </span>
      <div className={`st-s-photos__zone${drop.over ? " is-over" : ""}`} role="group" aria-labelledby={`${id}-l`} aria-describedby={`${id}-h`} {...drop.bind} onPaste={onPaste}>
        {photos.length ? (
          <ul className="st-s-photos__list">
            {photos.map((p, i) => {
              const pic = p.url ? <img src={p.url} alt={`${Noun} ${i + 1}`} width={72} height={72} /> : <span className="st-s-photos__noimg" role="img" aria-label={`${Noun} ${i + 1}`} />;
              return (
                <li key={p.key} className={`st-s-photos__item is-${p.state}`}>
                  {p.state === "failed" ? (
                    <button type="button" className="st-s-photos__retry" aria-label={`${Noun} ${i + 1} didn't send. Tap to try again`} onClick={() => retry(p.key)}>
                      {pic}
                      <span className="st-s-photos__again" aria-hidden="true">
                        Tap to try again
                      </span>
                    </button>
                  ) : (
                    <span className="st-s-photos__pic">{pic}</span>
                  )}
                  {p.state === "sending" ? <ProgressBar value={progress[p.key] ?? 0} label={`Sending ${noun} ${i + 1}`} /> : null}
                  <button type="button" className="st-s-iconbtn st-s-photos__remove" aria-label={`Remove ${noun} ${i + 1}`} onClick={() => remove(p.key)}>
                    <span aria-hidden="true">×</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
        <span className="st-s-photos__drop">{drop.over ? "Let go to add" : "Drop photos here"}</span>
        <span className="st-s-photos__add">
          {/* Never disabled: a full strip still takes the tap or the key and says why (aria-disabled). */}
          <input
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp"
            className="st-s-sr"
            id={`${id}-f`}
            aria-disabled={full || undefined}
            onClick={(e) => {
              if (!full) return;
              e.preventDefault();
              setProblem(tooMany);
            }}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (files.length) add(files);
            }}
          />
          <label htmlFor={`${id}-f`} className="st-btn" aria-disabled={full || undefined}>
            Add photos
          </label>
        </span>
        <span className="st-s-field__hint" id={`${id}-h`}>
          {hint}
        </span>
      </div>
      {shown ? <Notice tone="bad">{shown}</Notice> : null}
    </div>
  );
}
