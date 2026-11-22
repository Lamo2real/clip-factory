// "Try it" on the AI video makers (docs/CONTRACTS.md §45.35 D2, §45.37; request 2 §6E "Video-generation
// configuration"): Luma AI Ray2 since Amazon ended Nova Reel (Nova Reel's Try it is gone: it could only fail), and the
// owner's own video model, whose shots go to the same storage. The maker shows as working only after a real call
// worked, and only a video could make that call, which the maker being not ready stopped. Try it makes one test shot
// (5 seconds on Luma AI Ray2; Amazon bills it), as a one-step job ("provider_check", its step "Try it"), never behind
// the not-ready guard. The row follows the job through the providers list (its `check`, the newest try) while it runs,
// then shows how it went: it worked (ready for cut-aways), or Amazon Bedrock's own sentence, or what is still missing
// (the storage in the US, Oregon). Nothing switches to another maker.
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

/** The makers with a Try it (the API's providers.CHECKABLE): Luma AI Ray2, and the owner's own video model, whose shots go to the same storage. */
export type TryMaker = "luma-ray" | "own-video";

/** Each maker's own words: its name, the line, what it needs and the busy line (the API's CHECK_BUSY_LINE). */
export const TRY_WORDS: Record<TryMaker, { name: string; line: string; needs: string; stopped: string; busy: string; made: string }> = {
  "luma-ray": {
    name: "Luma AI Ray2",
    line: TRY_LINE,
    needs: TRY_NEEDS,
    stopped: TRY_STOPPED,
    busy: "Luma AI Ray2 is being tried. Wait until it is done.",
    made: "It works! Luma AI Ray2 made its test shot.",
  },
  "own-video": {
    name: "your own video model",
    line: "Try it makes one test shot with your own video model to see if it works for you. Amazon bills that one shot. Nothing is posted.",
    needs: "A shot can only work once Lamo Stories' storage in your model's Region (the US, Oregon) is switched on and Amazon has turned the model on for your account.",
    stopped: "Trying your own video model stopped. Tap Try it again.",
    busy: "Your own video model is being tried. Wait until it is done.",
    made: "It works! Your own video model made its test shot.",
  },
};

/** The try to show: the one just started until the list knows it, then the list's newest. */
export function shownTry(started: ProductionJob | null, check: ProductionJob | null | undefined): ProductionJob | null {
  if (started && (!check || (check.jobId !== started.jobId && check.createdAt < started.createdAt))) return started;
  return check ?? null;
}

export const tryRunning = (job: ProductionJob | null): boolean => !!job && (job.status === "queued" || job.status === "running");

/** What a finished try says: null while it runs or when it worked. */
export function tryProblem(job: ProductionJob | null, p: Pick<ProviderStatus, "lastError"> | undefined, stopped = TRY_STOPPED): string | null {
  if (!job || tryRunning(job) || job.status === "ready") return null;
  return job.steps.find((s) => s.key === "check")?.message || p?.lastError || stopped;
}

export function ReelTry({ ws, p, reload, maker = "luma-ray" }: { ws: string; p: ProviderStatus | undefined; reload: () => Promise<unknown>; maker?: TryMaker }) {
  const words = TRY_WORDS[maker];
  const subject = maker === "luma-ray" ? words.name : "Your own video model";
  const title = maker === "luma-ray" ? (p?.label ?? subject) : subject;
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
      toast.success(words.made);
    } else toast.error(tryProblem(done, p, words.stopped) ?? words.stopped);
  }, [done, p, toast, words]);

  const problem = tryProblem(job, p, words.stopped);
  return (
    <div className="st-stg-try" data-provider={maker} aria-label={`Try ${words.name}`} role="group">
      <div className="st-stg-try__head">
        <span className="st-stg-try__name">{title}</span>
        {job?.status === "ready" ? <Chip tone="mint">It worked</Chip> : problem ? <Chip tone="coral">It did not work</Chip> : null}
      </div>
      <p className="st-stg-small">{words.line}</p>
      {/* Picked, its own not-ready line says what is missing; not picked yet, this says it once. */}
      {p?.state === "off" && job?.status !== "ready" && !tryProblem(job, p, words.stopped) ? <p className="st-stg-small">{words.needs}</p> : null}
      {running ? (
        <div className="st-stg-try__run" role="status">
          <Progress value={null} label={`Trying ${words.name}`} />
          <span className="st-stg-small">{job?.steps[0]?.status === "running" ? `Making the ${maker === "luma-ray" ? "5-second " : ""}test shot… It takes a minute or two.` : "Starting the test shot…"}</span>
        </div>
      ) : job?.status === "ready" ? (
        <Note tone="mint" icon="check" role="status">
          {subject} made a test shot{job.updatedAt ? ` ${whenText(job.updatedAt)}` : ""}. It is ready for cut-aways.
        </Note>
      ) : problem ? (
        <Note tone="coral" role="status">
          {problem}
        </Note>
      ) : null}
      <div className="st-stg-actions">
        <Btn
          main={!job || job.status !== "ready"}
          off={running || asking ? words.busy : undefined}
          label={running ? `Trying ${words.name}` : `Try ${words.name}`}
          onClick={(e) => {
            if (running || asking) return;
            anchor.current = e.currentTarget;
            setAsking(true);
            void storiesApi()
              .tryMaker(ws, maker)
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
