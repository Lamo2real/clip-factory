// 1.3.0 (§47.9): TikTok's commercial content disclosure on Clip Factory's posts, set from the job and read back before
// Post, like privacy. The fake Studio below follows what the probe read in TikTok Studio on 24 Nov 2026 (headless,
// nothing posted): the "Disclose post content" switch sits under Show more; only once it is on do "Your brand" and
// "Branded content" show; Branded content is greyed out while Who can see it is Only you.
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.CF_TT_BASE = path.join(os.tmpdir(), "cf-tt-label-test");
process.env.CF_TT_DOWNLOADS = path.join(os.tmpdir(), "cf-tt-label-test-downloads");
const { BRANDED, DISCLOSE, REASONS, Stop, YOUR_BRAND, applyLabel, checkLabel, labelOf, readLabel } = await import("../src/tiktok.js");
const { tidyGoes } = await import("../src/run.js");

function studio({ privacy = "Everyone", sticky = [], missing = [], start = {} } = {}) {
  const st = { [DISCLOSE]: false, [YOUR_BRAND]: false, [BRANDED]: false, ...start };
  const clicks = [];
  let opened = false;
  const form = {
    openMore: async () => {
      opened = true;
    },
    box: async (name) => {
      if (!opened || missing.includes(name)) return null; // under Show more
      if (name !== DISCLOSE && !st[DISCLOSE]) return null; // the two boxes only show once Disclose is on
      return {
        on: async () => st[name],
        disabled: async () => name === BRANDED && privacy === "Only you",
        click: async () => {
          clicks.push(name);
          if (sticky.includes(name)) return;
          st[name] = !st[name];
          if (name === DISCLOSE && !st[DISCLOSE]) Object.assign(st, { [YOUR_BRAND]: false, [BRANDED]: false });
        },
      };
    },
  };
  return { form, st, clicks };
}

const isLabelStop = (e) => e instanceof Stop && e.reason === REASONS.label && !e.needsYou;
const job = (fields = {}) => ({ clipId: "c1", privacy: "PUBLIC_TO_EVERYONE", comment: true, duet: true, stitch: true, ...fields });

test("labelOf: Branded content (every campaign clip) and Your brand, each only when the job says true", () => {
  assert.deepEqual(labelOf(job({ brandContent: true, brandOrganic: false })), { disclose: true, organic: false, branded: true });
  assert.deepEqual(labelOf(job({ brandOrganic: true })), { disclose: true, organic: true, branded: false });
  assert.deepEqual(labelOf(job({ brandContent: true, brandOrganic: true })), { disclose: true, organic: true, branded: true });
  // An older server's job has neither key; "true" as text is not a label.
  assert.deepEqual(labelOf(job()), { disclose: false, organic: false, branded: false });
  assert.deepEqual(labelOf(job({ brandContent: "true" })), { disclose: false, organic: false, branded: false });
});

test("a campaign clip: Show more is opened, Disclose post content goes on, Branded content is ticked, Your brand stays off", async () => {
  const s = studio();
  await applyLabel(s.form, job({ brandContent: true, brandOrganic: false }));
  assert.deepEqual(s.st, { [DISCLOSE]: true, [YOUR_BRAND]: false, [BRANDED]: true });
  assert.deepEqual(s.clicks, [DISCLOSE, BRANDED]);
  assert.deepEqual(await readLabel(s.form), { disclose: true, organic: false, branded: true });
  await checkLabel(s.form, job({ brandContent: true })); // the read back right before Post passes
});

test("a paid clip with Your brand only, and one with both", async () => {
  const own = studio();
  await applyLabel(own.form, job({ brandOrganic: true }));
  assert.deepEqual(own.st, { [DISCLOSE]: true, [YOUR_BRAND]: true, [BRANDED]: false });
  const both = studio();
  await applyLabel(both.form, job({ brandContent: true, brandOrganic: true }));
  assert.deepEqual(both.st, { [DISCLOSE]: true, [YOUR_BRAND]: true, [BRANDED]: true });
});

test("a box TikTok carried over from the last post is unticked when this job doesn't want it", async () => {
  const s = studio({ start: { [DISCLOSE]: true, [YOUR_BRAND]: true, [BRANDED]: false } });
  await applyLabel(s.form, job({ brandContent: true }));
  assert.deepEqual(s.st, { [DISCLOSE]: true, [YOUR_BRAND]: false, [BRANDED]: true });
});

test("no label: Disclose post content stays off, and a carried-over one is turned off (read back)", async () => {
  const off = studio();
  await applyLabel(off.form, job());
  assert.deepEqual(off.clicks, []);
  const carried = studio({ start: { [DISCLOSE]: true, [BRANDED]: true } });
  await applyLabel(carried.form, job({ brandContent: false, brandOrganic: false }));
  assert.deepEqual(carried.st, { [DISCLOSE]: false, [YOUR_BRAND]: false, [BRANDED]: false });
  // A page without the switch at all is fine while no label is wanted.
  await applyLabel(studio({ missing: [DISCLOSE] }).form, job());
});

test("never a post without the label it needs: no switch, a greyed-out Branded content (Only you), or one TikTok doesn't keep", async () => {
  await assert.rejects(applyLabel(studio({ missing: [DISCLOSE] }).form, job({ brandContent: true })), isLabelStop);
  await assert.rejects(applyLabel(studio({ missing: [BRANDED] }).form, job({ brandContent: true })), isLabelStop);
  const onlyYou = studio({ privacy: "Only you" });
  await assert.rejects(applyLabel(onlyYou.form, job({ brandContent: true, privacy: "SELF_ONLY" })), isLabelStop);
  assert.equal(onlyYou.st[BRANDED], false);
  await assert.rejects(applyLabel(studio({ sticky: [BRANDED] }).form, job({ brandContent: true })), isLabelStop);
  await assert.rejects(applyLabel(studio({ sticky: [DISCLOSE] }).form, job({ brandOrganic: true })), isLabelStop);
  // ... and none without a label that stays on when it should be off.
  await assert.rejects(applyLabel(studio({ sticky: [DISCLOSE], start: { [DISCLOSE]: true } }).form, job()), isLabelStop);
});

test("the read back right before Post stops when the label moved after it was set", async () => {
  const s = studio();
  await applyLabel(s.form, job({ brandContent: true }));
  s.st[BRANDED] = false; // TikTok unticked it (say, after a privacy change)
  await assert.rejects(checkLabel(s.form, job({ brandContent: true })), isLabelStop);
  s.st[BRANDED] = true;
  s.st[YOUR_BRAND] = true;
  await assert.rejects(checkLabel(s.form, job({ brandContent: true })), isLabelStop);
  await assert.rejects(checkLabel(s.form, job()), isLabelStop);
});

test("REASONS.label, word for word", () => {
  assert.equal(REASONS.label, "Your Mac couldn't set TikTok's Branded content label the way this clip needs, so it didn't post. Tap Try again.");
});

test("tidy: the kept video goes once the post is up for everyone, or with the privacy this Mac's job set", () => {
  const posted = (privacy) => ({ platform: "tiktok", status: "posted", privacy });
  // Everyone (and a ledger entry from before 1.3.0, which has no privacy): only a public post lets it go.
  assert.equal(tidyGoes({ privacy: "PUBLIC_TO_EVERYONE" }, posted("public")), true);
  assert.equal(tidyGoes({}, posted("public")), true);
  assert.equal(tidyGoes({}, posted("private")), false);
  assert.equal(tidyGoes({ privacy: "PUBLIC_TO_EVERYONE" }, posted("private")), false);
  // Friends or Only you: the Mac's done says private, and that is the job's own choice.
  assert.equal(tidyGoes({ privacy: "MUTUAL_FOLLOW_FRIENDS" }, posted("private")), true);
  assert.equal(tidyGoes({ privacy: "SELF_ONLY" }, posted("private")), true);
  assert.equal(tidyGoes({ privacy: "SELF_ONLY" }, posted("public")), true); // the owner's It's on TikTok
  // Not up yet: never.
  assert.equal(tidyGoes({ privacy: "SELF_ONLY" }, { platform: "tiktok", status: "mac" }), false);
  assert.equal(tidyGoes({ privacy: "SELF_ONLY" }, undefined), false);
});
