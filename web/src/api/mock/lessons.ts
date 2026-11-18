// The lessons routes of docs/CONTRACTS.md §16.12 in memory: what the daily check learned from clips that did much
// better than normal 7 days after posting, with the same rules as the API (turn off and back on, delete for good).
import { ApiError } from "../errors.ts";
import type { Api, Clip, Lesson, LessonCreator, LessonsView } from "../types.ts";

/** Test knob (window.__cfMockFaults.lessons): "empty" = the daily check never ran; "needs-more" = too few clips. */
export type LessonsFault = "empty" | "needs-more";

const notFound = () => new ApiError(404, "not_found", "We could not find that lesson. Reload the page.");
const bad = (msg: string) => new ApiError(400, "bad_request", msg, "status");

const BIG = "youtube:id:UCbigstreamer000000000000";
const QUIET = "kick:name:quiet corner";
const day = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * day).toISOString();
const ahead = (days: number) => new Date(Date.now() + days * day).toISOString();

/** A winner clip that is no longer in the store (deleted since): the API keeps it in the evidence, never as a link. */
const gone = (n: number) => `01JGONE${String(n).padStart(19, "0")}`;

function evidence(
  winners: string[],
  measured: number,
  median: number,
  withTrait: number,
  others: [number, number],
  baseline: "creator" | "all" = "creator",
): Lesson["evidence"] {
  return {
    baseline,
    measured,
    winners: winners.length,
    medianViews: median,
    winnerViews: winners.map((clipId, i) => ({ clipId, postId: `P${clipId.slice(-6)}`, views: median * (3 + i) })),
    trait: {
      winnersWith: withTrait,
      winnersKnown: winners.length,
      othersWith: others[0],
      othersKnown: others[1],
      winnerPercent: Math.round((100 * withTrait) / winners.length),
      otherPercent: Math.round((100 * others[0]) / others[1]),
      sources: Math.min(3, withTrait),
    },
    computedAt: ago(1),
  };
}

/** The seeded lessons, citing real clips of the mock store (ids change on every load). Like the API, a winner clip
 * belongs to one lesson group only (one creator, one platform), and cited clips that are gone are not shown. */
export function seedLessons(clips: Clip[]): { lessons: Lesson[]; creators: LessonCreator[] } {
  const posted = clips.filter((c) => c.status === "posted");
  const ids = (from: number, n: number) => posted.slice(from, from + n).map((c) => c.clipId);
  const shown = (list: string[]) =>
    list.flatMap((id) => {
      const c = posted.find((p) => p.clipId === id);
      return c ? [{ clipId: c.clipId, hook: c.hook }] : [];
    });
  const lesson = (partial: Omit<Lesson, "kind" | "clipIds" | "clips">, cited: string[]): Lesson => ({
    kind: "creator",
    ...partial,
    clipIds: cited,
    clips: shown(cited),
  });
  const bigYoutube = ids(0, 3);
  const bigTiktok = ids(3, 3);
  const everyone = [...ids(6, 1), gone(1), gone(2)];
  const old = [gone(3), gone(4), gone(5)];
  const lessons: Lesson[] = [
    lesson(
      {
        lessonId: "a1b2c3d4e5f60718293a4b5c",
        creatorKey: BIG,
        creatorName: "Big Streamer",
        scope: "creator",
        platform: "youtube",
        trait: "start:instant",
        traitLabel: "talking right away (in the first half second)",
        text: "Start on the reaction itself: the first words should already be the scream or the laugh.",
        status: "active",
        evidence: evidence(bigYoutube, 31, 1200, 3, [5, 27]),
        createdAt: ago(16),
        confirmedAt: ago(4),
        expiresAt: ahead(86),
      },
      bigYoutube,
    ),
    lesson(
      {
        lessonId: "b2c3d4e5f60718293a4b5c6d",
        creatorKey: BIG,
        creatorName: "Big Streamer",
        scope: "creator",
        platform: "tiktok",
        trait: "hook:short",
        traitLabel: "short hooks of 5 words or fewer",
        text: "Keep hooks to 5 words or fewer, like a shout from the moment.",
        status: "trial",
        evidence: evidence(bigTiktok, 24, 3400, 3, [4, 21]),
        createdAt: ago(2),
        expiresAt: ahead(88),
      },
      bigTiktok,
    ),
    lesson(
      {
        lessonId: "d4e5f60718293a4b5c6d7e8f",
        creatorKey: BIG,
        creatorName: "Big Streamer",
        scope: "creator",
        platform: "youtube",
        trait: "length:20-30",
        traitLabel: "clips of 20 to 30 seconds",
        text: "Clips of 20 to 30 seconds keep people watching to the end.",
        status: "expired",
        evidence: evidence(old, 26, 1000, 3, [6, 23]),
        createdAt: ago(120),
        confirmedAt: ago(95),
        expiresAt: ago(5),
      },
      old,
    ),
    lesson(
      {
        lessonId: "c3d4e5f60718293a4b5c6d7e",
        creatorKey: "*",
        creatorName: "",
        scope: "all",
        platform: "youtube",
        trait: "moment:chaos",
        traitLabel: "chaos moments",
        text: "Chaos moments that build to one big crash do best. Lean toward them over slow talk.",
        status: "off",
        evidence: evidence(everyone, 40, 900, 3, [6, 37], "all"),
        createdAt: ago(30),
        confirmedAt: ago(20),
        expiresAt: ahead(70),
      },
      everyone,
    ),
  ];
  const creators: LessonCreator[] = [
    { creatorKey: BIG, creatorName: "Big Streamer", platforms: { youtube: { measured: 31, needed: 0, winners: 3 }, tiktok: { measured: 24, needed: 0, winners: 3 } } },
    { creatorKey: QUIET, creatorName: "Quiet Corner", platforms: { youtube: { measured: 9, needed: 12, winners: 0 } } },
    { creatorKey: "*", creatorName: "", platforms: { youtube: { measured: 40, needed: 0, winners: 3 }, tiktok: { measured: 24, needed: 0, winners: 0 } } },
  ];
  return { lessons, creators };
}

export function lessonsApi(
  clips: () => Clip[],
  fault: () => LessonsFault | undefined,
  delay: () => Promise<void>,
): Pick<Api, "listLessons" | "setLessonStatus" | "deleteLesson"> {
  let state: { lessons: Lesson[]; creators: LessonCreator[] } | null = null;
  const deleted = new Set<string>();
  const data = () => (state ??= seedLessons(clips()));
  const find = (lessonId: string) => {
    const hit = data().lessons.find((l) => l.lessonId === lessonId && !deleted.has(lessonId));
    if (!hit) throw notFound();
    return hit;
  };
  const before = new Map<string, Lesson["status"]>();
  return {
    async listLessons(): Promise<LessonsView> {
      await delay();
      const f = fault();
      if (f === "empty") return { lessons: [], creators: [] };
      if (f === "needs-more")
        return {
          lessons: [],
          creators: [{ creatorKey: QUIET, creatorName: "Quiet Corner", platforms: { youtube: { measured: 9, needed: 12, winners: 0 } } }],
          checkedAt: ago(0.2),
        };
      const { lessons, creators } = data();
      return structuredClone({ lessons: lessons.filter((l) => !deleted.has(l.lessonId)), creators, checkedAt: ago(0.2) });
    },
    async setLessonStatus(lessonId, to) {
      await delay();
      if (to !== "off" && to !== "on") throw bad('status must be "off" or "on".');
      const lesson = find(lessonId);
      if (lesson.status === "expired") return structuredClone(lesson); // too old: nothing to turn off or on (API parity)
      if (to === "off" && lesson.status !== "off") {
        before.set(lessonId, lesson.status);
        lesson.status = "off";
      } else if (to === "on" && lesson.status === "off") {
        lesson.status = before.get(lessonId) ?? (lesson.confirmedAt ? "active" : "trial");
        before.delete(lessonId);
      }
      lesson.updatedAt = new Date().toISOString();
      return structuredClone(lesson);
    },
    async deleteLesson(lessonId) {
      await delay();
      find(lessonId);
      deleted.add(lessonId);
    },
  };
}
