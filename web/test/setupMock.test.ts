import { beforeEach, describe, expect, it } from "vitest";
import { mockAuthorize, setupApi } from "../src/api/mock/setup.ts";
import { privacyChoices, sheetReady } from "../src/screens/review/TikTokSheet.tsx";

const YT = { clientId: "123456789012-abcdefghij0123456789klmnopqrst.apps." + "googleusercontent.com", clientSecret: "GOCSPX-" + "AbCdEfGhIjKlMnOpQrStUvWxYz12" };

beforeEach(() => sessionStorage.clear());

describe("the mock posting setup (§17.10)", () => {
  it("starts with five platforms, none ready, and the contract's values", () => {
    const o = setupApi().overview();
    expect(o.platforms.map((p) => p.platform)).toEqual(["youtube", "tiktok", "instagram", "facebook", "x"]);
    expect(o.ready).toBe(0);
    expect(o.values.redirectUris.youtube).toBe("https://hexample.execute-api.eu-north-1.amazonaws.com/v1/oauth/youtube/callback");
    expect(o.values.websiteUrl).toBe("https://dexample.cloudfront.net/about.html");
  });

  it("keeps only masked hints, never the keys, in what it answers", () => {
    const s = setupApi().saveKeys("youtube", YT);
    expect(s.keys.saved).toBe(true);
    expect(s.keys.hints).toEqual({ clientId: "123456….com", clientSecret: "••••Yz12" });
    expect(JSON.stringify(s)).not.toContain(YT.clientSecret);
    expect(sessionStorage.getItem("cf-mock-setup")).not.toContain(YT.clientSecret);
  });

  it("turns down keys that do not look right, with a friendly sentence", () => {
    expect(() => setupApi().saveKeys("youtube", { clientId: YT.clientId, clientSecret: "nope" })).toThrow(/starts with GOCSPX-/);
    expect(() => setupApi().saveKeys("instagram", { clientId: "1234567890123", clientSecret: "0123456789abcdef0123456789abcdef" })).toThrow(
      /Configuration ID/,
    );
  });

  it("needs keys before Connect, then goes through the pretend consent page and back", () => {
    const api = setupApi();
    expect(() => api.connect("youtube")).toThrow("Paste your YouTube keys first.");
    api.saveKeys("youtube", YT);
    const { authorizeUrl } = api.connect("youtube");
    expect(authorizeUrl).toMatch(/^\/mock-oauth\/youtube\?state=/);
    const state = new URL(authorizeUrl, "http://x").searchParams.get("state");
    expect(mockAuthorize("youtube", "wrong", true)).toBe("/settings/posting/setup/youtube?result=expired");
    api.connect("youtube");
    expect(mockAuthorize("youtube", null, false)).toBe("/settings/posting/setup/youtube?result=denied");
    const again = new URL(setupApi().connect("youtube").authorizeUrl, "http://x").searchParams.get("state");
    expect(again).not.toBe(state);
    expect(mockAuthorize("youtube", again, true)).toBe("/settings/posting/setup/youtube?result=connected");
    const yt = setupApi().get("youtube");
    expect(yt.account.status).toBe("connected");
    // YouTube is not ready until the app is published (gate published_app).
    expect(yt.ready).toBe(false);
    expect(setupApi().setStep("youtube", "key-publish", true).ready).toBe(true);
  });

  it("asks which account for Meta, then connects the one picked", () => {
    const api = setupApi();
    api.saveKeys("facebook", { clientId: "1234567890123456", clientSecret: "fedcba9876543210fedcba9876543210", configId: "1122334455667788" });
    const state = new URL(api.connect("facebook").authorizeUrl, "http://x").searchParams.get("state");
    expect(mockAuthorize("facebook", state, true)).toBe("/settings/posting/setup/facebook?result=choose");
    const fresh = setupApi();
    const choices = fresh.get("facebook").account.choices!;
    expect(choices).toHaveLength(2);
    const s = fresh.choose("facebook", choices[1]!.id);
    expect(s.account.status).toBe("connected");
    expect(s.account.handle).toBe("Clip Factory Fans");
    // Before the app is Live, posts only show to the owner (gate app_live limited) but it works.
    expect(s.ready).toBe(true);
  });

  it("checks keys: ok, or keys_wrong for a clientId with 'bad' in it", () => {
    const api = setupApi();
    api.saveKeys("x", { clientId: "dGhpc2lzYWNsaWVudGlkMTIz", clientSecret: "c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0" });
    expect(api.check("x").check).toMatchObject({ ok: true, code: "not_connected", message: "Your keys work. Now press Connect X." });
    api.saveKeys("x", { clientId: "badbadbadbadbadbadbadbad", clientSecret: "c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0" });
    expect(api.check("x").check).toMatchObject({ ok: false, code: "keys_wrong" });
  });

  it("new keys disconnect the account (keys_changed); expireToken asks for Connect again", () => {
    const api = setupApi();
    api.controls.finish("x");
    expect(api.get("x").ready).toBe(true);
    api.controls.expireToken("x");
    expect(api.get("x").account).toMatchObject({ status: "needs_reconnect", reason: "token_dead" });
    api.saveKeys("x", { clientId: "dGhpc2lzYW5ld2NsaWVudGlkMTIz", clientSecret: "c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0" });
    expect(api.get("x").account).toMatchObject({ status: "not_connected", reason: "keys_changed" });
  });

  it("takes TikTok's verification file only by its own name", () => {
    const api = setupApi();
    expect(() => api.uploadFile("evil.html", "x")).toThrow(/starts with tiktok/);
    expect(api.uploadFile("tiktokAbCd1234.txt", "tiktok-developers-site-verification=abc").files).toEqual(["tiktokAbCd1234.txt"]);
    api.deleteFile("tiktokAbCd1234.txt");
    expect(api.get("tiktok").files).toEqual([]);
  });

  it("TikTok works privately until its audit: posting_audit limited, creator only offers Only me", () => {
    const api = setupApi();
    api.controls.finish("tiktok");
    const t = api.get("tiktok");
    expect(t.ready).toBe(true);
    expect(t.gates.find((g) => g.key === "posting_audit")!.state).toBe("limited");
    expect(api.creator().privacyOptions).toEqual(["SELF_ONLY"]);
    api.controls.setAudit(true);
    expect(api.creator().privacyOptions).toContain("PUBLIC_TO_EVERYONE");
  });
});

describe("the Post to TikTok sheet's rules (§17.8)", () => {
  it("never offers Only me for branded content", () => {
    expect(privacyChoices(["PUBLIC_TO_EVERYONE", "SELF_ONLY"], false)).toEqual(["PUBLIC_TO_EVERYONE", "SELF_ONLY"]);
    expect(privacyChoices(["PUBLIC_TO_EVERYONE", "SELF_ONLY"], true)).toEqual(["PUBLIC_TO_EVERYONE"]);
  });

  it("puts Everyone first and Only me last, and never offers more than TikTok does", () => {
    expect(privacyChoices(["SELF_ONLY", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "PUBLIC_TO_EVERYONE"], false)).toEqual([
      "PUBLIC_TO_EVERYONE",
      "FOLLOWER_OF_CREATOR",
      "MUTUAL_FOLLOW_FRIENDS",
      "SELF_ONLY",
    ]);
    expect(privacyChoices(["SELF_ONLY"], false)).toEqual(["SELF_ONLY"]);
    expect(privacyChoices(["SELF_ONLY"], true)).toEqual([]);
  });

  it("keeps Keep off until a privacy is picked, and Commercial content says whose", () => {
    const base = { privacy: "", commercial: false, yourBrand: false, branded: false };
    expect(sheetReady(base)).toBe(false);
    expect(sheetReady({ ...base, privacy: "SELF_ONLY" })).toBe(true);
    expect(sheetReady({ ...base, privacy: "PUBLIC_TO_EVERYONE", commercial: true })).toBe(false);
    expect(sheetReady({ ...base, privacy: "PUBLIC_TO_EVERYONE", commercial: true, yourBrand: true })).toBe(true);
    expect(sheetReady({ ...base, privacy: "SELF_ONLY", commercial: true, branded: true })).toBe(false);
  });
});
