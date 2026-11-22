// "Try it" on the AI video maker (docs/CONTRACTS.md §45.35 D2, §45.37; request 2 §6E "Video-generation
// configuration"): Luma AI Ray2 since Amazon ended Nova Reel (Nova Reel's Try it is gone: it could only fail). The
// maker shows as working only after a real call worked, and only a video could make that call, which the maker being
// not ready stopped. Try it makes one 5-second test shot (Amazon bills it), as a one-step job ("provider_check", its
// step "Try it"), never behind the not-ready guard. The row follows the job through the providers list (its `check`,
// the newest try) while it runs, then shows how it went: it worked (ready for cut-aways), or Amazon Bedrock's own
// sentence, or what is still missing (the storage in the US, Oregon). Nothing switches to another maker.
import { useEffect, useRef, useState } from "react";
import { friendlyMessage } from "../../api/errors.ts";
import { useToast } from "../../components/Toasts.tsx";
import { usePoll } from "../../lib/hooks.ts";
import { storiesApi } from "../api/client.ts";
import { useAppActive } from "../pane.tsx";
import type { ProductionJob, ProviderStatus } from "../api/types.ts";
import { Btn, cheer, Chip, Note, Progress, SIcon, whenText } from "./bits.tsx";

/** How often the row asks how the try is going (the shot takes a minute or two). */
export const TRY_POLL_MS = 2500;

export const TRY_LINE = "Try it makes one 5-second test shot to see if Luma AI Ray2 works for you. Amazon bills that one shot. Nothing is posted.";
/** It needs its storage in the US (Oregon), which only the owner can switch on (the lead's stories_video_west_bucket). */
export const TRY_NEEDS = "A shot can only work once Luma AI Ray2's storage in the US (Oregon) is switched on and Amazon has turned the model on for your account.";
const TRY_STOPPED = "Trying Luma AI Ray2 stopped. Tap Try it again.";

/** The try to show: the one just started until the list knows it, then the list's newest. */
export function shownTry(started: ProductionJob | null, check: ProductionJob | null | undefined): ProductionJob | null {
  if (started && (!check || (check.jobId !== started.jobId && check.createdAt < started.createdAt))) return started;
  return check ?? null;
}

export const tryRunning = (job: ProductionJob | null): boolean => !!job && (job.status === "queued" || job.status === "running");

/** What a finished try says: null while it runs or when it worked. */
export function tryProblem(job: ProductionJob | null, p: Pick<ProviderStatus, "lastError"> | undefined): string | null {
  if (!job || tryRunning(job) || job.status === "ready") return null;
  return job.steps.find((s) => s.key === "check")?.message || p?.lastError || TRY_STOPPED;
}

export function ReelTry({ ws, p, reload }: { ws: string; p: ProviderStatus | undefined; reload: () => Promise<unknown> }) {
  const toast = useToast();
  const active = useAppActive();
  const [started, setStarted] = useState<ProductionJob | null>(null);
  const [asking, setAsking] = useState(false);
  const anchor = useRef<HTMLElement | null>(null);
  const job = shownTry(started, p?.check);
  const running = tryRunning(job);
  // Followed while it runs and Lamo Stories is on screen (behind Clip Factory it rests, and catches up when back).
  usePoll(reload, running && active, TRY_POLL_MS);

  // The try this page started has ended: say how it went, once.
  const done = started && job && job.jobId === started.jobId && !tryRunning(job) ? job : null;
  useEffect(() => {
    if (!done) return;
    setStarted(null);
    if (done.status === "ready") {
      cheer(anchor.current);
      toast.success("It works! Luma AI Ray2 made its test shot.");
    } else toast.error(tryProblem(done, p) ?? TRY_STOPPED);
  }, [done, p, toast]);

  const problem = tryProblem(job, p);
  return (
    <div className="st-stg-try" data-provider="luma-ray" aria-label="Try Luma AI Ray2" role="group">
      <div className="st-stg-try__head">
        <span className="st-stg-try__name">{p?.label ?? "Luma AI Ray2"}</span>
        {job?.status === "ready" ? <Chip tone="mint">It worked</Chip> : problem ? <Chip tone="coral">It did not work</Chip> : null}
      </div>
      <p className="st-stg-small">{TRY_LINE}</p>
      {/* Picked, its own not-ready line says what is missing; not picked yet, this says it once. */}
      {p?.state === "off" && job?.status !== "ready" && !tryProblem(job, p) ? <p className="st-stg-small">{TRY_NEEDS}</p> : null}
      {running ? (
        <div className="st-stg-try__run" role="status">
          <Progress value={null} label="Trying Luma AI Ray2" />
          <span className="st-stg-small">{job?.steps[0]?.status === "running" ? "Making the 5-second test shot… It takes a minute or two." : "Starting the test shot…"}</span>
        </div>
      ) : job?.status === "ready" ? (
        <Note tone="mint" icon="check" role="status">
          Luma AI Ray2 made a test shot{job.updatedAt ? ` ${whenText(job.updatedAt)}` : ""}. It is ready for cut-aways.
        </Note>
      ) : problem ? (
        <Note tone="coral" role="status">
          {problem}
        </Note>
      ) : null}
      <div className="st-stg-actions">
        <Btn
          main={!job || job.status !== "ready"}
          off={running || asking ? "Luma AI Ray2 is being tried. Wait until it is done." : undefined}
          label={running ? "Trying Luma AI Ray2" : "Try Luma AI Ray2"}
          onClick={(e) => {
            if (running || asking) return;
            anchor.current = e.currentTarget;
            setAsking(true);
            void storiesApi()
              .tryMaker(ws, "luma-ray")
              .then((j) => {
                setStarted(j);
                return reload();
              })
              .catch((err: unknown) => toast.error(friendlyMessage(err)))
              .finally(() => setAsking(false));
          }}
        >
          <SIcon name="film" size={20} />
          {running ? "Trying…" : job ? "Try it again" : "Try it"}
        </Btn>
      </div>
    </div>
  );
}
