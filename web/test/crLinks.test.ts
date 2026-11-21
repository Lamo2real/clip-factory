// campaignLink (docs/CONTRACTS.md §38.4): the same shapes as the API's links.parse_campaign_url, one case per row.
import { describe, expect, it } from "vitest";
import { campaignLink, CHECKOUT_REFUSED, CR_PAGE_REFUSED, INVITE_REFUSED } from "../src/lib/links.ts";

const UUID = "200ea21b-be80-4db8-b552-8e32b148604e";
const CANON = `https://contentrewards.com/c/campaigns/${UUID}`;

describe("campaignLink", () => {
  it.each([
    [`https://contentrewards.com/c/campaigns/${UUID}`],
    [`https://www.contentrewards.com/c/campaigns/${UUID}`],
    [`https://contentrewards.com/c/campaigns/${UUID}/`],
    [`https://contentrewards.com/c/campaigns/${UUID}?utm_source=x&ref=y`],
    [`https://contentrewards.com/discover/${UUID}`],
    [`https://contentrewards.com/c/discover/${UUID}`],
    [`https://whop.com/experiences/exp_123abc/campaigns/${UUID}`],
    [`https://www.whop.com/experiences/exp_123abc/campaigns/${UUID}`],
    [`  Join me! ${CANON}  `],
  ])("%s is the campaign", (url) => {
    expect(campaignLink(url)).toEqual({ kind: "campaign", uuid: UUID, url: CANON, group: false });
  });

  it("any case of the uuid, stored lowercase", () => {
    expect(campaignLink(`https://contentrewards.com/c/campaigns/${UUID.toUpperCase()}`)).toEqual({ kind: "campaign", uuid: UUID, url: CANON, group: false });
  });

  it("?group=1 is a group of campaigns (the API answers { group })", () => {
    expect(campaignLink(`${CANON}?group=1`)).toEqual({ kind: "campaign", uuid: UUID, url: CANON, group: true });
    expect(campaignLink(`https://whop.com/experiences/e/campaigns/${UUID}?group=1`).kind).toBe("campaign");
  });

  it("refuses invite links, Whop sign-up links and other Content Rewards pages, saying what to do", () => {
    expect(campaignLink("https://contentrewards.com/c/invite/abc123")).toEqual({ kind: "refused", message: INVITE_REFUSED });
    expect(campaignLink("https://whop.com/checkout/plan_123")).toEqual({ kind: "refused", message: CHECKOUT_REFUSED });
    for (const page of ["https://contentrewards.com/c/discover", "https://contentrewards.com/c/home", "https://contentrewards.com/faze", "https://contentrewards.com/c/campaigns/not-a-uuid"])
      expect(campaignLink(page)).toEqual({ kind: "refused", message: CR_PAGE_REFUSED });
    expect(INVITE_REFUSED).toContain("**Copy campaign link**");
  });

  it("anything else is not a campaign (Home treats it as a video link)", () => {
    for (const other of ["", "hello", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://whop.com/", "https://evilcontentrewards.com/c/campaigns/" + UUID, "ftp://contentrewards.com/c/campaigns/" + UUID])
      expect(campaignLink(other).kind, other).toBe("none");
  });
});
