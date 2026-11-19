import { describe, expect, it } from "vitest";
import { classifyDrop, dragKind, dragMayHoldText, isVideoFile, linkFrom, videoType } from "../src/lib/drops.ts";

/** A DataTransfer stand-in: files (as items and files) and string data by type. */
function dt(files: File[] = [], data: Record<string, string> = {}) {
  const types = [...(files.length ? ["Files"] : []), ...Object.keys(data)];
  const items = files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f }));
  return {
    types,
    items: Object.assign(items, { length: items.length }) as unknown as DataTransferItemList,
    files: Object.assign([...files], { length: files.length }) as unknown as FileList,
    getData: (t: string) => data[t] ?? "",
  };
}
const video = (name = "Kai Cenat Scammed Me!.mp4", type = "video/mp4") => new File(["x"], name, { type });

describe("dragKind", () => {
  it("is file for a Finder drag, link for a browser link, nothing otherwise", () => {
    expect(dragKind({ types: ["Files"] })).toBe("file");
    expect(dragKind({ types: ["text/uri-list", "text/plain"] })).toBe("link");
    expect(dragKind({ types: ["Files", "text/uri-list"] })).toBe("either");
    expect(dragKind({ types: ["text/plain"] })).toBeNull();
    expect(dragKind({ types: [] })).toBeNull();
    expect(dragKind(null)).toBeNull();
  });

  it("knows a plain-text drag may hold a link", () => {
    expect(dragMayHoldText({ types: ["text/plain"] })).toBe(true);
    expect(dragMayHoldText({ types: ["Files"] })).toBe(false);
  });
});

describe("isVideoFile and videoType", () => {
  it("takes video types, and video names when the system gives no type", () => {
    expect(isVideoFile({ type: "video/quicktime", name: "a.mov" })).toBe(true);
    expect(isVideoFile({ type: "", name: "a.MOV" })).toBe(true);
    expect(isVideoFile({ type: "", name: "a.webm" })).toBe(true);
    expect(isVideoFile({ type: "text/plain", name: "notes.mp4" })).toBe(false);
    expect(isVideoFile({ type: "", name: "notes.txt" })).toBe(false);
    expect(isVideoFile({ type: "image/png", name: "a.png" })).toBe(false);
  });

  it("gives an upload type from the name when there is none", () => {
    expect(videoType({ type: "video/webm", name: "a.webm" })).toBe("video/webm");
    expect(videoType({ type: "", name: "a.mov" })).toBe("video/quicktime");
    expect(videoType({ type: "", name: "a.webm" })).toBe("video/webm");
    expect(videoType({ type: "", name: "a.mp4" })).toBe("video/mp4");
  });
});

describe("linkFrom", () => {
  it("reads the first link of a uri-list, skipping comments", () => {
    expect(linkFrom(dt([], { "text/uri-list": "# from the bar\r\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ\r\nhttps://x.y" }))).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
  });

  it("finds a link in dragged text", () => {
    expect(linkFrom(dt([], { "text/plain": "watch this https://kick.com/lamo please" }))).toBe("https://kick.com/lamo");
    expect(linkFrom(dt([], { "text/plain": "twitch.tv/lamo" }))).toBe("twitch.tv/lamo");
  });

  it("is null for text that is not a link", () => {
    expect(linkFrom(dt([], { "text/plain": "hello there" }))).toBeNull();
    expect(linkFrom(dt())).toBeNull();
    expect(linkFrom(null)).toBeNull();
  });
});

describe("classifyDrop", () => {
  it("takes a dropped video", () => {
    const f = video();
    expect(classifyDrop(dt([f]))).toEqual({ kind: "video", file: f, others: 0 });
  });

  it("takes the first video of several and counts the rest", () => {
    const pic = new File(["x"], "a.png", { type: "image/png" });
    const a = video("a.mov", "video/quicktime");
    const b = video("b.mp4");
    expect(classifyDrop(dt([pic, a, b]))).toEqual({ kind: "video", file: a, others: 2 });
  });

  it("names another file so the form can say it is not a video", () => {
    const txt = new File(["x"], "notes.txt", { type: "text/plain" });
    expect(classifyDrop(dt([txt]))).toEqual({ kind: "other", file: txt });
  });

  it("takes a dropped link when no file came", () => {
    expect(classifyDrop(dt([], { "text/uri-list": "https://www.twitch.tv/videos/1" }))).toEqual({ kind: "link", url: "https://www.twitch.tv/videos/1" });
  });

  it("takes the link of a thumbnail dragged off a video page (its picture plus the page link)", () => {
    const jpg = new File(["x"], "hqdefault.jpg", { type: "image/jpeg" });
    const uri = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    expect(classifyDrop(dt([jpg], { "text/uri-list": uri }))).toEqual({ kind: "link", url: uri });
  });

  it("still takes a video over a link that came with it", () => {
    const f = video();
    expect(classifyDrop(dt([f], { "text/uri-list": "https://kick.com/x" }))).toEqual({ kind: "video", file: f, others: 0 });
  });

  it("takes a video with no type by its name", () => {
    const f = new File(["x"], "clip.mov", { type: "" });
    expect(classifyDrop(dt([f]))).toEqual({ kind: "video", file: f, others: 0 });
    expect(videoType(f)).toBe("video/quicktime");
  });

  it("is none for nothing it can use", () => {
    expect(classifyDrop(dt([], { "text/plain": "just words" }))).toEqual({ kind: "none" });
    expect(classifyDrop(null)).toEqual({ kind: "none" });
  });
});
