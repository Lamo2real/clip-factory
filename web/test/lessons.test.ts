import { describe, expect, it } from "vitest";
import { seed } from "../src/api/mock/fixtures.ts";
import { lessonsApi, type LessonsFault } from "../src/api/mock/lessons.ts";
import type { LessonEvidence, LessonsView } from "../src/api/types.ts";
import { searchSettings } from "../src/lib/settingsTree.ts";
import { evidenceLine, groupLessons, LEARNED_INTRO, neededLine, statusChip } from "../src/screens/settings/LearnedBranch.tsx";

const fresh = (fault?: LessonsFault) => {
  const store = seed();
  return lessonsApi(() => store.clips, () => fault, async () => undefined);
};

const ev = (winners: number, measured: number, baseline: "creator" | "all" = "creator"): LessonEvidence => ({
  baseline,
  measured,
  winners,
  medianViews: 1000,
  winnerViews: [],
  trait: { winnersWith: 3, winnersKnown: 4, othersWith: 1, othersKnown: 20, winnerPercent: 75, otherPercent: 5, sources: 3 },
  computedAt: "2026-11-18T05:00:00.000Z",
});

describe("What it learned: the words (§16.12)", () => {
  it("says the evidence in plain words, from the numbers it was given", () => {
    expect(evidenceLine(ev(4, 31))).toBe("4 of 31 clips did much better than normal");
    expect(evidenceLine(ev(3, 40, "all"))).toBe("3 of 40 clips from all your creators did much better than normal");
    expect(evidenceLine(undefined)).toBeNull();
  });

  it("names the status chips", () => {
    expect(statusChip("trial").text).toBe("Trying it");
    expect(statusChip("active").text).toBe("Using it");
    expect(statusChip("off").text).toBe("Turned off");
  });

  it("says how many more posted clips are needed, and nothing when there are enough", () => {
    expect(neededLine(12)).toBe("Needs 12 more posted clips");
    expect(neededLine(1)).toBe("Needs 1 more posted clip");
    expect(neededLine(0)).toBeNull();
  });

  it("has the one-line explanation at the top", () => {
    expect(LEARNED_INTRO).toBe(
      "Every day Clip Factory checks your clips 7 days after posting. Lessons it is sure about go to your skills as Prior learnings.",
    );
  });

  it("is found by search", () => {
    for (const q of ["lessons", "prior learnings", "what it learned"])
      expect(searchSettings(q)[0]!.href).toBe("/settings/clip-making/learned#what-it-learned");
  });
});

describe("grouping by creator", () => {
  it("puts named creators first by name, all creators last, and status lines only where there are no lessons", async () => {
    const view = await fresh().listLessons();
    const groups = groupLessons(view);
    expect(groups.map((g) => g.name)).toEqual(["Big Streamer", "Quiet Corner", "All creators"]);
    expect(groups[0]!.lessons.map((l) => l.platform)).toEqual(["youtube", "tiktok", "youtube"]);
    expect(groups[0]!.needs).toEqual([]);
    expect(groups[1]!.needs).toEqual([{ platform: "youtube", needed: 12 }]);
  });

  it("shows nothing at all before the first check", () => {
    const empty: LessonsView = { lessons: [], creators: [] };
    expect(groupLessons(empty)).toEqual([]);
  });
});

describe("mock lessons follow the API rules", () => {
  it("lists lessons citing real clips", async () => {
    const store = seed();
    const api = lessonsApi(() => store.clips, () => undefined, async () => undefined);
    const { lessons } = await api.listLessons();
    expect(lessons).toHaveLength(4);
    const ids = new Set(store.clips.map((c) => c.clipId));
    for (const l of lessons) for (const c of l.clips) expect(ids.has(c.clipId)).toBe(true);
  });

  it("never cites one winner clip in two lessons (a winner belongs to one creator and one platform)", async () => {
    const { lessons } = await fresh().listLessons();
    const cited = lessons.flatMap((l) => l.clipIds);
    expect(new Set(cited).size).toBe(cited.length);
    for (const l of lessons) expect(l.evidence!.winnerViews.map((w) => w.clipId)).toEqual(l.clipIds);
  });

  it("leaves a lesson that is too old as it is", async () => {
    const api = fresh();
    const { lessons } = await api.listLessons();
    const old = lessons.find((l) => l.status === "expired")!;
    expect(old.clips).toEqual([]); // its winner clips are gone
    expect((await api.setLessonStatus(old.lessonId, "off")).status).toBe("expired");
  });

  it("turns a lesson off and back to what it was", async () => {
    const api = fresh();
    const { lessons } = await api.listLessons();
    const active = lessons.find((l) => l.status === "active")!;
    expect((await api.setLessonStatus(active.lessonId, "off")).status).toBe("off");
    expect((await api.setLessonStatus(active.lessonId, "on")).status).toBe("active");
  });

  it("deletes for good", async () => {
    const api = fresh();
    const { lessons } = await api.listLessons();
    await api.deleteLesson(lessons[0]!.lessonId);
    expect((await api.listLessons()).lessons.map((l) => l.lessonId)).not.toContain(lessons[0]!.lessonId);
    await expect(api.setLessonStatus(lessons[0]!.lessonId, "on")).rejects.toMatchObject({ status: 404 });
  });

  it("has the empty and not-enough states for tests", async () => {
    expect(await fresh("empty").listLessons()).toEqual({ lessons: [], creators: [] });
    const few = await fresh("needs-more").listLessons();
    expect(few.lessons).toEqual([]);
    expect(groupLessons(few)[0]!.needs).toEqual([{ platform: "youtube", needed: 12 }]);
  });
});
