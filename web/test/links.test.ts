import { describe, expect, it } from "vitest";
import { checkLink, extractLink } from "../src/lib/links.ts";

describe("checkLink", () => {
  it("is empty for blank input", () => {
    expect(checkLink("   ")).toEqual({ state: "empty" });
  });

  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "video"],
    ["youtube.com/watch?v=dQw4w9WgXcQ&t=42s", "video"],
    ["https://youtu.be/dQw4w9WgXcQ?si=abc", "video"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "video"],
    ["https://www.youtube.com/live/dQw4w9WgXcQ", "live"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "video"],
  ])("recognises the YouTube link %s", (url, kind) => {
    const r = checkLink(url);
    expect(r).toMatchObject({ state: "ok", platform: "youtube", kind, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
  });

  it.each([
    ["https://www.twitch.tv/videos/2245119876", "video"],
    ["twitch.tv/lamo", "live"],
    ["https://clips.twitch.tv/FunnyClipSlug", "clip"],
    ["https://www.twitch.tv/lamo/clip/FunnyClipSlug", "clip"],
  ])("recognises the Twitch link %s", (url, kind) => {
    expect(checkLink(url)).toMatchObject({ state: "ok", platform: "twitch", kind });
  });

  it.each([
    ["https://kick.com/lamo", "live"],
    ["https://kick.com/lamo/videos/8f2c1a", "video"],
    ["https://kick.com/video/0b0f9a3e", "video"],
    ["https://kick.com/lamo/clips/clip_01", "clip"],
  ])("recognises the Kick link %s", (url, kind) => {
    expect(checkLink(url)).toMatchObject({ state: "ok", platform: "kick", kind });
  });

  it.each([
    ["https://www.twitch.tv/directory", "twitch"],
    ["https://www.twitch.tv/settings", "twitch"],
    ["https://www.twitch.tv/videos", "twitch"],
    ["twitch.tv/Search", "twitch"],
    ["https://kick.com/categories", "kick"],
    ["https://kick.com/browse", "kick"],
    ["https://kick.com/following", "kick"],
  ])("refuses the site page %s: it is not a live channel", (url, platform) => {
    const r = checkLink(url);
    expect(r).toMatchObject({ state: "error", platform });
    expect(r.state === "error" && r.message).toMatch(/Open the video or the channel and copy its link\.$/);
  });

  it.each([
    ["https://www.twitch.tv/lamo/videos", "twitch", "That's a list of videos. Open one video, then copy its link."],
    ["https://www.twitch.tv/lamo/videos?filter=archives", "twitch", "That's a list of videos. Open one video, then copy its link."],
    ["https://www.twitch.tv/lamo/clips", "twitch", "That's a list of clips. Open one clip, then copy its link."],
    ["https://kick.com/lamo/videos", "kick", "That's a list of videos. Open one video, then copy its link."],
    ["https://kick.com/lamo/clips", "kick", "That's a list of clips. Open one clip, then copy its link."],
  ])("says how to get one video from the channel's list %s", (url, platform, message) => {
    expect(checkLink(url)).toEqual({ state: "error", platform, message });
  });

  it("explains a YouTube link that is not a video", () => {
    expect(checkLink("https://www.youtube.com/@channel")).toMatchObject({ state: "error", platform: "youtube" });
    expect(checkLink("https://youtu.be/short")).toMatchObject({ state: "error", platform: "youtube" });
  });

  it("rejects other sites and non-links in plain words", () => {
    expect(checkLink("https://vimeo.com/123")).toEqual({
      state: "error",
      message: "Clip Factory works with YouTube, Twitch and Kick links.",
    });
    expect(checkLink("not a link")).toMatchObject({ state: "error" });
    expect(checkLink("ftp://youtube.com/watch?v=dQw4w9WgXcQ")).toMatchObject({ state: "error" });
  });
});

describe("extractLink", () => {
  it("pulls the link out of share text", () => {
    expect(extractLink("Watch this! https://youtu.be/dQw4w9WgXcQ?si=x")).toBe("https://youtu.be/dQw4w9WgXcQ?si=x");
    expect(extractLink("so good (https://www.twitch.tv/videos/123).")).toBe("https://www.twitch.tv/videos/123");
    expect(extractLink("look kick.com/xqc now")).toBe("kick.com/xqc");
    expect(extractLink("https://youtu.be/dQw4w9WgXcQ")).toBe("https://youtu.be/dQw4w9WgXcQ");
    expect(extractLink("just words")).toBe("just words");
  });
});
