// §47.10 D3: before every post the helper reads which TikTok its Chrome is logged in to and refuses unless it is
// the lane's target. Each source is a pure parser; sameAccount decides.
import assert from "node:assert/strict";
import { test } from "node:test";

import { at, bare, fromAccountInfo, fromHrefs, fromRehydration, linkHandle, mergeSeen, sameAccount, seenFrom, whoAmI } from "../src/whoami.js";

test("handles are compared in lower case without @; anything else is not a handle", () => {
  assert.equal(bare("@Clips.Funded"), "clips.funded");
  assert.equal(bare("lamo.clips"), "lamo.clips");
  assert.equal(bare("Clips Funded"), "");
  assert.equal(bare(null), "");
  assert.equal(at("clips.funded"), "@clips.funded");
  assert.equal(at("@Lamo.Clips"), "@Lamo.Clips");
  assert.equal(at("x/y"), null);
});

test("source 1: the passport answer's username and uid", () => {
  assert.deepEqual(fromAccountInfo({ data: { username: "clips.funded", user_id_str: "7400000000000000001" } }), {
    handle: "@clips.funded",
    uid: "7400000000000000001",
  });
  assert.deepEqual(fromAccountInfo({ data: { username: "", user_id_str: "abc" } }), {});
  assert.deepEqual(fromAccountInfo({ message: "error", data: { error_code: 1 } }), {});
  assert.deepEqual(fromAccountInfo(null), {});
  assert.deepEqual(fromAccountInfo("nope"), {});
});

test("source 2: the account's handles in Studio › Posts links, once each", () => {
  assert.deepEqual(
    fromHrefs([
      "https://www.tiktok.com/@lamo.clips/video/7710644811602169121?lang=en",
      "https://www.tiktok.com/@Lamo.Clips/video/7710644811602169122",
      "https://www.tiktok.com/tiktokstudio/content",
      "/video/7710644811602169121",
    ]),
    ["@lamo.clips"]
  );
  assert.deepEqual(fromHrefs([]), []);
  assert.deepEqual(fromHrefs(["https://www.tiktok.com/@a/video/12345678", "https://www.tiktok.com/@b/video/12345679"]), ["@a", "@b"]);
});

test("source 3: www.tiktok.com's rehydration data", () => {
  const page = { __DEFAULT_SCOPE__: { "webapp.app-context": { user: { uniqueId: "clips.funded", uid: "7400000000000000001" } } } };
  assert.deepEqual(fromRehydration(JSON.stringify(page)), { handle: "@clips.funded", uid: "7400000000000000001" });
  assert.deepEqual(fromRehydration({ "webapp.app-context": { user: { uniqueId: "x.y" } } }), { handle: "@x.y" });
  assert.deepEqual(fromRehydration("{not json"), {});
  assert.deepEqual(fromRehydration(JSON.stringify({ __DEFAULT_SCOPE__: { "webapp.app-context": {} } })), {});
});

test("one read gathers every handle and uid; two reads merge", () => {
  const seen = seenFrom({
    info: { handle: "@clips.funded", uid: "7400000000000000001" },
    hrefs: ["https://www.tiktok.com/@clips.funded/video/7710644811602169121"],
    rehydration: {},
  });
  assert.deepEqual(seen, { handles: ["@clips.funded"], uids: ["7400000000000000001"], uid: "7400000000000000001" });
  const more = mergeSeen({ handles: [], uids: [] }, seen);
  assert.deepEqual(more.handles, ["@clips.funded"]);
});

test("sameAccount: same only when every readable handle is the target and the uid is the pinned one", () => {
  const one = { handles: ["@Clips.Funded"], uids: ["7400000000000000001"] };
  assert.equal(sameAccount(one, "@clips.funded").verdict, "same");
  assert.equal(sameAccount(one, "clips.funded", "7400000000000000001").verdict, "same");
  assert.equal(sameAccount(one, "@clips.funded").uid, "7400000000000000001");
  // Another handle anywhere: wrong, and it says which.
  assert.deepEqual(sameAccount({ handles: ["@lamo.clips"] }, "@clips.funded"), { verdict: "wrong", seen: "@lamo.clips" });
  assert.equal(sameAccount({ handles: ["@clips.funded", "@lamo.clips"] }, "@clips.funded").verdict, "wrong");
  // The right handle but another uid than the pinned one, two different uids, or Clip Factory's uid: wrong.
  assert.equal(sameAccount(one, "@clips.funded", "7400000000000000009").verdict, "wrong");
  assert.equal(sameAccount({ handles: ["@clips.funded"], uids: ["1111111", "2222222"] }, "@clips.funded").verdict, "wrong");
  assert.equal(sameAccount(one, "@clips.funded", null, { notUid: "7400000000000000001" }).verdict, "wrong");
  // Nothing readable: unknown (nothing posts).
  assert.equal(sameAccount({ handles: [], uids: [] }, "@clips.funded").verdict, "unknown");
  assert.equal(sameAccount({}, "@clips.funded").verdict, "unknown");
  // Only a uid: same only when it is the pinned one.
  assert.equal(sameAccount({ handles: [], uids: ["7400000000000000001"] }, "@clips.funded", "7400000000000000001").verdict, "same");
  assert.equal(sameAccount({ handles: [], uids: ["7400000000000000001"] }, "@clips.funded").verdict, "unknown");
  // No target: never same.
  assert.equal(sameAccount(one, "").verdict, "unknown");
  assert.equal(sameAccount(one, "Clips Funded").verdict, "unknown");
});

test("linkHandle: the account in a post's link, or none", () => {
  assert.equal(linkHandle("https://www.tiktok.com/@clips.funded/video/7710644811602169121"), "@clips.funded");
  assert.equal(linkHandle("https://tiktok.com/@lamo.clips/video/7710644811602169121?lang=en"), "@lamo.clips");
  assert.equal(linkHandle("https://www.tiktok.com/video/7710644811602169121"), null);
  assert.equal(linkHandle("https://evil.example/@clips.funded/video/7710644811602169121"), null);
  assert.equal(linkHandle(null), null);
});

test("off Studio › Posts (www.tiktok.com's feed) the video links are other people's: only the account's own data counts", async () => {
  // A page whose passport answer is unreadable, whose links are the feed's, and whose rehydration data is the account's.
  const page = {
    evaluate: async (fn) => (String(fn).includes("__UNIVERSAL_DATA_FOR_REHYDRATION__") ? JSON.stringify({ __DEFAULT_SCOPE__: { "webapp.app-context": { user: { uniqueId: "clips.funded" } } } }) : null),
    $$eval: async () => ["https://www.tiktok.com/@someone.else/video/7710644811602169121"],
  };
  assert.deepEqual((await whoAmI(page, { links: false })).handles, ["@clips.funded"]);
  assert.equal(sameAccount(await whoAmI(page, { links: false }), "@clips.funded").verdict, "same");
  // On Studio › Posts the links are the account's own rows, so they count (and here they'd say another account).
  assert.equal(sameAccount(await whoAmI(page), "@clips.funded").verdict, "wrong");
});
