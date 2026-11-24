// Lamo Stories mock: the series part (docs/CONTRACTS.md §45.44, §45.16.8). A series is a folder of story videos with
// a short running memory, the story so far. Like the API, a series keeps only the owner's fields, the story so far and
// the episode summaries; its episodes (approved and published stories, numbered in the order of approval), the counts
// and the cover are worked out on every read. An approval in a series writes the episode's summary and the story so
// far at once (seriesApproved; knob recapFail: the recap fails, so "Write it again" shows). Deleting a series never
// deletes a video: its ideas and videos move to No series.
import type { AiTask, Series, SeriesInput, SeriesPatch, StoriesApi, Story } from "../types.ts";
import { SEED_CAR_ID } from "./characters.ts";
import { delay, type MockStore, type StoredSeries } from "./store.ts";
import { clone, fail, guardWs, iso, mockId, SEED_IDS } from "./stories.ts";

export const KEYS = ["listSeries", "createSeries", "getSeries", "patchSeries", "deleteSeries", "moveStoryToSeries", "recapEpisode"] as const;

/** "My first car": Pip and Rosso, with the published sandwich tower as its first episode. */
export const SEED_SERIES_ID = "01JSTSR0000000000000000001";

const NAME_MAX = 40;
const LINE_MAX = 120;
const STORY_SO_FAR_MAX = 1500;
const SUMMARY_MAX = 400;
const MAX_SERIES = 50;
const EPISODE: Story["status"][] = ["approved", "published"];
const MAKING: Story["status"][] = ["draft", "producing", "failed"];
const REVIEW: Story["status"][] = ["needs_check", "review"];

export const GONE = "That series is gone.";
export const CHANGED = "Someone changed this meanwhile. Look again, then save.";
export const RECAP_FAILED = "Clips Funded could not write the story so far. Tap Write it again.";

const tidy = (s: string) => s.replace(/\s+/g, " ").trim();

export function seriesExists(store: MockStore, ws: string, id: string): boolean {
  return store.series.some((s) => s.seriesId === id && s.workspaceId === ws);
}

function find(store: MockStore, ws: string, id: string): StoredSeries {
  const found = store.series.find((s) => s.seriesId === id && s.workspaceId === ws);
  if (!found) fail(404, "not_found", GONE);
  return found;
}

/** The series' episodes in the order of approval (the API's rule). */
function episodesOf(store: MockStore, s: StoredSeries): Story[] {
  return store.stories
    .filter((x) => x.workspaceId === s.workspaceId && x.seriesId === s.seriesId && EPISODE.includes(x.status))
    .sort((a, b) => (a.approvedAt ?? a.updatedAt).localeCompare(b.approvedAt ?? b.updatedAt) || a.storyId.localeCompare(b.storyId));
}

function portraitOf(store: MockStore, characterId: string | undefined): string | null {
  return store.characters.find((c) => c.characterId === characterId)?.portrait?.url ?? null;
}

/** The public Series (§45.6): episodes numbered 1..N, the counts and the cover worked out now. */
function shown(store: MockStore, s: StoredSeries): Series {
  const cast = s.castIds.filter((id) => store.characters.some((c) => c.characterId === id && c.workspaceId === s.workspaceId));
  const summaries = new Map(s.summaries.map((x) => [x.storyId, x]));
  const episodes = episodesOf(store, s).map((st, i) => {
    const sum = summaries.get(st.storyId);
    return {
      storyId: st.storyId,
      number: i + 1,
      title: st.title,
      status: st.status as "approved" | "published",
      summary: sum?.summary ?? null,
      by: sum?.by ?? null,
      approvedAt: st.approvedAt ?? st.updatedAt,
      ...(st.coverUrl ? { coverUrl: st.coverUrl } : {}),
    };
  });
  const mine = store.stories.filter((x) => x.workspaceId === s.workspaceId && x.seriesId === s.seriesId);
  const counts = {
    ideas: store.ideas.filter((i) => i.workspaceId === s.workspaceId && i.seriesId === s.seriesId && i.status === "saved").length,
    making: mine.filter((x) => MAKING.includes(x.status)).length,
    review: mine.filter((x) => REVIEW.includes(x.status)).length,
    done: mine.filter((x) => EPISODE.includes(x.status)).length,
  };
  let coverUrl: string | null = null;
  if (s.cover && "storyId" in s.cover) coverUrl = store.stories.find((x) => x.storyId === (s.cover as { storyId: string }).storyId)?.coverUrl ?? null;
  else if (s.cover && "characterId" in s.cover) coverUrl = portraitOf(store, s.cover.characterId);
  coverUrl ??= [...episodes].reverse().find((e) => e.coverUrl)?.coverUrl ?? null;
  coverUrl ??= portraitOf(store, cast[0]);
  return clone({
    seriesId: s.seriesId,
    workspaceId: s.workspaceId,
    name: s.name,
    line: s.line,
    castIds: cast,
    cover: s.cover,
    coverUrl,
    storySoFar: s.storySoFar,
    storySoFarBy: s.storySoFarBy,
    storySoFarAt: s.storySoFarAt,
    episodes,
    counts,
    recap: s.recap,
    version: s.version,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  });
}

function checkName(store: MockStore, ws: string, raw: unknown, except?: string): string {
  const name = tidy(typeof raw === "string" ? raw : "");
  if (!name) fail(400, "bad_request", "Give your series a name.");
  if (name.length > NAME_MAX) fail(400, "bad_request", "Keep the name to 40 letters.");
  const taken = store.series.find((s) => s.workspaceId === ws && s.seriesId !== except && tidy(s.name).toLowerCase() === name.toLowerCase());
  if (taken) fail(409, "conflict", `You already have a series called ${taken.name}.`);
  return name;
}

function checkLine(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const line = tidy(String(raw));
  if (line.length > LINE_MAX) fail(400, "bad_request", "Keep the line to 120 letters.");
  return line || null;
}

/** The API's cast rule (characters.cast_problem): each character is the workspace's, one car at most, with a driver. */
function checkCast(store: MockStore, ws: string, ids: string[] | undefined): string[] {
  const list = [...new Set(ids ?? [])];
  if (list.length > 3) fail(400, "bad_request", "Pick up to 3 characters.");
  const chars = list.map((id) => store.characters.find((c) => c.characterId === id && c.workspaceId === ws));
  if (chars.some((c) => !c)) fail(400, "bad_request", "We could not find one of those characters. Pick them again.");
  const cars = chars.filter((c) => c?.kind === "car").length;
  if (cars > 1) fail(400, "bad_request", "Pick one car.");
  if (cars === 1 && cars === chars.length) fail(400, "bad_request", "Add someone to drive it.");
  return list;
}

function namesOf(store: MockStore, s: StoredSeries): { people: string[]; car: string | null } {
  const chars = s.castIds.map((id) => store.characters.find((c) => c.characterId === id)).filter((c) => !!c);
  return { people: chars.filter((c) => c.kind !== "car").map((c) => c.name), car: chars.find((c) => c.kind === "car")?.name ?? null };
}

/** The practice recap: a summary from the video's own line, and the story so far's four parts brought up to date. */
function recapOf(store: MockStore, s: StoredSeries, story: Story): { summary: string; storySoFar: string } {
  const { people, car } = namesOf(store, s);
  const who = [...people, ...(car ? [car] : [])].join(" and ") || "The cast";
  const n = episodesOf(store, s).findIndex((x) => x.storyId === story.storyId) + 1 || episodesOf(store, s).length + 1;
  // The video's own scenes say what happened (a practice recap: the real one reads the script).
  const scenes = story.scenes.map((x) => x.title).filter(Boolean).slice(0, 3);
  const what = scenes.length ? `${scenes.join(", then ")}` : "a new day together";
  const summary = `Episode ${n}, ${story.title}: ${who}. ${what}.`.slice(0, SUMMARY_MAX);
  const stands = `Where things stand: after "${story.title}", ${who} are ready for the next day.`;
  let storySoFar: string;
  if (s.storySoFarBy === "owner" && s.storySoFar) {
    const kept = s.storySoFar.split("\n").filter((l) => !l.startsWith("Where things stand:"));
    storySoFar = [...kept, stands].join("\n");
  } else {
    storySoFar = [`Who: ${who}.`, "Places: home, the car park and the town road.", `Running jokes: ${people[0] ?? "the driver"} forgets where the car is parked.`, stands].join("\n");
  }
  return { summary, storySoFar: storySoFar.slice(0, STORY_SO_FAR_MAX) };
}

function writeRecap(store: MockStore, s: StoredSeries, story: Story): void {
  const at = iso();
  const { summary, storySoFar } = recapOf(store, s, story);
  s.summaries = [...s.summaries.filter((x) => x.storyId !== story.storyId), { storyId: story.storyId, summary, by: "ai" as const, at }].slice(-50);
  s.storySoFar = storySoFar;
  s.storySoFarBy = "ai";
  s.storySoFarAt = at;
  s.recap = null;
  s.version += 1;
  s.updatedAt = at;
}

/** An approval of a story filed in a series (the API's after_approve): its summary and the story so far, at once. */
export function seriesApproved(store: MockStore, story: Story): void {
  const s = story.seriesId ? store.series.find((x) => x.seriesId === story.seriesId && x.workspaceId === story.workspaceId) : undefined;
  if (!s) return;
  if (store.knobs.recapFail) {
    s.recap = { taskId: mockId(), storyId: story.storyId, status: "failed", error: RECAP_FAILED };
    return;
  }
  writeRecap(store, s, story);
}

/** A story moved out or deleted: its summary goes from every series. */
export function seriesForgetStory(store: MockStore, storyId: string): void {
  for (const s of store.series) {
    if (!s.summaries.some((x) => x.storyId === storyId)) continue;
    s.summaries = s.summaries.filter((x) => x.storyId !== storyId);
    s.version += 1;
    s.updatedAt = iso();
  }
}

export function seed(store: MockStore): void {
  const at = Date.now() - 9 * 86_400_000;
  const { characters: C, stories: S } = SEED_IDS;
  store.series.push({
    seriesId: SEED_SERIES_ID,
    workspaceId: "stories",
    name: "My first car",
    line: "He buys a car and drives it",
    castIds: [C.pip, SEED_CAR_ID],
    cover: null,
    storySoFar: [
      "Who: Pip and Rosso, the small red hatchback, and Pip's friend Dash.",
      "Places: the car park and the town road.",
      "Running jokes: Pip forgets where Rosso is parked, and builds snacks too tall.",
      "Where things stand: Pip bought Rosso, and his sandwich tower fell off its roof.",
    ].join("\n"),
    storySoFarBy: "ai",
    storySoFarAt: iso(at + 86_400_000),
    summaries: [{ storyId: S.published, summary: "Pip built the tallest sandwich ever on Rosso's roof in the car park. Dash wanted a bite, Rosso honked, and the tower fell.", by: "ai", at: iso(at + 86_400_000) }],
    recap: null,
    version: 2,
    createdAt: iso(at),
    updatedAt: iso(at + 86_400_000),
  });
}

/** Once every part has seeded: the first episode is the seeded published story. */
export function afterSeed(store: MockStore): void {
  const first = store.stories.find((s) => s.storyId === SEED_IDS.stories.published);
  if (first && seriesExists(store, first.workspaceId, SEED_SERIES_ID)) first.seriesId = SEED_SERIES_ID;
}

export function api(store: MockStore): Pick<StoriesApi, (typeof KEYS)[number]> {
  const story = (ws: string, storyId: string) => {
    const found = store.stories.find((s) => s.storyId === storyId && s.workspaceId === ws);
    if (!found) fail(404, "not_found", "We could not find that story.");
    return found;
  };
  return {
    async listSeries(ws) {
      guardWs(store, ws);
      await delay(120);
      return store.series
        .filter((s) => s.workspaceId === ws)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((s) => shown(store, s));
    },
    async createSeries(ws, input: SeriesInput) {
      guardWs(store, ws);
      await delay(160);
      if (store.series.filter((s) => s.workspaceId === ws).length >= MAX_SERIES) fail(409, "conflict", "You have 50 series. Delete one to make another.");
      const name = checkName(store, ws, input.name);
      const line = checkLine(input.line);
      const castIds = checkCast(store, ws, input.castIds);
      const at = iso();
      const s: StoredSeries = {
        seriesId: mockId(),
        workspaceId: ws,
        name,
        line,
        castIds,
        cover: null,
        storySoFar: "",
        storySoFarBy: null,
        storySoFarAt: null,
        summaries: [],
        recap: null,
        version: 1,
        createdAt: at,
        updatedAt: at,
      };
      store.series.push(s);
      return shown(store, s);
    },
    async getSeries(ws, seriesId) {
      guardWs(store, ws);
      await delay(100);
      return shown(store, find(store, ws, seriesId));
    },
    async patchSeries(ws, seriesId, patch: SeriesPatch) {
      guardWs(store, ws);
      await delay(140);
      const s = find(store, ws, seriesId);
      if (patch.version !== s.version) fail(409, "conflict", CHANGED);
      const changes = Object.keys(patch).filter((k) => k !== "version");
      if (!changes.length) fail(400, "bad_request", "Nothing to change.");
      const next: Partial<StoredSeries> = {};
      if (patch.name !== undefined) next.name = checkName(store, ws, patch.name, seriesId);
      if (patch.line !== undefined) next.line = checkLine(patch.line);
      if (patch.castIds !== undefined) next.castIds = checkCast(store, ws, patch.castIds);
      if (patch.cover !== undefined) {
        if (patch.cover && "storyId" in patch.cover && store.stories.find((x) => x.storyId === (patch.cover as { storyId: string }).storyId)?.seriesId !== seriesId)
          fail(400, "bad_request", "Pick a cover from this series' videos.");
        next.cover = patch.cover;
      }
      if (patch.storySoFar !== undefined) {
        const text = patch.storySoFar.trim();
        if (text.length > STORY_SO_FAR_MAX) fail(400, "bad_request", "Keep the story so far to 1500 letters.");
        Object.assign(next, { storySoFar: text, storySoFarBy: text ? "owner" : null, storySoFarAt: iso() });
      }
      Object.assign(s, next, { version: s.version + 1, updatedAt: iso() });
      return shown(store, s);
    },
    async deleteSeries(ws, seriesId) {
      guardWs(store, ws);
      await delay(140);
      find(store, ws, seriesId);
      store.series = store.series.filter((s) => s.seriesId !== seriesId);
      // Its videos and ideas stay, under No series.
      for (const st of store.stories)
        if (st.workspaceId === ws && st.seriesId === seriesId) {
          delete st.seriesId;
          st.version += 1;
          st.updatedAt = iso();
        }
      for (const idea of store.ideas) if (idea.workspaceId === ws && idea.seriesId === seriesId) delete idea.seriesId;
    },
    async moveStoryToSeries(ws, storyId, seriesId) {
      guardWs(store, ws);
      await delay(140);
      const st = story(ws, storyId);
      const target = seriesId === null ? null : find(store, ws, seriesId);
      const before = st.seriesId;
      if ((before ?? null) === seriesId) return clone(st);
      if (target) st.seriesId = target.seriesId;
      else delete st.seriesId;
      st.version += 1;
      st.updatedAt = iso();
      if (before) {
        const old = store.series.find((s) => s.seriesId === before);
        if (old?.summaries.some((x) => x.storyId === storyId)) {
          old.summaries = old.summaries.filter((x) => x.storyId !== storyId);
          old.version += 1;
        }
      }
      if (target && EPISODE.includes(st.status)) seriesApproved(store, st);
      return clone(st);
    },
    async recapEpisode(ws, seriesId, storyId) {
      guardWs(store, ws);
      await delay(160);
      const s = find(store, ws, seriesId);
      const st = story(ws, storyId);
      if (st.seriesId !== seriesId || !EPISODE.includes(st.status)) fail(409, "conflict", "Only an approved video of this series gets a summary.");
      writeRecap(store, s, st);
      const at = iso();
      const task: AiTask = {
        taskId: mockId(),
        kind: "series_recap",
        status: "done",
        model: "sonnet-5-5",
        effort: "low",
        effortApplied: true,
        result: { seriesId, storyId, episodeSummary: s.summaries.at(-1)?.summary ?? "", storySoFar: s.storySoFar },
        createdAt: at,
        updatedAt: at,
      };
      store.tasks.push(task);
      return clone(task);
    },
  };
}
