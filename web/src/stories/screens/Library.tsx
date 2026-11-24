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
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, friendlyMessage } from "../../api/errors.ts";
import { useToast } from "../../components/Toasts.tsx";
import { A } from "../../components/ui.tsx";
import { Glide } from "../../components/Glide.tsx";
import { bytes, relative, shortDate } from "../../lib/format.ts";
import { useLoad } from "../../lib/hooks.ts";
import { navigate } from "../../lib/router.ts";
import { storiesApi } from "../api/client.ts";
import { STEP_LABEL, type AssetKind, type Character, type DownloadFormat, type LibraryItem, type ProductionJob, type StepKey, type Story } from "../api/types.ts";
import { modelIdLine, modelUseWords, stoppedOn } from "../studio/ai.tsx";
import { usePaged } from "../studio/hooks.ts";
import { filterOf, MoveToSeries, SeriesSwitch, seriesQuery, useSeriesList } from "../studio/SeriesSwitch.tsx";
import { TechDetails } from "../studio/kit.tsx";
import { HELPER_KIND, helperName, STORAGE_WORDS, topicTitle, type ModelLookup } from "../studio/words.ts";
import { Glass, GlassPill, MediaRow, cx } from "../glass/index.ts";
import { storiesReduceMotion } from "../prefs.ts";
import { storiesHref } from "../routes.ts";
import { STATUS_WORDS, StButton, StError, StIcon, StLinkButton, StLoading, StMascot, StPageHead, type MascotMood, type StIconName, type StTone } from "../ui.tsx";
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

/** Every empty Library page shows the same warm character (the owner's warm palette of 22 Nov: no cool blues or greens). */
const EMPTY: Record<LibraryTab, { title: string; text: string; mood: MascotMood; tone: StTone }> = {
  projects: { title: "No projects yet", text: "Each video you make shows up here, with its files.", mood: "wave", tone: "sun" },
  videos: { title: "No videos yet", text: "Finished videos land here, ready to download.", mood: "sleepy", tone: "sun" },
  storyboards: { title: "No storyboards yet", text: "Each video's story plan and its captions are kept here.", mood: "think", tone: "sun" },
  characters: { title: "No character pictures yet", text: "Pictures you add to a character show up here.", mood: "wave", tone: "sun" },
  pictures: { title: "No pictures yet", text: "Video covers and character portraits show up here.", mood: "sleepy", tone: "sun" },
  sounds: { title: "No sounds yet", text: "Each video's sound effects and music are kept here.", mood: "think", tone: "sun" },
  scenes: { title: "No scenes yet", text: "Every scene's picture and clip is kept here.", mood: "wave", tone: "sun" },
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
      .slice(0, 40) || "clips-funded";
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
      // Kid-proof: never `disabled`. A tap while it works is ignored, with the app's deny sound.
      aria-disabled={busy || undefined}
      aria-label={`Download ${KIND_LABEL[item.kind].toLowerCase()}${format ? ` (${format === "webm" ? "WebM" : "MOV"})` : ""} of ${item.title}`}
      onClick={async () => {
        if (busy) return;
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
  // The media row's thumbnail: the picture itself (a video's cover, a scene's still), or the kind's icon on the warm
  // glow. Nothing on it looks like a button, because it is not one: the caps caption beside it says what it is.
  return (
    <span className={cx("st-file__thumb", `st-file__thumb--${item.kind}`, still && "has-picture")}>
      {still ? (
        <img src={still} alt="" loading="lazy" decoding="async" />
      ) : (
        <span className="st-file__badge" aria-hidden="true">
          <StIcon name={KIND_ICON[item.kind]} size={26} />
        </span>
      )}
    </span>
  );
}

/**
 * One file as a media row on its own glass (MediaRow, styles/GLASS-CONTRACT.md): the thumbnail, its kind as a caps
 * caption, the story or character it belongs to (a link), its version, size and date, and Download as the control.
 * The kind sits in the row's title slot and the story's name in its meta slot, so the name can wrap and keep its
 * focus ring (the title slot clips with an ellipsis).
 */
function FileCard({ ws, item, pictures, stories }: { ws: string; item: LibraryItem; pictures: Map<string, string>; stories: Story[] | null }) {
  const owner = item.storyId ? storiesHref({ name: "library", kind: null, storyId: item.storyId }) : item.characterId ? `/stories/characters/${encodeURIComponent(item.characterId)}` : null;
  return (
    <MediaRow
      as="li"
      className="st-file st-glass"
      thumb={<Thumb item={item} pictures={pictures} />}
      title={
        <span className="st-file__kind st-caps">
          <StIcon name={KIND_ICON[item.kind]} size={16} />
          <span>
            {KIND_LABEL[item.kind]}
            {item.meta.format === "webm" ? " · WebM" : item.meta.format === "mov" ? " · MOV" : ""}
            {typeof item.meta.sceneId === "string" ? ` · scene ${item.meta.sceneId.replace(/^s/, "")}` : ""}
          </span>
        </span>
      }
      meta={
        <>
          {owner ? (
            <A href={owner} className="st-file__title">
              {item.title}
            </A>
          ) : (
            <span className="st-file__title">{item.title}</span>
          )}
          <span className="st-file__meta st-num">
            {item.version ? `Version ${item.version}${item.meta.current === 0 ? " (older)" : ""} · ` : ""}
            {bytes(item.bytes)} · {shortDate(item.createdAt)}
          </span>
        </>
      }
      controls={<DownloadButton ws={ws} item={item} stories={stories} />}
    />
  );
}

/**
 * One page of one kind. A video's extra copies (kind `video`, §45.35 D10) are asked for too; an API that does not know
 * that kind yet answers 400, and then the tab simply has no copies (its MP4s still show), never a broken tab.
 */
async function kindPage(ws: string, q: { kind: AssetKind; storyId?: string; limit: number; cursor?: string; seriesId?: string }): Promise<{ items: LibraryItem[]; nextCursor: string | null }> {
  try {
    return await storiesApi().library(ws, q);
  } catch (e) {
    if (q.kind === "video" && e instanceof ApiError && e.status === 400) return { items: [], nextCursor: null };
    throw e;
  }
}

/** One tab's files: each of its kinds asked for separately and shown newest first, with Show more. */
function useFiles(ws: string, kinds: AssetKind[], storyId: string | null, seriesId?: string) {
  const [extra, setExtra] = useState<{ items: LibraryItem[]; cursors: (string | null)[] } | null>(null);
  const key = `${ws}|${kinds.join(",")}|${storyId ?? ""}${seriesId ? `|${seriesId}` : ""}`;
  // §45.44: one series' files only when the page shows one (the key is left out otherwise)
  const inSeries = seriesId ? { seriesId } : {};
  const loaded = useLoad(
    async () => {
      setExtra(null);
      const pages = await Promise.all(kinds.map((kind) => kindPage(ws, { kind, storyId: storyId ?? undefined, limit: 48, ...inSeries })));
      return { items: pages.flatMap((p) => p.items), cursors: pages.map((p) => p.nextCursor) };
    },
    key,
    "st-library",
  );
  const data = extra ?? loaded.data;
  const more = async () => {
    if (!data) return;
    const pages = await Promise.all(
      kinds.map((kind, i) => (data.cursors[i] ? kindPage(ws, { kind, storyId: storyId ?? undefined, limit: 48, cursor: data.cursors[i]!, ...inSeries }) : Promise.resolve({ items: [], nextCursor: null }))),
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

function Files({ ws, tab, storyId, stories, onClear, seriesId }: { ws: string; tab: Exclude<LibraryTab, "projects">; storyId: string | null; stories: Story[] | null; onClear: () => void; seriesId?: string }) {
  const files = useFiles(ws, TAB_KINDS[tab], storyId, seriesId);
  const pictures = usePictures(ws, storyId, tab === "videos" || tab === "scenes");
  const story = storyId ? stories?.find((s) => s.storyId === storyId) : undefined;
  return (
    <>
      {storyId ? (
        <p className="st-filter st-glass">
          <span className="st-filter__words">
            Only files of <strong>{story?.title ?? "one video"}</strong>.
          </span>
          <GlassPill icon={<StIcon name="close" size={16} />} onClick={onClear} className="st-filter__clear">
            Show every video
          </GlassPill>
        </p>
      ) : null}
      {files.error && !files.data ? (
        <StError message={files.error} onRetry={() => void files.reload()} />
      ) : !files.data ? (
        <StLoading label="Opening the boxes…" />
      ) : files.items.length === 0 ? (
        <LibraryEmpty mood={EMPTY[tab].mood} tone={EMPTY[tab].tone} title={EMPTY[tab].title} action={<StLinkButton href="/stories/production/new" main>Make a video</StLinkButton>}>
          {EMPTY[tab].text}
        </LibraryEmpty>
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

/**
 * How far a story has come on its way (started, being made, ready to watch, approved, posted), for the project row's
 * bar; null where a bar would mislead (stopped, not used).
 */
export function storyProgress(status: Story["status"]): number | null {
  const STAGE: Partial<Record<Story["status"], number>> = { draft: 1, producing: 2, needs_check: 3, review: 3, approved: 4, published: 5 };
  const stage = STAGE[status];
  return stage === undefined ? null : stage / 5;
}

/** A story's state in words with a small dot of its colour (the colour is a mark; the words keep their own ink). */
function StateLabel({ status }: { status: Story["status"] }) {
  const s = STATUS_WORDS[status];
  return (
    <span className={`st-state st-state--${s.tone}`}>
      <span className="st-state__dot" aria-hidden="true" />
      {s.label}
    </span>
  );
}

/** The empty Library, a tab or a project with nothing in it yet: a character on lit glass and the one tap that fixes it. */
function LibraryEmpty({ mood, tone, title, children, action }: { mood: MascotMood; tone: StTone; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <Glass variant="hero" className="st-shelf">
      <span className="st-shelf__glow" aria-hidden="true" />
      <StMascot mood={mood} tone={tone} size={112} />
      <h2 className="st-shelf__title st-display">{title}</h2>
      {children ? <p className="st-shelf__text">{children}</p> : null}
      {action ? <div className="st-shelf__action">{action}</div> : null}
    </Glass>
  );
}

/**
 * A project as a media row on glass: its cover, its title, who is in it, a bar for how far it has come with its state
 * in words, and a round glass arrow. The whole row is the link (the arrow is part of it, so a tap on it opens the
 * project too). The bar is for the eyes only: the state's words already say how far it has come, so the link's spoken
 * name never gets a bare number. The newest project leads the list as a lit hero row (its rim may bend where the
 * device allows).
 */
function ProjectCard({ ws, story, cover, cast, featured = false, onMoved }: { ws: string; story: Story; cover?: string; cast: Character[] | null; featured?: boolean; onMoved?: () => void }) {
  const length = story.actualDurationSec ?? story.durationSec;
  const picture = cover ?? story.coverUrl;
  const progress = storyProgress(story.status);
  const chip = <StateLabel status={story.status} />;
  return (
    <li className={cx("st-project", featured && "st-project--featured")}>
      <A href={storiesHref({ name: "library", kind: null, storyId: story.storyId })} className={cx("st-project__link st-glass", featured && "st-glass--hero st-lens")}>
        <MediaRow
          thumb={<span className="st-project__cover">{picture ? <img src={picture} alt="" loading="lazy" decoding="async" /> : <StIcon name="clapper" size={featured ? 36 : 30} />}</span>}
          title={<span className={cx("st-project__title", featured && "st-display")}>{story.title}</span>}
          meta={
            <>
              <span className="st-project__meta st-num">
                {castNames(story, cast)} · {Math.round(length)} s · Script {story.scriptVersion || 1} · {shortDate(story.createdAt)}
              </span>
              {/* Stopped or not used: no bar (it would look like it is still going), only the state. */}
              {progress === null ? (
                <span className="st-project__state">{chip}</span>
              ) : (
                <span className="st-project__bar">
                  <span className="st-project__track" aria-hidden="true">
                    <span className="st-project__fill" style={{ width: `${progress * 100}%` }} />
                  </span>
                  {chip}
                </span>
              )}
            </>
          }
          controls={
            <span className="st-project__go" aria-hidden="true">
              <StIcon name="chevron" size={20} />
            </span>
          }
        />
      </A>
      <span className="st-project__move">
        <MoveToSeries ws={ws} kind="story" id={story.storyId} title={story.title} current={story.seriesId ?? null} onMoved={() => onMoved?.()} />
      </span>
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
/**
 * The models by key: a model's name, and its label, maker and host, so a helper is named after the model that did
 * the work (§45.36 E7).
 */
function useModelNames(ws: string): { modelName: (key: string) => string; lookup: ModelLookup } {
  const ai = useLoad(() => storiesApi().getAi(ws).catch(() => null), ws, "st-library-models");
  const lookup: ModelLookup = (key) => ai.data?.models.find((m) => m.key === key) ?? null;
  return { modelName: (key) => lookup(key)?.label ?? key, lookup };
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
  const { modelName, lookup } = useModelNames(ws);
  const topics = useTopics(ws);
  return (
    <section className="st-details st-glass" aria-labelledby="st-details-title">
      <h2 className="st-details__title st-display" id="st-details-title">
        <span className="st-details__icon" aria-hidden="true">
          <StIcon name="clock" size={20} />
        </span>
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
                  <dd>{topicTitle(topics, job.meta.safetyTopicId) ?? "None (just the basic safety check)"}</dd>
                </div>
                {Object.entries(job.meta.providers).map(([kind, id]) => (
                  <div key={kind}>
                    <dt>{HELPER_KIND[kind] ?? "Helper"}</dt>
                    <dd>{helperName(kind, id, job.meta.writerModel, lookup)}</dd>
                  </div>
                ))}
                {(job.meta.models ?? []).map((m, i) => (
                  <div key={`${m.step}|${m.task ?? ""}|${i}`}>
                    <dt>{modelUseWords(m, STEP_WORDS)}</dt>
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
                    {(job.meta.models ?? []).some((m) => modelIdLine(m)) ? (
                      <div>
                        <dt>Exact models</dt>
                        <dd>
                          <ul className="st-tech__ids">
                            {(job.meta.models ?? []).map((m, i) =>
                              modelIdLine(m) ? (
                                <li key={`id|${m.step}|${m.task ?? ""}|${i}`}>
                                  {modelUseWords(m, STEP_WORDS)}: <span className="st-facts__code">{modelIdLine(m)}</span>
                                </li>
                              ) : null,
                            )}
                          </ul>
                        </dd>
                      </div>
                    ) : null}
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
  const cover = pictures.get(`cover:${story.storyId}`) ?? story.coverUrl;
  const progress = storyProgress(story.status);
  // The hero, its files by group, and "How it was made": from 1100 px the card stands beside the hero and the files,
  // so the lit hero is as wide as the files under it.
  return (
    <div className="st-projectview">
      {/* The project's hero: lit glass (its rim may bend where the device allows), the cover, the title, its state. The
          way back is a round glass button with its words beside it (one link: the button and the words). */}
      <Glass as="header" variant="hero" lens className="st-projectview__head">
        <A href={storiesHref({ name: "library", kind: null, storyId: null })} className="st-back st-projectview__back">
          <span className="st-projectview__puck" aria-hidden="true">
            <StIcon name="chevron" size={20} className="st-back__icon" />
          </span>
          All projects
        </A>
        <div className="st-projectview__hero">
          <span className="st-projectview__cover">{cover ? <img src={cover} alt="" decoding="async" /> : <StIcon name="clapper" size={34} />}</span>
          <div className="st-projectview__text">
            <h2 className="st-projectview__title st-display">{story.title}</h2>
            <p className="st-projectview__meta">
              <StateLabel status={story.status} />
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
            {progress !== null ? (
              <span className="st-projectview__bar" role="progressbar" aria-label={status.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
                <span className="st-projectview__fill" style={{ width: `${progress * 100}%` }} />
              </span>
            ) : null}
          </div>
        </div>
      </Glass>
      <div className="st-projectview__files">
        {files.error && !files.data ? (
          <StError message={files.error} onRetry={() => void files.reload()} />
        ) : !files.data ? (
          <StLoading label="Opening the project…" />
        ) : files.data.length === 0 ? (
          <LibraryEmpty mood="sleepy" tone="sun" title="No files yet">
            This video's files show up here as it is made.
          </LibraryEmpty>
        ) : (
          GROUPS.map((g) => {
            const items = files.data!.filter((f) => g.kinds.includes(f.kind));
            if (!items.length) return null;
            return (
              <section key={g.title} className="st-group" aria-label={g.title}>
                <h3 className="st-group__title st-plate st-display">{g.title}</h3>
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
      <LibraryEmpty mood="think" tone="sun" title="We could not find that project" action={<StLinkButton href="/stories/library" main>See every project</StLinkButton>}>
        It may have been deleted.
      </LibraryEmpty>
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
      <LibraryEmpty mood={EMPTY.projects.mood} tone={EMPTY.projects.tone} title={EMPTY.projects.title} action={<StLinkButton href="/stories/production/new" main>Make a video</StLinkButton>}>
        {EMPTY.projects.text}
      </LibraryEmpty>
    );
  return (
    <>
      <ul className="st-projects">
        {stories.data.map((s, i) => (
          <ProjectCard key={s.storyId} ws={ws} story={s} cover={covers.get(`cover:${s.storyId}`)} cast={cast} featured={i === 0} onMoved={() => void stories.reload()} />
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
  const series = page.name === "library" ? filterOf(page) : "all";
  const seriesId = seriesQuery(series);
  const { list: seriesList } = useSeriesList(ws);
  const tab = tabFor(kind);
  const stories = usePaged(
    async (cursor) => {
      const q = cursor ? { status: "all" as const, limit: 50, cursor } : { status: "all" as const, limit: 50 };
      const r = await storiesApi().listStories(ws, seriesId ? { ...q, seriesId } : q);
      return { items: r.stories, nextCursor: r.nextCursor };
    },
    seriesId ? `${ws}|${seriesId}` : ws,
    "st-library-story-pages",
    (s) => s.storyId,
  );
  const cast = useLoad(() => storiesApi().listCharacters(ws), ws, "st-library-cast");
  const go = (next: LibraryTab, story: string | null = storyId) => {
    const q = new URLSearchParams();
    if (next !== "projects") q.set("kind", next);
    if (story) q.set("story", story);
    if (seriesId) q.set("series", seriesId);
    const qs = q.toString();
    navigate(`/stories/library${qs ? `?${qs}` : ""}`, { replace: true });
  };
  // On a phone the kinds are one row that scrolls sideways: the chosen pill is always brought into view (at once the
  // first time, then with a short glide unless motion is calm).
  const kinds = useRef<HTMLDivElement>(null);
  const shown = useRef(false);
  useLayoutEffect(() => {
    const box = kinds.current;
    const on = box?.querySelector<HTMLElement>(".st-tabs__tab.is-on");
    const first = !shown.current;
    shown.current = true;
    if (!box || !on || box.scrollWidth <= box.clientWidth + 1) return;
    const room = parseFloat(getComputedStyle(box).scrollPaddingInlineStart) || 0;
    const start = on.offsetLeft - room;
    const end = on.offsetLeft + on.offsetWidth + room - box.clientWidth;
    const left = box.scrollLeft > start ? start : box.scrollLeft < end ? end : box.scrollLeft;
    if (Math.abs(left - box.scrollLeft) < 1) return;
    if (typeof box.scrollTo === "function") box.scrollTo({ left, behavior: first || storiesReduceMotion() ? "auto" : "smooth" });
    else box.scrollLeft = left;
  }, [tab]);
  return (
    <section className="st-page st-library">
      <StPageHead
        title="Library"
        lede="Your Clips Funded files. Clip Factory's files stay separate."
        actions={
          seriesList?.length ? (
            <SeriesSwitch ws={ws} value={series} onChange={(v) => navigate(storiesHref({ name: "library", kind, storyId: null, ...(seriesQuery(v) ? { seriesId: seriesQuery(v) } : {}) }))} />
          ) : undefined
        }
      />
      {/* The kinds as pills (the reference's chips): the chosen one solid cream with espresso words, sliding on
          <Glide>; the rest glass. Each keeps .st-tabs__tab and role="tab". One row on a phone, scrolling sideways. */}
      <div className="st-library__kinds" role="tablist" aria-label="Library" ref={kinds}>
        <Glide active=".st-tabs__tab.is-on" className="st-library__glide" />
        {TABS.map((t) => (
          <GlassPill
            key={t.id}
            role="tab"
            aria-selected={t.id === tab}
            active={t.id === tab}
            icon={<StIcon name={t.icon} size={18} />}
            className="st-tabs__tab"
            onClick={() => go(t.id, t.id === "projects" ? null : storyId)}
          >
            {t.label}
          </GlassPill>
        ))}
      </div>
      <div role="tabpanel" aria-label={TABS.find((t) => t.id === tab)!.label} className="st-library__panel">
        {tab === "projects" ? (
          <Projects ws={ws} storyId={storyId} stories={stories} cast={cast.data} />
        ) : (
          <Files ws={ws} tab={tab} storyId={storyId} stories={stories.data} onClear={() => go(tab, null)} seriesId={seriesId} />
        )}
      </div>
    </section>
  );
}
