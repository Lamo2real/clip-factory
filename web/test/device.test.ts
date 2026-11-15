import { describe, expect, it } from "vitest";
import { detectOs, isInstalled, isIosSafari, parseManifest, planFor, type InstalledInput } from "../src/lib/device.ts";

const UA = {
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  chromeos: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
  iphoneInstagram: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 357.0.0.25.101",
  android: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  desktopApp: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) ClipFactoryDesktop",
};

describe("detectOs", () => {
  it.each([
    [UA.mac, "mac"],
    [UA.macChrome, "mac"],
    [UA.windows, "windows"],
    [UA.linux, "linux"],
    [UA.chromeos, "chromeos"],
    [UA.iphone, "ios"],
    [UA.iphoneChrome, "ios"],
    [UA.android, "android"],
  ] as const)("reads %s as %s", (userAgent, os) => {
    expect(detectOs({ userAgent })).toBe(os);
  });

  it("treats an iPad asking for the desktop site (Mac user agent with touch) as iOS", () => {
    expect(detectOs({ userAgent: UA.mac, maxTouchPoints: 5 })).toBe("ios");
    expect(detectOs({ userAgent: UA.mac, maxTouchPoints: 0 })).toBe("mac");
  });

  it("prefers userAgentData.platform when the user agent is frozen", () => {
    expect(detectOs({ userAgent: "Mozilla/5.0", platform: "Windows" })).toBe("windows");
    expect(detectOs({ userAgent: "Mozilla/5.0", platform: "macOS" })).toBe("mac");
    expect(detectOs({ userAgent: "Mozilla/5.0", platform: "Android" })).toBe("android");
    expect(detectOs({ userAgent: "Mozilla/5.0", platform: "Chrome OS" })).toBe("chromeos");
    expect(detectOs({ userAgent: "Mozilla/5.0" })).toBe("unknown");
  });
});

describe("isIosSafari", () => {
  it("is true only for Safari itself", () => {
    expect(isIosSafari(UA.iphone)).toBe(true);
    expect(isIosSafari(UA.iphoneChrome)).toBe(false);
    expect(isIosSafari(UA.iphoneInstagram)).toBe(false);
    expect(isIosSafari(UA.android)).toBe(false);
  });
});

describe("isInstalled (the hide rules)", () => {
  const base: InstalledInput = { matches: () => false, userAgent: UA.macChrome };

  it("is false in a normal browser tab", () => {
    expect(isInstalled(base)).toBe(false);
  });
  it("hides in an installed window (standalone)", () => {
    expect(isInstalled({ ...base, matches: (q) => q === "(display-mode: standalone)" })).toBe(true);
  });
  it("hides with window controls overlay", () => {
    expect(isInstalled({ ...base, matches: (q) => q === "(display-mode: window-controls-overlay)" })).toBe(true);
  });
  it("hides on an iPhone Home Screen app", () => {
    expect(isInstalled({ ...base, userAgent: UA.iphone, iosStandalone: true })).toBe(true);
    expect(isInstalled({ ...base, userAgent: UA.iphone, iosStandalone: false })).toBe(false);
  });
  it("hides in the desktop wrapper (flag or user agent)", () => {
    expect(isInstalled({ ...base, desktopFlag: true })).toBe(true);
    expect(isInstalled({ ...base, desktopFlag: "true" })).toBe(false);
    expect(isInstalled({ ...base, userAgent: UA.desktopApp })).toBe(true);
  });
  it("hides after the appinstalled event was remembered", () => {
    expect(isInstalled({ ...base, installedFlag: "1" })).toBe(true);
    expect(isInstalled({ ...base, installedFlag: "0" })).toBe(false);
    expect(isInstalled({ ...base, installedFlag: null })).toBe(false);
  });
});

describe("parseManifest", () => {
  it("keeps only safe /downloads/ paths", () => {
    const m = parseManifest({
      version: "abc1234",
      files: {
        mac: { path: "/downloads/Clip-Factory.dmg", size: 100 },
        windows: { path: "https://evil.example/x.exe" },
        linux: { path: "/downloads/../secret" },
      },
    });
    expect(m).toEqual({ version: "abc1234", files: { mac: { path: "/downloads/Clip-Factory.dmg", size: 100 } } });
  });
  it("copes with junk", () => {
    expect(parseManifest(null)).toEqual({ files: {} });
    expect(parseManifest({ files: "nope" })).toEqual({ files: {} });
  });
});

describe("planFor", () => {
  const manifest = parseManifest({
    files: { mac: { path: "/downloads/Clip-Factory.dmg" }, windows: { path: "/downloads/Clip-Factory-Setup.exe" } },
  });

  it("offers the .dmg on a Mac and the .exe on Windows, with the first-open hint", () => {
    expect(planFor("mac", manifest, false, UA.mac)).toMatchObject({
      kind: "download",
      label: "Download for Mac",
      file: { path: "/downloads/Clip-Factory.dmg" },
      firstOpenHint: expect.stringContaining("Open Anyway"),
    });
    expect(planFor("windows", manifest, true, UA.windows)).toMatchObject({
      kind: "download",
      label: "Download for Windows",
      firstOpenHint: expect.stringContaining("Run anyway"),
    });
  });

  it("falls back to the browser install when the file is missing (never a dead link)", () => {
    expect(planFor("linux", manifest, true, UA.linux)).toEqual({ kind: "prompt", os: "linux" });
    expect(planFor("mac", { files: {} }, false, UA.mac)).toEqual({ kind: "browser-steps", os: "mac" });
    expect(planFor("windows", null, true, UA.windows)).toEqual({ kind: "prompt", os: "windows" });
  });

  it("shows picture steps on iPhone, and says to open Safari first elsewhere", () => {
    expect(planFor("ios", manifest, false, UA.iphone)).toEqual({ kind: "ios-steps", inSafari: true });
    expect(planFor("ios", manifest, false, UA.iphoneChrome)).toEqual({ kind: "ios-steps", inSafari: false });
  });

  it("uses the install prompt on Android when there is one, else the steps", () => {
    expect(planFor("android", manifest, true, UA.android)).toEqual({ kind: "prompt", os: "android" });
    expect(planFor("android", manifest, false, UA.android)).toEqual({ kind: "android-steps" });
  });
});
