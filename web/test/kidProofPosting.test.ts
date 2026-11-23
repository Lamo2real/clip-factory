// Kid-proof fixes in Set up posting, Money, Get paid and Campaigns: TikTok's twice-downloaded file is still TikTok's,
// a failed Paste says what works on this device, a same-page link in Sent to your bank keeps its way back, and a
// campaign being removed leaves Your campaigns at once (back on Undo).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Api, CampaignSummary, CrOverview } from "../src/api/types.ts";

let current: Partial<Api> = {};
vi.mock("../src/api/index.ts", async (orig) => ({ ...(await orig<object>()), api: () => current as Api }));

const { fileProblem, tiktokFileName } = await import("../src/screens/settings/setup/VerificationUpload.tsx");
const lib = await import("../src/lib/contentRewards.ts");
const { anchorHere } = await import("../src/screens/getpaid/SentRows.tsx");

describe("TikTok's verification file (§17.4)", () => {
  it("takes the copy a browser saved on a second download, under TikTok's own name", () => {
    expect(tiktokFileName("tiktokAbCdEf123456.txt")).toBe("tiktokAbCdEf123456.txt");
    expect(tiktokFileName("tiktokAbCdEf123456 (1).txt")).toBe("tiktokAbCdEf123456.txt");
    expect(tiktokFileName("tiktokAbCdEf123456(2).txt")).toBe("tiktokAbCdEf123456.txt");
    expect(tiktokFileName("TikTokAbCdEf123456.TXT")).toBe("tiktokAbCdEf123456.txt");
    expect(fileProblem("tiktokAbCdEf123456 (1).txt", 80)).toBeNull();
  });

  it("says what is wrong with any other file, and how to fix it", () => {
    expect(tiktokFileName("tiktokAbCdEf123456 - Copy.txt")).toBeNull();
    expect(fileProblem("tiktokAbCdEf123456 - Copy.txt", 80)).toBe("This file's name was changed. Download it again from TikTok and pick it without renaming it.");
    expect(fileProblem("notes.txt", 80)).toBe("That is not TikTok's file. Pick the tiktok….txt file TikTok gave you.");
    expect(fileProblem("tiktokAbCdEf123456.txt", 9000)).toBe("That file is too big to be TikTok's. Download it again from TikTok.");
  });
});

describe("a failed Paste (§38.4)", () => {
  it("names the keys on a computer and hold-and-Paste only on a touch screen", () => {
    expect(lib.pasteByHand("the box", false)).toBe("Click in the box and press ⌘V (Ctrl+V on Windows).");
    expect(lib.pasteByHand("the link box", true)).toBe("Press and hold in the link box, then choose Paste.");
  });
});

describe("Sent to your bank's buttons (§40.4)", () => {
  it("a link to a step on the same page is a jump there, any other link stays a link", () => {
    const here = "/settings/posting/getpaid/youtube";
    expect(anchorHere("/settings/posting/getpaid/youtube#yt-reading", here)).toBe("yt-reading");
    expect(anchorHere("#yt-reading", here)).toBe("yt-reading");
    expect(anchorHere("/settings/posting/getpaid/youtube#yt-reading", "/settings/posting/getpaid/contentrewards")).toBeNull();
    expect(anchorHere("/settings/posting/getpaid/youtube", here)).toBeNull();
  });
});

describe("Remove from Clip Factory (§38.4)", () => {
  afterEach(() => lib.resetCr());
  const row = (campaignId: string) => ({ campaignId, name: campaignId }) as CampaignSummary;

  it("hides the campaign while the Undo counts, brings it back on Undo, and keeps it gone once removed", async () => {
    let campaigns = [row("a"), row("b")];
    current = { crOverview: vi.fn(async () => ({ campaigns, connection: {} }) as unknown as CrOverview) };
    await lib.reloadCr();
    const ids = () => lib.crSnapshot().data?.campaigns.map((c) => c.campaignId);
    expect(ids()).toEqual(["a", "b"]);
    lib.hideCampaign("a");
    expect(ids()).toEqual(["b"]);
    // A live refresh while the Undo counts (the server still has it) does not bring it back.
    await lib.reloadCr();
    expect(ids()).toEqual(["b"]);
    lib.hideCampaign("a", false);
    expect(ids()).toEqual(["a", "b"]);
    // Removed for good: hidden until the server leaves it out, then it may be added again.
    lib.hideCampaign("a");
    lib.campaignRemoved("a");
    expect(ids()).toEqual(["b"]);
    campaigns = [row("b")];
    await lib.reloadCr();
    expect(lib.campaignHidden("a")).toBe(false);
    campaigns = [row("a"), row("b")];
    await lib.reloadCr();
    expect(ids()).toEqual(["a", "b"]);
  });
});
