// Lamo Stories › References: the list and the upload (docs/CONTRACTS.md §45.16.7, §45.28). Videos the owner likes,
// uploaded as files (links to other people's videos are not downloaded), each opening its own page.
import { useEffect, useRef, useState, type DragEvent } from "react";
import { A } from "../../../components/ui.tsx";
import { navigate } from "../../../lib/router.ts";
import { storiesApi } from "../../api/client.ts";
import type { ReferenceVideo } from "../../api/types.ts";
import { storiesHref } from "../../routes.ts";
import { Btn, cheer, Chip, clock, Empty, Icon, Progress, sentence, size, UndoBar, Waiting } from "../kit.tsx";
import { modelLabel, useModels } from "../models.ts";
import { refusedDelete, undoDelete, usePendingDelete } from "../undo.ts";
import { dismissUpload, retryUpload, startUpload, stopUpload, useUploads, type UploadJob } from "./uploads.ts";

export const REF_STATUS: Record<ReferenceVideo["status"], { text: string; tone: "sun" | "coral" | "mint" | "sky" }> = {
  uploading: { text: "Uploading", tone: "sky" },
  ready: { text: "Ready to analyze", tone: "sun" },
  analyzing: { text: "Analyzing…", tone: "sky" },
  analyzed: { text: "Analyzed", tone: "mint" },
  failed: { text: "Needs another try", tone: "coral" },
};

export function RefList({ ws }: { ws: string }) {
  const models = useModels(ws);
  const [list, setList] = useState<ReferenceVideo[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const here = useRef(true);
  const { pending, version } = usePendingDelete("reference");
  const uploads = useUploads(ws);

  useEffect(() => {
    here.current = true;
    return () => {
      here.current = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    storiesApi()
      .listReferences(ws)
      .then((l) => {
        if (!live) return;
        setList(l);
        setProblem(null);
      })
      .catch((e: unknown) => live && setProblem(sentence(e, "Your reference videos did not load. Try again.")));
    return () => {
      live = false;
    };
  }, [ws, round, version]);

  const done = (ref: ReferenceVideo) => {
    setList((prev) => [ref, ...(prev ?? []).filter((r) => r.refId !== ref.refId)]);
    if (!here.current) return;
    cheer(undefined);
    navigate(storiesHref({ name: "reference", refId: ref.refId }));
  };

  function pick(files: FileList | null) {
    const file = files?.[0];
    if (file) startUpload(ws, file, done);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDrag(false);
    pick(e.dataTransfer.files);
  }

  const shown = (list ?? []).filter((r) => !(pending && pending.id === r.refId) && !uploads.some((u) => u.refId === r.refId && u.status !== "done"));
  const refused = refusedDelete("reference");

  return (
    <section className="st-page st-refs">
      <header className="st-chat-head">
        <div className="st-chat-head__text">
          <h1 className="st-chat-head__title">Reference videos</h1>
          <p className="st-chat-head__lede">Upload a video you like. The video analysis agent studies its shots, timing and jokes, so your videos can borrow the ideas. It never copies the characters or the footage.</p>
        </div>
      </header>

      <div
        className={`st-ref-drop${drag ? " is-over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
      >
        <Icon name="film" size={36} />
        <div className="st-ref-drop__text">
          <p className="st-ref-drop__title">Add a reference video</p>
          <p className="st-ref-drop__line">MP4 or MOV, up to 2 GB and 10 minutes. Found one online? Save it to your device first, then upload the video file.</p>
        </div>
        <Btn main icon="upload" onClick={() => input.current?.click()}>
          Upload a video
        </Btn>
        <input
          ref={input}
          type="file"
          accept="video/mp4,video/quicktime,.mp4,.mov,.m4v"
          hidden
          onChange={(e) => {
            pick(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {uploads.length ? (
        <ul className="st-ref-uploads" aria-label="Uploads">
          {uploads.map((u) => (
            <UploadRow key={u.key} u={u} onRetry={() => retryUpload(u.key, done)} />
          ))}
        </ul>
      ) : null}

      {refused ? (
        <p className="st-chat-note st-chat-note--bad" role="alert">
          {refused}
        </p>
      ) : null}

      {problem ? (
        <Empty
          mood="oops"
          title="Your reference videos did not load"
          action={
            <Btn main icon="retry" onClick={() => setRound((n) => n + 1)}>
              Try again
            </Btn>
          }
        >
          {problem}
        </Empty>
      ) : list === null ? (
        <Waiting label="Finding your reference videos…" />
      ) : shown.length ? (
        <ul className="st-ref-grid" aria-label="Your reference videos">
          {shown.map((r) => (
            <li key={r.refId}>
              <A href={storiesHref({ name: "reference", refId: r.refId })} className="st-ref-card">
                <span className="st-ref-card__tile" aria-hidden="true">
                  <Icon name="clapper" size={30} />
                </span>
                <span className="st-ref-card__text">
                  <span className="st-ref-card__title">{r.title}</span>
                  <span className="st-ref-card__line">
                    {[r.durationSec ? clock(r.durationSec) : null, r.bytes ? size(r.bytes) : null, r.analyzedWith ? `Analyzed with ${modelLabel(models.models, r.analyzedWith.model)}` : null].filter(Boolean).join(" · ")}
                  </span>
                  <Chip tone={REF_STATUS[r.status].tone}>{REF_STATUS[r.status].text}</Chip>
                </span>
              </A>
            </li>
          ))}
        </ul>
      ) : !uploads.length ? (
        <Empty title="No reference videos yet">Upload a short video you love. You'll see what makes it work, shot by shot.</Empty>
      ) : null}

      {pending ? <UndoBar text={pending.text} onUndo={() => undoDelete()} /> : null}
    </section>
  );
}

function UploadRow({ u, onRetry }: { u: UploadJob; onRetry: () => void }) {
  const pct = Math.round(u.fraction * 100);
  const line =
    u.status === "checking"
      ? "Checking the video…"
      : u.status === "uploading"
        ? `${pct}%${u.parts > 1 ? ` · part ${Math.min(u.parts, u.partsDone + 1)} of ${u.parts}` : ""} · ${size(u.bytes)}`
        : u.status === "finishing"
          ? "Almost there…"
          : u.status === "done"
            ? "Uploaded!"
            : u.status === "stopped"
              ? "Stopped. Nothing was kept."
              : (u.problem ?? "The upload stopped before it finished.");
  return (
    <li className={`st-ref-upload is-${u.status}`}>
      <div className="st-ref-upload__text">
        <span className="st-ref-upload__title">{u.title}</span>
        <span className="st-ref-upload__line" role={u.status === "failed" ? "alert" : undefined}>
          {line}
        </span>
      </div>
      {u.status === "checking" || u.status === "uploading" || u.status === "finishing" ? <Progress value={u.fraction} label={`Uploading ${u.title}`} /> : null}
      <div className="st-ref-upload__buttons">
        {u.status === "checking" || u.status === "uploading" ? (
          <Btn quiet icon="stop" onClick={() => stopUpload(u.key)}>
            Stop
          </Btn>
        ) : null}
        {u.status === "failed" && u.retry ? (
          <Btn main icon="retry" onClick={onRetry}>
            Try again
          </Btn>
        ) : null}
        {u.status === "failed" || u.status === "stopped" ? (
          <Btn quiet icon="close" label={`Hide ${u.title}`} onClick={() => dismissUpload(u.key)} />
        ) : null}
      </div>
    </li>
  );
}
