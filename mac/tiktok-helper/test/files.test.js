import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Where the helper saves videos, read when its modules load.
const downloads = path.join(os.tmpdir(), "cf-downloads-test");
process.env.CF_TT_DOWNLOADS = downloads;
const { ownFile } = await import("../src/run.js");

test("the helper only ever reuses or deletes its own clip-factory videos, directly in Downloads", () => {
  assert.equal(ownFile(path.join(downloads, "clip-factory-the-replay-settles-who-was-lying.mp4")), true);
  assert.equal(ownFile(path.join(downloads, "clip-factory-jump (2).mp4")), true);
  // Anything else in Downloads is never touched.
  assert.equal(ownFile(path.join(downloads, "STEP 1-3.mp4")), false);
  assert.equal(ownFile(path.join(downloads, "clip-factory-icon.png")), false);
  assert.equal(ownFile(path.join(downloads, "google-clip-factory-secrets.json")), false);
  // Not outside Downloads, not in a folder inside it, and never without a path.
  assert.equal(ownFile(path.join(os.homedir(), "Movies", "clip-factory-x.mp4")), false);
  assert.equal(ownFile(path.join(downloads, "sub", "clip-factory-x.mp4")), false);
  assert.equal(ownFile(path.join(downloads, "..", "clip-factory-x.mp4")), false);
  assert.equal(ownFile(null), false);
  assert.equal(ownFile(""), false);
});

test("Clips Funded's videos too: clips-funded-….mp4, directly in Downloads, and nothing else", () => {
  assert.equal(ownFile(path.join(downloads, "clips-funded-the-heist.mp4")), true);
  assert.equal(ownFile(path.join(downloads, "clips-funded-the-heist (2).mp4")), true);
  assert.equal(ownFile(path.join(downloads, "clips-funded.mp4")), false);
  assert.equal(ownFile(path.join(downloads, "Clips-Funded-x.mov")), false);
  assert.equal(ownFile(path.join(downloads, "sub", "clips-funded-x.mp4")), false);
  assert.equal(ownFile(path.join(downloads, "my-clips-funded-x.mp4")), false);
  assert.equal(ownFile(path.join(os.homedir(), "Movies", "clips-funded-x.mp4")), false);
});
