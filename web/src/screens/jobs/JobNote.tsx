import { Icon } from "../../components/Icon.tsx";
import type { Job } from "../../api/types.ts";

/** The job's own short note while it is queued or running, e.g. "Picking up where it stopped…" after the app picked a
 * stopped job back up on its own (CONTRACTS §30). Nothing once the job has ended. */
export function JobNote({ job }: { job: Pick<Job, "status" | "note"> }) {
  if (!job.note || (job.status !== "running" && job.status !== "queued")) return null;
  return (
    <p className="panel__note job-note" role="status">
      <Icon name="retry" size={18} />
      <span>{job.note}</span>
    </p>
  );
}
