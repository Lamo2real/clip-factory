// Settings › Clip making › What it learned (docs/CONTRACTS.md §16.12): every lesson the daily check learned from
// clips that did much better than normal 7 days after posting, grouped by creator, with the evidence in plain words,
// the winner clips, and two actions: Turn off / Turn on, and Delete (with a question first).
import { useState } from "react";
import { api } from "../../api/index.ts";
import { friendlyMessage } from "../../api/errors.ts";
import type { Lesson, LessonCreator, LessonEvidence, LessonStatus, LessonsView, Platform } from "../../api/types.ts";
import { Sheet } from "../../components/Sheet.tsx";
import { useToast } from "../../components/Toasts.tsx";
import { A, Button, ErrorPanel, Pill, Skeleton, type Tone } from "../../components/ui.tsx";
import { PLATFORM_LABEL, PLATFORM_ORDER, plural } from "../../lib/format.ts";
import { useLoad } from "../../lib/hooks.ts";
import { Apple, Panel } from "./parts.tsx";

export const LEARNED_INTRO = "Clip Factory checks each clip 7 days after posting. Lessons it is sure of join your skills as Prior learnings.";
export const ALL_CREATORS = "*";

const CHIPS: Record<LessonStatus, { text: string; tone: Tone }> = {
  trial: { text: "Trying it", tone: "neutral" },
  active: { text: "Using it", tone: "success" },
  off: { text: "Turned off", tone: "bone" },
  expired: { text: "Too old", tone: "warn" },
};

/** The chip on a lesson: Trying it, Using it, Turned off, Too old. */
export function statusChip(status: LessonStatus): { text: string; tone: Tone } {
  return CHIPS[status] ?? CHIPS.trial;
}

/** "4 of 31 clips did much better than normal" (numbers from the evidence, never made up). */
export function evidenceLine(ev: LessonEvidence | undefined): string | null {
  if (!ev || !Number.isFinite(ev.winners) || !Number.isFinite(ev.measured)) return null;
  const whose = ev.baseline === "all" ? " from all your creators" : "";
  return `${ev.winners} of ${plural(ev.measured, "clip")}${whose} did much better than normal`;
}

/** "Needs 12 more posted clips" for one platform, or null when there are enough. */
export function neededLine(needed: number | undefined): string | null {
  if (!needed || needed <= 0) return null;
  return `Needs ${needed} more posted ${needed === 1 ? "clip" : "clips"}`;
}

export interface CreatorGroup {
  key: string;
  name: string;
  lessons: Lesson[];
  /** Platforms that still need more posted clips, with how many. */
  needs: { platform: Platform; needed: number }[];
}

/** Lessons and status lines grouped by creator: named creators by name, then "All creators" last. */
export function groupLessons(view: LessonsView): CreatorGroup[] {
  const groups = new Map<string, CreatorGroup>();
  const group = (key: string, name: string) => {
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, name: key === ALL_CREATORS ? "All creators" : name || "A creator", lessons: [], needs: [] }));
    else if (name && g.name === "A creator") g.name = name;
    return g;
  };
  for (const l of view.lessons) group(l.creatorKey, l.creatorName ?? "").lessons.push(l);
  for (const c of view.creators) addNeeds(group(c.creatorKey, c.creatorName), c);
  return [...groups.values()]
    .filter((g) => g.lessons.length || g.needs.length)
    .sort((a, b) => Number(a.key === ALL_CREATORS) - Number(b.key === ALL_CREATORS) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

function addNeeds(g: CreatorGroup, c: LessonCreator) {
  for (const p of PLATFORM_ORDER) {
    const row = c.platforms[p];
    if (row && row.needed > 0 && !g.lessons.some((l) => l.platform === p)) g.needs.push({ platform: p, needed: row.needed });
  }
}

export function LearnedBranch() {
  const { data, error, reload, setData } = useLoad(() => api().listLessons());
  const groups = data ? groupLessons(data) : null;
  const replace = (next: Lesson) =>
    setData((d) => (d ? { ...d, lessons: d.lessons.map((l) => (l.lessonId === next.lessonId ? { ...l, ...next, clips: l.clips } : l)) } : d));
  const drop = (lessonId: string) => setData((d) => (d ? { ...d, lessons: d.lessons.filter((l) => l.lessonId !== lessonId) } : d));
  return (
    <Panel>
      <Apple id="what-it-learned" wide>
        <p className="learned__intro">{LEARNED_INTRO}</p>
        {error && !data ? <ErrorPanel message={error} onRetry={reload} /> : null}
        {!data && !error ? <Skeleton className="line-skel" /> : null}
        {groups && groups.length === 0 ? (
          <p className="muted learned__empty">Nothing yet. Lessons come 7 days after your clips post.</p>
        ) : null}
        {groups?.map((g) => (
          <section key={g.key} className="learned__group" aria-label={g.name}>
            <h3 className="learned__creator user-text">{g.name}</h3>
            {g.needs.map((n) => (
              <p key={n.platform} className="learned__needs" data-needs={n.platform}>
                {PLATFORM_LABEL[n.platform]}: {neededLine(n.needed)}
              </p>
            ))}
            {g.lessons.length ? (
              <ul className="learned__list" aria-label={`Lessons for ${g.name}`}>
                {g.lessons.map((l) => (
                  <li key={l.lessonId}>
                    <LessonCard lesson={l} onChange={replace} onDeleted={drop} />
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ))}
      </Apple>
    </Panel>
  );
}

function LessonCard({ lesson, onChange, onDeleted }: { lesson: Lesson; onChange: (l: Lesson) => void; onDeleted: (id: string) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const chip = statusChip(lesson.status);
  const evidence = evidenceLine(lesson.evidence);
  const off = lesson.status === "off";
  // A lesson that is too old has nothing to turn off or on (the API returns it unchanged): only Delete.
  const expired = lesson.status === "expired";

  /** false tells the button's motion it did not work (§20.5). */
  async function turn(): Promise<boolean> {
    setBusy(true);
    try {
      const next = await api().setLessonStatus(lesson.lessonId, off ? "on" : "off");
      onChange(next);
      toast.success(off ? "Turned on." : "Turned off. Clip Factory will not use it.");
      return true;
    } catch (e) {
      toast.error(friendlyMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setAsking(false);
    try {
      await api().deleteLesson(lesson.lessonId);
      onDeleted(lesson.lessonId);
      toast.success("Deleted. It will not be learned again.");
    } catch (e) {
      toast.error(friendlyMessage(e));
    }
  }

  return (
    <article className="lesson" data-lesson={lesson.lessonId} data-status={lesson.status}>
      <p className="lesson__text user-text">{lesson.text}</p>
      <p className="lesson__meta">
        <Pill tone={chip.tone}>{chip.text}</Pill>
        <span>{PLATFORM_LABEL[lesson.platform] ?? lesson.platform}</span>
        {evidence ? <span>{evidence}</span> : null}
      </p>
      {lesson.clips.length ? (
        <p className="lesson__clips">
          <span className="lesson__clips-label">Clips that did best:</span>
          {lesson.clips.map((c) => (
            <A key={c.clipId} href={`/clips/${c.clipId}`} className="lesson__clip user-text">
              {c.hook || "Open the clip"}
            </A>
          ))}
        </p>
      ) : null}
      {expired ? <p className="lesson__note muted">Too old to use. New clips can teach it again.</p> : null}
      <div className="lesson__actions">
        {expired ? null : (
          <Button size="sm" icon={off ? "check" : "x"} act="toggle" loading={busy} onClick={() => turn()}>
            {off ? "Turn on" : "Turn off"}
          </Button>
        )}
        <Button size="sm" variant="ghost" icon="trash" onClick={() => setAsking(true)}>
          Delete
        </Button>
      </div>
      {asking ? (
        <Sheet
          title="Delete this lesson?"
          onClose={() => setAsking(false)}
          actions={
            <>
              <Button icon="x" onClick={() => setAsking(false)}>
                Keep it
              </Button>
              <Button variant="danger" icon="trash" act="delete" onClick={() => void remove()}>
                Delete
              </Button>
            </>
          }
        >
          <p>Clip Factory will stop using it and will not learn it again.</p>
        </Sheet>
      ) : null}
    </article>
  );
}
