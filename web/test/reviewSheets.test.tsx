import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import type { Api, Captions, Clip, TikTokCreator, TikTokPostOptions, TikTokPreset } from "../src/api/types.ts";
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

/** Opens the sheet from an Upload button and re-renders on every caption change, the way Review does. */
function Harness({ onClose, onUpload, preset }: { onClose?: () => void; onUpload?: (o: TikTokPostOptions) => void; preset?: TikTokPreset }) {
  const [open, setOpen] = useState(false);
  const [caption, setCaption] = useState("Twelve cars");
  return (
    <>
      <button type="button" id="keep" onClick={() => setOpen(true)}>
        Upload
      </button>
      {open ? (
        <TikTokSheet
          clip={clip}
          caption={caption}
          onCaption={setCaption}
          onUpload={(o) => onUpload?.(o)}
          preset={preset}
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

async function openSheet(onClose?: () => void, more: { onUpload?: (o: TikTokPostOptions) => void; preset?: TikTokPreset } = {}) {
  act(() => root.render(<Harness onClose={onClose} {...more} />));
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

  it("traps Tab inside, closes on Escape and gives the focus back to Upload (F030)", async () => {
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

  const privacyButton = (dialog: HTMLElement) => dialog.querySelector<HTMLButtonElement>('.dropdown__button[aria-haspopup="listbox"]')!;
  const uploadButton = (dialog: HTMLElement) => Array.from(dialog.querySelectorAll<HTMLButtonElement>(".tt-sheet__actions button")).pop()!;
  function pickPrivacy(dialog: HTMLElement, name: string) {
    act(() => privacyButton(dialog).click());
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((o) => o.querySelector(".dropdown__name")!.textContent === name)!;
    act(() => option.click());
  }

  it("asks who can see it in the app's own dropdown: no OS list, no default, Everyone first (TikTok's rules)", async () => {
    current = { tiktokCreatorInfo: async () => ({ ...creator, privacyOptions: ["SELF_ONLY", "MUTUAL_FOLLOW_FRIENDS", "PUBLIC_TO_EVERYONE"] }) };
    const { dialog } = await openSheet();
    expect(dialog.querySelector("select")).toBeNull();
    const button = privacyButton(dialog);
    expect(button.getAttribute("aria-labelledby")!.split(" ").map((i) => document.getElementById(i)!.textContent)[0]).toBe("Who can see it");
    // Nothing picked until the owner picks.
    expect(button.textContent).toContain("Pick who can see it");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(uploadButton(dialog).getAttribute("aria-disabled")).toBe("true");
    expect(dialog.textContent).toContain("Tap who can see it to turn on Upload.");
    act(() => button.click());
    const names = Array.from(document.querySelectorAll('[role="option"] .dropdown__name')).map((n) => n.textContent);
    // Exactly TikTok's list (never more), Everyone first.
    expect(names).toEqual(["Everyone", "Friends", "Only me"]);
    expect(document.querySelectorAll('[role="option"][aria-selected="true"]')).toHaveLength(0);
    act(() => (document.querySelector('[role="option"]') as HTMLElement).click());
    expect(privacyButton(dialog).textContent).toContain("Everyone");
    expect(uploadButton(dialog).getAttribute("aria-disabled")).not.toBe("true");
  });

  it("before TikTok approves the app: only Only me, a plain line, still the owner's pick", async () => {
    current = { tiktokCreatorInfo: async () => ({ ...creator, privacyOptions: ["SELF_ONLY"] }) };
    const { dialog } = await openSheet();
    expect(dialog.textContent).toContain("TikTok keeps posts private until it approves your app.");
    expect(privacyButton(dialog).textContent).toContain("Pick who can see it");
    act(() => privacyButton(dialog).click());
    expect(Array.from(document.querySelectorAll('[role="option"] .dropdown__name')).map((n) => n.textContent)).toEqual(["Only me"]);
  });

  it("Comments, Duet and Stitch start off and visible; Turn all on switches on the ones TikTok allows", async () => {
    const { dialog } = await openSheet();
    const sw = (name: string) => Array.from(dialog.querySelectorAll<HTMLButtonElement>('[role="switch"]')).find((b) => document.getElementById(b.getAttribute("aria-labelledby")!)!.textContent === name)!;
    for (const name of ["Comments", "Duet", "Stitch", "Commercial content"]) expect(sw(name).getAttribute("aria-checked")).toBe("false");
    const allOn = Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === "Turn all on")!;
    act(() => allOn.click());
    expect(sw("Comments").getAttribute("aria-checked")).toBe("true");
    expect(sw("Duet").getAttribute("aria-checked")).toBe("true");
    // Stitch is off in the creator's TikTok settings: it stays off and greyed.
    expect(sw("Stitch").getAttribute("aria-checked")).toBe("false");
    expect(sw("Stitch").getAttribute("aria-disabled")).toBe("true");
    expect(sw("Commercial content").getAttribute("aria-checked")).toBe("false");
    // Each switch still changes on its own.
    act(() => sw("Duet").click());
    expect(sw("Duet").getAttribute("aria-checked")).toBe("false");
  });

  it("Branded content (paid partnership) takes Only me away and adds the Branded Content Policy line", async () => {
    const { dialog } = await openSheet();
    pickPrivacy(dialog, "Only me");
    const sw = Array.from(dialog.querySelectorAll<HTMLButtonElement>('[role="switch"]')).find((b) => document.getElementById(b.getAttribute("aria-labelledby")!)!.textContent === "Commercial content")!;
    act(() => sw.click());
    expect(uploadButton(dialog).getAttribute("aria-disabled")).toBe("true");
    const branded = Array.from(dialog.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))[1]!;
    expect(branded.closest("label")!.textContent).toContain("Paid partnership");
    act(() => branded.click());
    expect(privacyButton(dialog).textContent).toContain("Pick who can see it");
    act(() => privacyButton(dialog).click());
    expect(Array.from(document.querySelectorAll('[role="option"] .dropdown__name')).map((n) => n.textContent)).toEqual(["Everyone"]);
    act(() => (document.querySelector('[role="option"]') as HTMLElement).click());
    expect(dialog.textContent).toContain("Branded Content Policy");
    expect(uploadButton(dialog).getAttribute("aria-disabled")).not.toBe("true");
  });

  it("Use my settings puts the owner's TikTok choices in with his one tap, within what TikTok allows", async () => {
    const sent: TikTokPostOptions[] = [];
    const preset: TikTokPreset = { privacy: "PUBLIC_TO_EVERYONE", comments: true, duet: true, stitch: true, commercial: false, aigc: false };
    const { dialog } = await openSheet(undefined, { onUpload: (o) => sent.push(o), preset });
    expect(privacyButton(dialog).textContent).toContain("Pick who can see it");
    const mine = Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === "Use my settings")!;
    act(() => mine.click());
    expect(privacyButton(dialog).textContent).toContain("Everyone");
    act(() => uploadButton(dialog).click());
    expect(sent).toEqual([
      { privacyLevel: "PUBLIC_TO_EVERYONE", disableComment: false, disableDuet: false, disableStitch: true, brandContent: false, brandOrganic: false },
    ]);
  });

  it("Use my settings on an app TikTok has not approved picks Only me, the one choice there is", async () => {
    current = { tiktokCreatorInfo: async () => ({ ...creator, privacyOptions: ["SELF_ONLY"] }) };
    const preset: TikTokPreset = { privacy: "PUBLIC_TO_EVERYONE", comments: true, duet: true, stitch: true, commercial: false, aigc: false };
    const { dialog } = await openSheet(undefined, { preset });
    act(() => Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === "Use my settings")!.click());
    expect(privacyButton(dialog).textContent).toContain("Only me");
  });

  it("a clip too long for TikTok says what to do next; a limit of 0 does not block (F022)", async () => {
    expect(tooLongForTikTok(32, 5)).toBe(true);
    expect(tooLongForTikTok(32, 600)).toBe(false);
    expect(tooLongForTikTok(32, 0)).toBe(false);
    current = { tiktokCreatorInfo: async () => ({ ...creator, maxDurationSec: 5 }) };
    const { dialog } = await openSheet();
    expect(dialog.textContent).toContain("To upload it to your other places now, turn TikTok off above and tap Upload.");
    expect(dialog.textContent).not.toContain("Tap who can see it to turn on Upload.");
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

  it("only the chosen places count as too long (§33.2)", () => {
    const long = { ...ok, x: "x".repeat(281) };
    expect(tabsTooLong(long, ["youtube", "tiktok"])).toEqual([]);
    expect(tabsTooLong(long, ["youtube", "x"])).toEqual(["x"]);
  });

  it("shows tabs only for the chosen places, keeps a turned-off place's caption, and never writes X twice", () => {
    const captions = { ...ok, x: "kept x text" };
    act(() => root.render(<CaptionTabs captions={captions} onChange={() => undefined} platforms={["youtube", "x"]} />));
    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs.map((t) => t.getAttribute("aria-label"))).toEqual(["YouTube", "X"]);
    const x = tabs[1]!;
    act(() => x.click());
    // The X tab shows its mark only: no visible "X" next to the X logo.
    expect(x.textContent).toBe("");
    expect(host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("kept x text");
    act(() => root.render(<CaptionTabs captions={captions} onChange={() => undefined} platforms={["youtube"]} />));
    expect(Array.from(host.querySelectorAll('[role="tab"]')).map((t) => t.getAttribute("aria-label"))).toEqual(["YouTube"]);
    act(() => root.render(<CaptionTabs captions={captions} onChange={() => undefined} platforms={["youtube", "x"]} />));
    act(() => Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'))[1]!.click());
    expect(host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("kept x text");
  });

  it("marks a too-long tab even when it is not open, and Upload's refusal opens and focuses it (F006)", () => {
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
