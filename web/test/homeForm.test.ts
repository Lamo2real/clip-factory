// Home's form helpers: the unsent draft kept while the app stays open, and Paste's fallback words per device.
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/api/index.ts", () => ({ api: () => ({}) }));

const { clearDraft, pasteFallback, readDraft, saveDraft } = await import("../src/screens/home/NewJobForm.tsx");

describe("Home's draft", () => {
  it("keeps the link, notes and clip count until the job starts", () => {
    clearDraft();
    expect(readDraft()).toBeNull();
    saveDraft({ link: "https://youtu.be/dQw4w9WgXcQ", notes: "Say hi to Marco", count: "exact", exact: 7 });
    expect(readDraft()).toEqual({ link: "https://youtu.be/dQw4w9WgXcQ", notes: "Say hi to Marco", count: "exact", exact: 7 });
    clearDraft();
    expect(readDraft()).toBeNull();
  });

  it("keeps nothing for an untouched form", () => {
    saveDraft({ link: "x", notes: "", count: "range", exact: 6 });
    saveDraft({ link: "  ", notes: "", count: "range", exact: 6 });
    expect(readDraft()).toBeNull();
  });

  it("hands out a copy, so the form can't change what is kept", () => {
    saveDraft({ link: "", notes: "n", count: "range", exact: 6 });
    readDraft()!.notes = "changed";
    expect(readDraft()!.notes).toBe("n");
    clearDraft();
  });
});

describe("Paste's fallback", () => {
  it("says press and hold only on a touch screen", () => {
    expect(pasteFallback(true, "iPhone")).toBe("Press and hold in the box, then choose Paste.");
  });

  it("names the keys a mouse and keyboard use", () => {
    expect(pasteFallback(false, "MacIntel")).toBe("Click in the box and press ⌘V.");
    expect(pasteFallback(false, "Win32")).toBe("Click in the box and press Ctrl+V.");
    expect(pasteFallback(false, "Linux x86_64")).toBe("Click in the box and press Ctrl+V.");
  });
});
