// "Delete this job?" (docs/CONTRACTS.md §34.6): the one question before a job, or several, is deleted. It says exactly
// what happens, in short words, and asks the only real choice: whether the job's clips still waiting in Review go too
// (off unless the owner turns it on). Keep it is the safe answer: first, focused, and what Escape or a tap outside
// mean. The delete itself still waits 8 seconds for an Undo (jobDeletes.ts).
import { useEffect, useState } from "react";
import { api } from "../../api/index.ts";
import type { Job, JobDeleteClips } from "../../api/types.ts";
import { Icon, type IconName } from "../../components/Icon.tsx";
import { Sheet } from "../../components/Sheet.tsx";
import { Button, Toggle } from "../../components/ui.tsx";
import { plural } from "../../lib/format.ts";

export const isWorking = (j: Pick<Job, "status">) => j.status === "running" || j.status === "queued";

/** The sheet's words, worked out apart from the sheet so the tests can read each case. */
export function deleteWords(count: number, working: number, review: number, clipsToo: boolean) {
  const one = count === 1;
  const facts: { icon: IconName; text: string }[] = [];
  if (working > 0)
    facts.push({
      icon: "stop",
      text: one ? "It is still working, so it stops first." : `${working === 1 ? "1 is" : `${working} are`} still working, so ${working === 1 ? "it stops" : "they stop"} first.`,
    });
  facts.push({ icon: "trash", text: one ? "Its working files go away." : "Their working files go away." });
  facts.push({ icon: "check", text: "Clips you kept or posted stay. Your posts stay up too." });
  return {
    title: one ? "Delete this job?" : `Delete ${plural(count, "job")}?`,
    facts,
    toggle: review > 0 ? `Also delete ${one ? "its" : "their"} ${plural(review, "clip")} in Review` : null,
    toggleNote: clipsToo ? "They go with the job." : "They stay in Review.",
    undo: "You can undo for 8 seconds.",
    action: one ? "Delete job" : `Delete ${plural(count, "job")}`,
  };
}

/** How many clips wait in Review for each job (one call; `null` until it answers or when it fails). */
export function useReviewCounts(jobIds: string[], known?: Record<string, number>): Record<string, number> | null {
  const [counts, setCounts] = useState<Record<string, number> | null>(known ?? null);
  const key = jobIds.join(",");
  useEffect(() => {
    if (known) return;
    let alive = true;
    api()
      .listClips({ status: "review" })
      .then((clips) => {
        if (!alive) return;
        const out: Record<string, number> = {};
        for (const c of clips) out[c.jobId] = (out[c.jobId] ?? 0) + 1;
        setCounts(out);
      })
      .catch(() => alive && setCounts({}));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return counts;
}

export function DeleteJobsSheet({
  jobs,
  reviewCounts,
  onClose,
  onDelete,
}: {
  jobs: Job[];
  /** Review clips per job when the page already knows them (the job page); otherwise the sheet asks. */
  reviewCounts?: Record<string, number>;
  onClose: () => void;
  onDelete: (clips: JobDeleteClips, review: Record<string, number>) => void;
}) {
  const counts = useReviewCounts(
    jobs.map((j) => j.jobId),
    reviewCounts,
  );
  const [clipsToo, setClipsToo] = useState(false);
  const review = counts ? jobs.reduce((n, j) => n + (counts[j.jobId] ?? 0), 0) : 0;
  const words = deleteWords(jobs.length, jobs.filter(isWorking).length, review, clipsToo);
  return (
    <Sheet
      title={words.title}
      onClose={onClose}
      actions={
        <>
          <Button icon="x" className="delete-sheet__keep" onClick={onClose}>
            Keep it
          </Button>
          <Button
            variant="danger"
            icon="trash"
            act="delete"
            className="delete-sheet__go"
            onClick={() => onDelete(clipsToo && review > 0 ? "delete" : "keep", counts ?? {})}
          >
            {words.action}
          </Button>
        </>
      }
    >
      <ul className="delete-sheet__facts">
        {words.facts.map((f) => (
          <li key={f.text}>
            <Icon name={f.icon} size={18} />
            <span>{f.text}</span>
          </li>
        ))}
      </ul>
      {words.toggle ? (
        <div className="delete-sheet__clips">
          <Toggle checked={clipsToo} onChange={setClipsToo} label={words.toggle} description={words.toggleNote} />
        </div>
      ) : null}
      <p className="delete-sheet__undo">{words.undo}</p>
    </Sheet>
  );
}
