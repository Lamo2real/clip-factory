import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import type { Api, Captions, Clip, TikTokCreator } from "../src/api/types.ts";
import type { Toaster } from "../src/components/Toasts.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let current: Partial<Api>;
vi.mock("../src/api/index.ts", () => ({ api: () => current }));

const { seed } = await import("../src/api/mock/fixtures.ts");
const { TikTokSheet, tooLongForTikTok } = await import("../src/screens/review/TikTokSheet.tsx");
const { CaptionTabs, tabsTooLong } = await import("../src/screens/review/CaptionTabs.tsx");
const { reviewCountForJob } = await import("../src/screens/review/Review.tsx");
const { Sheet } = await import("../src/components/Sheet.tsx");
const { ALREADY_DECIDED, isThrownAway, onClipBack, resetThrownAway, throwAwayWithUndo } = await import("../src/lib/throwAways.ts");

const creator: TikTokCreator = {
  nickname: "Clip Factory",
  username: "clipfactory",
  privacyOptions: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
  commentDisabled: false,
  duetDisabled: false,
  stitchDisabled: true,
  maxDurationSec: 600,
};

const clip: Clip = seed().clips[0]!;

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  host = document.createElement("div");
  host.className = "review-card glass";
  document.body.appendChild(host);
  root = createRoot(host);
  current = { tiktokCreatorInfo: async () => creator };
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetThrownAway();
});

const flush = () => act(async () => await new Promise((r) => setTimeout(r, 0)));

function typeInto(el: HTMLTextAreaElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(key: string, shiftKey = false) {
  const at = document.activeElement ?? document.body;
  act(() => {
    at.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }));
  });
}

/** Opens the sheet from a Keep button and re-renders on every caption change, the way Review does. */
function Harness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const [caption, setCaption] = useState("Twelve cars");
  return (
    <>
      <button type="button" id="keep" onClick={() => setOpen(true)}>
        Keep
      </button>
      {open ? (
        <TikTokSheet
          clip={clip}
          caption={caption}
          onCaption={setCaption}
          onKeep={() => undefined}
          // A new function on every render, like Review's inline arrow before the fix.
          onClose={() => {
            onClose?.();
            setOpen(false);
          }}
          busy={false}
        />
      ) : null}
    </>
  );
}

async function openSheet(onClose?: () => void) {
  act(() => root.render(<Harness onClose={onClose} />));
  const keep = host.querySelector<HTMLButtonElement>("#keep")!;
  keep.focus();
  act(() => keep.click());
  await flush();
  return { keep, dialog: document.querySelector<HTMLElement>(".tt-sheet")! };
}

describe("Post to TikTok sheet", () => {
  it("is drawn on document.body, outside the glass card that opens it (F002)", async () => {
    const { dialog } = await openSheet();
    expect(dialog).not.toBeNull();
    expect(host.contains(dialog)).toBe(false);
    expect(dialog.closest(".tt-sheet-backdrop")!.parentElement).toBe(document.body);
  });

  it("keeps the caret in the caption while typing several letters (F003)", async () => {
    await openSheet();
    const box = document.querySelector<HTMLTextAreaElement>(".tt-sheet__caption")!;
    box.focus();
    for (const text of ["Twelve cars ", "Twelve cars a", "Twelve cars ab", "Twelve cars abc"]) {
      typeInto(box, text);
      expect(document.activeElement).toBe(box);
    }
    expect(box.value).toBe("Twelve cars abc");
  });

  it("traps Tab inside, closes on Escape and gives the focus back to Keep (F030)", async () => {
    const closed = vi.fn();
    const { keep, dialog } = await openSheet(closed);
    expect(document.activeElement).toBe(dialog);
    const close = dialog.querySelector<HTMLButtonElement>(".tt-sheet__close")!;
    const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>(".tt-sheet__actions button"));
    const last = buttons[buttons.length - 1]!;
    // jsdom has no layout, so every control counts as visible only when it is focused; give them boxes.
    for (const el of Array.from(dialog.querySelectorAll<HTMLElement>("*"))) el.getClientRects = () => [new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList;
    // From the dialog itself Tab goes to the first control; from the last control it wraps to the first.
    press("Tab");
    expect(document.activeElement).toBe(close);
    last.focus();
    press("Tab");
    expect(document.activeElement).toBe(close);
    press("Tab", true);
    expect(document.activeElement).toBe(last);
    press("Escape");
    expect(closed).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".tt-sheet")).toBeNull();
    expect(document.activeElement).toBe(keep);
  });

  it("a clip too long for TikTok says what to do next; a limit of 0 does not block (F022)", async () => {
    expect(tooLongForTikTok(32, 5)).toBe(true);
    expect(tooLongForTikTok(32, 600)).toBe(false);
    expect(tooLongForTikTok(32, 0)).toBe(false);
    current = { tiktokCreatorInfo: async () => ({ ...creator, maxDurationSec: 5 }) };
    const { dialog } = await openSheet();
    expect(dialog.textContent).toContain("turn TikTok off in Where clips go, tap Keep, then turn TikTok back on");
    expect(dialog.querySelector('a[href="/settings/posting/where"]')).not.toBeNull();
    expect(dialog.textContent).not.toContain("Pick who can see it to turn on Keep.");
  });

  it("a creator-info error offers Ask TikTok again, which asks again (F022)", async () => {
    let calls = 0;
    current = {
      tiktokCreatorInfo: async () => {
        calls += 1;
        if (calls === 1) throw new ApiError(409, "conflict", "TikTok is busy right now.");
        return creator;
      },
    };
    const { dialog } = await openSheet();
    expect(dialog.textContent).toContain("Tap Ask TikTok again.");
    const again = Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent?.includes("Ask TikTok again"))!;
    act(() => again.click());
    await flush();
    expect(calls).toBe(2);
    expect(dialog.textContent).toContain("Posting as");
  });
});

describe("Sheet", () => {
  it("draws its scrim on document.body and wraps Tab (F002)", () => {
    act(() =>
      root.render(
        <Sheet
          title="Leave without saving?"
          onClose={() => undefined}
          actions={
            <>
              <button type="button">Keep editing</button>
              <button type="button">Leave</button>
            </>
          }
        />,
      ),
    );
    const scrim = document.querySelector<HTMLElement>(".sheet-scrim")!;
    expect(scrim.parentElement).toBe(document.body);
    expect(host.contains(scrim)).toBe(false);
    const [first, last] = Array.from(scrim.querySelectorAll<HTMLButtonElement>("button"));
    for (const el of [first!, last!]) el.getClientRects = () => [new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList;
    expect(document.activeElement).toBe(first);
    last!.focus();
    press("Tab");
    expect(document.activeElement).toBe(first);
  });
});

describe("caption tabs", () => {
  const ok: Captions = { ...clip.captions, x: "short", youtubeTitle: "short", youtubeDescription: "", tiktok: "", instagram: "", facebook: "" };

  it("lists the too-long tabs in tab order (F006)", () => {
    expect(tabsTooLong(ok)).toEqual([]);
    expect(tabsTooLong({ ...ok, x: "x".repeat(281), youtubeTitle: "y".repeat(101) })).toEqual(
      expect.arrayContaining(["youtube", "x"]),
    );
    expect(tabsTooLong({ ...ok, youtubeDescription: "d".repeat(5001) })).toEqual(["youtube"]);
  });

  it("marks a too-long tab even when it is not open, and Keep's refusal opens and focuses it (F006)", () => {
    const handle: { current: { showTooLong(): string | null } | null } = { current: null };
    act(() => root.render(<CaptionTabs captions={{ ...ok, x: "x".repeat(300) }} onChange={() => undefined} handle={handle} />));
    const x = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((t) => t.id.endsWith("-tab-x"))!;
    expect(x.className).toContain("is-over");
    expect(x.getAttribute("aria-label")).toBe("X, too long");
    expect(x.getAttribute("aria-selected")).toBe("false");
    let name: string | null = null;
    act(() => {
      name = handle.current!.showTooLong();
    });
    expect(name).toBe("X");
    expect(x.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(x);
    expect(host.querySelector<HTMLTextAreaElement>("textarea")!.getAttribute("aria-invalid")).toBe("true");
  });
});

describe("job-filtered Review count (F060)", () => {
  it("says the clips come from this job, with the total when it is more", () => {
    expect(reviewCountForJob(4, 5)).toBe("4 clips from this job waiting (5 in all)");
    expect(reviewCountForJob(4, 4)).toBe("4 clips from this job waiting");
    expect(reviewCountForJob(1, undefined)).toBe("1 clip from this job waiting");
  });
});

describe("thrown-away store (F007)", () => {
  function toaster() {
    const undo: { onUndo: () => void; onCommit: () => void }[] = [];
    const errors: string[] = [];
    const infos: string[] = [];
    const t: Toaster = {
      success: () => undefined,
      info: (text) => void infos.push(text),
      error: (text) => void errors.push(text),
      undo: (_text, o) => void undo.push(o as { onUndo: () => void; onCommit: () => void }),
    };
    return { t, undo, errors, infos };
  }

  it("hides the clip at once and Undo brings it back on any Review listening", () => {
    const { t, undo } = toaster();
    const back = vi.fn();
    const stop = onClipBack(back);
    throwAwayWithUndo(clip, t);
    expect(isThrownAway(clip.clipId)).toBe(true);
    undo[0]!.onUndo();
    expect(isThrownAway(clip.clipId)).toBe(false);
    expect(back).toHaveBeenCalledWith(clip.clipId);
    stop();
  });

  it("a decline refused because the clip was already decided keeps it gone and never says it is back", async () => {
    current = { declineClip: async () => Promise.reject(new ApiError(409, "conflict", "This clip has already been confirmed or declined.")) };
    const { t, undo, errors, infos } = toaster();
    throwAwayWithUndo(clip, t);
    undo[0]!.onCommit();
    await flush();
    expect(isThrownAway(clip.clipId)).toBe(true);
    // Not an error, and never "back in your list": the clip was decided elsewhere and stays gone.
    expect(errors).toEqual([]);
    expect(infos).toEqual([ALREADY_DECIDED]);
  });

  it("any other failed decline brings the clip back and says so", async () => {
    current = { declineClip: async () => Promise.reject(new ApiError(500, "internal", "Something went wrong. Try again in a minute.")) };
    const { t, undo, errors } = toaster();
    throwAwayWithUndo(clip, t);
    undo[0]!.onCommit();
    await flush();
    expect(isThrownAway(clip.clipId)).toBe(false);
    expect(errors[0]).toMatch(/The clip is back in your list\.$/);
  });

  it("a decline that goes through keeps the clip hidden and reports it", async () => {
    current = { declineClip: async () => ({ ...clip, status: "declined" }) };
    const { t, undo } = toaster();
    const done = vi.fn();
    throwAwayWithUndo(clip, t, done);
    undo[0]!.onCommit();
    await flush();
    expect(done).toHaveBeenCalled();
    expect(isThrownAway(clip.clipId)).toBe(true);
  });
});
