// The way back from a setup page (docs/CONTRACTS.md §39.1 `?back=`): only the six same-origin shapes count.
import { describe, expect, it } from "vitest";
import { backLabel, backLink, backNext, parseBack, withBack } from "../src/lib/backLink.ts";

const UUID = "200ea21b-be80-4db8-b552-8e32b148604e";
const ULID = "01JD3X5Q7Z9ABCDEFGHJKMNPQR";

describe("?back=", () => {
  it("the six shapes pass, with their words", () => {
    expect(parseBack(`/campaigns/${UUID}`)).toEqual({ href: `/campaigns/${UUID}`, kind: "campaign", campaignId: UUID });
    expect(parseBack("/campaigns")).toEqual({ href: "/campaigns", kind: "campaigns" });
    expect(parseBack("/review")).toEqual({ href: "/review", kind: "clip" });
    expect(parseBack(`/review?job=${ULID}`)).toEqual({ href: `/review?job=${ULID}`, kind: "clip" });
    expect(parseBack(`/clips/${ULID}`)).toEqual({ href: `/clips/${ULID}`, kind: "clip" });
    expect(parseBack("/money")).toEqual({ href: "/money", kind: "money" });
    expect(backLabel(parseBack(`/campaigns/${UUID}`)!, "FaZe Clips")).toBe("Back to FaZe Clips");
    expect(backLabel(parseBack(`/campaigns/${UUID}`)!)).toBe("Back to your campaign");
    expect(backLabel(parseBack("/campaigns")!)).toBe("Back to your campaigns");
    expect(backLabel(parseBack("/review")!)).toBe("Back to your clip");
    expect(backLabel(parseBack(`/clips/${ULID}`)!)).toBe("Back to your clip");
    expect(backLabel(parseBack("/money")!)).toBe("Back to Money");
    expect(backNext(parseBack(`/campaigns/${UUID}`)!, "FaZe Clips")).toBe("Next: back to FaZe Clips.");
  });

  it("§40: Get paid's list and place pages say Back to Get paid; a setup page says its own name", () => {
    expect(parseBack("/settings/posting/getpaid")).toEqual({ href: "/settings/posting/getpaid", kind: "getpaid" });
    for (const p of ["youtube", "tiktok", "instagram", "facebook", "x", "contentrewards"]) {
      const b = parseBack(`/settings/posting/getpaid/${p}`)!;
      expect(b).toEqual({ href: `/settings/posting/getpaid/${p}`, kind: "getpaid" });
      expect(backLabel(b)).toBe("Back to Get paid");
    }
    expect(backLabel(parseBack("/settings/posting/setup/youtube")!)).toBe("Back to YouTube setup");
    expect(backLabel(parseBack("/settings/posting/setup/contentrewards")!)).toBe("Back to Content Rewards setup");
    expect(backNext(parseBack("/settings/posting/getpaid/youtube")!)).toBe("Next: back to Get paid.");
    // The Get paid link on a setup page, and Set up YouTube from Get paid, carry their way back.
    expect(backLink("?back=/settings/posting/setup/youtube")?.kind).toBe("setup");
    expect(withBack("/settings/posting/setup/youtube", "/settings/posting/getpaid/youtube")).toBe("/settings/posting/setup/youtube?back=/settings/posting/getpaid/youtube");
    for (const bad of [
      "/settings/posting/getpaid/myspace",
      "/settings/posting/getpaid/youtube/x",
      "/settings/posting/getpaid/youtube?x=1",
      "/settings/posting/getpaid/",
      "/settings/posting/setup/myspace",
      "/settings/posting/setup",
      "/settings/posting/getpaid/YouTube",
    ])
      expect(parseBack(bad), bad).toBeNull();
  });

  it("reads the page's query, raw or encoded, and only one back", () => {
    expect(backLink(`?back=/campaigns/${UUID}`)?.kind).toBe("campaign");
    expect(backLink(`?back=${encodeURIComponent(`/review?job=${ULID}`)}`)?.href).toBe(`/review?job=${ULID}`);
    expect(backLink(`?back=/review?job=${ULID}`)?.href).toBe(`/review?job=${ULID}`);
    expect(backLink("?back=/money&result=connected")?.href).toBe("/money");
    expect(backLink("?back=/money&back=/campaigns")).toBeNull();
    expect(backLink("")).toBeNull();
  });

  it("ignores //evil, https:, other paths, extra keys and bad ids", () => {
    for (const bad of [
      "//evil.example/campaigns",
      "https://evil.example/money",
      "https:/money",
      "javascript:alert(1)",
      "money",
      "/settings",
      "/money/",
      "/money?x=1",
      "/campaigns?x=1",
      `/review?job=${ULID}&x=1`,
      "/review?job=",
      "/review?job=../../x",
      "/campaigns/not-a-uuid",
      `/campaigns/${UUID}/x`,
      "/clips/../../settings",
      `/clips/${ULID}#x`,
      "/\\evil.example",
      "/ money",
    ])
      expect(parseBack(bad), bad).toBeNull();
  });

  it("a setup href gets the way back only for a page of the six shapes, and keeps its own", () => {
    expect(withBack("/settings/posting/setup/contentrewards", `/campaigns/${UUID}`)).toBe(`/settings/posting/setup/contentrewards?back=/campaigns/${UUID}`);
    expect(withBack("/settings/posting/setup/youtube", "/money")).toBe("/settings/posting/setup/youtube?back=/money");
    expect(withBack("/settings/posting/setup/youtube", "/settings")).toBe("/settings/posting/setup/youtube");
    expect(withBack("/settings/posting/setup/contentrewards?back=/money", "/campaigns")).toBe("/settings/posting/setup/contentrewards?back=/money");
    expect(withBack("/campaigns", "/money")).toBe("/campaigns");
    const href = withBack("/settings/posting/setup/x", `/review?job=${ULID}`);
    expect(backLink(href.slice(href.indexOf("?")))?.href).toBe(`/review?job=${ULID}`);
  });
});
