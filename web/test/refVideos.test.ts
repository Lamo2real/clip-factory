// Reference videos, "Edit like these" (docs/CONTRACTS.md §57): the pure rules of lib/refVideos.ts.
import { describe, expect, it } from "vitest";
import type { RefVideo } from "../src/api/types.ts";
import {
  anyChecking,
  mergeRefs,
  putRefBack,
  REF_ACCEPT,
  REF_MAX_BYTES,
  REF_MAX_COUNT,
  REF_REFUSE,
  refFileCheck,
  refName,
  refRefusal,
  refStatusTone,
  refStatusWord,
  refType,
  sortRefVideos,
  takeRef,
} from "../src/lib/refVideos.ts";

const file = (name: string, type: string, size = 1000) => ({
  name,
  type,
  size,
});
const vid = (
  refId: string,
  createdAt: string,
  status: RefVideo["status"] = "ready",
): RefVideo => ({ refId, name: refId, status, createdAt });

describe("reference video files", () => {
  it("takes MP4, MOV, WebM and M4V by type or by ending", () => {
    expect(refType(file("a.mp4", "video/mp4"))).toBe("video/mp4");
    expect(refType(file("a.mov", "video/quicktime"))).toBe("video/quicktime");
    expect(refType(file("a.webm", "video/webm"))).toBe("video/webm");
    expect(refType(file("a.m4v", "video/x-m4v"))).toBe("video/x-m4v");
    expect(refType(file("A.MOV", ""))).toBe("video/quicktime");
    expect(refType(file("a.m4v", "application/octet-stream"))).toBe(
      "video/x-m4v",
    );
  });

  it("refuses anything else with one short line", () => {
    expect(refType(file("a.avi", "video/x-msvideo"))).toBeNull();
    expect(refType(file("a.mp4", "image/png"))).toBeNull();
    expect(refFileCheck(file("notes.txt", "text/plain"))).toBe(REF_REFUSE.kind);
    expect(refFileCheck(file("a.mp4", "video/mp4", 0))).toBe(REF_REFUSE.empty);
    expect(refFileCheck(file("a.mp4", "video/mp4", REF_MAX_BYTES + 1))).toBe(
      REF_REFUSE.big,
    );
    expect(refFileCheck(file("a.mp4", "video/mp4", REF_MAX_BYTES))).toBeNull();
  });

  it("stops at 10 videos", () => {
    expect(REF_MAX_COUNT).toBe(10);
    expect(refRefusal(file("a.mp4", "video/mp4"), 9)).toBeNull();
    expect(refRefusal(file("a.mp4", "video/mp4"), 10)).toBe(REF_REFUSE.full);
    // A wrong file says why it is wrong, even when the list is full.
    expect(refRefusal(file("a.txt", "text/plain"), 10)).toBe(REF_REFUSE.kind);
  });

  it("the picker takes several of the four kinds", () => {
    expect(REF_ACCEPT).toBe(
      "video/mp4,video/quicktime,video/webm,video/x-m4v,.mp4,.mov,.webm,.m4v",
    );
  });

  it("names a video after its file, without the ending, at most 60 letters", () => {
    expect(refName({ name: "My best clip.mp4" })).toBe("My best clip");
    expect(refName({ name: ".mp4" })).toBe("Video");
    const long = refName({ name: `${"a".repeat(80)}.mov` });
    expect(Array.from(long)).toHaveLength(60);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("reference video status", () => {
  it("is one word each", () => {
    expect(refStatusWord("uploading")).toBe("Uploading");
    expect(refStatusWord("analyzing")).toBe("Checking");
    expect(refStatusWord("ready")).toBe("Ready");
    expect(refStatusWord("failed")).toBe("Failed");
    expect(refStatusTone("ready")).toBe("success");
    expect(refStatusTone("failed")).toBe("warn");
    expect(refStatusTone("analyzing")).toBe("neutral");
  });

  it("polls only while one is being checked", () => {
    expect(anyChecking(null)).toBe(false);
    expect(anyChecking([vid("a", "1"), vid("b", "2", "failed")])).toBe(false);
    expect(anyChecking([vid("a", "1"), vid("b", "2", "analyzing")])).toBe(true);
  });
});

describe("reference video list", () => {
  const a = vid("a", "2026-11-01T00:00:00Z");
  const b = vid("b", "2026-11-02T00:00:00Z");
  const c = vid("c", "2026-11-03T00:00:00Z");

  it("lists newest first", () => {
    expect(sortRefVideos([a, c, b]).map((v) => v.refId)).toEqual([
      "c",
      "b",
      "a",
    ]);
  });

  it("a delete can be undone in its old place", () => {
    const { list, removed } = takeRef([c, b, a], "b");
    expect(list.map((v) => v.refId)).toEqual(["c", "a"]);
    expect(putRefBack(list, removed!).map((v) => v.refId)).toEqual([
      "c",
      "b",
      "a",
    ]);
    expect(takeRef([a], "zz").removed).toBeNull();
    expect(putRefBack([b], { video: b, at: 0 })).toHaveLength(1);
  });

  it("a fresh read keeps deletes waiting on Undo out and new uploads in", () => {
    const merged = mergeRefs([a, b], [c], new Set(["a"]));
    expect(merged.map((v) => v.refId)).toEqual(["c", "b"]);
    // The read's own copy wins over the one this window had.
    const fresher = { ...c, status: "ready" as const };
    expect(
      mergeRefs([fresher], [{ ...c, status: "analyzing" }], new Set())[0]!
        .status,
    ).toBe("ready");
  });
});
