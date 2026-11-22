import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// The frame module reads CF_TT_CONTROL when it loads, so point it at an empty folder first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-frame-"));
process.env.CF_TT_CONTROL = dir;
const { frame } = await import("../src/frame.js");

test("a normal run shows nothing: no frame, no notification (the owner's rule of 22 Nov)", async () => {
  fs.writeFileSync(path.join(dir, "state.txt"), "off\n\n");
  const fr = frame();
  assert.equal(await fr.on("Getting it ready"), true); // never blocks a run
  await fr.step("Uploading the video to TikTok");
  await fr.done("On TikTok");
  await fr.off();
  assert.equal(fs.readFileSync(path.join(dir, "state.txt"), "utf8"), "off\n\n"); // the frame never changed
});
