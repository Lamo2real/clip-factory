// Lamo Stories › Library (docs/CONTRACTS.md §45.12, §45.16.7): only this workspace's files, never Lamo Clips' (that
// Library reads CLIP# items only). Tabs: Projects (the stories themselves; one opens its files grouped by kind and a
// Details panel with its production metadata), Videos, Storyboards, Characters, Pictures, Sounds, Scenes. Every item
// shows its story or character and has Download (a video's MP4, or its WebM or MOV copy, by name). The address keeps
// the tab (`?kind=`) and the project (`?story=`). Projects pages with the API's cursor (Show more, §45.34 "All
// projects"), and a `?story=` that is not in the pages loaded so far is fetched by itself before "could not find".
// Videos lists each video's MP4 and its WebM and MOV copies (kind `video`, §45.35 D10). How it was made names the
// helpers and the safety advice in words, says where the files are in words, and keeps the exact folder, the seed, the
// engine version and each step's exact model id behind "Technical details" (§45.35 D5, D21).
import "../styles/studio.css";
import { useMemo, useState } from "react";
import { friendlyMessage } from "../../api/errors.ts";
import { useToast } from "../../components/Toasts.tsx";
import { A } from "../../components/ui.tsx";
import { Glide } from "../../components/Glide.tsx";
import { bytes, relative, shortDate } from "../../lib/format.ts";
import { useLoad } from "../../lib/hooks.ts";
import { navigate } from "../../lib/router.ts";
import { storiesApi } from "../api/client.ts";
import { STEP_LABEL, type AssetKind, type Character, type DownloadFormat, type LibraryItem, type ProductionJob, type StepKey, type Story } from "../api/types.ts";
import { modelIdLine, stoppedOn } from "../studio/ai.tsx";
import { usePaged } from "../studio/hooks.ts";
import { TechDetails } from "../studio/kit.tsx";
import { HELPER_KIND, providerName, STORAGE_WORDS, topicTitle } from "../studio/words.ts";
import { storiesHref } from "../routes.ts";
import { STATUS_WORDS, StButton, StEmpty, StError, StIcon, StLinkButton, StLoading, StPageHead, type MascotMood, type StIconName, type StTone } from "../ui.tsx";
import type { StoriesScreenProps } from "./types.ts";

export type LibraryTab = "projects" | "videos" | "storyboards" | "characters" | "pictures" | "sounds" | "scenes";

/** Which asset kinds each tab holds (§45.12: no item sits in two tabs); a video's WebM and MOV copies are videos too. */
export const TAB_KINDS: Record<Exclude<LibraryTab, "projects">, AssetKind[]> = {
  videos: ["final_video", "video"],
  storyboards: ["storyboard", "captions"],
  characters: ["character_ref"],
  pictures: ["cover", "portrait"],
  sounds: ["audio"],
  scenes: ["scene_clip", "scene_still"],
};

const TABS: { id: LibraryTab; label: string; icon: StIconName }[] = [
  { id: "projects", label: "Projects", icon: "folder" },
  { id: "videos", label: "Videos", icon: "film" },
  { id: "storyboards", label: "Storyboards", icon: "board" },
  { id: "characters", label: "Characters", icon: "face" },
  { id: "pictures", label: "Pictures", icon: "picture" },
  { id: "sounds", label: "Sounds", icon: "music" },
  { id: "scenes", label: "Scenes", icon: "scenes" },
];

const EMPTY: Record<LibraryTab, { title: string; text: string; mood: MascotMood; tone: StTone }> = {
  projects: { title: "No projects yet", text: "Every video you make is a project here, with all its files.", mood: "wave", tone: "sun" },
  videos: { title: "No videos yet", text: "Finished videos land here, ready to download.", mood: "sleepy", tone: "sky" },
  storyboards: { title: "No storyboards yet", text: "Each video's story plan and its captions are kept here.", mood: "think", tone: "sky" },
  characters: { title: "No character pictures yet", text: "Pictures you add to a character show up here.", mood: "wave", tone: "mint" },
  pictures: { title: "No pictures yet", text: "Video covers and character portraits show up here.", mood: "sleepy", tone: "coral" },
  sounds: { title: "No sounds yet", text: "Each video's sound effects and music are kept here.", mood: "think", tone: "sun" },
  scenes: { title: "No scenes yet", text: "Every scene's picture and clip is kept here.", mood: "wave", tone: "sky" },
};

export const KIND_LABEL: Record<AssetKind, string> = {
  final_video: "Video",
  cover: "Cover picture",
  storyboard: "Storyboard",
  scene_clip: "Scene clip",
  scene_still: "Scene picture",
  character_ref: "Character picture",
  portrait: "Portrait",
  audio: "Sound mix",
  captions: "Captions",
  design_ref: "Design picture",
  video: "Video copy",
};

const KIND_ICON: Record<AssetKind, StIconName> = {
  final_video: "film",
  cover: "picture",
  storyboard: "board",
  scene_clip: "scenes",
  scene_still: "picture",
  character_ref: "face",
  portrait: "face",
  audio: "music",
  captions: "comment",
  design_ref: "picture",
  video: "film",
};

const IMAGE = (i: LibraryItem) => i.contentType.startsWith("image/");

/** The tab for `?kind=`: a tab's own name, or an asset kind (another page linking to `?kind=final_video`). */
export function tabFor(kind: string | null): LibraryTab {
  if (kind && TABS.some((t) => t.id === kind)) return kind as LibraryTab;
  if (kind) for (const [tab, kinds] of Object.entries(TAB_KINDS)) if ((kinds as string[]).includes(kind)) return tab as LibraryTab;
  return "projects";
}

function fileName(i: LibraryItem): string {
  const ext: Record<string, string> = { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "audio/mp4": "m4a", "application/json": "json", "text/x-ssa": "ass" };
  const slug =
    i.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "lamo-stories";
  const scene = typeof i.meta.sceneId === "string" ? `-${i.meta.sceneId}` : "";
  return `${slug}-${i.kind.replace(/_/g, "-")}${scene}${i.version ? `-v${i.version}` : ""}.${ext[i.contentType] ?? "bin"}`;
}

/** Starts a download of `url` from this page (the server's file link; a story's video asks for its named copy). */
function saveFile(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  if (!url.startsWith("data:") && !url.startsWith("blob:")) a.target = "_blank";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function DownloadButton({ ws, item, stories }: { ws: string; item: LibraryItem; stories: Story[] | null }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const story = item.storyId ? stories?.find((s) => s.storyId === item.storyId) : undefined;
  const named = (item.kind === "final_video" || item.kind === "video") && item.meta.current !== 0 && (story?.status === "approved" || story?.status === "published");
  // A video's extra copy (WebM, MOV) is asked for by its own name (§45.34).
  const format = item.meta.format === "webm" || item.meta.format === "mov" ? (item.meta.format as DownloadFormat) : null;
  return (
    <StButton
      className="st-file__download"
      disabled={busy}
      aria-label={`Download ${KIND_LABEL[item.kind].toLowerCase()}${format ? ` (${format === "webm" ? "WebM" : "MOV"})` : ""} of ${item.title}`}
      onClick={async () => {
        if (!named || !item.storyId) return saveFile(item.url, fileName(item));
        setBusy(true);
        try {
          const { url, filename } = format ? await storiesApi().download(ws, item.storyId, { format }) : await storiesApi().download(ws, item.storyId);
          saveFile(url, filename);
        } catch (e) {
          // The file link the Library already has still works (it is the same video).
          saveFile(item.url, fileName(item));
          if (!(e instanceof Error && /not built/.test(e.message))) toast.info(friendlyMessage(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <StIcon name="download" size={20} />
      Download
    </StButton>
  );
}

function Thumb({ item, pictures }: { item: LibraryItem; pictures: Map<string, string> }) {
  const still =
    IMAGE(item)
      ? item.url
      : (item.kind === "final_video" || item.kind === "video") && item.storyId
        ? pictures.get(`cover:${item.storyId}`)
        : item.kind === "scene_clip" && item.storyId
          ? pictures.get(`still:${item.storyId}:${String(item.meta.sceneId ?? "")}`)
          : undefined;
  return (
    <span className={`st-file__thumb st-file__thumb--${item.kind}`}>
      {still ? <img src={still} alt="" loading="lazy" decoding="async" /> : null}
      <span className="st-file__badge" aria-hidden="true">
        <StIcon name={item.kind === "final_video" || item.kind === "video" || item.kind === "scene_clip" ? "play" : KIND_ICON[item.kind]} size={item.kind === "final_video" || item.kind === "video" || item.kind === "scene_clip" ? 26 : 30} />
      </span>
    </span>
  );
}

function FileCard({ ws, item, pictures, stories }: { ws: string; item: LibraryItem; pictures: Map<string, string>; stories: Story[] | null }) {
  const owner = item.storyId ? storiesHref({ name: "library", kind: null, storyId: item.storyId }) : item.characterId ? `/stories/characters/${encodeURIComponent(item.characterId)}` : null;
  return (
    <li className="st-file">
      <Thumb item={item} pictures={pictures} />
      <div className="st-file__body">
        <span className="st-file__kind">
          <StIcon name={KIND_ICON[item.kind]} size={16} />
          {KIND_LABEL[item.kind]}
          {item.meta.format === "webm" ? " · WebM" : item.meta.format === "mov" ? " · MOV" : ""}
          {typeof item.meta.sceneId === "string" ? ` · scene ${item.meta.sceneId.replace(/^s/, "")}` : ""}
        </span>
        {owner ? (
          <A href={owner} className="st-file__title">
            {item.title}
          </A>
        ) : (
          <span className="st-file__title">{item.title}</span>
        )}
        <span className="st-file__meta">
          {item.version ? `Version ${item.version}${item.meta.current === 0 ? " (older)" : ""} · ` : ""}
          {bytes(item.bytes)} · {shortDate(item.createdAt)}
        </span>
      </div>
      <DownloadButton ws={ws} item={item} stories={stories} />
    </li>
  );
}

/** One tab's files: each of its kinds asked for separately and shown newest first, with Show more. */
function useFiles(ws: string, kinds: AssetKind[], storyId: string | null) {
  const [extra, setExtra] = useState<{ items: LibraryItem[]; cursors: (string | null)[] } | null>(null);
  const key = `${ws}|${kinds.join(",")}|${storyId ?? ""}`;
  const loaded = useLoad(
    async () => {
      setExtra(null);
      const pages = await Promise.all(kinds.map((kind) => storiesApi().library(ws, { kind, storyId: storyId ?? undefined, limit: 48 })));
      return { items: pages.flatMap((p) => p.items), cursors: pages.map((p) => p.nextCursor) };
    },
    key,
    "st-library",
  );
  const data = extra ?? loaded.data;
  const more = async () => {
    if (!data) return;
    const pages = await Promise.all(
      kinds.map((kind, i) => (data.cursors[i] ? storiesApi().library(ws, { kind, storyId: storyId ?? undefined, limit: 48, cursor: data.cursors[i]! }) : Promise.resolve({ items: [], nextCursor: null }))),
    );
    setExtra({ items: [...data.items, ...pages.flatMap((p) => p.items)], cursors: pages.map((p) => p.nextCursor) });
  };
  // "Design with AI" pictures are working files of the Characters page: the Library hides them (§45.6).
  const items = useMemo(() => (data?.items ?? []).filter((i) => i.kind !== "design_ref").sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [data]);
  return { ...loaded, items, hasMore: !!data?.cursors.some(Boolean), more };
}

/** The pictures other files borrow as thumbnails: each story's cover, each scene's still. */
function usePictures(ws: string, storyId: string | null, want: boolean) {
  const loaded = useLoad(
    async () => {
      if (!want) return [] as LibraryItem[];
      const [covers, stills] = await Promise.all([
        storiesApi().library(ws, { kind: "cover", storyId: storyId ?? undefined, limit: 100 }),
        storiesApi().library(ws, { kind: "scene_still", storyId: storyId ?? undefined, limit: 100 }),
      ]);
      return [...covers.items, ...stills.items];
    },
    `${ws}|${storyId ?? ""}|${want}`,
    "st-library-pictures",
  );
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const p of loaded.data ?? []) {
      if (!p.storyId || p.meta.current === 0) continue;
      if (p.kind === "cover") map.set(`cover:${p.storyId}`, p.url);
      else map.set(`still:${p.storyId}:${String(p.meta.sceneId ?? "")}`, p.url);
    }
    return map;
  }, [loaded.data]);
}

function Files({ ws, tab, storyId, stories, onClear }: { ws: string; tab: Exclude<LibraryTab, "projects">; storyId: string | null; stories: Story[] | null; onClear: () => void }) {
  const files = useFiles(ws, TAB_KINDS[tab], storyId);
  const pictures = usePictures(ws, storyId, tab === "videos" || tab === "scenes");
  const story = storyId ? stories?.find((s) => s.storyId === storyId) : undefined;
  return (
    <>
      {storyId ? (
        <p className="st-filter">
          Only files of <strong>{story?.title ?? "one video"}</strong>.
          <StButton quiet onClick={onClear}>
            Show every video
          </StButton>
        </p>
      ) : null}
      {files.error && !files.data ? (
        <StError message={files.error} onRetry={() => void files.reload()} />
      ) : !files.data ? (
        <StLoading label="Opening the boxes…" />
      ) : files.items.length === 0 ? (
        <StEmpty mood={EMPTY[tab].mood} tone={EMPTY[tab].tone} title={EMPTY[tab].title} action={<StLinkButton href="/stories/production/new" main>Make a video</StLinkButton>}>
          {EMPTY[tab].text}
        </StEmpty>
      ) : (
        <>
          <ul className="st-files">
            {files.items.map((item) => (
              <FileCard key={item.assetId} ws={ws} item={item} pictures={pictures} stories={stories} />
            ))}
          </ul>
          {files.hasMore ? (
            <div className="st-more-row">
              <StButton onClick={() => void files.more()}>Show more</StButton>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}

function castNames(story: Story, cast: Character[] | null): string {
  const names = story.characterIds.map((id) => cast?.find((c) => c.characterId === id)?.name).filter((n): n is string => !!n);
  if (names.length) return names.join(", ");
  return story.characterIds.length === 1 ? "1 character" : `${story.characterIds.length} characters`;
}

function ProjectCard({ story, cover, cast }: { story: Story; cover?: string; cast: Character[] | null }) {
  const status = STATUS_WORDS[story.status];
  const length = story.actualDurationSec ?? story.durationSec;
  return (
    <li className="st-project">
      <A href={storiesHref({ name: "library", kind: null, storyId: story.storyId })} className="st-project__link">
        <span className="st-project__cover">
          {cover ?? story.coverUrl ? <img src={cover ?? story.coverUrl} alt="" loading="lazy" decoding="async" /> : <StIcon name="clapper" size={34} />}
        </span>
        <span className="st-project__body">
          <span className="st-project__title">{story.title}</span>
          <span className={`st-chip st-chip--${status.tone}`}>{status.label}</span>
          <span className="st-project__meta">
            {castNames(story, cast)} · {Math.round(length)} s · Script {story.scriptVersion || 1} · {shortDate(story.createdAt)}
          </span>
        </span>
      </A>
    </li>
  );
}

function seconds(job: ProductionJob["steps"][number]): string {
  if (!job.startedAt || !job.finishedAt) return "";
  const s = Math.max(0, Math.round((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
}

const JOB_WORDS: Record<ProductionJob["status"], string> = {
  queued: "Waiting to start",
  running: "Being made",
  ready: "Done",
  needs_check: "Done, needs a check",
  failed: "Stopped",
  canceled: "Cancelled",
};

/** Lamo Stories' own model names (GET …/ai), by key; a key it does not know shows as it is. */
function useModelNames(ws: string): (key: string) => string {
  const ai = useLoad(() => storiesApi().getAi(ws).catch(() => null), ws, "st-library-models");
  return (key) => ai.data?.models.find((m) => m.key === key)?.label ?? key;
}

const EFFORT_WORDS: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum" };

/** A job's per-step model line: the step's own label (a reference analysis or a portrait has its own words). */
const STEP_WORDS: Record<string, string> = { ...STEP_LABEL, portrait: "Draw the picture", reference_analysis: "Study the video" };

/** The checked advice topics, for their titles (never their ids); null while unknown. */
function useTopics(ws: string) {
  const g = useLoad(() => storiesApi().guidance(ws).catch(() => null), ws, "st-library-guidance");
  return g.data?.topics ?? null;
}

function Details({ ws, story }: { ws: string; story: Story }) {
  const jobs = useLoad(() => storiesApi().storyJobs(ws, story.storyId), `${ws}|${story.storyId}`, "st-library-jobs");
  const modelName = useModelNames(ws);
  const topics = useTopics(ws);
  return (
    <section className="st-details" aria-labelledby="st-details-title">
      <h2 className="st-details__title" id="st-details-title">
        <StIcon name="clock" size={22} />
        How it was made
      </h2>
      <dl className="st-facts">
        <div>
          <dt>Saved in</dt>
          <dd>{STORAGE_WORDS}</dd>
        </div>
        <div>
          <dt>Length</dt>
          <dd>{story.actualDurationSec ? `${story.actualDurationSec.toFixed(1)} s (asked for ${story.durationSec} s)` : `${story.durationSec} s asked for`}</dd>
        </div>
        <div>
          <dt>Script</dt>
          <dd>Version {story.scriptVersion || 1}</dd>
        </div>
      </dl>
      <TechDetails className="st-tech">
        <dl className="st-facts st-facts--small">
          <div>
            <dt>Folder</dt>
            <dd className="st-facts__code">{story.storageLocation}</dd>
          </div>
        </dl>
      </TechDetails>
      {jobs.error && !jobs.data ? (
        <StError message={jobs.error} onRetry={() => void jobs.reload()} />
      ) : !jobs.data ? (
        <StLoading label="Reading the notes…" />
      ) : jobs.data.length === 0 ? (
        <p className="st-tile__note">No production runs yet.</p>
      ) : (
        <ol className="st-runs">
          {jobs.data.map((job) => (
            <li key={job.jobId} className="st-run">
              <p className="st-run__head">
                <strong>{job.jobType === "changes" ? "Changes" : job.jobType === "portrait" ? "Portrait" : "Made"}</strong> {relative(job.createdAt)} · {JOB_WORDS[job.status]}
              </p>
              <dl className="st-facts st-facts--small">
                {job.meta.writerModel ? (
                  <div>
                    <dt>Writer</dt>
                    <dd>{modelName(job.meta.writerModel)}</dd>
                  </div>
                ) : null}
                {job.meta.targetSec !== null ? (
                  <div>
                    <dt>Length</dt>
                    <dd>
                      {job.meta.actualSec !== null ? `${job.meta.actualSec.toFixed(1)} s` : "–"} of {job.meta.targetSec} s
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt>Safety advice</dt>
                  <dd>{topicTitle(topics, job.meta.safetyTopicId) ?? "None (only the nothing-dangerous check)"}</dd>
                </div>
                {Object.entries(job.meta.providers).map(([kind, id]) => (
                  <div key={kind}>
                    <dt>{HELPER_KIND[kind] ?? "Helper"}</dt>
                    <dd>{providerName(id)}</dd>
                  </div>
                ))}
                {(job.meta.models ?? []).map((m) => (
                  <div key={`${m.step}|${m.agentId}`}>
                    <dt>{STEP_WORDS[m.step] ?? m.step}</dt>
                    <dd>
                      {modelName(m.model)}
                      {m.effort ? ` · ${EFFORT_WORDS[m.effort] ?? m.effort}${stoppedOn(job, m) || m.effortApplied ? "" : " (not offered)"}` : ""}
                      {stoppedOn(job, m) ? " (stopped)" : ""}
                    </dd>
                  </div>
                ))}
              </dl>
              {job.meta.engineVersion !== null || job.meta.seed !== null || (job.meta.models ?? []).some((m) => modelIdLine(m)) ? (
                <TechDetails className="st-tech">
                  <dl className="st-facts st-facts--small">
                    {job.meta.engineVersion !== null ? (
                      <div>
                        <dt>Animation engine</dt>
                        <dd>Version {job.meta.engineVersion}</dd>
                      </div>
                    ) : null}
                    {job.meta.seed !== null ? (
                      <div>
                        <dt>Seed</dt>
                        <dd>{job.meta.seed}</dd>
                      </div>
                    ) : null}
                    {(job.meta.models ?? []).map((m) =>
                      modelIdLine(m) ? (
                        <div key={`id|${m.step}|${m.agentId}`} className="st-tech__model">
                          <dt>{STEP_WORDS[m.step] ?? m.step}</dt>
                          <dd className="st-facts__code">{modelIdLine(m)}</dd>
                        </div>
                      ) : null,
                    )}
                  </dl>
                </TechDetails>
              ) : null}
              <ol className="st-run__steps">
                {job.steps.map((s) => (
                  <li key={s.key} className={`st-run__step is-${s.status}`}>
                    <span className="st-run__dot" aria-hidden="true" />
                    <span>{STEP_LABEL[s.key as StepKey] ?? s.label}</span>
                    <span className="st-run__time">{s.status === "done" ? seconds(s) : s.status === "skipped" ? "skipped" : s.status === "failed" ? "stopped" : s.status === "running" ? "now" : ""}</span>
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const GROUPS: { kinds: AssetKind[]; title: string }[] = [
  { kinds: ["final_video", "video", "cover"], title: "The video" },
  { kinds: ["storyboard", "captions"], title: "Story and captions" },
  { kinds: ["scene_still", "scene_clip"], title: "Scenes" },
  { kinds: ["audio"], title: "Sound" },
];

function Project({ ws, story, cast, stories }: { ws: string; story: Story; cast: Character[] | null; stories: Story[] | null }) {
  const files = useLoad(
    async () => {
      const out: LibraryItem[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 5; i++) {
        const page = await storiesApi().library(ws, { storyId: story.storyId, limit: 100, cursor });
        out.push(...page.items);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      return out;
    },
    `${ws}|${story.storyId}`,
    "st-library-project",
  );
  const pictures = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of files.data ?? []) {
      if (p.meta.current === 0) continue;
      if (p.kind === "cover") map.set(`cover:${story.storyId}`, p.url);
      if (p.kind === "scene_still") map.set(`still:${story.storyId}:${String(p.meta.sceneId ?? "")}`, p.url);
    }
    return map;
  }, [files.data, story.storyId]);
  const status = STATUS_WORDS[story.status];
  return (
    <div className="st-projectview">
      <header className="st-projectview__head">
        <A href={storiesHref({ name: "library", kind: null, storyId: null })} className="st-back">
          <StIcon name="chevron" size={18} className="st-back__icon" />
          All projects
        </A>
        <h2 className="st-projectview__title">{story.title}</h2>
        <p className="st-projectview__meta">
          <span className={`st-chip st-chip--${status.tone}`}>{status.label}</span>
          <span>{castNames(story, cast)}</span>
          {story.status === "review" || story.status === "needs_check" || story.status === "approved" || story.status === "published" ? (
            <A href={`/stories/review/${encodeURIComponent(story.storyId)}`} className="st-textlink">
              Open in Review
            </A>
          ) : (
            <A href={`/stories/production/${encodeURIComponent(story.storyId)}`} className="st-textlink">
              Open in Production
            </A>
          )}
        </p>
      </header>
      <div className="st-projectview__grid">
        <div className="st-projectview__files">
          {files.error && !files.data ? (
            <StError message={files.error} onRetry={() => void files.reload()} />
          ) : !files.data ? (
            <StLoading label="Opening the project…" />
          ) : files.data.length === 0 ? (
            <StEmpty mood="sleepy" tone="sky" title="No files yet">
              This video's files show up here as it is made.
            </StEmpty>
          ) : (
            GROUPS.map((g) => {
              const items = files.data!.filter((f) => g.kinds.includes(f.kind));
              if (!items.length) return null;
              return (
                <section key={g.title} className="st-group" aria-label={g.title}>
                  <h3 className="st-group__title">{g.title}</h3>
                  <ul className="st-files">
                    {items.map((item) => (
                      <FileCard key={item.assetId} ws={ws} item={item} pictures={pictures} stories={stories} />
                    ))}
                  </ul>
                </section>
              );
            })
          )}
        </div>
        <Details ws={ws} story={story} />
      </div>
    </div>
  );
}

type StoryPages = ReturnType<typeof usePaged<Story>>;

/** A project that is not in the pages loaded so far: it is fetched by itself before "could not find" (§45.34). */
function ProjectById({ ws, storyId, cast, stories }: { ws: string; storyId: string; cast: Character[] | null; stories: Story[] }) {
  const one = useLoad(async () => (await storiesApi().getStory(ws, storyId)).story, `${ws}|${storyId}`, "st-library-one");
  if (one.data) return <Project ws={ws} story={one.data} cast={cast} stories={[one.data, ...stories]} />;
  if (one.error && !one.missing) return <StError message={one.error} onRetry={() => void one.reload()} />;
  if (one.missing)
    return (
      <StEmpty mood="think" tone="sky" title="We could not find that project" action={<StLinkButton href="/stories/library" main>See every project</StLinkButton>}>
        It may have been deleted.
      </StEmpty>
    );
  return <StLoading label="Opening the project…" />;
}

function Projects({ ws, storyId, stories, cast }: { ws: string; storyId: string | null; stories: StoryPages; cast: Character[] | null }) {
  const covers = usePictures(ws, null, true);
  if (stories.error && !stories.data) return <StError message={stories.error} onRetry={() => void stories.reload()} />;
  if (!stories.data) return <StLoading label="Opening the boxes…" />;
  if (storyId) {
    const story = stories.data.find((s) => s.storyId === storyId);
    if (!story) return <ProjectById key={storyId} ws={ws} storyId={storyId} cast={cast} stories={stories.data} />;
    return <Project ws={ws} story={story} cast={cast} stories={stories.data} />;
  }
  if (stories.data.length === 0)
    return (
      <StEmpty mood={EMPTY.projects.mood} tone={EMPTY.projects.tone} title={EMPTY.projects.title} action={<StLinkButton href="/stories/production/new" main>Make a video</StLinkButton>}>
        {EMPTY.projects.text}
      </StEmpty>
    );
  return (
    <>
      <ul className="st-projects">
        {stories.data.map((s) => (
          <ProjectCard key={s.storyId} story={s} cover={covers.get(`cover:${s.storyId}`)} cast={cast} />
        ))}
      </ul>
      {stories.problem ? <StError message={stories.problem} onRetry={() => void stories.more()} /> : null}
      {stories.hasMore ? (
        <div className="st-more-row">
          <StButton aria-disabled={stories.busy || undefined} onClick={() => !stories.busy && void stories.more()}>
            {stories.busy ? "Getting more projects…" : "Show more"}
          </StButton>
        </div>
      ) : null}
    </>
  );
}

export function LibraryScreen({ ws, page }: StoriesScreenProps) {
  const kind = page.name === "library" ? page.kind : null;
  const storyId = page.name === "library" ? page.storyId : null;
  const tab = tabFor(kind);
  const stories = usePaged(
    async (cursor) => {
      const r = await storiesApi().listStories(ws, cursor ? { status: "all", limit: 50, cursor } : { status: "all", limit: 50 });
      return { items: r.stories, nextCursor: r.nextCursor };
    },
    ws,
    "st-library-story-pages",
    (s) => s.storyId,
  );
  const cast = useLoad(() => storiesApi().listCharacters(ws), ws, "st-library-cast");
  const go = (next: LibraryTab, story: string | null = storyId) => {
    const q = new URLSearchParams();
    if (next !== "projects") q.set("kind", next);
    if (story) q.set("story", story);
    const qs = q.toString();
    navigate(`/stories/library${qs ? `?${qs}` : ""}`, { replace: true });
  };
  return (
    <section className="st-page st-library">
      <StPageHead title="Library" lede="Every file Lamo Stories made or you added, kept safe. Only Lamo Stories' own: Lamo Clips' Library stays separate." />
      <div className="st-tabs" role="tablist" aria-label="Library">
        <Glide active=".st-tabs__tab.is-on" className="glide--st" />
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === tab}
            className={`st-tabs__tab${t.id === tab ? " is-on" : ""}`}
            onClick={() => go(t.id, t.id === "projects" ? null : storyId)}
          >
            <StIcon name={t.icon} size={18} />
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={TABS.find((t) => t.id === tab)!.label} className="st-library__panel">
        {tab === "projects" ? (
          <Projects ws={ws} storyId={storyId} stories={stories} cast={cast.data} />
        ) : (
          <Files ws={ws} tab={tab} storyId={storyId} stories={stories.data} onClear={() => go(tab, null)} />
        )}
      </div>
    </section>
  );
}
