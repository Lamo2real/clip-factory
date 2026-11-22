import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// The frame module reads CF_TT_CONTROL when it loads, so point it at an empty folder first.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-frame-"));
process.env.CF_TT_CONTROL = dir;
const { frame, frameAvailable } = await import("../src/frame.js");

test("no frame app: the frame can't go up, so the helper drives nothing, and the state file is untouched", async () => {
  fs.writeFileSync(path.join(dir, "state.txt"), "control\nanother session's step\n");
  assert.equal(frameAvailable(), false);
  const fr = frame();
  assert.equal(await fr.on("Getting it ready"), false);
  assert.equal(fr.shown, false);
  await fr.done("On TikTok");
  await fr.off();
  assert.equal(fs.readFileSync(path.join(dir, "state.txt"), "utf8"), "control\nanother session's step\n");
});
