// The logo library of the CR editor (docs/CONTRACTS.md §53 C4): the owner's logos as tiles to pick, "Add a logo" (drop,
// paste or pick), and a delete with Undo. A logo goes up the way a note's file does: ask for a presigned PUT, PUT the
// file (with its progress), then say it is complete; the server checks the first bytes and the size.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import type { Logo } from "../../api/types.ts";
import { putFile } from "../../api/upload.ts";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { Progress, Skeleton } from "../../components/ui.tsx";
import { LOGO_ACCEPT, LOGO_UNDO_MS, logoName, logoRefusal, logoType, putLogoBack, takeLogo, W } from "../../lib/crOverlay.ts";

export interface UploadingLogo {
  id: string;
  name: string;
  progress: number;
  /** A small local picture while it goes up (absent where the browser cannot make one). */
  thumb?: string;
}

export interface Logos {
  /** null while the library is read. */
  logos: Logo[] | null;
  /** The read failed (one sentence). */
  error: string | null;
  uploading: UploadingLogo[];
  /** Adds pictures (picker, paste or drop): checks each, says the first refusal, uploads the rest. */
  add(files: readonly File[]): void;
  /** Deletes a logo: its tile leaves at once and an Undo toast brings it back until the time is up. */
  remove(logoId: string): void;
  /** A logo that came from elsewhere (a campaign's own) joins the library. */
  put(logo: Logo): void;
  reload(): void;
}

interface Hooks {
  /** A picture of the owner's went up: it is picked at once. */
  onAdded?: (logo: Logo) => void;
  /** A logo was deleted: if it was the picked one, the editor lets go of it. */
  onRemoved?: (logoId: string) => void;
}

export function useLogos({ onAdded, onRemoved }: Hooks = {}): Logos {
  const toast = useToast();
  const [logos, setLogos] = useState<Logo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<UploadingLogo[]>([]);
  const [tries, setTries] = useState(0);
  const alive = useRef(true);
  const list = useRef<Logo[] | null>(null);
  const busyCount = useRef(0);
  const hooks = useRef<Hooks>({});
  hooks.current = { onAdded, onRemoved };
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const set = useCallback((next: Logo[] | null) => {
    list.current = next;
    if (alive.current) setLogos(next);
  }, []);

  useEffect(() => {
    alive.current = true;
    let current = true;
    api()
      .listLogos()
      .then((l) => {
        if (!current) return;
        setError(null);
        // A logo added or put here while the list was being read stays.
        const mine = list.current ?? [];
        set([...l, ...mine.filter((m) => !l.some((x) => x.logoId === m.logoId))]);
      })
      .catch((e) => current && setError(friendlyMessage(e)));
    return () => {
      current = false;
      alive.current = false;
    };
  }, [set, tries]);

  const reload = useCallback(() => {
    setError(null);
    setTries((n) => n + 1);
  }, []);

  const send = useCallback(
    async (file: File, tempId: string) => {
      const type = logoType(file);
      const name = logoName(file);
      const patch = (p: Partial<UploadingLogo>) => alive.current && setUploading((u) => u.map((x) => (x.id === tempId ? { ...x, ...p } : x)));
      try {
        const up = await api().createLogoUpload({ filename: name, contentType: type, size: file.size });
        await putFile({ key: up.logoId, uploadUrl: up.uploadUrl, headers: up.headers ?? { "Content-Type": type } }, file, (p) => patch({ progress: p }));
        const logo = await api().completeLogo(up.logoId);
        set([...(list.current ?? []).filter((l) => l.logoId !== logo.logoId), logo]);
        hooks.current.onAdded?.(logo);
      } catch (e) {
        toastRef.current.error(friendlyMessage(e));
      } finally {
        busyCount.current -= 1;
        if (alive.current) {
          setUploading((u) => {
            const gone = u.find((x) => x.id === tempId);
            if (gone?.thumb) {
              try {
                URL.revokeObjectURL(gone.thumb);
              } catch {
                // Already gone.
              }
            }
            return u.filter((x) => x.id !== tempId);
          });
        }
      }
    },
    [set],
  );

  const add = useCallback(
    (files: readonly File[]) => {
      let refused: string | null = null;
      for (const file of files) {
        const have = (list.current?.length ?? 0) + busyCount.current;
        const why = logoRefusal(file, have);
        if (why) {
          refused ??= why;
          continue;
        }
        busyCount.current += 1;
        const tempId = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
        let thumb: string | undefined;
        try {
          if (typeof URL.createObjectURL === "function") thumb = URL.createObjectURL(file);
        } catch {
          thumb = undefined;
        }
        setUploading((u) => [...u, { id: tempId, name: logoName(file), progress: 0, thumb }]);
        void send(file, tempId);
      }
      if (refused) toastRef.current.info(refused);
    },
    [send],
  );

  const remove = useCallback(
    (logoId: string) => {
      const { list: next, removed } = takeLogo(list.current ?? [], logoId);
      if (!removed) return;
      set(next);
      hooks.current.onRemoved?.(logoId);
      toastRef.current.undo("Logo deleted.", {
        ms: LOGO_UNDO_MS,
        onUndo: () => set(putLogoBack(list.current ?? [], removed)),
        onCommit: () => {
          api()
            .deleteLogo(logoId)
            .catch((e) => {
              set(putLogoBack(list.current ?? [], removed));
              toastRef.current.error(friendlyMessage(e));
            });
        },
      });
    },
    [set],
  );

  const put = useCallback(
    (logo: Logo) => {
      set([...(list.current ?? []).filter((l) => l.logoId !== logo.logoId), logo]);
    },
    [set],
  );

  return { logos, error, uploading, add, remove, put, reload };
}

/** The tiles: pick one (tap it again to let go), delete one, or add one. */
export function LogoLibrary({ lib, picked, onPick }: { lib: Logos; picked: string | null; onPick: (logoId: string | null) => void }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="cr-logos" data-help="cr-logos">
      <span className="field__label" id={`${id}-l`}>
        {W.logo}
      </span>
      {lib.error ? (
        <p className="callout callout--bad" role="alert">
          <Icon name="alert" size={18} />
          <span>Couldn&apos;t read your logos. </span>
          <button type="button" className="text-link" onClick={lib.reload}>
            Try again
          </button>
        </p>
      ) : null}
      {lib.logos === null && !lib.error ? <Skeleton className="line-skel" /> : null}
      <ul className="cr-logos__grid" aria-labelledby={`${id}-l`}>
        {(lib.logos ?? []).map((l) => (
          <li key={l.logoId} className="cr-logo">
            <button type="button" className={`cr-logo__pick${picked === l.logoId ? " is-on" : ""}`} aria-pressed={picked === l.logoId} aria-label={l.name} onClick={() => onPick(picked === l.logoId ? null : l.logoId)}>
              <img src={l.url} alt="" draggable={false} />
            </button>
            <button type="button" className="icon-btn cr-logo__remove" aria-label={`Delete ${l.name}`} onClick={() => lib.remove(l.logoId)}>
              <Icon name="trash" size={16} />
            </button>
          </li>
        ))}
        {lib.uploading.map((u) => (
          <li key={u.id} className="cr-logo cr-logo--up" data-logo-uploading="">
            <span className="cr-logo__pick">{u.thumb ? <img src={u.thumb} alt="" draggable={false} /> : <Icon name="image" size={22} />}</span>
            <Progress value={u.progress} label={`Uploading ${u.name}`} />
          </li>
        ))}
        <li className="cr-logo">
          <label className="cr-logo__add" data-help="cr-add-logo">
            <input
              ref={input}
              type="file"
              multiple
              accept={LOGO_ACCEPT}
              className="sr-only"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                // Cleared, so the same picture can be picked again after a delete.
                e.target.value = "";
                if (files.length) lib.add(files);
              }}
            />
            <Icon name="plus" size={22} />
            <span className="cr-logo__add-title">{W.addLogo}</span>
            <span className="cr-logo__add-hint">{W.dropPastePick}</span>
          </label>
        </li>
      </ul>
    </div>
  );
}
