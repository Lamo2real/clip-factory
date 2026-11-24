// Clips Funded › References: the list and the ways in (docs/CONTRACTS.md §45.16.7, §45.28, §45.40). Videos the owner
// likes: uploaded, dropped anywhere on the page, or pasted as a link that Clips Funded's own runtime fetches; each
// opens its own page. A link row says "Getting it…" until the video is here (the list checks every 3 s), then it
// cheers and opens, like a finished upload; one that did not arrive opens too, where its page says why and what to do.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DropOverlay } from "../../../components/DropOverlay.tsx";
import { A } from "../../../components/ui.tsx";
import { usePoll } from "../../../lib/hooks.ts";
import { useFileDrop } from "../../../lib/useFileDrop.ts";
import { storiesApi } from "../../api/client.ts";
import { SITE_NAME, siteOf } from "../../api/refLinks.ts";
import { cx, MediaRow } from "../../glass/index.ts";
import { storiesGoLater } from "../../pane.tsx";
import type { ReferenceVideo } from "../../api/types.ts";
import { storiesHref } from "../../routes.ts";
import { referencesChanged } from "../../studio/hooks.ts";
import { Btn, cheer, Chip, clock, Empty, Icon, Progress, sentence, size, UndoBar, Waiting } from "../kit.tsx";
import { modelLabel, useModels } from "../models.ts";
import { refusedDelete, undoDelete, usePendingDelete } from "../undo.ts";
import { videoProblem } from "../upload.ts";
import { RefLinkBox, usePagePaste, useRefLink } from "./RefLinkBox.tsx";
import { dismissUpload, retryUpload, startUpload, stopUpload, useUploads, type UploadJob } from "./uploads.ts";

export const REF_STATUS: Record<ReferenceVideo["status"], { text: string; tone: "sun" | "coral" | "mint" | "sky" }> = {
  uploading: { text: "Uploading", tone: "sky" },
  fetching: { text: "Getting it…", tone: "sky" },
  fetch_failed: { text: "Didn't arrive", tone: "coral" },
  ready: { text: "Ready to analyze", tone: "sun" },
  analyzing: { text: "Analyzing…", tone: "sky" },
  analyzed: { text: "Analyzed", tone: "mint" },
  failed: { text: "Needs another try", tone: "coral" },
};

/** A status's chip; one this bundle does not know (a newer API, a cached old bundle) shows as `failed`, never a crash. */
export function statusOf(status: string): { text: string; tone: "sun" | "coral" | "mint" | "sky" } {
  return REF_STATUS[status as ReferenceVideo["status"]] ?? REF_STATUS.failed;
}

/** "From TikTok" for a reference made from a link, else null. */
export function fromLine(link: string | null | undefined): string | null {
  const site = link ? siteOf(link) : null;
  return site ? `From ${SITE_NAME[site]}` : null;
}

/** The most videos one drop or paste starts. */
export const DROP_MAX = 5;
export const DROP_TOO_MANY = "Up to 5 videos at once. Drop the rest after.";
export const DROP_WORDS = { file: "Drop your video here", link: "Drop the link here", either: "Drop it here" };

export function RefList({ ws }: { ws: string }) {
  const models = useModels(ws);
  const [list, setList] = useState<ReferenceVideo[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const pageRef = useRef<HTMLElement>(null);
  /** Clips Funded's own root: the page's drop layer goes there, so its --st-* glass applies. */
  const [layerHost, setLayerHost] = useState<Element | null>(null);
  const { pending, version } = usePendingDelete("reference");
  const uploads = useUploads(ws);
  // Uploads that had finished before this list opened: they are in the list it loads, with no cheer.
  const seen = useRef<Set<string> | null>(null);
  seen.current ??= new Set(uploads.filter((u) => u.status === "done").map((u) => u.key));
  /** Link references seen on their way while this list is open: the one that arrives cheers and opens. */
  const onTheWay = useRef(new Set<string>());

  useLayoutEffect(() => setLayerHost(pageRef.current?.closest(".stories-app") ?? null), []);

  const link = useRefLink(ws, (ref) => {
    onTheWay.current.add(ref.refId);
    setList((prev) => [ref, ...(prev ?? []).filter((r) => r.refId !== ref.refId)]);
  });

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

  // A link on its way: the list looks again every 3 s until it is here (or did not arrive).
  usePoll(
    async () => {
      setList(await storiesApi().listReferences(ws));
    },
    !!list?.some((r) => r.status === "fetching"),
    3000,
  );

  // A link's video arriving while this list is open: a cheer, and its own page opens (as a finished upload does). One
  // that did not arrive opens its page too, with no cheer: the reason and the one thing to do are there (never a coral
  // chip alone).
  useEffect(() => {
    if (!list) return;
    let arrived: ReferenceVideo | null = null;
    let missed: ReferenceVideo | null = null;
    for (const r of list) {
      if (r.status === "fetching") onTheWay.current.add(r.refId);
      else if (onTheWay.current.delete(r.refId)) {
        if (r.status === "ready") arrived ??= r;
        else if (r.status === "fetch_failed") missed ??= r;
      }
    }
    const open = arrived ?? missed;
    if (!open) return;
    referencesChanged();
    if (arrived) cheer(undefined);
    storiesGoLater(storiesHref({ name: "reference", refId: open.refId }));
  }, [list]);

  // An upload finishing while this list is open (also one started before the owner left and came back): it joins
  // the list as it is now, with a cheer, and its own page opens.
  useEffect(() => {
    for (const u of uploads) {
      if (u.status !== "done" || !u.reference || seen.current!.has(u.key)) continue;
      seen.current!.add(u.key);
      const ref = u.reference;
      setList((prev) => [ref, ...(prev ?? []).filter((r) => r.refId !== ref.refId)]);
      cheer(undefined);
      // After the wait (the upload): never while Clip Factory is on screen; it opens once Lamo Stories is back (§45.35 D17).
      storiesGoLater(storiesHref({ name: "reference", refId: ref.refId }));
      return;
    }
  }, [uploads]);

  /** Videos picked, dropped or pasted: each one passed the same check, so each starts its upload at once. */
  function send(files: File[]) {
    link.say(null);
    for (const f of files) startUpload(ws, f);
  }

  /** The picker's video: a wrong one is refused in the card's line (never a failed upload row). */
  function pick(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    const bad = videoProblem(file);
    if (bad) return link.say(bad);
    send([file]);
  }

  // Drop a video, or a link, anywhere on the page (§45.40): a video starts its upload, a link fills the box.
  const drop = useFileDrop({ scope: "page", checkFile: videoProblem, maxFiles: DROP_MAX, tooMany: DROP_TOO_MANY, links: true, onFiles: send, onLink: link.fill });
  // A refused drop's line stays in the card's line until the box changes (the pill only shows it for a moment).
  const say = link.say;
  useEffect(() => {
    if (drop.refusals && drop.refused) say(drop.refused);
  }, [drop.refusals, drop.refused, say]);
  // A paste anywhere on the page does the same (never into another field, never into Ask).
  usePagePaste({ enabled: true, box: link.box, checkFile: videoProblem, maxFiles: DROP_MAX, onFiles: send, onLink: link.fill, onRefused: link.say });

  const shown = (list ?? []).filter((r) => !(pending && pending.id === r.refId) && !uploads.some((u) => u.droppedRefId === r.refId || (u.refId === r.refId && u.status !== "done")));
  const refused = refusedDelete("reference");
  // One main action at a time: "Upload a video", except while the box holds a video link (then Add).
  const linkReady = link.look.kind === "ok";

  return (
    <section className="st-page st-refs" ref={pageRef}>
      <header className="st-chat-head st-plate">
        <div className="st-chat-head__text">
          <h1 className="st-chat-head__title st-display">Reference videos</h1>
          <p className="st-chat-head__lede">Upload a video you like. We learn its tricks, never copy it.</p>
        </div>
      </header>

      <div className={cx("st-ref-drop st-glass st-glass--hero", drop.over && drop.over !== "busy" && "is-over")}>
        <span className="st-ref-drop__icon" aria-hidden="true">
          <Icon name="film" size={32} />
        </span>
        <div className="st-ref-drop__text">
          <p className="st-ref-drop__title">Add a reference video</p>
          <p className="st-ref-drop__line">Drop a video or paste its link. Up to 10 minutes.</p>
        </div>
        <div className="st-ref-add">
          <div className="st-ref-add__row">
            <RefLinkBox link={link} />
            <Btn main={!linkReady} quiet={linkReady} icon="upload" onClick={() => input.current?.click()}>
              Upload a video
            </Btn>
          </div>
          <p className="st-ref-line" role="status" aria-live="polite">
            {link.line}
          </p>
        </div>
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
      <DropOverlay drop={drop} scope="page" look="stories" host={layerHost} words={DROP_WORDS} />

      {uploads.length ? (
        <ul className="st-ref-uploads" aria-label="Uploads">
          {uploads.map((u) => (
            <UploadRow key={u.key} u={u} onRetry={() => retryUpload(u.key)} />
          ))}
        </ul>
      ) : null}

      {refused ? (
        <p className="st-chat-note st-chat-note--bad st-plate" role="alert">
          {refused}
        </p>
      ) : null}

      {problem ? (
        <Empty
          card
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
        <Waiting plate label="Finding your reference videos…" />
      ) : shown.length ? (
        <ul className="st-ref-grid" aria-label="Your reference videos">
          {shown.map((r) => (
            <li key={r.refId}>
              <A href={storiesHref({ name: "reference", refId: r.refId })} className="st-ref-card st-glass">
                <MediaRow
                  thumb={
                    <span className="st-ref-card__tile" aria-hidden="true">
                      <Icon name="clapper" size={28} />
                    </span>
                  }
                  title={r.title}
                  meta={[fromLine(r.link), r.durationSec ? clock(r.durationSec) : null, r.bytes ? size(r.bytes) : null, r.analyzedWith ? `Analyzed with ${modelLabel(models.models, r.analyzedWith.model)}` : null].filter(Boolean).join(" · ")}
                  controls={<Chip tone={statusOf(r.status).tone}>{statusOf(r.status).text}</Chip>}
                />
              </A>
            </li>
          ))}
        </ul>
      ) : !uploads.length ? (
        <Empty card title="No reference videos yet">
          Upload one to see why it works, shot by shot.
        </Empty>
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
    <li className={`st-ref-upload st-glass is-${u.status}`}>
      <div className="st-media">
        <span className="st-media__thumb st-ref-upload__thumb" aria-hidden="true">
          <Icon name="film" size={28} />
        </span>
        <div className="st-media__text st-ref-upload__text">
          <span className="st-media__title st-ref-upload__title">{u.title}</span>
          <span className="st-media__meta st-ref-upload__line" role={u.status === "failed" ? "alert" : undefined}>
            {line}
          </span>
        </div>
        {u.status === "checking" || u.status === "uploading" || u.status === "finishing" ? (
          <div className="st-media__bar">
            <Progress value={u.fraction} label={`Uploading ${u.title}`} />
          </div>
        ) : null}
        <div className="st-media__controls st-ref-upload__buttons">
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
      </div>
    </li>
  );
}
