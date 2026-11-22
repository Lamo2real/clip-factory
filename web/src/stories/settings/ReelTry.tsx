// "Try it" on Amazon Nova Reel (docs/CONTRACTS.md §45.35 D2; request 2 §6E "Video-generation configuration"): Nova
// Reel shows as working only after a real call worked, and before round 4 only a video could make that call, which
// Nova Reel being not ready stopped. Try it makes one 6-second test shot (Amazon bills it), as a one-step job
// ("provider_check", its step "Try it"), never behind the not-ready guard. The row follows the job through the
// providers list (its `check`, the newest try) while it runs, then shows how it went: it worked (Nova Reel is ready),
// or Amazon Bedrock's own sentence, or what is still missing (the US storage). Nothing switches to another maker.
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

export const TRY_LINE = "Try it makes one 6-second test shot to see if Nova Reel works for you. Amazon bills that one shot. Nothing is posted.";
const TRY_STOPPED = "Trying Amazon Nova Reel stopped. Tap Try it again.";

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
      toast.success("It works! Nova Reel made its test shot.");
    } else toast.error(tryProblem(done, p) ?? TRY_STOPPED);
  }, [done, p, toast]);

  const problem = tryProblem(job, p);
  return (
    <div className="st-stg-try" data-provider="nova-reel" aria-label="Try Amazon Nova Reel" role="group">
      <div className="st-stg-try__head">
        <span className="st-stg-try__name">{p?.label ?? "Amazon Nova Reel"}</span>
        {job?.status === "ready" ? <Chip tone="mint">It worked</Chip> : problem ? <Chip tone="coral">It did not work</Chip> : null}
      </div>
      <p className="st-stg-small">{TRY_LINE}</p>
      {running ? (
        <div className="st-stg-try__run" role="status">
          <Progress value={null} label="Trying Amazon Nova Reel" />
          <span className="st-stg-small">{job?.steps[0]?.status === "running" ? "Making the 6-second test shot… It takes a minute or two." : "Starting the test shot…"}</span>
        </div>
      ) : job?.status === "ready" ? (
        <Note tone="mint" icon="check" role="status">
          Nova Reel made a test shot{job.updatedAt ? ` ${whenText(job.updatedAt)}` : ""}. It is ready for cut-aways.
        </Note>
      ) : problem ? (
        <Note tone="coral" role="status">
          {problem}
        </Note>
      ) : null}
      <div className="st-stg-actions">
        <Btn
          main={!job || job.status !== "ready"}
          off={running || asking ? "Nova Reel is being tried. Wait until it is done." : undefined}
          label={running ? "Trying Amazon Nova Reel" : "Try Amazon Nova Reel"}
          onClick={(e) => {
            if (running || asking) return;
            anchor.current = e.currentTarget;
            setAsking(true);
            void storiesApi()
              .tryNovaReel(ws)
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
