// Section 1 of the round-3 contract (D2): the helper and Clip Factory's server read one rule. The server's minutes
// live in api/src/clipfactory_api/tiktok_self.py, one line each, so this test reads them from there.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { BEAT_EVERY_MS, FIND_FOR_MS } from "../src/plan.js";

const SERVER = new URL("../../../api/src/clipfactory_api/tiktok_self.py", import.meta.url);

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
