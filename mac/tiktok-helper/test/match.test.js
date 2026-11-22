import assert from "node:assert/strict";
import { test } from "node:test";

import { captionMatches, findExisting, findNewPost, freeName, normalize, postLink, videoId } from "../src/match.js";

test("normalize drops accents, case and extra spaces", () => {
  assert.equal(normalize("  Café   NO WAY\n"), "cafe no way");
});

test("a Studio row holds the caption, even cut short and with tags", () => {
  const caption = "the jump counted?? no way he landed that #gta #fyp";
  assert.ok(captionMatches("Posted 2m ago\nThe jump counted?? No way he landed th… 0 views", caption) === false);
  assert.ok(captionMatches("The jump counted?? No way he landed that #gta #fyp\n0 views", caption));
});

test("video ids and links", () => {
  assert.equal(videoId("https://www.tiktok.com/@lamo.clips/video/7710644811602169121?lang=en"), "7710644811602169121");
  assert.equal(postLink("https://www.tiktok.com/@lamo.clips/video/7710644811602169121"), "https://www.tiktok.com/@lamo.clips/video/7710644811602169121");
  assert.equal(postLink("/video/7710644811602169121", "@lamo.clips"), "https://www.tiktok.com/@lamo.clips/video/7710644811602169121");
  assert.equal(postLink("/video/7710644811602169121"), null);
  assert.equal(videoId("https://www.tiktok.com/tiktokstudio/content"), null);
});

test("the new post is one not in the baseline with this caption; two candidates = unsure", () => {
  const caption = "clutch 1v4 with a pistol";
  const rows = [
    { id: "111111", text: "clutch 1v4 with a pistol" },
    { id: "222222", text: "another clip" },
  ];
  assert.equal(findNewPost(rows, caption, ["111111"]), null);
  assert.equal(findNewPost(rows, caption, ["222222"]).id, "111111");
  const twice = [...rows, { id: "333333", text: "Clutch 1v4 with a pistol" }];
  assert.equal(findNewPost(twice, caption, ["222222"]), null);
});

test("an existing post with the caption is found (never post a duplicate)", () => {
  assert.equal(findExisting([{ id: "9", text: "x" }, { id: "999999", text: "Clutch 1v4 with a pistol" }], "clutch 1v4 with a pistol").id, "999999");
  assert.equal(findExisting([{ id: "999999", text: "something else" }], "clutch 1v4 with a pistol"), null);
});

test("file names never overwrite a file in Downloads", () => {
  const taken = new Set(["clip-factory-jump.mp4", "clip-factory-jump (2).mp4"]);
  assert.equal(freeName("clip-factory-jump.mp4", (n) => taken.has(n)), "clip-factory-jump (3).mp4");
  assert.equal(freeName("a/b:c.mp4", () => false), "a-b-c.mp4");
});
