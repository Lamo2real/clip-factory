import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors.ts";
import type { Api, Captions, Clip, Platform, TikTokCreator, TikTokPostOptions } from "../src/api/types.ts";
import type { PlaceRowsHandle, TikTokRow } from "../src/screens/review/PlaceRows.tsx";
import type { Toaster } from "../src/components/Toasts.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let current: Partial<Api>;
vi.mock("../src/api/index.ts", () => ({ api: () => current }));

const { seed } = await import("../src/api/mock/fixtures.ts");
const { TikTokSheet, tooLongForTikTok } = await import("../src/screens/review/TikTokSheet.tsx");
const { PlaceRows, placesTooLong, tiktokNowLine, captionsTooLong } = await import("../src/screens/review/PlaceRows.tsx");
const { myTikTokChoices, NO_TIKTOK_CHOICES } = await import("../src/lib/tiktokChoices.ts");
const { cardOptionsFrom, clipOptionsProblem, DEFAULT_PRESET, optionsFor, presetOf, presetProblem } = await import("../src/lib/preset.ts");
const { reviewCountForJob } = await import("../src/screens/review/Review.tsx");
const { Sheet } = await import("../src/components/Sheet.tsx");
const { Dropdown } = await import("../src/components/Dropdown.tsx");
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
function Harness({ onClose, onUpload }: { onClose?: () => void; onUpload?: (o: TikTokPostOptions) => void }) {
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

async function openSheet(onClose?: () => void, more: { onUpload?: (o: TikTokPostOptions) => void } = {}) {
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

  const uploadButton = (dialog: HTMLElement) => Array.from(dialog.querySelectorAll<HTMLButtonElement>(".tt-sheet__actions button")).pop()!;
  const privacyButton = (dialog: HTMLElement) => dialog.querySelector<HTMLButtonElement>('.dropdown__button[aria-haspopup="listbox"]')!;
  function privacyNames(dialog: HTMLElement) {
    act(() => privacyButton(dialog).click());
    const names = Array.from(dialog.querySelectorAll('[role="option"] .dropdown__name')).map((n) => n.textContent);
    act(() => privacyButton(dialog).click());
    return names;
  }
  const privacyOn = (dialog: HTMLElement) =>
    privacyButton(dialog).classList.contains("is-picked") ? privacyButton(dialog).querySelector(".dropdown__value")!.textContent : null;
  function pickPrivacy(dialog: HTMLElement, name: string) {
    act(() => privacyButton(dialog).click());
    const option = Array.from(dialog.querySelectorAll<HTMLElement>('[role="option"]')).find((o) => o.querySelector(".dropdown__name")!.textContent === name)!;
    act(() => option.click());
  }

  it("asks who can see it from the app's own dropdown: no OS list, no default, Everyone first (TikTok's rules)", async () => {
    current = { tiktokCreatorInfo: async () => ({ ...creator, privacyOptions: ["SELF_ONLY", "MUTUAL_FOLLOW_FRIENDS", "PUBLIC_TO_EVERYONE"] }) };
    const { dialog } = await openSheet();
    expect(dialog.querySelector("select")).toBeNull();
    // The list opens only when tapped; its label is the visible "Who can see it".
    expect(dialog.querySelector('[role="listbox"]')).toBeNull();
    const labelId = privacyButton(dialog).getAttribute("aria-labelledby")!.split(" ")[0]!;
    expect(document.getElementById(labelId)!.textContent).toBe("Who can see it");
    expect(privacyButton(dialog).textContent).toContain("Pick who can see it");
    // Exactly TikTok's list (never more), Everyone first, and nothing picked until the owner picks.
    expect(privacyNames(dialog)).toEqual(["Everyone", "Friends", "Only me"]);
    expect(privacyOn(dialog)).toBeNull();
    expect(uploadButton(dialog).getAttribute("aria-disabled")).toBe("true");
    expect(dialog.textContent).toContain("Pick who can see it to turn on Upload.");
    pickPrivacy(dialog, "Everyone");
    expect(privacyOn(dialog)).toBe("Everyone");
    expect(uploadButton(dialog).getAttribute("aria-disabled")).not.toBe("true");
  });

  it("before TikTok approves the app: one choice, Only me, a plain line, still the owner's tap", async () => {
    current = { tiktokCreatorInfo: async () => ({ ...creator, privacyOptions: ["SELF_ONLY"] }) };
    const { dialog } = await openSheet();
    expect(dialog.textContent).toContain("TikTok keeps posts private until it approves Clip Factory.");
    expect(privacyNames(dialog)).toEqual(["Only me"]);
    expect(privacyOn(dialog)).toBeNull();
    expect(uploadButton(dialog).getAttribute("aria-disabled")).toBe("true");
    pickPrivacy(dialog, "Only me");
    expect(uploadButton(dialog).getAttribute("aria-disabled")).not.toBe("true");
  });

  it("Comments, Duet and Stitch start off and visible, each its own switch, with no Turn all on", async () => {
    const { dialog } = await openSheet();
    const sw = (name: string) => Array.from(dialog.querySelectorAll<HTMLButtonElement>('[role="switch"]')).find((b) => document.getElementById(b.getAttribute("aria-labelledby")!)!.textContent === name)!;
    for (const name of ["Comments", "Duet", "Stitch", "Commercial content"]) expect(sw(name).getAttribute("aria-checked")).toBe("false");
    expect(Array.from(dialog.querySelectorAll("button")).some((b) => /turn all on|use my settings/i.test(b.textContent ?? ""))).toBe(false);
    act(() => sw("Duet").click());
    expect(sw("Duet").getAttribute("aria-checked")).toBe("true");
    act(() => sw("Duet").click());
    expect(sw("Duet").getAttribute("aria-checked")).toBe("false");
    // Stitch is off in the creator's TikTok settings: it stays off and greyed.
    expect(sw("Stitch").getAttribute("aria-disabled")).toBe("true");
  });

  const switchNamed = (dialog: HTMLElement, name: string) =>
    Array.from(dialog.querySelectorAll<HTMLButtonElement>('[role="switch"]')).find((b) => document.getElementById(b.getAttribute("aria-labelledby")!)!.textContent === name)!;
  const chip = (dialog: HTMLElement, name: string) =>
    Array.from(dialog.querySelectorAll<HTMLInputElement>('.tt-sheet__brand input[type="checkbox"]')).find((i) => i.closest("label")!.textContent!.startsWith(name))!;
  const legal = (dialog: HTMLElement) => dialog.querySelector(".tt-sheet__legal")!.textContent;
  function optionState(dialog: HTMLElement) {
    act(() => privacyButton(dialog).click());
    const out = Array.from(dialog.querySelectorAll<HTMLElement>('[role="option"]')).map((o) => ({
      name: o.querySelector(".dropdown__name")!.textContent,
      off: o.getAttribute("aria-disabled") === "true",
      line: o.querySelector(".dropdown__line")?.textContent ?? null,
    }));
    act(() => privacyButton(dialog).click());
    return out;
  }

  it("Commercial content with nothing ticked: Upload is off with TikTok's own words, as hover text and as a line", async () => {
    const { dialog } = await openSheet();
    pickPrivacy(dialog, "Everyone");
    expect(uploadButton(dialog).getAttribute("title")).toBeNull();
    act(() => switchNamed(dialog, "Commercial content").click());
    const words = "You need to indicate if your content promotes yourself, a third party, or both.";
    expect(uploadButton(dialog).getAttribute("aria-disabled")).toBe("true");
    expect(uploadButton(dialog).getAttribute("title")).toBe(words);
    expect(dialog.querySelector(".tt-sheet__why")!.textContent).toBe(`${words} Pick Your brand or Branded content to turn on Upload.`);
    expect(dialog.textContent).toContain("Pick Your brand, Branded content, or both.");
    act(() => chip(dialog, "Your brand").click());
    expect(uploadButton(dialog).getAttribute("title")).toBeNull();
    expect(uploadButton(dialog).getAttribute("aria-disabled")).not.toBe("true");
  });

  it("says which label the video gets: Promotional content for Your brand, Paid partnership once Branded content is ticked", async () => {
    const { dialog } = await openSheet();
    pickPrivacy(dialog, "Everyone");
    act(() => switchNamed(dialog, "Commercial content").click());
    const line = () => Array.from(dialog.querySelectorAll(".tt-sheet__brand .field__hint")).map((p) => p.textContent);
    expect(line()).toEqual(["Pick Your brand, Branded content, or both."]);
    act(() => chip(dialog, "Your brand").click());
    expect(line()).toEqual(["Your video will be labeled as 'Promotional content'."]);
    act(() => chip(dialog, "Branded content").click());
    expect(line()).toEqual(["Your video will be labeled as 'Paid partnership'."]);
    act(() => chip(dialog, "Your brand").click());
    expect(line()).toEqual(["Your video will be labeled as 'Paid partnership'."]);
  });

  it("the agreement line: Music Usage alone, then the Branded Content Policy first once Branded content is ticked", async () => {
    const { dialog } = await openSheet();
    pickPrivacy(dialog, "Everyone");
    expect(legal(dialog)).toBe("By posting, you agree to TikTok's Music Usage Confirmation.");
    act(() => switchNamed(dialog, "Commercial content").click());
    act(() => chip(dialog, "Your brand").click());
    expect(legal(dialog)).toBe("By posting, you agree to TikTok's Music Usage Confirmation.");
    act(() => chip(dialog, "Branded content").click());
    expect(legal(dialog)).toBe("By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation.");
    const links = Array.from(dialog.querySelectorAll<HTMLAnchorElement>(".tt-sheet__legal a")).map((a) => a.href);
    expect(links).toEqual(["https://www.tiktok.com/legal/page/global/bc-policy/en", "https://www.tiktok.com/legal/page/global/music-usage-confirmation/en"]);
  });

  it("Branded content first: Only me and Followers show greyed with TikTok's line and cannot be picked", async () => {
    current = { tiktokCreatorInfo: async () => ({ ...creator, privacyOptions: ["SELF_ONLY", "FOLLOWER_OF_CREATOR", "MUTUAL_FOLLOW_FRIENDS", "PUBLIC_TO_EVERYONE"] }) };
    const { dialog } = await openSheet();
    act(() => switchNamed(dialog, "Commercial content").click());
    act(() => chip(dialog, "Branded content").click());
    const greyed = "Branded content visibility cannot be set to private.";
    expect(optionState(dialog)).toEqual([
      { name: "Everyone", off: false, line: null },
      { name: "Followers", off: true, line: greyed },
      { name: "Friends", off: false, line: null },
      { name: "Only me", off: true, line: greyed },
    ]);
    // A tap on a greyed choice does nothing: the list stays open and nothing is picked.
    pickPrivacy(dialog, "Only me");
    expect(dialog.querySelector('[role="listbox"]')).not.toBeNull();
    expect(privacyOn(dialog)).toBeNull();
    act(() => privacyButton(dialog).click());
    pickPrivacy(dialog, "Friends");
    expect(privacyOn(dialog)).toBe("Friends");
    expect(uploadButton(dialog).getAttribute("aria-disabled")).not.toBe("true");
  });

  it("Only me first: Branded content is greyed with a line saying what to do, and nothing he picked is cleared", async () => {
    const { dialog } = await openSheet();
    pickPrivacy(dialog, "Only me");
    act(() => switchNamed(dialog, "Commercial content").click());
    const branded = chip(dialog, "Branded content");
    expect(branded.disabled).toBe(true);
    expect(branded.closest("label")!.textContent).toContain("Paid partnership");
    expect(dialog.textContent).toContain("Branded content can't be Only me. Pick Everyone or Friends first.");
    act(() => branded.click());
    expect(branded.checked).toBe(false);
    expect(privacyOn(dialog)).toBe("Only me");
    pickPrivacy(dialog, "Everyone");
    expect(chip(dialog, "Branded content").disabled).toBe(false);
    expect(dialog.textContent).not.toContain("Pick Everyone or Friends first.");
    act(() => chip(dialog, "Branded content").click());
    expect(uploadButton(dialog).getAttribute("aria-disabled")).not.toBe("true");
  });

  it("sends exactly what the owner tapped (nothing is on unless he turned it on)", async () => {
    const sent: TikTokPostOptions[] = [];
    const { dialog } = await openSheet(undefined, { onUpload: (o) => sent.push(o) });
    pickPrivacy(dialog, "Everyone");
    act(() => uploadButton(dialog).click());
    expect(sent).toEqual([
      { privacyLevel: "PUBLIC_TO_EVERYONE", disableComment: true, disableDuet: true, disableStitch: true, brandContent: false, brandOrganic: false },
    ]);
  });

  it("a clip too long for TikTok says what to do next; a limit of 0 does not block (F022)", async () => {
    expect(tooLongForTikTok(32, 5)).toBe(true);
    expect(tooLongForTikTok(32, 600)).toBe(false);
    expect(tooLongForTikTok(32, 0)).toBe(false);
    current = { tiktokCreatorInfo: async () => ({ ...creator, maxDurationSec: 5 }) };
    const { dialog } = await openSheet();
    expect(dialog.textContent).toContain("Too long for TikTok. To post it elsewhere, turn TikTok off above and tap Upload.");
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

describe("Dropdown", () => {
  it("skips greyed choices with the keys and on tap", () => {
    const picked: string[] = [];
    const options = [
      { value: "a", label: "A" },
      { value: "b", label: "B", disabled: true },
      { value: "c", label: "C" },
    ];
    act(() => root.render(<Dropdown label="Pick" value="" placeholder="Pick one" options={options} onChange={(v) => picked.push(v)} />));
    const button = host.querySelector<HTMLButtonElement>(".dropdown__button")!;
    act(() => button.click());
    const opts = () => Array.from(host.querySelectorAll<HTMLElement>('[role="option"]'));
    expect(opts()[1]!.getAttribute("aria-disabled")).toBe("true");
    act(() => opts()[1]!.click());
    expect(picked).toEqual([]);
    press("ArrowDown");
    expect(opts()[2]!.className).toContain("is-at");
    press("ArrowUp");
    expect(opts()[0]!.className).toContain("is-at");
    press("End");
    press("Enter");
    expect(picked).toEqual(["c"]);
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

describe("place rows (§36)", () => {
  const ok: Captions = { ...clip.captions, x: "short", youtubeTitle: "short", youtubeDescription: "", tiktok: "", instagram: "", facebook: "" };
  const cardOpts = cardOptionsFrom(DEFAULT_PRESET, "public");
  function Rows({ places, captions = ok, handle, tiktok = {} }: { places: Platform[]; captions?: Captions; handle?: { current: PlaceRowsHandle | null }; tiktok?: Partial<TikTokRow> }) {
    const [opts, setOpts] = useState(cardOpts);
    return (
      <PlaceRows
        places={places}
        captions={captions}
        onChange={() => undefined}
        handle={handle}
        options={opts}
        onOptions={(p, patch) => setOpts((o) => ({ ...o, [p]: { ...o[p], ...patch } }))}
        tiktok={{ creator, error: null, asking: false, onAskAgain: () => undefined, choices: NO_TIKTOK_CHOICES, onChoices: () => undefined, durationSec: 30, onOpen: () => undefined, ...tiktok }}
      />
    );
  }
  const rowNames = () => Array.from(host.querySelectorAll<HTMLElement>(".place-row")).map((r) => r.dataset.place);

  it("lists the too-long places in their order, counting only the chosen ones", () => {
    expect(placesTooLong(ok)).toEqual([]);
    expect(placesTooLong({ ...ok, x: "x".repeat(281), youtubeTitle: "y".repeat(101) })).toEqual(["youtube", "x"]);
    expect(placesTooLong({ ...ok, x: "x".repeat(281) }, ["youtube", "tiktok"])).toEqual([]);
    expect(captionsTooLong({ ...ok, x: "x".repeat(281) }, ["youtube", "x"])).toBe(true);
  });

  it("one closed row per chosen place, in order, saying what is inside; no tab bar and no second place picker", () => {
    act(() => root.render(<Rows places={["x", "tiktok", "youtube"]} />));
    expect(rowNames()).toEqual(["youtube", "tiktok", "x"]);
    expect(host.querySelector('[role="tablist"], [role="tab"]')).toBeNull();
    // The only pick-one bar is YouTube's own "Who can see it", inside its row.
    expect(Array.from(host.querySelectorAll('[role="radiogroup"]')).map((g) => g.getAttribute("aria-label"))).toEqual(["Who can see it on YouTube"]);
    expect(Array.from(host.querySelectorAll("details")).every((d) => !d.open)).toBe(true);
    const yt = host.querySelector<HTMLElement>('[data-place="youtube"] summary')!;
    expect(yt.textContent).toContain("YouTube · title, description and settings");
    expect(yt.textContent).toContain("Who can see it: Everyone · Made for kids: No · Gaming");
    // X's mark reads "X": its name is for screen readers only (never "X X").
    expect(host.querySelector('[data-place="x"] .place-row__title')!.textContent).toBe("Xcaption and settings");
  });

  it("opening a row shows that place's words and every option; YouTube starts not made for kids", () => {
    act(() => root.render(<Rows places={["youtube", "instagram", "x"]} />));
    act(() => host.querySelector<HTMLElement>('[data-place="youtube"] summary')!.click());
    const body = host.querySelector<HTMLElement>('[data-place="youtube"] .place-row__body')!;
    expect(body.querySelector<HTMLInputElement>("input.input")!.value).toBe("short");
    const kids = Array.from(body.querySelectorAll<HTMLButtonElement>('[role="switch"]')).find((b) => document.getElementById(b.getAttribute("aria-labelledby")!)!.textContent === "Made for kids")!;
    expect(kids.getAttribute("aria-checked")).toBe("false");
    expect(body.textContent).toContain("Category");
    act(() => kids.click());
    expect(host.querySelector('[data-place="youtube"] summary')!.textContent).toContain("Made for kids: Yes");
    act(() => host.querySelector<HTMLElement>('[data-place="x"] summary')!.click());
    expect(host.querySelector('[data-place="x"] .place-row__body')!.textContent).toContain("Who can reply");
  });

  it("the TikTok row asks TikTok when opened and shows its dropdown with nothing picked", async () => {
    const onOpen = vi.fn();
    act(() => root.render(<Rows places={["tiktok"]} tiktok={{ onOpen }} />));
    expect(host.querySelector('[data-place="tiktok"] summary')!.textContent).toContain("Who can see it: not picked yet");
    act(() => host.querySelector<HTMLElement>('[data-place="tiktok"] summary')!.click());
    await flush();
    expect(onOpen).toHaveBeenCalled();
    const body = host.querySelector<HTMLElement>('[data-place="tiktok"] .place-row__body')!;
    expect(body.querySelector(".dropdown__button")!.textContent).toContain("Pick who can see it");
    expect(body.textContent).toContain("Commercial content");
  });

  it("the TikTok row says which label the video gets and greys Branded content while Followers is picked", async () => {
    const all = { ...creator, privacyOptions: ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"] };
    const choices = { ...NO_TIKTOK_CHOICES, privacy: "FOLLOWER_OF_CREATOR", commercial: true, yourBrand: true };
    act(() => root.render(<Rows places={["tiktok"]} tiktok={{ creator: all, choices }} />));
    act(() => host.querySelector<HTMLElement>('[data-place="tiktok"] summary')!.click());
    await flush();
    const body = host.querySelector<HTMLElement>('[data-place="tiktok"] .place-row__body')!;
    expect(body.textContent).toContain("Your video will be labeled as 'Promotional content'.");
    const branded = Array.from(body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find((i) => i.closest("label")!.textContent!.startsWith("Branded content"))!;
    expect(branded.disabled).toBe(true);
    expect(body.textContent).toContain("Branded content can't be Followers. Pick Everyone or Friends first.");
  });

  it("Upload's refusal opens the too-long row and focuses its box", () => {
    const handle: { current: PlaceRowsHandle | null } = { current: null };
    act(() => root.render(<Rows places={["youtube", "x"]} captions={{ ...ok, x: "x".repeat(300) }} handle={handle} />));
    const x = host.querySelector<HTMLDetailsElement>('[data-place="x"]')!;
    expect(x.className).toContain("is-over");
    expect(x.open).toBe(false);
    let name: string | null = null;
    act(() => {
      name = handle.current!.showTooLong();
    });
    expect(name).toBe("X");
    expect(x.open).toBe(true);
  });
});

describe("Use my settings (§36)", () => {
  it("puts the owner's TikTok settings on, within what TikTok offers him now; Commercial content stays off", () => {
    const mine = myTikTokChoices(DEFAULT_PRESET.tiktok, { ...creator, privacyOptions: ["SELF_ONLY", "PUBLIC_TO_EVERYONE"] });
    // Stitch is off in this creator's TikTok settings: it stays off.
    expect(mine).toEqual({ ...NO_TIKTOK_CHOICES, privacy: "PUBLIC_TO_EVERYONE", comments: true, duet: true, stitch: false });
    expect(myTikTokChoices({ ...DEFAULT_PRESET.tiktok, privacy: "FOLLOWER_OF_CREATOR" }, { ...creator, privacyOptions: ["SELF_ONLY"] }).privacy).toBe("SELF_ONLY");
  });

  it("putting his settings back again keeps a paid partnership ticked on this clip", () => {
    const now = { ...NO_TIKTOK_CHOICES, privacy: "PUBLIC_TO_EVERYONE", commercial: true, branded: true, yourBrand: false };
    const again = myTikTokChoices(DEFAULT_PRESET.tiktok, creator, now);
    expect(again).toMatchObject({ commercial: true, branded: true, yourBrand: false });
    // A saved "Only me" cannot go with a paid partnership: privacy waits for his pick instead of dropping the label.
    const only = myTikTokChoices({ ...DEFAULT_PRESET.tiktok, privacy: "SELF_ONLY" }, { ...creator, privacyOptions: ["SELF_ONLY", "PUBLIC_TO_EVERYONE"] }, now);
    expect(only.branded).toBe(true);
    expect(only.privacy).not.toBe("SELF_ONLY");
  });

  it("the closed TikTok line names the account he posts to", () => {
    expect(tiktokNowLine(NO_TIKTOK_CHOICES, "Gamer Joe")).toBe("Posting as Gamer Joe · Who can see it: not picked yet");
    expect(tiktokNowLine({ ...NO_TIKTOK_CHOICES, privacy: "PUBLIC_TO_EVERYONE" }, "Gamer Joe")).toContain("Posting as Gamer Joe · Who can see it:");
    expect(tiktokNowLine(NO_TIKTOK_CHOICES)).toBe("Who can see it: not picked yet");
  });

  it("YouTube, Instagram and X start from My settings; YouTube follows the saved privacy and is never made for kids", () => {
    const o = cardOptionsFrom(presetOf({ youtube: { category: "23", notifySubscribers: false, embeddable: true } }), "unlisted");
    expect(o.youtube).toEqual({ privacy: "unlisted", category: "23", madeForKids: false, notifySubscribers: false, embeddable: true });
    expect(optionsFor(["youtube", "tiktok"], o)).toEqual({ youtube: o.youtube });
  });

  it("the mock refuses made for kids in My settings, like the API", () => {
    expect(presetProblem({ youtube: { madeForKids: true } })).toBe("My settings never mark a clip as made for kids.");
    expect(presetProblem({ tiktok: { duet: false } })).toBeNull();
    expect(clipOptionsProblem({ youtube: { madeForKids: true } })).toBeNull();
    expect(clipOptionsProblem({ tiktok: {} })).not.toBeNull();
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
    // With the promise that settles once its auto-posting hold is let go (§46.13).
    expect(back).toHaveBeenCalledWith(clip.clipId, expect.any(Promise));
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
