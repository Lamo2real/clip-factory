// Section 1 of the round-3 contract (D2): the helper and Clip Factory's server read one rule. The server's minutes
// live in api/src/clipfactory_api/tiktok_self.py, one line each, so this test reads them from there.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { VERSION } from "../src/paths.js";
import { BEAT_EVERY_MS, FIND_FOR_MS } from "../src/plan.js";

const SERVER = new URL("../../../api/src/clipfactory_api/tiktok_self.py", import.meta.url);
const WS_SERVER = new URL("../../../api/src/clipfactory_api/workspaces/mac.py", import.meta.url);

function minutes(name) {
  const text = fs.readFileSync(SERVER, "utf8");
  const found = text.match(new RegExp(`^${name} = timedelta\\(minutes=(\\d+)\\)$`, "m"));
  assert.ok(found, `${name} = timedelta(minutes=N) is in tiktok_self.py`);
  return Number(found[1]);
}

test("the helper looks for a pressed post exactly as long as Try again waits (MAC_FIND_WINDOW)", () => {
  assert.equal(FIND_FOR_MS, minutes("MAC_FIND_WINDOW") * 60_000);
});

test("the helper beats a job often enough that a working post never reads stuck (MAC_BEAT_STALE)", () => {
  assert.ok(3 * BEAT_EVERY_MS <= minutes("MAC_BEAT_STALE") * 60_000);
});

test("this helper's version is one Clip Factory counts beats for (MAC_BEATS_FROM): older ones get only the claim cap", () => {
  const text = fs.readFileSync(SERVER, "utf8");
  const found = text.match(/^MAC_BEATS_FROM = "(\d+(?:\.\d+)*)"$/m);
  assert.ok(found, 'MAC_BEATS_FROM = "x.y.z" is in tiktok_self.py');
  const parts = (v) => v.split(".").map(Number);
  const [mine, from] = [parts(VERSION), parts(found[1])];
  const cmp = mine.map((n, i) => n - (from[i] ?? 0)).find((d) => d !== 0) ?? 0;
  assert.ok(cmp >= 0, `VERSION ${VERSION} is at least ${found[1]}`);
});

test("this helper's version is one Clips Funded hands its TikTok jobs to (MAC_WS_FROM): older ones never get them", () => {
  const text = fs.readFileSync(WS_SERVER, "utf8");
  const found = text.match(/^MAC_WS_FROM = "(\d+\.\d+\.\d+)"$/m);
  assert.ok(found, 'MAC_WS_FROM = "x.y.z" is in workspaces/mac.py');
  const parts = (v) => v.split(".").map(Number);
  const [mine, from] = [parts(VERSION), parts(found[1])];
  const cmp = mine.map((n, i) => n - (from[i] ?? 0)).find((d) => d !== 0) ?? 0;
  assert.ok(cmp >= 0, `VERSION ${VERSION} is at least ${found[1]}`);
  assert.equal(VERSION, "1.2.1");
});

test("package.json and its lockfile say the same version as the helper", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(fs.readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(pkg.version, VERSION);
  assert.equal(lock.version, VERSION);
  assert.equal(lock.packages[""].version, VERSION);
});
