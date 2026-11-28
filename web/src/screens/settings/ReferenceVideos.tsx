// Settings › Clip making › Skills, the top card "Edit like these" (docs/CONTRACTS.md §57): the owner's reference
// videos, the way he wants his clips edited (format, hook, captions, placement, pacing). Drop several videos on the
// box (it lights up while they are over it) or tap Upload videos and pick several; each goes up the way a logo does
// (a presigned PUT with its progress, then complete), then Clip Factory checks it and lists what it copies. A video
// can be deleted (Undo for a few seconds) and a failed check tried again. The rules are lib/refVideos.ts.
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { api } from "../../api/index.ts";
import { ApiError, friendlyMessage } from "../../api/errors.ts";
import type { RefVideo } from "../../api/types.ts";
import { putFile } from "../../api/upload.ts";
import { DropOverlay } from "../../components/DropOverlay.tsx";
import { Icon } from "../../components/Icon.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { Button, Pill, Progress, Skeleton } from "../../components/ui.tsx";
import { burst, centerOf } from "../../lib/confetti.ts";
import { useFileDrop } from "../../lib/useFileDrop.ts";
import {
  anyChecking,
  mergeRefs,
  putRefBack,
  REF_ACCEPT,
  REF_DROP_WORDS,
  REF_MAX_COUNT,
  REF_POLL_MS,
  REF_REFUSE,
  REF_UNDO_MS,
  refFileCheck,
  refName,
  refRefusal,
  refStatusTone,
  refStatusWord,
  refType,
  sortRefVideos,
  takeRef,
} from "../../lib/refVideos.ts";
import { Apple } from "./parts.tsx";
import "../../styles/ref-videos.css";

interface Uploading {
  id: string;
  name: string;
  progress: number;
}

export function ReferenceVideos() {
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const uploadButton = useRef<HTMLButtonElement>(null);
  const [videos, setVideos] = useState<RefVideo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<Uploading[]>([]);
  const [tries, setTries] = useState(0);
  const list = useRef<RefVideo[] | null>(null);
  const alive = useRef(true);
  const busyCount = useRef(0);
  /** Deleted here with their Undo still open: a read never brings them back. */
  const hidden = useRef(new Set<string>());
  /** Went up here since the last read began: a read that started before them keeps them. */
  const addedHere = useRef<RefVideo[]>([]);
  /** The files of the last drop, so a mixed drop can say why the rest were left out. */
  const dropped = useRef<File[]>([]);

  const set = useCallback((next: RefVideo[] | null) => {
    list.current = next;
    if (alive.current) setVideos(next);
  }, []);

  const read = useCallback(async () => {
    const since = [...addedHere.current];
    const l = await api().listRefVideos();
    addedHere.current = addedHere.current.filter((v) => !since.includes(v));
    set(mergeRefs(l, [...since, ...addedHere.current], hidden.current));
  }, [set]);

  useEffect(() => {
    alive.current = true;
    let current = true;
    read()
      .then(() => current && setError(null))
      .catch(
        (e) =>
          current &&
          (e instanceof ApiError && e.status === 404
            ? set([])
            : setError(friendlyMessage(e))),
      );
    return () => {
      current = false;
      alive.current = false;
    };
  }, [read, set, tries]);

  // Read again every few seconds while a video is being checked.
  const checking = anyChecking(videos);
  useEffect(() => {
    if (!checking) return;
    const t = setInterval(
      () => void read().catch(() => undefined),
      REF_POLL_MS,
    );
    return () => clearInterval(t);
  }, [checking, read]);

  const put = useCallback(
    (v: RefVideo) => {
      addedHere.current = [
        ...addedHere.current.filter((x) => x.refId !== v.refId),
        v,
      ];
      set(
        sortRefVideos([
          ...(list.current ?? []).filter((x) => x.refId !== v.refId),
          v,
        ]),
      );
    },
    [set],
  );

  const send = useCallback(
    async (file: File, tempId: string) => {
      const type = refType(file)!;
      const patch = (p: Partial<Uploading>) =>
        alive.current &&
        setUploading((u) =>
          u.map((x) => (x.id === tempId ? { ...x, ...p } : x)),
        );
      try {
        const up = await api().createRefVideo({
          filename: file.name,
          contentType: type,
          size: file.size,
        });
        await putFile(
          {
            key: up.refId,
            uploadUrl: up.uploadUrl,
            headers: up.headers ?? { "Content-Type": type },
          },
          file,
          (p) => patch({ progress: p }),
        );
        const v = await api().completeRefVideo(up.refId);
        put(v);
        // A video that went up is a win: confetti from the button.
        burst(centerOf(uploadButton.current), 70);
        toastRef.current.success("Uploaded. Checking it now.");
      } catch (e) {
        toastRef.current.error(friendlyMessage(e));
      } finally {
        busyCount.current -= 1;
        if (alive.current)
          setUploading((u) => u.filter((x) => x.id !== tempId));
      }
    },
    [put],
  );

  const add = useCallback(
    (files: readonly File[], refusedBefore: string | null = null) => {
      let refused = refusedBefore;
      for (const file of files) {
        const have = (list.current?.length ?? 0) + busyCount.current;
        const why = refRefusal(file, have);
        if (why) {
          refused ??= why;
          continue;
        }
        busyCount.current += 1;
        const tempId = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
        setUploading((u) => [
          ...u,
          { id: tempId, name: refName(file), progress: 0 },
        ]);
        void send(file, tempId);
      }
      if (refused) toastRef.current.info(refused);
    },
    [send],
  );

  const remove = useCallback(
    (refId: string) => {
      const { list: next, removed } = takeRef(list.current ?? [], refId);
      if (!removed) return;
      hidden.current.add(refId);
      set(next);
      toastRef.current.undo("Video deleted.", {
        ms: REF_UNDO_MS,
        onUndo: () => {
          hidden.current.delete(refId);
          set(putRefBack(list.current ?? [], removed));
        },
        onCommit: () => {
          api()
            .deleteRefVideo(refId)
            .then(() => hidden.current.delete(refId))
            .catch((e) => {
              hidden.current.delete(refId);
              // Already gone is what was wanted.
              if (e instanceof ApiError && e.status === 404) return;
              set(putRefBack(list.current ?? [], removed));
              toastRef.current.error(friendlyMessage(e));
            });
        },
      });
    },
    [set],
  );

  const retry = useCallback(
    async (refId: string) => {
      try {
        put(await api().completeRefVideo(refId));
      } catch (e) {
        toastRef.current.error(friendlyMessage(e));
        return false;
      }
      return true;
    },
    [put],
  );

  // The whole card is the drop box: several videos at once.
  const drop = useFileDrop({
    scope: "element",
    checkFile: refFileCheck,
    maxFiles: REF_MAX_COUNT,
    tooMany: REF_REFUSE.full,
    wrongThing: REF_REFUSE.kind,
    onFiles: (files) => {
      // A mixed drop: the good ones go up, and one line says why the rest did not.
      const bad =
        dropped.current.map((f) => refFileCheck(f)).find((w) => w !== null) ??
        null;
      dropped.current = [];
      add(files, bad);
    },
  });
  const onDrop = (e: DragEvent<HTMLElement>) => {
    dropped.current = Array.from(e.dataTransfer?.files ?? []);
    drop.bind.onDrop?.(e);
  };

  const count = (videos?.length ?? 0) + uploading.length;

  return (
    <div
      className={`apple-panel glass drop-host ref-box${drop.over ? " is-over" : ""}`}
      {...drop.bind}
      onDrop={onDrop}
      data-ref-drop=""
    >
      <Apple
        id="ref-videos"
        wide
        aside={
          count ? (
            <span className="ref-count">{`${count} of ${REF_MAX_COUNT}`}</span>
          ) : null
        }
      >
        <input
          ref={input}
          type="file"
          multiple
          accept={REF_ACCEPT}
          className="sr-only"
          id={`${id}-file`}
          tabIndex={-1}
          aria-label="Reference videos"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            // Cleared, so the same video can be picked again after a delete.
            e.target.value = "";
            if (files.length) add(files);
          }}
        />
        {error ? (
          <p className="callout callout--bad" role="alert">
            <Icon name="alert" size={18} />
            <span>Couldn&apos;t read your videos. </span>
            <button
              type="button"
              className="text-link"
              onClick={() => setTries((n) => n + 1)}
            >
              Try again
            </button>
          </p>
        ) : null}
        {videos === null && !error ? <Skeleton className="line-skel" /> : null}
        {count > 0 ? (
          <ul className="ref-list" aria-label="Your reference videos">
            {uploading.map((u) => (
              <li key={u.id} className="ref-row is-up" data-ref-uploading="">
                <span className="ref-row__thumb" aria-hidden="true">
                  <Icon name="video" size={24} />
                </span>
                <span className="ref-row__main">
                  <span className="ref-row__head">
                    <span className="ref-row__name user-text">{u.name}</span>
                    <Pill tone="neutral">{refStatusWord("uploading")}</Pill>
                  </span>
                  <Progress value={u.progress} label={`Uploading ${u.name}`} />
                </span>
              </li>
            ))}
            {(videos ?? []).map((v) => (
              <RefRow
                key={v.refId}
                video={v}
                onRemove={remove}
                onRetry={retry}
              />
            ))}
          </ul>
        ) : null}
        <div className="ref-add">
          <span className="ref-add__icon" aria-hidden="true">
            <Icon name="film" size={28} />
          </span>
          <span className="ref-add__words">Drop videos here</span>
          <Button
            ref={uploadButton}
            size="lg"
            icon="upload"
            act="upload"
            onClick={() => input.current?.click()}
          >
            Upload videos
          </Button>
        </div>
      </Apple>
      <DropOverlay
        drop={drop}
        scope="element"
        words={REF_DROP_WORDS}
        icon={<Icon name="film" size={40} />}
      />
    </div>
  );
}

/** One reference video: its picture, name and one-word status, a delete, and (when ready) one fold of what it copies. */
function RefRow({
  video: v,
  onRemove,
  onRetry,
}: {
  video: RefVideo;
  onRemove: (refId: string) => void;
  onRetry: (refId: string) => Promise<boolean>;
}) {
  const summary = v.summary ?? [];
  const notYet = v.unsupported ?? [];
  const more =
    v.status === "failed" ||
    (v.status === "ready" && (summary.length > 0 || notYet.length > 0));
  return (
    <li className={`ref-row is-${v.status}`} data-ref-id={v.refId}>
      <span className="ref-row__thumb" aria-hidden="true">
        {v.thumbUrl ? (
          <img src={v.thumbUrl} alt="" draggable={false} />
        ) : (
          <Icon name="video" size={24} />
        )}
      </span>
      <span className="ref-row__main">
        <span className="ref-row__head">
          <span className="ref-row__name user-text">{v.name}</span>
          <Pill
            tone={refStatusTone(v.status)}
            icon={v.status === "ready" ? "check" : undefined}
          >
            {refStatusWord(v.status)}
          </Pill>
        </span>
      </span>
      <button
        type="button"
        className="icon-btn ref-row__remove"
        aria-label={`Delete ${v.name}`}
        onClick={() => onRemove(v.refId)}
      >
        <Icon name="trash" size={18} />
      </button>
      {more ? (
        <div className="ref-row__more">
          {v.status === "failed" ? (
            <span className="ref-row__fail">
              <span className="ref-row__error">
                {v.error ?? "That didn't work. Tap Try again."}
              </span>
              <Button
                size="sm"
                icon="retry"
                act="retry"
                onClick={() => onRetry(v.refId)}
              >
                Try again
              </Button>
            </span>
          ) : null}
          {v.status === "ready" ? (
            <details className="ref-fold">
              <summary className="ref-fold__q">
                <Icon name="eye" size={18} />
                <span>What it copies</span>
                <Icon
                  name="chevronRight"
                  size={18}
                  className="icon ref-fold__chev act-turn"
                />
              </summary>
              <div className="ref-fold__body">
                {summary.length ? (
                  <ul className="ref-lines">
                    {summary.map((line) => (
                      <li key={line}>
                        <Icon name="check" size={16} />
                        <span>{line}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {notYet.length ? (
                  <>
                    <span className="ref-lines__label">Not yet</span>
                    <ul className="ref-lines ref-lines--no">
                      {notYet.map((line) => (
                        <li key={line}>
                          <Icon name="minus" size={16} />
                          <span>{line}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </div>
            </details>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
