// Throw away with its 8 s Undo and auto-posting (docs/CONTRACTS.md §20.7, §46.13): the tap holds the clip at once so
// a run inside the Undo leaves it alone, Undo lets the hold go, the decline still goes only when the toast ends, and a
// clip a run already sent stays out of Review with a calm note. The real toasts, on fake timers.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import type { Api, Clip } from "../src/api/types.ts";
import type { Toaster } from "../src/components/Toasts.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let fake: Partial<Api> = {};
vi.mock("../src/api/index.ts", () => ({ api: () => fake }));

const { ToastProvider, UNDO_MS, useToast } = await import("../src/components/Toasts.tsx");
const { ALREADY_DECIDED, ALREADY_UPLOADING, isThrownAway, onClipBack, resetThrownAway, throwAwayWithUndo } = await import("../src/lib/throwAways.ts");
const { AUTO_ALREADY_SENT } = await import("../src/lib/autopost.ts");
const { seed } = await import("../src/api/mock/fixtures.ts");

const clip: Clip = seed().clips[0]!;
const DECIDED_ELSEWHERE = "This clip has already been confirmed or declined.";

let root: Root;
let host: HTMLElement;
let toast: Toaster;

function Grab() {
  toast = useToast();
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <ToastProvider>
        <Grab />
      </ToastProvider>,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetThrownAway();
  vi.useRealTimers();
});

/** Lets the api's answers land (and any timers due in `ms`). */
const wait = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const texts = () => [...host.querySelectorAll(".toast")].map((t) => `${t.className.match(/toast--(\w+)/)![1]}:${t.querySelector(".toast__text")!.textContent}`);
const undoButton = () => host.querySelector<HTMLButtonElement>(".toast__undo");

function api(over: Partial<Api> = {}) {
  const calls = {
    holdClip: vi.fn(async () => clip),
    unholdClip: vi.fn(async () => undefined),
    declineClip: vi.fn(async () => ({ ...clip, status: "declined" as const })),
    getClip: vi.fn(async () => clip),
  };
  const merged = { ...calls, ...over } as typeof calls;
  fake = merged;
  return merged;
}

describe("Throw away holds the clip for its Undo (§46.13)", () => {
  it("the tap holds it at once; the decline goes only when the 8 s Undo ends", async () => {
    const calls = api();
    const done = vi.fn();
    act(() => throwAwayWithUndo(clip, toast, done));
    // At the tap, before any answer: held, hidden, and nothing declined yet.
    expect(calls.holdClip).toHaveBeenCalledTimes(1);
    expect(calls.holdClip).toHaveBeenCalledWith(clip.clipId);
    expect(isThrownAway(clip.clipId)).toBe(true);
    expect(texts()).toEqual(["undo:Clip thrown away."]);
    await wait(UNDO_MS - 1);
    expect(calls.declineClip).not.toHaveBeenCalled();
    await wait(1);
    expect(calls.declineClip).toHaveBeenCalledTimes(1);
    expect(calls.declineClip).toHaveBeenCalledWith(clip.clipId);
    expect(done).toHaveBeenCalled();
    expect(calls.unholdClip).not.toHaveBeenCalled();
    expect(isThrownAway(clip.clipId)).toBe(true);
    expect(UNDO_MS).toBe(8000);
  });

  it("Undo lets the hold go and sends nothing; a failed release says nothing", async () => {
    const calls = api({ unholdClip: vi.fn(async () => Promise.reject(new ApiError(500, "internal", "No."))) });
    const back = vi.fn();
    const stop = onClipBack(back);
    act(() => throwAwayWithUndo(clip, toast));
    await wait(2000);
    act(() => undoButton()!.click());
    // Back at once; the release follows the hold's answer (already here).
    expect(isThrownAway(clip.clipId)).toBe(false);
    expect(back).toHaveBeenCalledWith(clip.clipId, expect.any(Promise));
    await wait();
    expect(calls.unholdClip).toHaveBeenCalledWith(clip.clipId);
    await wait(UNDO_MS * 2);
    expect(calls.declineClip).not.toHaveBeenCalled();
    expect(texts()).toEqual([]);
    stop();
  });

  it("Undo before the hold answered: the release goes only after it, and the clip's back news waits for the release", async () => {
    let answerHold!: () => void;
    let answerUnhold!: () => void;
    const order: string[] = [];
    const calls = api({
      holdClip: vi.fn(
        () =>
          new Promise<Clip>((ok) => {
            answerHold = () => {
              order.push("hold answered");
              ok(clip);
            };
          }),
      ),
      unholdClip: vi.fn(() => {
        order.push("unhold sent");
        return new Promise<void>((ok) => {
          answerUnhold = () => {
            order.push("unhold answered");
            ok();
          };
        });
      }),
    });
    const released = vi.fn();
    const stop = onClipBack((id, done) => void done.then(() => released(id)));
    act(() => throwAwayWithUndo(clip, toast));
    // A slow hold (a cold start): Undo is tapped before it answers.
    await wait(200);
    act(() => undoButton()!.click());
    expect(isThrownAway(clip.clipId)).toBe(false);
    await wait(1000);
    expect(calls.unholdClip).not.toHaveBeenCalled();
    answerHold();
    await wait();
    expect(calls.unholdClip).toHaveBeenCalledTimes(1);
    expect(released).not.toHaveBeenCalled();
    answerUnhold();
    await wait();
    expect(released).toHaveBeenCalledWith(clip.clipId);
    expect(order).toEqual(["hold answered", "unhold sent", "unhold answered"]);
    await wait(UNDO_MS * 2);
    expect(calls.declineClip).not.toHaveBeenCalled();
    stop();
  });

  it("a decline that fails brings the clip back and lets the hold go, so auto-posting may take it again", async () => {
    const calls = api({ declineClip: vi.fn(async () => Promise.reject(new ApiError(500, "internal", "Something went wrong."))) });
    const released = vi.fn();
    const stop = onClipBack((id, done) => void done.then(() => released(id)));
    act(() => throwAwayWithUndo(clip, toast));
    await wait(UNDO_MS);
    await wait();
    expect(calls.declineClip).toHaveBeenCalledTimes(1);
    expect(isThrownAway(clip.clipId)).toBe(false);
    expect(calls.unholdClip).toHaveBeenCalledWith(clip.clipId);
    expect(released).toHaveBeenCalledWith(clip.clipId);
    expect(texts()).toEqual([expect.stringMatching(/^error:.* The clip is back in your list\.$/)]);
    stop();
  });

  it("a run sent it first: the hold's 409 closes the Undo toast, keeps it out of Review and sends no decline", async () => {
    const calls = api({ holdClip: vi.fn(async () => Promise.reject(new ApiError(409, "conflict", AUTO_ALREADY_SENT))) });
    const back = vi.fn();
    const stop = onClipBack(back);
    act(() => throwAwayWithUndo(clip, toast));
    await wait();
    expect(undoButton()).toBeNull();
    expect(texts()).toEqual([`info:${AUTO_ALREADY_SENT}`]);
    expect(AUTO_ALREADY_SENT).toBe("Auto-posting already sent this clip.");
    expect(isThrownAway(clip.clipId)).toBe(true);
    await wait(UNDO_MS * 2);
    expect(calls.declineClip).not.toHaveBeenCalled();
    expect(calls.unholdClip).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
    stop();
  });

  it("a hold refused for any other reason changes nothing: the decline still decides when the toast ends", async () => {
    for (const refusal of [
      new ApiError(409, "conflict", DECIDED_ELSEWHERE),
      new ApiError(404, "not_found", "That clip no longer exists."),
      new ApiError(0, "network", "Clip Factory cannot be reached. Check your connection and try again."),
    ]) {
      resetThrownAway();
      const calls = api({
        holdClip: vi.fn(async () => Promise.reject(refusal)),
        declineClip: vi.fn(async () => Promise.reject(new ApiError(409, "conflict", DECIDED_ELSEWHERE))),
      });
      act(() => throwAwayWithUndo(clip, toast));
      await wait();
      expect(texts(), refusal.message).toEqual(["undo:Clip thrown away."]);
      await wait(UNDO_MS);
      expect(calls.declineClip).toHaveBeenCalledTimes(1);
      expect(texts()).toEqual([`info:${ALREADY_DECIDED}`]);
      expect(isThrownAway(clip.clipId)).toBe(true);
      await wait(10_000);
    }
  });

  it("a decline refused because a run sent the clip says so, not that it was decided somewhere else", async () => {
    const calls = api({
      declineClip: vi.fn(async () => Promise.reject(new ApiError(409, "conflict", DECIDED_ELSEWHERE))),
      getClip: vi.fn(async () => ({ ...clip, status: "confirmed" as const, auto: { runId: "2026-11-22T11:00:00.000Z#scheduled", at: "2026-11-22T11:00:00.000Z" } })),
    });
    act(() => throwAwayWithUndo(clip, toast));
    await wait(UNDO_MS);
    expect(calls.getClip).toHaveBeenCalledWith(clip.clipId);
    expect(texts()).toEqual([`info:${AUTO_ALREADY_SENT}`]);
    expect(isThrownAway(clip.clipId)).toBe(true);

    // A 404 (gone) whose read fails too: the calm note as before.
    resetThrownAway();
    await wait(10_000);
    api({
      declineClip: vi.fn(async () => Promise.reject(new ApiError(404, "not_found", "That clip no longer exists."))),
      getClip: vi.fn(async () => Promise.reject(new ApiError(404, "not_found", "That clip no longer exists."))),
    });
    act(() => throwAwayWithUndo(clip, toast));
    await wait(UNDO_MS);
    expect(texts()).toEqual([`info:${ALREADY_DECIDED}`]);
  });
});

describe("a clip whose Upload already went through (bug hunt, 23 Nov)", () => {
  it("the hold's 409 on an uploaded clip: no Undo, no decline, and it says it is uploading, never 'somewhere else'", async () => {
    for (const status of ["confirmed", "publishing", "posted", "failed"] as const) {
      resetThrownAway();
      const calls = api({
        holdClip: vi.fn(async () => Promise.reject(new ApiError(409, "conflict", DECIDED_ELSEWHERE))),
        getClip: vi.fn(async () => ({ ...clip, status })),
      });
      const back = vi.fn();
      const stop = onClipBack(back);
      act(() => throwAwayWithUndo(clip, toast));
      await wait();
      expect(undoButton(), status).toBeNull();
      expect(texts()).toEqual([`info:${ALREADY_UPLOADING}`]);
      await wait(UNDO_MS * 2);
      expect(calls.declineClip).not.toHaveBeenCalled();
      expect(texts().join(" ")).not.toContain("somewhere else");
      expect(back).not.toHaveBeenCalled();
      stop();
      await wait(10_000);
    }
    expect(ALREADY_UPLOADING).toBe("This clip is already uploading, so it can't be thrown away.");
  });

  it("a decline refused because the clip is uploading says so too", async () => {
    api({
      declineClip: vi.fn(async () => Promise.reject(new ApiError(409, "conflict", DECIDED_ELSEWHERE))),
      getClip: vi.fn(async () => ({ ...clip, status: "confirmed" as const })),
    });
    act(() => throwAwayWithUndo(clip, toast));
    await wait(UNDO_MS);
    await wait();
    expect(texts()).toEqual([`info:${ALREADY_UPLOADING}`]);
    // Declined elsewhere: the calm note as before.
    resetThrownAway();
    await wait(10_000);
    api({
      declineClip: vi.fn(async () => Promise.reject(new ApiError(409, "conflict", DECIDED_ELSEWHERE))),
      getClip: vi.fn(async () => ({ ...clip, status: "declined" as const })),
    });
    act(() => throwAwayWithUndo(clip, toast));
    await wait(UNDO_MS);
    await wait();
    expect(texts()).toEqual([`info:${ALREADY_DECIDED}`]);
  });
});

describe("an Undo toast with nothing left to decide (Toasts' signal)", () => {
  it("aborting it takes the toast away and runs neither Undo nor the real action", async () => {
    const onUndo = vi.fn();
    const onCommit = vi.fn();
    const stop = new AbortController();
    act(() => toast.undo("Clip thrown away.", { onUndo, onCommit, signal: stop.signal }));
    expect(texts()).toEqual(["undo:Clip thrown away."]);
    act(() => stop.abort());
    expect(texts()).toEqual([]);
    await wait(UNDO_MS * 2);
    expect(onUndo).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    // Without a signal (every other Undo): unchanged, it commits when the time is up.
    act(() => toast.undo("Deleted.", { onUndo, onCommit }));
    await wait(UNDO_MS);
    expect(onCommit).toHaveBeenCalledTimes(1);
    // Already aborted: never shown.
    act(() => toast.undo("Gone.", { onUndo, onCommit, signal: AbortSignal.abort() }));
    expect(texts()).toEqual([]);
    await wait(UNDO_MS);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});
